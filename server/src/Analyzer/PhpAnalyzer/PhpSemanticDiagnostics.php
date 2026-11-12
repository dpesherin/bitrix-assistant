<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/** Осторожные семантические диагностики: аргументы, типы, неизвестные функции/переменные. */
final class PhpSemanticDiagnostics
{
	private const MAX = 30;

	/** `declare(strict_types=1)` в текущем документе: приведение скаляров запрещено. */
	private bool $strictTypes = false;

	/** @var array<string, array<string, string>> use-карты файлов объявлений (кэш) */
	private array $declaringUses = [];

	/** Только проверки существования символов (работают без bitrix.php.semantic). */
	private bool $symbolsOnly = false;

	/** @var array<string, array<int, string>> */
	private const ADDED_FUNCTIONS = [
		'8.2' => ['ini_parse_quantity', 'memory_reset_peak_usage', 'mysqli_execute_query', 'openssl_cipher_key_length'],
		'8.3' => ['json_validate', 'mb_str_pad', 'str_increment', 'str_decrement', 'stream_context_set_options', 'posix_sysconf'],
		'8.4' => [
			'array_find', 'array_find_key', 'array_any', 'array_all', 'bcdivmod', 'bcceil', 'bcfloor', 'bcround',
			'grapheme_str_split', 'http_get_last_response_headers', 'http_clear_last_response_headers',
			'mb_ucfirst', 'mb_lcfirst', 'mb_trim', 'mb_ltrim', 'mb_rtrim', 'pcntl_getcpu',
			'pcntl_getqos_class', 'pcntl_setqos_class', 'request_parse_body',
		],
	];

