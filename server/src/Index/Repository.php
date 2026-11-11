<?php

declare(strict_types=1);

namespace BitrixLsp\Index;

use BitrixLsp\Support\Logger;
use BitrixLsp\Support\Paths;

/**
 * Чтение индекса (SQLite, только чтение). База создаётся и наполняется
 * расширением (VS Code), LSP — потребитель. Если файла ещё нет — методы
 * возвращают пустые результаты, сервер продолжает работать.
 */
final class Repository
{
	private ?Sqlite $database = null;
	private ?string $openedPath = null;

	/** @var array<int, array<string, mixed>>|null */
	private ?array $extensions = null;
	private int $extensionsAt = 0;
	/** @var array<string, array{0: int, 1: array<int, string>}> */
	private array $resultKeyCache = [];
	/** @var array<string, array{0: int, 1: array<int, array<string, mixed>>}> кэш потомков: fqcn => [время, строки] */
	private array $descendantsCache = [];

	public function __construct(
		private ?string $dbPath,
		private readonly Logger $logger,
	) {
	}

	public function setDbPath(?string $dbPath): void
	{
		$this->dbPath = $dbPath;
		$this->database = null;
		$this->openedPath = null;
		$this->extensions = null;
		$this->descendantsCache = [];
	}

	/**
	 * PHP-файлы, попавшие в индекс (для поиска использований по тексту).
	 *
	 * @return array<int, string>
	 */
	public function indexedPhpFiles(int $limit = 4000): array
	{
		$rows = $this->rows(
			"SELECT path FROM file_hashes WHERE path LIKE '%.php' ORDER BY path ASC LIMIT ?",
			[$limit],
		);
		return array_map(static fn (array $row): string => (string) ($row['path'] ?? ''), $rows);
	}

	public function isAvailable(): bool
	{
		return $this->database() !== null;
	}

	/**
	 * База — необязательный артефакт: индексатор может создать её позже,
	 * поэтому отсутствие файла не кешируется.
	 */
	private function database(): ?Sqlite
	{
		$path = $this->dbPath;
		if ($path === null || !is_file($path)) {
			return null;
		}
		if ($this->database !== null && $this->openedPath === $path) {
			return $this->database->isAvailable() ? $this->database : null;
		}
		$database = new Sqlite($path, $this->logger);
		$this->openedPath = $path;
		$this->database = $database->isAvailable() ? $database : null;
		return $this->database;
	}

	/**
	 * @param array<int, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function rows(string $sql, array $params = []): array
	{
		$database = $this->database();
		if ($database === null) {
			return [];
		}
		return $database->rows($sql, $params);
	}

	/**
	 * @param array<int, mixed> $params
	 * @return array<string, mixed>|null
	 */
	private function row(string $sql, array $params = []): ?array
	{
		$rows = $this->rows($sql, $params);
		return $rows[0] ?? null;
	}

	private static function likePrefix(string $prefix): string
	{
		$escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $prefix);
		return $escaped . '%';
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function globalsByPrefix(string $prefix, int $limit = 200): array
	{
		$sql = 'SELECT name, extension_name, type, source_file, line, signature, return_type, params_json, doc '
			. 'FROM js_globals '
			. "WHERE name LIKE ? ESCAPE '\\' ORDER BY name ASC LIMIT ?";
		return $this->rows($sql, [self::likePrefix($prefix), $limit]);
	}