	public function __construct(
		private readonly Repository $repository,
		private readonly PhpMethodResolver $resolver,
		private readonly string $version = 'auto',
		/** @var array<int, string> */
		private readonly array $ignoreSymbols = [],
	) {
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	/**
	 * Неизвестные функции/методы — базовая проверка, включена всегда:
	 * такие ошибки видны в Problems независимо от `bitrix.php.semantic`.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function checkSymbols(TextDocument $document): array
	{
		$this->symbolsOnly = true;
		try {
			return $this->check($document);
		} finally {
			$this->symbolsOnly = false;
		}
	}

	public function check(TextDocument $document): array
	{
		$masked = JsScanner::maskCode(PhpSource::phpOnly($document->text), true);
		$this->strictTypes = preg_match('/\bdeclare\s*\(\s*strict_types\s*=\s*1\s*\)/', $masked) === 1;
		$context = PhpDocumentContext::create($document);
		$diagnostics = [];
		$seen = [];
		$builtins = array_fill_keys(array_map('strtolower', get_defined_functions()['internal'] ?? []), true);
		$target = $this->version === 'auto' ? PHP_VERSION : $this->version;
		$runtime = PHP_VERSION;
		foreach (self::ADDED_FUNCTIONS as $introduced => $functions) {
			$add = version_compare($target, $introduced, '>=') && version_compare($runtime, $introduced, '<');
			$remove = version_compare($target, $introduced, '<') && version_compare($runtime, $introduced, '>=');
			foreach ($functions as $function) {
				if ($add) {
					$builtins[strtolower($function)] = true;
				} elseif ($remove) {
					unset($builtins[strtolower($function)]);
				}
			}
		}
		$keywords = array_fill_keys([
			'if', 'elseif', 'while', 'for', 'foreach', 'switch', 'catch', 'function', 'new',
			'isset', 'empty', 'unset', 'array', 'list', 'echo', 'print', 'include', 'include_once',
			'require', 'require_once', 'eval', 'match', 'return', 'exit', 'die', 'clone', 'yield',
			'static', 'global', 'declare', 'namespace', 'use', 'class', 'interface', 'trait', 'fn',
			// `break(2)` / `continue(2)` — это не вызовы функций.
			'break', 'continue', 'match', 'throw',
		], true);

		$callRe = '/(?<![>\\w$:])\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)\\s*\\(/';
		if (preg_match_all($callRe, $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$name = $matches[1][$index][0];
				$lower = strtolower($name);
				if (isset($keywords[$lower]) || str_contains($name, '\\')) {
					continue;
				}
				$before = substr($masked, max(0, $whole[1] - 80), min(80, $whole[1]));
				if (preg_match('/\b(?:new|function|fn)\s+&?\s*$/', $before) === 1) {
					continue;
				}
				$open = $whole[1] + strrpos($whole[0], '(');
				$close = $this->matchingParen($masked, $open);
				if ($close <= $open) {
					continue;
				}
				$key = $name . ':' . $whole[1];
				if (isset($seen[$key])) {
					continue;
				}
				$seen[$key] = true;
				$function = $this->repository->findFunction($name);
				if ($function === null) {
					if (in_array($lower, $this->ignoreSymbols, true)) {
						continue;
					}
					if (!isset($builtins[$lower]) && function_exists($name) === false) {
						$diagnostics[] = $this->warning(
							$document,
							$whole[1],
							$whole[1] + strlen($name),
							"Функция {$name}() не найдена в индексе и среди встроенных PHP-функций.",
							'bitrix.php.unknown-function',
							['kind' => 'unknown-function', 'name' => $name],
						);
					}
					continue;
				}
				if (!$this->symbolsOnly) {
					$diagnostics = array_merge(
						$diagnostics,
						$this->checkArguments($document, $function, $open, $close, $name, $context),
					);
				}
				if (count($diagnostics) >= self::MAX) {
					return array_slice($diagnostics, 0, self::MAX);
				}
			}
		}

		$methodRe = '/(?:->|::)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(/';
		if (preg_match_all($methodRe, $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$name = $matches[1][$index][0];
				$nameOffset = $whole[1] + strpos($whole[0], $name);
				$reference = $this->resolver->resolve($document, $nameOffset);
				if ($reference === null) {
					$unknown = $this->unknownMethod($document, $nameOffset, $name);
					if ($unknown !== null) {
						$diagnostics[] = $unknown;
						if (count($diagnostics) >= self::MAX) {
							break;
						}
					}
					continue;
				}
				$open = $whole[1] + strrpos($whole[0], '(');
				$close = $this->matchingParen($masked, $open);
				if ($close <= $open) {
					continue;
				}
				$visibility = $this->visibilityDiagnostic($document, $nameOffset, $name, $reference);
				if ($visibility !== null) {
					$diagnostics[] = $visibility;
					if (count($diagnostics) >= self::MAX) {
						break;
					}
				}
				if (!$this->symbolsOnly) {
					$diagnostics = array_merge(
						$diagnostics,
						$this->checkArguments(
							$document,
							$reference['method'],
							$open,
							$close,
							(string) $reference['method']['name'],
							$context,
						),
					);
				}
				if (count($diagnostics) >= self::MAX) {
					break;
				}
			}
		}

		$unicodeMethodRe = '/(?:->|::)\s*([\p{L}_][\p{L}\p{N}_]*)\s*\(/u';
		if (preg_match_all($unicodeMethodRe, $masked, $unicodeMatches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($unicodeMatches[0] as $index => $whole) {
				$name = $unicodeMatches[1][$index][0];
				if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name) === 1) {
					continue; // обычные имена уже разобраны выше
				}
				$nameOffset = $whole[1] + strpos($whole[0], $name);
				$target = $this->resolver->resolveMemberTarget($document, $nameOffset);
				if ($target === null) {
					continue;
				}
				$class = ltrim($target['class'], '\\');
				if ($class === '' || $this->repository->classByName($class) === null) {
					continue;
				}
				$diagnostics[] = $this->warning(
					$document,
					$nameOffset,
					$nameOffset + mb_strlen($name),
					"Метод {$name}() не найден в классе {$class} (в имени не-ASCII символы — проверьте раскладку).",
					'bitrix.php.unknown-method',
					['kind' => 'unknown-method', 'name' => $name, 'class' => $class],
				);
				if (count($diagnostics) >= self::MAX) {
					break;
				}
			}
		}

		if (!$this->symbolsOnly) {
			$diagnostics = array_merge($diagnostics, $this->checkReturnTypes($document, $masked, $context));
			// В подключаемых фрагментах (шаблоны, properties_dialog.php) переменные
			// приходят из включающего файла — проверка даёт только ложные срабатывания.
			$selfContained = preg_match('/\b(?:function|class|interface|trait|enum)\s+[A-Za-z_]/i', $masked) === 1;
			if ($selfContained) {
				$diagnostics = array_merge($diagnostics, $this->undefinedVariables($document, $masked));
			}
		}
		return array_slice($diagnostics, 0, self::MAX);
	}

	/**
	 * Вызов private/protected метода снаружи класса — в PHP это фатальная ошибка.
	 *
	 * @param array{method: array<string, mixed>, class: string} $reference
	 * @return array<string, mixed>|null
	 */
	private function visibilityDiagnostic(
		TextDocument $document,
		int $nameOffset,
		string $name,
		array $reference,
	): ?array {
		$visibility = strtolower((string) ($reference['method']['visibility'] ?? 'public'));
		if ($visibility === 'public' || $visibility === '' || str_starts_with($name, '__')) {
			return null;
		}
		$declaring = ltrim((string) ($reference['method']['class_fqcn'] ?? ''), '\\');
		if ($declaring === '') {
			return null;
		}
		$declaringRow = $this->repository->classByName($declaring);
		if ($declaringRow === null) {
			return null;
		}
		// Трейты: метод «приезжает» в класс, отдельного класса-владельца нет.
		if ((string) ($declaringRow['kind'] ?? '') === 'trait') {
			return null;
		}
		if (stripos((string) ($declaringRow['doc'] ?? ''), '@method') !== false) {
			return null;
		}
		$caller = PhpDocumentContext::create($document)->classAt($nameOffset);
		$callerFqcn = $caller !== null ? ltrim((string) $caller['fqcn'], '\\') : '';
		if ($callerFqcn !== '' && strcasecmp($callerFqcn, $declaring) === 0) {
			return null;
		}
		if ($visibility === 'protected' && $callerFqcn !== '' && $this->isSubclassOf($callerFqcn, $declaring)) {
			return null;
		}
		$where = $callerFqcn === '' ? 'вне класса' : "в классе {$callerFqcn}";
		return [
			'range' => $document->range($nameOffset, $nameOffset + strlen($name)),
			'severity' => 1,
			'source' => 'bitrix',
			'code' => 'bitrix.php.method-visibility',
			'message' => "Метод {$name}() объявлен как {$visibility} в {$declaring} и недоступен {$where}.",
			'data' => ['kind' => 'method-visibility', 'name' => $name, 'class' => $declaring, 'visibility' => $visibility],
		];
	}

	/** Наследник ли класс (extends/implements/traits по индексу). */
	private function isSubclassOf(string $class, string $parent): bool
	{
		return $this->repository->classIsA($class, $parent);
	}

	/**
	 * Вызов метода, которого нет у известного класса (учитываются `__call`
	 * и встроенные классы PHP, которых нет в индексе).
	 *
	 * @return array<string, mixed>|null
	 */
	private function unknownMethod(TextDocument $document, int $nameOffset, string $name): ?array
	{
		if ($name === '' || str_starts_with($name, '__')) {
			return null;
		}
		if (in_array(strtolower($name), $this->ignoreSymbols, true)) {
			return null;
		}
		$target = $this->resolver->resolveMemberTarget($document, $nameOffset);
		if ($target === null) {
			return null;
		}
		$class = ltrim($target['class'], '\\');
		if ($class === '') {
			return null;
		}
		if ($this->repository->classByName($class) === null) {
			// Класс объявлен в этом же (ещё не проиндексированном) файле:
			// проверяем по тексту документа, иначе молчим.
			$context = PhpDocumentContext::create($document);
			$local = $context->classAt($nameOffset);
			if ($local === null || strcasecmp(ltrim($local['fqcn'], '\\'), $class) !== 0) {
				return null;
			}
			if (preg_match('/function\s+&?\s*' . preg_quote($name, '/') . '\s*\(/i', $document->text) === 1) {
				return null;
			}
		}
		$row = $this->repository->classByName($class);
		if ($row !== null && stripos((string) ($row['doc'] ?? ''), '@method') !== false) {
			return null;
		}
		// Интерфейс описывает контракт: у реализации методы могут быть
		// объявлены иначе (генерируемый ORM-код) — не предупреждаем.
		if ($row !== null && strtolower((string) ($row['kind'] ?? '')) === 'interface') {
			return null;
		}
		// Динамическая диспетчеризация: `$runtime->GetService('DocumentService')->Foo()`
		// — тип зависит от строкового аргумента, проверить нельзя.
		$beforeCall = substr($document->text, max(0, $nameOffset - 240), min(240, $nameOffset));
		if (preg_match('/(?:->|::)\s*[A-Za-z_][A-Za-z0-9_]*\s*\(\s*[\'"]/', $beforeCall) === 1) {
			return null;
		}
		$magic = $target['operator'] === '::' ? '__callStatic' : '__call';
		if (
			$this->repository->findMethodInHierarchy($class, $magic) !== null
			|| $this->repository->findMethodInHierarchy($class, '__call') !== null
			|| $this->repository->findMethodInHierarchy($class, '__callStatic') !== null
		) {
			return null;
		}
		return $this->warning(
			$document,
			$nameOffset,
			$nameOffset + strlen($name),
			"Метод {$name}() не найден в классе {$class}.",
			'bitrix.php.unknown-method',
			['kind' => 'unknown-method', 'name' => $name, 'class' => $class],
		);
	}

	/**
	 * Типы аргументов: скаляры с учётом `strict_types`, классы — с учётом
	 * иерархии (`new Child()` подходит для параметра `Parent`), nullability.
	 *
	 * @param array<string, mixed> $callable
	 * @return array<int, array<string, mixed>>
	 */
	private function checkArguments(
		TextDocument $document,
		array $callable,
		int $open,
		int $close,
		string $name,
		PhpDocumentContext $context,
	): array {
		$params = json_decode((string) ($callable['params_json'] ?? '[]'), true);
		if (!is_array($params)) {
			return [];
		}
		$args = $this->splitArguments($document->text, $open + 1, $close);
		// `f(...$args)`: количество аргументов неизвестно — не проверяем.
		foreach ($args as $argument) {
			if (preg_match('/^\s*\.\.\./', $argument) === 1) {
				return [];
			}
		}
		$required = 0;
		$variadic = false;
		foreach ($params as $param) {
			if (!empty($param['variadic'])) {
				$variadic = true;
			} elseif (!array_key_exists('default', $param)) {
				$required++;
			}
		}
		// PHP ругается на лишние аргументы только у встроенных функций; у
		// пользовательских лишние аргументы молча игнорируются (легаси-код на этом живёт).
		$internal = str_starts_with((string) ($callable['file'] ?? ''), '<phpstub>');
		$tooFew = count($args) < $required;
		$tooMany = !$variadic && count($args) > count($params);
		if ($tooFew || ($tooMany && $internal)) {
			return [
				$this->warning(
					$document,
					$open - strlen($name),
					$close + 1,
					sprintf(
						'%s(): ожидается аргументов %d%s, передано %d.',
						$name,
						$required,
						$variadic ? '+' : '–' . count($params),
						count($args),
					),
					'bitrix.php.argument-count',
					['kind' => 'argument-count', 'name' => $name],
				),
			];
		}
		$diagnostics = [];
		$selfClass = $context->classAt($open)['fqcn'] ?? null;
		[$callableNamespace, $callableUses] = $this->declaringContext($callable);
		foreach ($args as $index => $arg) {
			$param = $params[$index] ?? null;
			if (!is_array($param)) {
				break;
			}
			$expected = trim((string) ($param['type'] ?? ''));
			if ($expected === '') {
				continue;
			}
			$allowed = $this->typeList($expected);
			$nullable = str_starts_with(trim($expected), '?') || in_array('null', $allowed, true);
			$actual = $this->literalType($arg);
			if ($actual === 'null') {
				if ($nullable) {
					continue;
				}
			}
			$actualName = $actual;
			if ($actual !== null) {
				$ok = $this->scalarAllows($allowed, $actual, $arg, $this->strictTypes);
			} else {
				$newClass = $this->classOfNew($arg, $context);
				if ($newClass === null) {
					continue; // тип аргумента неизвестен — молчим
				}
				$ok = $this->classAllows($allowed, $newClass, $context, $selfClass, $callableNamespace, $callableUses);
				$actualName = $newClass;
			}
			if ($ok) {
				continue;
			}
			$message = sprintf('%s(): аргумент %d ожидает %s, передан %s.', $name, $index + 1, $expected, $actualName);
			if ($actual !== null && $this->strictTypes && $this->scalarAllows($allowed, $actual, $arg, false)) {
				$message .= ' Документ объявлен со strict_types=1 — приведение скалярных типов запрещено.';
			}
			$diagnostics[] = $this->warning(
				$document,
				$open + 1,
				$close,
				$message,
				'bitrix.php.argument-type',
				['kind' => 'argument-type', 'name' => $name],
			);
		}
		return $diagnostics;
	}

	/**
	 * Разбор строки типа в список имён (`?Foo`, `Foo|null`, `A&B`).
	 *
	 * @return array<int, string>
	 */
	private function typeList(string $expected): array
	{
		$result = [];
		foreach (preg_split('/[|&]/', $expected) ?: [] as $part) {
			$part = trim($part, " \t\n\r?() ");
			if ($part !== '') {
				$result[] = $part;
			}
		}
		return $result;
	}

	/**
	 * Скалярное соответствие: в coercive-режиме PHP приводит числовые строки,
	 * int/float и скаляры к string/bool; со strict_types — только точное совпадение.
	 *
	 * @param array<int, string> $allowed
	 */
	private function scalarAllows(array $allowed, string $actual, string $literal, bool $strict): bool
	{
		$allowed = array_map('strtolower', $allowed);
		if (in_array('mixed', $allowed, true) || in_array($actual, $allowed, true)) {
			return true;
		}
		// callable принимает и имя функции ('trim'), и [объект, метод] / [$this, 'x']
		if (in_array('callable', $allowed, true) && in_array($actual, ['string', 'array'], true)) {
			return true;
		}
		if ($actual === 'null' || $strict) {
			return false;
		}
		$raw = trim($literal);
		if (preg_match('/^([\'"]).*\1$/s', $raw) === 1 && strlen($raw) >= 2) {
			$raw = substr($raw, 1, -1); // строковый литерал: сравниваем содержимое
		}
		$numeric = is_numeric($raw);
		if (in_array('int', $allowed, true) && ($actual === 'bool' || $actual === 'float' || ($actual === 'string' && $numeric))) {
			return true;
		}
		if (in_array('float', $allowed, true) && ($actual === 'bool' || $actual === 'int' || ($actual === 'string' && $numeric))) {
			return true;
		}
		if (in_array('string', $allowed, true) && in_array($actual, ['int', 'float', 'bool'], true)) {
			return true;
		}
		if (in_array('bool', $allowed, true) && in_array($actual, ['int', 'float', 'string'], true)) {
			return true;
		}
		return false;
	}

	/** Класс из выражения `new Foo(...)` (с учётом use/namespace документа). */
	private function classOfNew(string $arg, PhpDocumentContext $context): ?string
	{
		if (preg_match('/^new\s+\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)\s*\(/', trim($arg), $match) !== 1) {
			return null;
		}
		foreach ($context->classCandidates($match[1]) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return null;
	}

	/**
	 * Подходит ли класс аргумента объявленному типу (сам класс, предок,
	 * интерфейс, `self`/`static`/`parent` относительно текущего класса).
	 */
	private function classAllows(
		array $allowed,
		string $actualClass,
		PhpDocumentContext $context,
		?string $selfClass,
		string $namespace = '',
		array $uses = [],
	): bool {
		foreach ($allowed as $type) {
			$lower = strtolower($type);
			if (in_array($lower, ['mixed', 'object', 'iterable', 'callable'], true)) {
				return true;
			}
			if (in_array($lower, ['int', 'float', 'string', 'bool', 'array', 'void', 'never', 'null', 'false', 'true'], true)) {
				continue;
			}
			if ($type === 'self' || $type === 'static' || $type === '$this' || $lower === 'self' || $lower === 'static' || $lower === '$this') {
				if ($selfClass === null || $this->repository->classIsA($actualClass, $selfClass)) {
					return true;
				}
				continue;
			}
			if ($lower === 'parent') {
				$row = $selfClass === null ? null : $this->repository->classByName($selfClass);
				$parent = $row === null ? null : $this->repository->parentClassName($row);
				if ($parent === null || $this->repository->classIsA($actualClass, $parent)) {
					return true;
				}
				continue;
			}
			$candidates = $this->expectedCandidates($type, $namespace, $uses);
			$resolved = false;
			foreach ($candidates as $candidate) {
				if ($this->repository->classByName($candidate) === null) {
					continue;
				}
				$resolved = true;
				if ($this->repository->classIsA($actualClass, $candidate)) {
					return true;
				}
			}
			if (!$resolved) {
				return true; // тип объявлен в неиндексированном коде — не проверяем
			}
		}
		return false;
	}

	/**
	 * Кандидаты FQCN для имени типа в контексте **объявляющего** файла:
	 * `use`-алиасы, namespace объявления, затем имя как есть.
	 *
	 * @param array<string, string> $uses
	 * @return array<int, string>
	 */
	private function expectedCandidates(string $type, string $namespace, array $uses): array
	{
		$clean = ltrim($type, '\\');
		$candidates = [];
		$resolved = PhpUseMap::resolve($clean, $uses);
		if ($resolved !== $clean) {
			$candidates[] = $resolved;
		}
		if (str_contains($clean, '\\')) {
			$candidates[] = $clean;
			if ($namespace !== '') {
				$candidates[] = $namespace . '\\' . $clean;
			}
		} else {
			if ($namespace !== '') {
				$candidates[] = $namespace . '\\' . $clean;
			}
			$candidates[] = $clean;
		}
		return array_values(array_unique($candidates));
	}

	/**
	 * Namespace и use-карта файла, где объявлен вызываемый символ.
	 *
	 * @param array<string, mixed> $callable
	 * @return array{0: string, 1: array<string, string>}
	 */
	private function declaringContext(array $callable): array
	{
		$namespace = (string) ($callable['namespace'] ?? '');
		$file = (string) ($callable['file'] ?? '');
		$class = (string) ($callable['class_fqcn'] ?? '');
		if ($class !== '') {
			$row = $this->repository->classByName($class);
			if ($row !== null) {
				$namespace = (string) ($row['namespace'] ?? $namespace);
				$file = (string) ($row['file'] ?? $file);
			}
		}
		return [$namespace, $this->usesOf($file)];
	}

	/** @return array<string, string> */
	private function usesOf(string $file): array
	{
		if ($file === '') {
			return [];
		}
		if (!isset($this->declaringUses[$file])) {
			$text = @file_get_contents($file);
			$this->declaringUses[$file] = is_string($text) ? PhpUseMap::parse($text) : [];
		}
		return $this->declaringUses[$file];
	}

	/**
	 * Проверка объявленного типа возврата: отсутствующий return, `return;`
	 * в не-void функции и литеральные несовпадения (включая union `array|false`).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function checkReturnTypes(TextDocument $document, string $masked, PhpDocumentContext $context): array
	{
		$diagnostics = [];
		$re = '/\bfunction\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/';
		if (preg_match_all($re, $masked, $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		foreach ($matches[0] as $index => $whole) {
			if (count($diagnostics) >= self::MAX) {
				break;
			}
			$name = $matches[1][$index][0];
			$open = $whole[1] + strpos($whole[0], '(');
			$close = $this->matchingParen($masked, $open);
			if ($close <= $open) {
				continue;
			}
			$rest = substr($masked, $close + 1);
			if (preg_match('/^\s*:\s*([^{;]+)/', $rest, $typeMatch) !== 1) {
				continue;
			}
			$typeText = trim($typeMatch[1]);
			$bodyOpen = $close + 1 + strlen($typeMatch[0]);
			while ($bodyOpen < strlen($masked) && ctype_space($masked[$bodyOpen])) {
				$bodyOpen++;
			}
			if (($masked[$bodyOpen] ?? '') !== '{') {
				continue; // abstract/interface — тела нет
			}
			$bodyClose = $this->matchingBrace($masked, $bodyOpen);
			if ($bodyClose <= $bodyOpen) {
				continue;
			}
			$body = $this->withoutNestedFunctions(substr($masked, $bodyOpen + 1, $bodyClose - $bodyOpen - 1));
			// maskCode вырезает строковые литералы, поэтому само выражение return
			// берём из исходного текста: смещения в маске и в тексте совпадают.
			$rawBody = substr($document->text, $bodyOpen + 1, $bodyClose - $bodyOpen - 1);
			$declared = str_replace(' ', '', $typeText);
			$parts = $this->typeList($declared);
			$lowerParts = array_map('strtolower', $parts);
			$nullable = str_starts_with($declared, '?') || in_array('null', $lowerParts, true);
			$isVoid = in_array('void', $lowerParts, true);
			$isNever = in_array('never', $lowerParts, true);
			$hasReturn = false;
			if (preg_match_all('/\breturn\b\s*([^;]*);/', $body, $returns, PREG_OFFSET_CAPTURE) > 0) {
				$hasReturn = true;
				foreach ($returns[0] as $returnIndex => $returnMatch) {
					$rawReturn = substr($rawBody, $returnMatch[1], strlen($returnMatch[0]));
					$valueStart = strpos($rawReturn, 'return');
					$value = trim(rtrim(substr($rawReturn, $valueStart === false ? 0 : $valueStart + 6), " \t;"));
					$offset = $bodyOpen + 1 + $returnMatch[1];
					if ($isNever) {
						$diagnostics[] = $this->warning(
							$document,
							$offset,
							$offset + 6,
							"Функция {$name}() объявлена как never и не должна возвращать управление.",
							'bitrix.php.return-type',
							['kind' => 'return-type', 'name' => $name],
						);
						continue;
					}
					if ($isVoid) {
						if ($value !== '') {
							$diagnostics[] = $this->warning(
								$document,
								$offset,
								$offset + strlen($returnMatch[0]),
								"Функция {$name}() объявлена как void и не должна возвращать значение.",
								'bitrix.php.return-type',
								['kind' => 'return-type', 'name' => $name],
							);
						}
						continue;
					}
					if ($value === '') {
						$diagnostics[] = $this->warning(
							$document,
							$offset,
							$offset + 6,
							"Функция {$name}() должна возвращать значение типа {$typeText}.",
							'bitrix.php.return-type',
							['kind' => 'return-type', 'name' => $name],
						);
						continue;
					}
					$actual = $this->literalType($value);
					$newClass = $actual === null ? $this->classOfNew($value, $context) : null;
					if ($actual === null && $newClass === null && trim($value) !== '$this') {
						continue;
					}
					$actualName = $newClass ?? $actual;
					if ($this->returnAllows($parts, $nullable, $value, $actual, $newClass, $context, $context->classAt($offset)['fqcn'] ?? null, $context->namespaceName(), $context->uses())) {
						continue;
					}
					$message = "Функция {$name}() объявляет возврат {$typeText}, а возвращает {$actualName}.";
					if ($actual !== null && $this->strictTypes && $this->scalarAllows($parts, $actual, $value, false)) {
						$message .= ' Документ объявлен со strict_types=1 — приведение скалярных типов запрещено.';
					}
					$diagnostics[] = $this->warning(
						$document,
						$offset,
						$offset + strlen($returnMatch[0]),
						$message,
						'bitrix.php.return-type',
						['kind' => 'return-type', 'name' => $name],
					);
				}
			}
			if ($hasReturn || $isVoid || $isNever) {
				continue;
			}
			if (preg_match('/\b(?:yield|throw|exit|die)\b/', $body) === 1) {
				continue;
			}
			$diagnostics[] = $this->warning(
				$document,
				$bodyOpen,
				$bodyOpen + 1,
				"Функция {$name}() объявляет возврат {$typeText}, но не содержит return.",
				'bitrix.php.return-type',
				['kind' => 'return-type', 'name' => $name],
			);
		}
		return $diagnostics;
	}

	/**
	 * @param array<int, string> $parts
	 */
	private function returnAllows(
		array $parts,
		bool $nullable,
		string $value,
		?string $actual,
		?string $newClass,
		PhpDocumentContext $context,
		?string $selfClass,
		string $namespace = '',
		array $uses = [],
	): bool {
		$lowerParts = array_map('strtolower', $parts);
		if (in_array('mixed', $lowerParts, true)) {
			return true;
		}
		if ($actual === 'null') {
			return $nullable;
		}
		if ($actual !== null) {
			$raw = strtolower(trim($value));
			if ($actual === 'bool') {
				if (in_array('bool', $lowerParts, true)) {
					return true;
				}
				if ($raw === 'false' && in_array('false', $lowerParts, true)) {
					return true;
				}
				if ($raw === 'true' && in_array('true', $lowerParts, true)) {
					return true;
				}
			}
			return $this->scalarAllows($parts, $actual, $value, $this->strictTypes);
		}
		if (trim($value) === '$this') {
			return in_array('static', $lowerParts, true) || in_array('self', $lowerParts, true);
		}
		if ($newClass !== null) {
			return $this->classAllows($parts, $newClass, $context, $selfClass, $namespace, $uses);
		}
		return true; // тип возврата не определили — не ругаемся
	}

	/** Маскирует вложенные `function (...) { ... }`, чтобы не читать их return. */
	private function withoutNestedFunctions(string $body): string
	{
		$out = $body;
		$offset = 0;
		while (preg_match('/\bfunction\b/', $out, $match, PREG_OFFSET_CAPTURE, $offset) === 1) {
			$start = $match[0][1];
			$brace = strpos($out, '{', $start);
			if ($brace === false) {
				break;
			}
			$close = $this->matchingBrace($out, $brace);
			if ($close <= $brace) {
				break;
			}
			$out = substr($out, 0, $start) . str_repeat(' ', $close - $start + 1) . substr($out, $close + 1);
			$offset = $close + 1;
		}
		return $out;
	}

	private function matchingBrace(string $text, int $open): int
	{
		$depth = 0;
		$length = strlen($text);
		for ($i = $open; $i < $length; $i++) {
			if ($text[$i] === '{') {
				$depth++;
			} elseif ($text[$i] === '}') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function undefinedVariables(TextDocument $document, string $masked): array
	{
		$declared = [];
		$assign = '/\\$([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\[[^\\]]*\\]\\s*)?(?:=|\\.=|\\+=|-=|\\*=|\\/=|\\?\\?=|%=)/';
		if (preg_match_all($assign, $masked, $matches) > 0) {
			foreach ($matches[1] as $name) {
				$declared[$name] = true;
			}
		}
		if (preg_match_all('/\bforeach\s*\(.*?\bas\b(.*?)\)/is', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		if (preg_match_all('/\bcatch\s*\(([^)]*)\)/i', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		if (preg_match_all('/\blist\s*\(([^)]*)\)/i', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		if (preg_match_all('/\buse\s*\(([^)]*)\)/i', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		if (preg_match_all('/\b(?:global|static)\b([^;]*);/i', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}

		if (preg_match_all('/\b(?:public|protected|private|var|readonly|static|final)\s+(?:[?\\\\A-Za-z0-9_|]+\s+)?\$([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/', $masked, $matches) > 0) {
			foreach ($matches[1] as $name) {
				$declared[$name] = true;
			}
		}
		if (preg_match_all('/\bfunction\s*[^()]*\(([^)]*)\)/i', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		// Переменные, переданные по ссылке: `preg_match(..., $matches)`,
		// `preg_split(..., $parts)` — они объявляются самим вызовом.
		if (preg_match_all('/(?<![>\w$:])(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)\s*\(/', $masked, $calls, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($calls[0] as $callIndex => $call) {
				$functionName = $calls[1][$callIndex][0];
				$function = $this->repository->findFunction($functionName);
				if ($function === null) {
					continue;
				}
				$functionParams = json_decode((string) ($function['params_json'] ?? '[]'), true);
				if (!is_array($functionParams) || $functionParams === []) {
					continue;
				}
				$open = $call[1] + strrpos($call[0], '(');
				$close = $this->matchingParen($masked, $open);
				if ($close <= $open) {
					continue;
				}
				foreach ($this->splitArguments($document->text, $open + 1, $close) as $argIndex => $argument) {
					$param = $functionParams[$argIndex] ?? null;
					if (!is_array($param) || empty($param['byRef'])) {
						continue;
					}
					if (preg_match('/^&?\s*\$([A-Za-z_][A-Za-z0-9_]*)$/', trim($argument), $match) === 1) {
						$declared[$match[1]] = true;
					}
				}
			}
		}

		$known = array_fill_keys([
			'this', 'GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION',
			'_REQUEST', '_ENV', 'APPLICATION', 'USER', 'DB', 'arParams', 'arResult', 'arCurrentValues',
			'component', 'templateFolder', 'componentPath', 'siteId', 'MESS', 'arTheme',
			'templateData', 'arElement', 'arSection', 'arItem', 'arFilter', 'arSelect', 'arOrder',
		], true);
		$diagnostics = [];
		$reported = [];
		if (preg_match_all('/\\$([A-Za-z_][A-Za-z0-9_]*)/', $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$name = $matches[1][$index][0];
				if (isset($known[$name]) || isset($declared[$name]) || isset($reported[$name])) {
					continue;
				}
				$before = substr($masked, max(0, $whole[1] - 2), 2);
				if ($before === '->' || $before === '::') {
					continue;
				}
				$reported[$name] = true;
				$diagnostics[] = $this->warning(
					$document,
					$whole[1],
					$whole[1] + strlen($name) + 1,
					"Переменная \${$name} используется, но не объявлена в этом файле.",
					'bitrix.php.undefined-variable',
					['kind' => 'undefined-variable', 'name' => $name],
				);
				if (count($diagnostics) >= self::MAX) {
					break;
				}
			}
		}
		return $diagnostics;
	}

	/**
	 * @return array<int, string>
	 */
	private function splitArguments(string $text, int $start, int $end): array
	{
		$args = [];
		$depth = 0;
		$last = $start;
		$quote = null;
		for ($i = $start; $i < $end; $i++) {
			$ch = $text[$i];
			// Запятые внутри строк не разделяют аргументы: `implode(', ', $a)`.
			if ($quote !== null) {
				if ($ch === '\\') {
					$i++;
					continue;
				}
				if ($ch === $quote) {
					$quote = null;
				}
				continue;
			}
			if ($ch === '"' || $ch === "'" || $ch === '`') {
				$quote = $ch;
				continue;
			}
			if ($ch === '(' || $ch === '[' || $ch === '{') {
				$depth++;
			} elseif ($ch === ')' || $ch === ']' || $ch === '}') {
				$depth--;
			} elseif ($ch === ',' && $depth === 0) {
				$args[] = trim(substr($text, $last, $i - $last));
				$last = $i + 1;
			}
		}
		$tail = trim(substr($text, $last, $end - $last));
		if ($tail !== '') {
			$args[] = $tail;
		}
		return $args;
	}

	private function literalType(string $arg): ?string
	{
		$arg = trim($arg);
		if (preg_match('/^([\'"]).*\\1$/s', $arg) === 1) {
			return 'string';
		}
		if (preg_match('/^-?\\d+$/', $arg) === 1) {
			return 'int';
		}
		if (preg_match('/^-?\\d+\\.\\d+$/', $arg) === 1) {
			return 'float';
		}
		if (preg_match('/^(true|false)$/i', $arg) === 1) {
			return 'bool';
		}
		if (strtolower($arg) === 'null') {
			return 'null';
		}
		if (str_starts_with($arg, '[') || preg_match('/^array\\s*\\(/', $arg) === 1) {
			return 'array';
		}
		return null;
	}

	private function matchingParen(string $text, int $open): int
	{
		$depth = 0;
		$length = strlen($text);
		for ($i = $open; $i < $length; $i++) {
			if ($text[$i] === '(') {
				$depth++;
			} elseif ($text[$i] === ')') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}

	/**
	 * @param array<string, mixed> $data
	 * @return array<string, mixed>
	 */
	private function warning(
		TextDocument $document,
		int $start,
		int $end,
		string $message,
		string $code,
		array $data,
	): array {
		return [
			'range' => $document->range($start, $end),
			'severity' => 2,
			'source' => 'bitrix',
			'code' => $code,
			'message' => $message,
			'data' => $data,
		];
	}
}