	/**
	 * Глобалы, у которых короткое имя метода совпадает (`%.setSize`).
	 * Нужно для `this.method` в легаси-бандлах, где класс не всегда известен.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function jsGlobalsByShortName(string $name, int $limit = 30): array
	{
		$escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $name);
		return $this->rows(
			'SELECT name, extension_name, type, source_file, line, signature, return_type, params_json, doc '
			. "FROM js_globals WHERE name LIKE ? ESCAPE '\\' "
			. 'ORDER BY (signature IS NULL) ASC, (extension_name IS NULL) ASC, LENGTH(source_file) ASC LIMIT ?',
			['%.' . $escaped, $limit],
		);
	}

	/**
	 * Прямые дочерние сегменты для автодополнения (`BX.` → Main, UI, ...;
	 * `BX.Main.` → Popup, Core, ...). Группировка в SQL, чтобы не выгружать
	 * десятки тысяч строк ради 100 подсказок.
	 *
	 * @return array<int, array{segment: string, type: string, extension_name: ?string}>
	 */
	public function childSegments(string $prefix, int $limit = 2000, string $partial = ''): array
	{
		$length = strlen($prefix);
		$sql = "SELECT substr(name, ? + 1,
					CASE WHEN instr(substr(name, ? + 1), '.') > 0
						THEN instr(substr(name, ? + 1), '.') - 1
						ELSE length(name) END) AS segment,
					MIN(type) AS type,
					MAX(extension_name) AS extension_name,
					MAX(signature) AS signature,
					MAX(return_type) AS return_type,
					MAX(doc) AS doc
				FROM js_globals
				WHERE name LIKE ? ESCAPE '\\'
				GROUP BY segment
				ORDER BY segment ASC
				LIMIT ?";
		return $this->rows($sql, [$length, $length, $length, self::likePrefix($prefix . $partial), $limit]);
	}

	/**
	 * Ключи TS-формы (`type X = {…}` / `interface X`) с учётом extends.
	 * Предпочитает определение из того же каталога, что и исходный файл.
	 *
	 * @param array<string, bool> $seen
	 * @return array<int, string>
	 */
	public function typeKeys(string $name, string $sourceFile = '', array $seen = []): array
	{
		$name = ltrim(trim($name), '?');
		if ($name === '' || isset($seen[$name])) {
			return [];
		}
		$seen[$name] = true;
		$rows = $this->rows(
			'SELECT keys_json, extends_json, source_file FROM js_types WHERE name = ?',
			[$name],
		);
		if ($rows === []) {
			return [];
		}
		$best = $rows[0];
		if ($sourceFile !== '') {
			$dir = dirname($sourceFile);
			foreach ($rows as $row) {
				if (dirname((string) $row['source_file']) === $dir) {
					$best = $row;
					break;
				}
			}
		}
		$keys = json_decode((string) $best['keys_json'], true);
		$result = [];
		if (is_array($keys)) {
			foreach ($keys as $key) {
				if (is_string($key) && $key !== '') {
					$result[$key] = true;
				}
			}
		}
		$parents = json_decode((string) $best['extends_json'], true);
		if (is_array($parents)) {
			foreach ($parents as $parent) {
				if (!is_string($parent)) {
					continue;
				}
				foreach ($this->typeKeys($parent, $sourceFile, $seen) as $key) {
					$result[$key] = true;
				}
			}
		}
		return array_keys($result);
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function globalByName(string $name): ?array
	{
		$rows = $this->globalsByName($name);
		return $rows[0] ?? null;
	}

	/**
	 * Все строки с одним именем: старый бандл и современный ES-класс могут
	 * дополнять друг друга (ключи options из тела и из типа).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function globalsByName(string $name): array
	{
		return $this->rows(
			'SELECT name, extension_name, type, source_file, line, signature, return_type, params_json, doc '
			. 'FROM js_globals WHERE name = ? '
			. 'ORDER BY (signature IS NULL) ASC, (extension_name IS NULL) ASC, LENGTH(source_file) ASC',
			[$name],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function allExtensions(): array
	{
		$now = time();
		if ($this->extensions !== null && $now - $this->extensionsAt < 5) {
			return $this->extensions;
		}
		$this->extensions = $this->rows(
			'SELECT id, name, vendor, path, config_path, js_files_json, css_json, lang_json, rel_json, skip_core '
			. 'FROM js_extensions ORDER BY name ASC',
		);
		$this->extensionsAt = $now;
		return $this->extensions;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function extensionByName(string $name): ?array
	{
		foreach ($this->allExtensions() as $extension) {
			if ($extension['name'] === $name) {
				return $extension;
			}
		}
		return null;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function extensionsForFile(string $file): array
	{
		$needle = Paths::normalize($file);
		$result = [];
		foreach ($this->allExtensions() as $extension) {
			$files = json_decode((string) $extension['js_files_json'], true);
			if (!is_array($files)) {
				continue;
			}
			foreach ($files as $candidate) {
				if (is_string($candidate) && Paths::normalize($candidate) === $needle) {
					$result[] = $extension;
					break;
				}
			}
		}
		return $result;
	}

	/**
	 * Расширение по пути JS-файла: точное совпадение из `js_files_json`,
	 * затем — по каталогу расширения (включая пары `install/js` ↔ `js`).
	 *
	 * @return array<string, mixed>|null
	 */
	public function extensionForFilePath(string $file): ?array
	{
		$direct = $this->extensionsForFile($file);
		if ($direct !== []) {
			return $direct[0];
		}
		$logical = self::logicalJsPath($file);
		if ($logical === '') {
			return null;
		}
		$best = null;
		$bestLength = 0;
		foreach ($this->allExtensions() as $extension) {
			$extensionPath = self::logicalJsPath((string) ($extension['path'] ?? ''));
			if ($extensionPath === '') {
				continue;
			}
			if ($logical === $extensionPath || str_starts_with($logical, $extensionPath . '/')) {
				$length = strlen($extensionPath);
				if ($length > $bestLength) {
					$best = $extension;
					$bestLength = $length;
				}
			}
		}
		return $best;
	}

	/**
	 * Логический путь внутри `js`: `.../install/js/main/core` → `main/core`,
	 * `.../bitrix/js/main/core` → `main/core`.
	 */
	private static function logicalJsPath(string $path): string
	{
		$normalized = Paths::normalize($path);
		if (preg_match('#/(?:install/)?js/(.+)$#', $normalized, $matches) === 1) {
			return $matches[1];
		}
		return '';
	}

	/**
	 * Транзитивное замыкание по `rel` (js_dependencies).
	 *
	 * @param array<int, string> $names
	 * @return array<string, true>
	 */
	public function dependencyClosure(array $names, int $maxDepth = 8): array
	{
		$seen = [];
		$queue = array_values(array_unique($names));
		$depth = 0;
		while ($queue !== [] && $depth < $maxDepth) {
			$next = [];
			foreach ($queue as $name) {
				if (isset($seen[$name])) {
					continue;
				}
				$seen[$name] = true;
				foreach ($this->rows(
					'SELECT d.depends_on_name AS dep FROM js_dependencies d '
					. 'JOIN js_extensions e ON e.id = d.extension_id WHERE e.name = ?',
					[$name],
				) as $row) {
					$dep = (string) $row['dep'];
					if (!isset($seen[$dep])) {
						$next[] = $dep;
					}
				}
			}
			$queue = $next;
			$depth++;
		}
		return $seen;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function classByName(string $fqcn): ?array
	{
		$fqcn = ltrim($fqcn, '\\');
		return $this->row(
			'SELECT fqcn, name, namespace, kind, module, file, line, extends, implements, traits_json, is_orm, deprecated, doc '
			. 'FROM classes WHERE fqcn = ? LIMIT 1',
			[$fqcn],
		);
	}

	/**
	 * Поиск класса по короткому имени (тип возврата вида `?Item`).
	 * Предпочитает классы Bitrix и более короткие FQCN.
	 *
	 * @return array<string, mixed>|null
	 */
	public function findClassByShortName(string $name): ?array
	{
		return $this->row(
			'SELECT fqcn, name, namespace, kind, module, file, line, extends, implements, is_orm, deprecated, doc '
			. 'FROM classes WHERE name = ? '
			. "ORDER BY (fqcn LIKE 'Bitrix%') DESC, LENGTH(fqcn) ASC LIMIT 1",
			[$name],
		);
	}

	/**
	 * Классы по короткому имени (`CFile`, `CFi`) — для автодополнения без `\`.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function classesByShortNamePrefix(string $prefix, int $limit = 50): array
	{
		return $this->rows(
			'SELECT fqcn, name, namespace, kind, module, file, line, deprecated FROM classes '
			. "WHERE name LIKE ? ESCAPE '\\' "
			. "ORDER BY (fqcn LIKE 'Bitrix%') DESC, LENGTH(fqcn) ASC, fqcn ASC LIMIT ?",
			[self::likePrefix($prefix), $limit],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function classesByPrefix(string $prefix, int $limit = 50): array
	{
		$prefix = ltrim($prefix, '\\');
		return $this->rows(
			'SELECT fqcn, name, namespace, kind, module, file, line, deprecated FROM classes '
			. "WHERE fqcn LIKE ? ESCAPE '\\' ORDER BY fqcn ASC LIMIT ?",
			[self::likePrefix($prefix), $limit],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function methodsForClass(string $fqcn): array
	{
		return $this->rows(
			'SELECT class_fqcn, name, signature, return_type, params_json, is_static, visibility, '
			. 'is_abstract, deprecated, doc, file, line '
			. 'FROM methods WHERE class_fqcn = ? ORDER BY name ASC',
			[ltrim($fqcn, '\\')],
		);
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function methodByName(string $fqcn, string $name): ?array
	{
		return $this->row(
			'SELECT class_fqcn, name, signature, return_type, params_json, is_static, visibility, '
			. 'is_abstract, deprecated, doc, file, line '
			. 'FROM methods WHERE class_fqcn = ? AND name = ? LIMIT 1',
			[ltrim($fqcn, '\\'), $name],
		);
	}

	/**
	 * Методы класса с учётом наследования (дочерние переопределения важнее).
	 *
	 * @return array<string, array<string, mixed>>
	 */
	public function methodsForClassWithParents(string $fqcn, int $maxDepth = 12): array
	{
		$methods = [];
		$seen = [];
		$queue = [ltrim($fqcn, '\\')];
		$guard = 0;
		while ($queue !== [] && $guard++ < 200 && count($seen) < $maxDepth * 20) {
			$name = array_shift($queue);
			if ($name === null || $name === '' || isset($seen[$name])) {
				continue;
			}
			$seen[$name] = true;
			$class = $this->classByName($name);
			if ($class === null) {
				continue;
			}
			foreach ($this->methodsForClass($name) as $method) {
				$methodName = (string) $method['name'];
				if (!isset($methods[$methodName])) {
					$methods[$methodName] = $method;
				}
			}
			foreach ($this->directAncestors($class) as $ancestor) {
				$queue[] = $ancestor;
			}
		}
		return $methods;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function findMethodInHierarchy(string $fqcn, string $name): ?array
	{
		$seen = [];
		$queue = [ltrim($fqcn, '\\')];
		$guard = 0;
		while ($queue !== [] && $guard++ < 200) {
			$className = array_shift($queue);
			if ($className === null || $className === '' || isset($seen[$className])) {
				continue;
			}
			$seen[$className] = true;
			$method = $this->methodByName($className, $name);
			if ($method !== null) {
				return $method;
			}
			$class = $this->classByName($className);
			if ($class !== null) {
				foreach ($this->directAncestors($class) as $ancestor) {
					$queue[] = $ancestor;
				}
			}
		}
		return null;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function propertiesForClass(string $fqcn): array
	{
		return $this->rows(
			'SELECT class_fqcn, name, type, visibility, is_static, default_value, doc, file, line '
			. 'FROM properties WHERE class_fqcn = ? ORDER BY name ASC',
			[ltrim($fqcn, '\\')],
		);
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function propertyByName(string $fqcn, string $name): ?array
	{
		return $this->row(
			'SELECT class_fqcn, name, type, visibility, is_static, default_value, doc, file, line '
			. 'FROM properties WHERE class_fqcn = ? AND name = ? LIMIT 1',
			[ltrim($fqcn, '\\'), $name],
		);
	}

	/**
	 * @return array<string, array<string, mixed>>
	 */
	public function propertiesForClassWithParents(string $fqcn): array
	{
		$properties = [];
		$seen = [];
		$queue = [ltrim($fqcn, '\\')];
		$guard = 0;
		while ($queue !== [] && $guard++ < 200) {
			$name = array_shift($queue);
			if ($name === null || $name === '' || isset($seen[$name])) {
				continue;
			}
			$seen[$name] = true;
			$class = $this->classByName($name);
			if ($class === null) {
				continue;
			}
			foreach ($this->propertiesForClass($name) as $property) {
				$propertyName = (string) $property['name'];
				if (!isset($properties[$propertyName])) {
					$properties[$propertyName] = $property;
				}
			}
			foreach ($this->directAncestors($class) as $ancestor) {
				$queue[] = $ancestor;
			}
		}
		return $properties;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function findPropertyInHierarchy(string $fqcn, string $name): ?array
	{
		$seen = [];
		$queue = [ltrim($fqcn, '\\')];
		$guard = 0;
		while ($queue !== [] && $guard++ < 200) {
			$className = array_shift($queue);
			if ($className === null || $className === '' || isset($seen[$className])) {
				continue;
			}
			$seen[$className] = true;
			$property = $this->propertyByName($className, $name);
			if ($property !== null) {
				return $property;
			}
			$class = $this->classByName($className);
			if ($class !== null) {
				foreach ($this->directAncestors($class) as $ancestor) {
					$queue[] = $ancestor;
				}
			}
		}
		return null;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function constantsForClass(string $fqcn): array
	{
		return $this->rows(
			'SELECT class_fqcn, name, type, value, doc, file, line FROM constants WHERE class_fqcn = ? ORDER BY name ASC',
			[ltrim($fqcn, '\\')],
		);
	}

	/**
	 * @return array<string, array<string, mixed>>
	 */
	public function constantsForClassWithParents(string $fqcn): array
	{
		$constants = [];
		$seen = [];
		$queue = [ltrim($fqcn, '\\')];
		$guard = 0;
		while ($queue !== [] && $guard++ < 200) {
			$name = array_shift($queue);
			if ($name === null || $name === '' || isset($seen[$name])) {
				continue;
			}
			$seen[$name] = true;
			$class = $this->classByName($name);
			if ($class === null) {
				continue;
			}
			foreach ($this->constantsForClass($name) as $constant) {
				$constantName = (string) $constant['name'];
				if (!isset($constants[$constantName])) {
					$constants[$constantName] = $constant;
				}
			}
			foreach ($this->directAncestors($class) as $ancestor) {
				$queue[] = $ancestor;
			}
		}
		return $constants;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function findConstantInHierarchy(string $fqcn, string $name): ?array
	{
		$seen = [];
		$queue = [ltrim($fqcn, '\\')];
		$guard = 0;
		while ($queue !== [] && $guard++ < 200) {
			$className = array_shift($queue);
			if ($className === null || $className === '' || isset($seen[$className])) {
				continue;
			}
			$seen[$className] = true;
			$constant = $this->row(
				'SELECT class_fqcn, name, type, value, doc, file, line FROM constants '
				. 'WHERE class_fqcn = ? AND name = ? LIMIT 1',
				[$className, $name],
			);
			if ($constant !== null) {
				return $constant;
			}
			$class = $this->classByName($className);
			if ($class !== null) {
				foreach ($this->directAncestors($class) as $ancestor) {
					$queue[] = $ancestor;
				}
			}
		}
		return null;
	}

	/**
	 * Наследники и реализации класса (транзитивно, по extends/implements).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function descendantsOf(string $fqcn, int $limit = 300): array
	{
		$start = ltrim($fqcn, '\\');
		if ($start === '') {
			return [];
		}
		// Индекс между запросами не меняется, а запрос не бесплатный (скан по LIKE).
		$key = strtolower($start) . ':' . $limit;
		$cached = $this->descendantsCache[$key] ?? null;
		if ($cached !== null && time() - $cached[0] < 60) {
			return $cached[1];
		}
		$result = [];
		$seen = [strtolower($start) => true];
		$queue = [$start];
		while ($queue !== [] && count($result) < $limit) {
			$current = array_shift($queue);
			$position = strrpos($current, '\\');
			$short = $position === false ? $current : substr($current, $position + 1);
			if ($short === '') {
				continue;
			}
			$rows = $this->rows(
				'SELECT fqcn, name, kind, file, line FROM classes WHERE extends LIKE ? OR implements LIKE ? LIMIT 800',
				['%' . $short, '%' . $short . '%'],
			);
			foreach ($rows as $row) {
				$child = ltrim((string) ($row['fqcn'] ?? ''), '\\');
				$key = strtolower($child);
				if ($child === '' || isset($seen[$key])) {
					continue;
				}
				// LIKE по короткому имени может поймать однофамильцев — проверяем иерархию.
				if (!$this->classIsA($child, $current)) {
					continue;
				}
				$seen[$key] = true;
				$result[] = $row;
				$queue[] = $child;
				if (count($result) >= $limit) {
					break;
				}
			}
		}
		$this->descendantsCache[$key] = [time(), $result];
		return $result;
	}

	/**
	 * Переопределения метода у наследников/реализаций.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function methodImplementations(string $fqcn, string $name, int $limit = 100): array
	{
		$result = [];
		foreach ($this->descendantsOf($fqcn, 400) as $row) {
			$method = $this->methodByName((string) ($row['fqcn'] ?? ''), $name);
			if ($method === null) {
				continue;
			}
			$result[] = $method;
			if (count($result) >= $limit) {
				break;
			}
		}
		return $result;
	}

	/**
	 * Является ли класс наследником/реализацией `$target` (обход extends,
	 * implements и трейтов по индексу). Сравнение без учёта регистра.
	 */
	public function classIsA(string $class, string $target): bool
	{
		$target = strtolower(ltrim($target, '\\'));
		if ($target === '') {
			return false;
		}
		$queue = [ltrim($class, '\\')];
		$seen = [];
		while ($queue !== [] && count($seen) < 64) {
			$current = array_shift($queue);
			$key = strtolower($current);
			if (isset($seen[$key])) {
				continue;
			}
			$seen[$key] = true;
			if ($key === $target) {
				return true;
			}
			$row = $this->classByName($current);
			if ($row === null) {
				continue;
			}
			foreach ($this->directAncestors($row) as $ancestor) {
				$queue[] = $ancestor;
			}
		}
		return false;
	}

	/**
	 * Прямые предки: extends + implements + traits (имена разрешены по namespace).
	 *
	 * @param array<string, mixed> $class
	 * @return array<int, string>
	 */
	private function directAncestors(array $class): array
	{
		$namespace = (string) ($class['namespace'] ?? '');
		$raw = [];
		$extends = $class['extends'] ?? null;
		if (is_string($extends) && $extends !== '') {
			$raw[] = $extends;
		}
		foreach (['implements', 'traits_json'] as $field) {
			$decoded = json_decode((string) ($class[$field] ?? '[]'), true);
			if (is_array($decoded)) {
				foreach ($decoded as $item) {
					if (is_string($item) && $item !== '') {
						$raw[] = $item;
					}
				}
			}
		}
		$result = [];
		foreach ($raw as $name) {
			foreach ($this->resolveClassCandidates($name, $namespace) as $candidate) {
				if ($this->classByName($candidate) !== null) {
					$result[] = $candidate;
					break;
				}
			}
		}
		return array_values(array_unique($result));
	}

	/**
	 * @return array<int, string>
	 */
	private function resolveClassCandidates(string $name, string $namespace): array
	{
		$clean = ltrim($name, '\\');
		if ($clean === '') {
			return [];
		}
		if (str_starts_with($name, '\\')) {
			return [$clean];
		}
		if (str_contains($clean, '\\')) {
			return $namespace !== '' ? [$clean, $namespace . '\\' . $clean] : [$clean];
		}
		return $namespace !== '' ? [$namespace . '\\' . $clean, $clean] : [$clean];
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function parentClassName(array $class): ?string
	{
		$extends = $class['extends'] ?? null;
		if (!is_string($extends) || $extends === '') {
			return null;
		}
		$candidates = $this->resolveClassCandidates($extends, (string) ($class['namespace'] ?? ''));
		foreach ($candidates as $candidate) {
			if ($this->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return $candidates[0] ?? null;
	}

	/**
	 * Глобальная PHP-функция по имени: сначала FQCN, затем короткое имя.
	 *
	 * @return array<string, mixed>|null
	 */
	public function findFunction(string $name): ?array
	{
		$clean = ltrim(trim($name), '\\');
		if ($clean === '') {
			return null;
		}
		$row = $this->row(
			'SELECT name, namespace, fqcn, signature, return_type, params_json, doc, deprecated, file, line '
			. 'FROM php_functions WHERE fqcn = ? LIMIT 1',
			[$clean],
		);
		if ($row !== null) {
			return $row;
		}
		return $this->row(
			'SELECT name, namespace, fqcn, signature, return_type, params_json, doc, deprecated, file, line '
			. 'FROM php_functions WHERE name = ? '
			. "ORDER BY (fqcn LIKE 'Bitrix%') DESC, LENGTH(fqcn) ASC, file ASC LIMIT 1",
			[$clean],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function functionsByPrefix(string $prefix, int $limit = 50): array
	{
		return $this->rows(
			'SELECT name, namespace, fqcn, signature, return_type, params_json, doc, file, line FROM php_functions '
			. "WHERE name LIKE ? ESCAPE '\\' ORDER BY name ASC, LENGTH(fqcn) ASC LIMIT ?",
			[self::likePrefix($prefix), $limit],
		);
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function findGlobalConstant(string $name): ?array
	{
		return $this->row(
			'SELECT name, value, doc, file, line FROM php_constants WHERE name = ? '
			. "ORDER BY (file LIKE '%/bitrix/modules/%') DESC, (file LIKE '%/local/%') DESC, LENGTH(file) ASC LIMIT 1",
			[$name],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function globalConstantsByPrefix(string $prefix, int $limit = 50): array
	{
		return $this->rows(
			'SELECT name, value, doc, file, line FROM php_constants '
			. "WHERE name LIKE ? ESCAPE '\\' ORDER BY name ASC LIMIT ?",
			[self::likePrefix($prefix), $limit],
		);
	}

	/**
	 * Поиск классов для workspace/symbol (Ctrl+T).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function searchSymbols(string $query, int $limit = 50): array
	{
		$escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $query);
		$like = '%' . $escaped . '%';
		return $this->rows(
			'SELECT fqcn, name, namespace, kind, module, file, line FROM classes '
			. "WHERE name LIKE ? ESCAPE '\\' OR fqcn LIKE ? ESCAPE '\\' "
			. 'ORDER BY (name LIKE ?) DESC, LENGTH(fqcn) ASC LIMIT ?',
			[$like, $like, $like, $limit],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function searchFunctions(string $query, int $limit = 50): array
	{
		$escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $query);
		$like = '%' . $escaped . '%';
		return $this->rows(
			'SELECT name, fqcn, signature, file, line FROM php_functions '
			. "WHERE name LIKE ? ESCAPE '\\' OR fqcn LIKE ? ESCAPE '\\' "
			. 'ORDER BY LENGTH(fqcn) ASC LIMIT ?',
			[$like, $like, $limit],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function searchMethods(string $query, int $limit = 50): array
	{
		$escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $query);
		$like = '%' . $escaped . '%';
		return $this->rows(
			'SELECT class_fqcn, name, signature, file, line FROM methods '
			. "WHERE name LIKE ? ESCAPE '\\' "
			. 'ORDER BY LENGTH(class_fqcn) ASC, name ASC LIMIT ?',
			[$like, $limit],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function functionsForFile(string $file): array
	{
		return $this->rows(
			'SELECT name, fqcn, signature, file, line FROM php_functions WHERE file = ? ORDER BY line ASC',
			[Paths::normalize($file)],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function globalConstantsForFile(string $file): array
	{
		return $this->rows(
			'SELECT name, value, file, line FROM php_constants WHERE file = ? ORDER BY line ASC',
			[Paths::normalize($file)],
		);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function classesForFile(string $file): array
	{
		return $this->rows(
			'SELECT fqcn, name, namespace, kind, module, file, line FROM classes WHERE file = ? ORDER BY line ASC',
			[Paths::normalize($file)],
		);
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function componentForFile(string $file): ?array
	{
		if (preg_match('#^(.*?/components/[^/]+/[^/]+)/#', Paths::normalize($file), $matches) !== 1) {
			return null;
		}
		$row = $this->row(
			'SELECT id, name, namespace, module, path, parameters_file FROM components WHERE path = ? LIMIT 1',
			[$matches[1]],
		);
		if ($row !== null) {
			return $row;
		}
		// Компонент без .parameters.php: имя всё равно нужно для hover
		// `$arResult`/`$arParams` и шаблонов.
		return [
			'id' => null,
			'name' => basename($matches[1]),
			'namespace' => null,
			'module' => null,
			'path' => $matches[1],
			'parameters_file' => null,
		];
	}

	/**
	 * Ключи `$arResult`, которые компонент присваивает литерально.
	 * Динамические значения (`$arResult = $service->getData()`) не выводятся.
	 *
	 * @param array<string, mixed> $component
	 * @return array<int, string>
	 */
	public function resultKeysForComponent(array $component): array
	{
		$path = (string) ($component['path'] ?? '');
		if ($path === '') {
			return [];
		}
		$file = $path . '/class.php';
		$mtime = @filemtime($file);
		if ($mtime === false) {
			return [];
		}
		if (isset($this->resultKeyCache[$file]) && $this->resultKeyCache[$file][0] === $mtime) {
			return $this->resultKeyCache[$file][1];
		}
		$content = @file_get_contents($file);
		if (!is_string($content)) {
			return [];
		}
		$keys = [];
		if (preg_match_all('/\$(?:this->)?arResult\s*\[\s*[\'"]([A-Za-z_][A-Za-z0-9_]*)[\'"]\s*\]/', $content, $matches) > 0) {
			foreach ($matches[1] as $name) {
				$keys[$name] = true;
			}
		}
		if (preg_match_all('/\$(?:this->)?arResult\s*=\s*\[(.*?)\]\s*;/s', $content, $assignments) > 0) {
			foreach ($assignments[1] as $body) {
				if (preg_match_all('/(?:^|,)\s*[\'"]([A-Za-z_][A-Za-z0-9_]*)[\'"]\s*=>/', $body, $arrayKeys) > 0) {
					foreach ($arrayKeys[1] as $name) {
						$keys[$name] = true;
					}
				}
			}
		}
		foreach ($this->dynamicResultKeys($content) as $name) {
			$keys[$name] = true;
		}
		$names = array_keys($keys);
		sort($names, SORT_STRING);
		$this->resultKeyCache[$file] = [$mtime, $names];
		return $names;
	}

	/**
	 * Ключи из `@return array{…}` методов, результаты которых присваиваются
	 * `$this->arResult`: `$this->arResult = $this->getData()` и
	 * `$this->arResult = $this->service->getData()`.
	 *
	 * @return array<int, string>
	 */
	private function dynamicResultKeys(string $content): array
	{
		$keys = [];
		$classFqcn = $this->classFqcnInFile($content);
		if (preg_match_all('/\$(?:this->)?arResult\s*=\s*(.+?);/s', $content, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[1] as $index => $match) {
				$expression = trim($match[0]);
				if ($expression === '') {
					continue;
				}
				foreach ($this->shapeKeysForExpression($content, $classFqcn, $expression, $matches[0][$index][1], 0) as $name) {
					$keys[$name] = true;
				}
			}
		}
		return array_keys($keys);
	}

	/**
	 * @return array<int, string>
	 */
	private function shapeKeysForExpression(string $content, ?string $classFqcn, string $expression, int $offset, int $depth): array
	{
		if ($depth > 4 || $classFqcn === null) {
			return [];
		}
		$expression = trim($expression);
		if (preg_match('/^\$([A-Za-z_][A-Za-z0-9_]*)$/', $expression, $variable) === 1 && $variable[1] !== 'this') {
			$rhs = $this->previousAssignment($content, $variable[1], $offset);
			return $rhs === null ? [] : $this->shapeKeysForExpression($content, $classFqcn, $rhs, $offset, $depth + 1);
		}
		if (preg_match('/^(\$this|\$[A-Za-z_][A-Za-z0-9_]*)((?:->[A-Za-z_][A-Za-z0-9_]*)*)->([A-Za-z_][A-Za-z0-9_]*)\s*\(/', $expression, $call) !== 1) {
			return [];
		}
		$receiver = $call[1];
		if ($receiver === '$this') {
			$class = $classFqcn;
		} else {
			$class = $this->localVariableClass($content, substr($receiver, 1), $offset, $depth + 1);
		}
		if ($class === null) {
			return [];
		}
		$chain = trim($call[2], '->');
		if ($chain !== '') {
			foreach (explode('->', $chain) as $property) {
				if ($property === '') {
					continue;
				}
				$class = $this->propertyClass($content, $class, $property, $classFqcn);
				if ($class === null) {
					return [];
				}
			}
		}
		$method = $call[3];
		$keys = [];
		if ($class === $classFqcn) {
			foreach ($this->shapeKeysForLocalMethod($content, $method) as $name) {
				$keys[$name] = true;
			}
		}
		foreach ($this->shapeKeysForIndexedMethod($class, $method) as $name) {
			$keys[$name] = true;
		}
		return array_keys($keys);
	}

	private function previousAssignment(string $content, string $variable, int $offset): ?string
	{
		$pattern = '/\$' . preg_quote($variable, '/') . '\s*=\s*(.+?);/s';
		if (preg_match_all($pattern, $content, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		$rhs = null;
		foreach ($matches[0] as $index => $match) {
			if ($match[1] >= $offset) {
				break;
			}
			$rhs = trim($matches[1][$index][0]);
		}
		return $rhs;
	}

	private function localVariableClass(string $content, string $variable, int $offset, int $depth): ?string
	{
		if ($depth > 4) {
			return null;
		}
		$rhs = $this->previousAssignment($content, $variable, $offset);
		if ($rhs === null) {
			return null;
		}
		if (preg_match('/^new\s+([\\A-Za-z_][\\A-Za-z0-9_]*)/', $rhs, $match) === 1) {
			return $this->resolveTypeInFile($content, $match[1]);
		}
		if (preg_match('/^\$this->([A-Za-z_][A-Za-z0-9_]*)((?:->[A-Za-z_][A-Za-z0-9_]*)*)$/', $rhs, $match) === 1) {
			$class = $this->classFqcnInFile($content);
			if ($class === null) {
				return null;
			}
			$chain = trim($match[2], '->');
			$properties = $match[1] . ($chain !== '' ? '->' . $chain : '');
			foreach (explode('->', $properties) as $property) {
				$class = $this->propertyClass($content, $class, $property, $this->classFqcnInFile($content));
				if ($class === null) {
					return null;
				}
			}
			return $class;
		}
		return null;
	}

	private function propertyClass(string $content, string $class, string $property, ?string $currentClass): ?string
	{
		$type = null;
		if ($class === $currentClass) {
			$type = $this->propertyTypeInFile($content, $property);
			if ($type !== null) {
				return $this->resolveTypeInFile($content, $type);
			}
		}
		$row = $this->findPropertyInHierarchy($class, $property);
		if ($row === null) {
			return null;
		}
		return $this->resolveTypeForClass($class, (string) ($row['type'] ?? ''));
	}

	private function resolveTypeForClass(string $class, string $type): ?string
	{
		$type = trim($type);
		if ($type === '') {
			return null;
		}
		$row = $this->classByName($class);
		$namespace = $row !== null ? trim((string) ($row['namespace'] ?? '')) : '';
		foreach (explode('|', $type) as $part) {
			$part = ltrim(trim($part), '?');
			if ($part === '') {
				continue;
			}
			$candidates = [];
			if (str_starts_with($part, '\\')) {
				$candidates[] = ltrim($part, '\\');
			} else {
				if ($namespace !== '') {
					$candidates[] = $namespace . '\\' . $part;
				}
				$candidates[] = $part;
			}
			foreach ($candidates as $candidate) {
				if ($this->classByName($candidate) !== null) {
					return $candidate;
				}
			}
		}
		return null;
	}

	private function classFqcnInFile(string $content): ?string
	{
		if (preg_match('/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/', $content, $classMatch) !== 1) {
			return null;
		}
		$namespace = preg_match('/\bnamespace\s+([^;]+);/', $content, $namespaceMatch) === 1
			? trim($namespaceMatch[1])
			: '';
		return $namespace !== '' ? $namespace . '\\' . $classMatch[1] : $classMatch[1];
	}

	private function propertyTypeInFile(string $content, string $property): ?string
	{
		$name = preg_quote($property, '/');
		if (preg_match('/(?:^|[;{}\n])\s*(?:(?:public|protected|private|static|readonly|var)\s+)*(?:([?\\\\A-Za-z0-9_|]+)\s+)?\$' . $name . '\b/', $content, $match) === 1) {
			$type = trim($match[1] ?? '');
			if ($type !== '' && !in_array(strtolower(ltrim($type, '?')), ['array', 'string', 'int', 'float', 'bool', 'callable', 'mixed', 'object'], true)) {
				return $type;
			}
		}
		if (preg_match('#/\*\*[\s\S]*?@var\s+([?\\\\A-Za-z0-9_|]+)\s+\$' . $name . '\b#', $content, $match) === 1) {
			return trim($match[1]);
		}
		return null;
	}

	private function resolveTypeInFile(string $content, ?string $type): ?string
	{
		if ($type === null) {
			return null;
		}
		$type = trim($type);
		foreach (explode('|', $type) as $part) {
			$part = ltrim(trim($part), '?');
			if ($part === '') {
				continue;
			}
			$namespace = preg_match('/\bnamespace\s+([^;]+);/', $content, $namespaceMatch) === 1
				? trim($namespaceMatch[1])
				: '';
			$uses = [];
			if (preg_match_all('/\buse\s+([^;]+);/', $content, $useMatches) > 0) {
				foreach ($useMatches[1] as $use) {
					$use = trim($use);
					if (str_contains($use, '{')) {
						continue;
					}
					$alias = null;
					if (preg_match('/^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i', $use, $aliasMatch) === 1) {
						$use = trim($aliasMatch[1]);
						$alias = $aliasMatch[2];
					}
					$position = strrpos($use, '\\');
					$short = $position === false ? $use : substr($use, $position + 1);
					$uses[$alias ?? $short] = ltrim($use, '\\');
				}
			}
			$candidates = [];
			if (str_starts_with($part, '\\')) {
				$candidates[] = ltrim($part, '\\');
			} else {
				$shortPosition = strrpos($part, '\\');
				$short = $shortPosition === false ? $part : substr($part, $shortPosition + 1);
				if (isset($uses[$short])) {
					$candidates[] = $uses[$short];
				}
				if ($namespace !== '') {
					$candidates[] = $namespace . '\\' . $part;
				}
				$candidates[] = $part;
			}
			foreach ($candidates as $candidate) {
				if ($this->classByName($candidate) !== null) {
					return $candidate;
				}
			}
		}
		return null;
	}

	/**
	 * @return array<int, string>
	 */
	private function shapeKeysForIndexedMethod(string $class, string $method): array
	{
		$row = $this->methodByName($class, $method);
		return $row === null ? [] : $this->arrayShapeKeys((string) ($row['doc'] ?? ''));
	}

	/**
	 * @return array<int, string>
	 */
	private function shapeKeysForLocalMethod(string $content, string $method): array
	{
		if (preg_match('/\bfunction\s+' . preg_quote($method, '/') . '\s*\(/', $content, $match, PREG_OFFSET_CAPTURE) !== 1) {
			return [];
		}
		$before = substr($content, 0, $match[0][1]);
		$doc = '';
		if (preg_match_all('#/\*\*[\s\S]*?\*/#', $before, $docs) > 0) {
			$doc = (string) end($docs[0]);
		}
		return $this->arrayShapeKeys($doc);
	}

	/**
	 * Ключи верхнего уровня из `@return array{KEY: type, …}`.
	 *
	 * @return array<int, string>
	 */
	private function arrayShapeKeys(string $doc): array
	{
		$position = strpos($doc, 'array{');
		if ($position === false) {
			return [];
		}
		$start = $position + strlen('array{');
		$depth = 1;
		$end = $start;
		for ($length = strlen($doc); $end < $length; $end++) {
			if ($doc[$end] === '{') {
				$depth++;
			} elseif ($doc[$end] === '}') {
				$depth--;
				if ($depth === 0) {
					break;
				}
			}
		}
		$body = substr($doc, $start, max(0, $end - $start));
		if (preg_match_all('/(?:^|,)\s*[\'"]?([A-Za-z_][A-Za-z0-9_]*)[\'"]?\s*[?:]/', $body, $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		$keys = [];
		foreach ($matches[0] as $index => $match) {
			if ($this->shapeDepthAt($body, $match[1]) === 0) {
				$keys[$matches[1][$index][0]] = true;
			}
		}
		return array_keys($keys);
	}

	private function shapeDepthAt(string $body, int $offset): int
	{
		$depth = 0;
		for ($i = 0; $i < $offset; $i++) {
			if ($body[$i] === '{' || $body[$i] === '[' || $body[$i] === '(') {
				$depth++;
			} elseif ($body[$i] === '}' || $body[$i] === ']' || $body[$i] === ')') {
				$depth--;
			}
		}
		return $depth;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function paramsForComponent(string $component): array
	{
		return $this->rows(
			'SELECT component, name, type, default_value, is_required FROM params WHERE component = ? ORDER BY name ASC',
			[$component],
		);
	}

	public function paramExists(string $component, string $name): bool
	{
		return $this->row('SELECT 1 AS ok FROM params WHERE component = ? AND name = ? LIMIT 1', [$component, $name]) !== null;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function deprecatedSubject(string $subject): ?array
	{
		return $this->row('SELECT subject, replaced_by, since, note FROM deprecated WHERE subject = ? LIMIT 1', [$subject]);
	}
}
