<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\DocBlock;
use BitrixLsp\Support\HoverColor;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * Автодополнение PHP: FQCN, методы класса (`::`, `$this->`, `$var->`),
 * ключи `$arParams` компонента.
 */
final class PhpCompletionProvider
{
	/** Магические методы: объявление целиком по префиксу `__con`. */
	private const MAGIC_METHODS = [
		'__construct',
		'__destruct',
		'__call',
		'__callStatic',
		'__get',
		'__set',
		'__isset',
		'__unset',
		'__sleep',
		'__wakeup',
		'__serialize',
		'__unserialize',
		'__toString',
		'__invoke',
		'__set_state',
		'__clone',
		'__debugInfo',
	];
	public function __construct(
		private readonly Repository $repository,
		private readonly PhpTypeInference $inference,
	) {
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, int $offset): array
	{
		$from = max(0, $offset - 300);
		$before = substr($document->text, $from, $offset - $from);

		$declaration = $this->methodDeclarationItems($document, $offset, $before);
		if ($declaration !== []) {
			return $declaration;
		}

		if (preg_match('/\$arParams\[\s*[\'"]([A-Za-z0-9_]*)$/', $before, $matches) === 1) {
			return $this->paramItems($document, $offset, $matches[1]);
		}

		if (preg_match('/\$arResult\[\s*[\'"]([A-Za-z0-9_]*)$/', $before, $matches) === 1) {
			return $this->resultItems($document, $offset, $matches[1]);
		}

		// Легаси-форма `$GLOBALS['APPLICATION']->` — тип известен из таблицы глобалов.
		if (preg_match('/\$GLOBALS\s*\[\s*[\'"]([A-Za-z_][A-Za-z0-9_]*)[\'"]\s*\]\s*->\s*([A-Za-z_][A-Za-z0-9_]*)?$/', $before, $globalsMatch) === 1) {
			$globalClass = PhpDocumentContext::globalClass($globalsMatch[1]);
			if ($globalClass !== null) {
				return $this->memberItems($document, $offset, $globalClass, $globalsMatch[2] ?? '', true, false);
			}
		}

		if (preg_match('/\$([A-Za-z_][A-Za-z0-9_]*)->([A-Za-z_][A-Za-z0-9_]*)?$/', $before, $matches) === 1) {
			$context = PhpDocumentContext::create($document);
			return $this->methodsForVariable($document, $offset, $context, $matches[1], $matches[2] ?? '');
		}

		if (preg_match('/->\s*([A-Za-z_][A-Za-z0-9_]*)?$/', $before, $chainMatch) === 1) {
			$arrow = strrpos($before, '->');
			$expression = $arrow === false ? '' : $this->lastExpression(substr($before, 0, $arrow));
			if ($expression !== '' && (str_contains($expression, '(') || str_contains($expression, '->'))) {
				$context = PhpDocumentContext::create($document);
				$classes = $this->inference->expressionCandidatesFor($context, $expression, $offset);
				foreach ($classes as $class) {
					$items = $this->memberItems($document, $offset, $class, $chainMatch[1] ?? '', true, true);
					if ($items !== []) {
						return $items;
					}
				}
			}
		}

		if (preg_match('/([\\\\A-Za-z0-9_]+)::([A-Za-z_][A-Za-z0-9_]*)?$/', $before, $matches) === 1) {
			$context = PhpDocumentContext::create($document);
			return $this->methodsForClassName($document, $offset, $context, $matches[1], $matches[2] ?? '');
		}

		// Локальные переменные: `$`, `$it` — по тексту текущего документа,
		// без сохранения и без индекса (работает и для untitled, и для public).
		if (preg_match('/\$([A-Za-z_][A-Za-z0-9_]*)?$/', $before, $varMatch) === 1) {
			$prefix = $varMatch[0];
			$prior = substr($before, 0, strlen($before) - strlen($prefix));
			if (preg_match('/(?:->|::|\$)\s*$/', $prior) !== 1) {
				return $this->variableItems($document, $offset, $varMatch[1] ?? '');
			}
		}

		// Глобальные функции и константы: только в обычной позиции имени,
		// не после `->`, `::`, `\`, `$` и не в объявлении.
		if (preg_match('/(?<![$\\\\:>])([A-Za-z_][A-Za-z0-9_]*)$/', $before, $matches) === 1) {
			$prefix = $matches[1];
			$prior = rtrim(substr($before, 0, strlen($before) - strlen($prefix)));
			if (preg_match('/(?:->|::|\\$|\b(?:new|function|class|interface|trait|enum|use|namespace|extends|implements|const|public|protected|private|static))$/i', $prior) !== 1) {
				$items = $this->globalItems($document, $offset, $prefix);
				// `str_con_`: точных совпадений нет. Чтобы виджет не показывал
				// залипший старый список, отдаём ближайший валидный префикс,
				// растянув filterText и диапазон на весь введённый текст.
				if ($items === [] && str_contains($prefix, '_')) {
					$trimmed = rtrim($prefix, '_');
					if ($trimmed !== '' && $trimmed !== $prefix) {
						$fallback = $this->globalItems($document, $offset, $trimmed);
						$range = $document->range($offset - strlen($prefix), $offset);
						foreach ($fallback as &$fallbackItem) {
							$label = (string) ($fallbackItem['label'] ?? '');
							$fallbackItem['filterText'] = $prefix . substr($label, strlen($trimmed));
							$fallbackItem['textEdit'] = [
								'range' => $range,
								'newText' => $label . ((int) ($fallbackItem['kind'] ?? 0) === 3 ? '($0)' : ''),
							];
						}
						unset($fallbackItem);
						$items = $fallback;
					}
				}
				return $items;
			}
		}

		// Автодополнение классов перенесено в нативный VS Code-провайдер
		// (src/features/phpClassCompletion.ts): он умеет вставлять `use`
		// и не конфликтует с определением слова в PHP (обратный слэш).
		return [];
	}

	/**
	 * Объявление магического метода в теле класса: `__con` → полная конструкция.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function methodDeclarationItems(TextDocument $document, int $offset, string $before): array
	{
		if (preg_match('/(?<![\w$>:\\\\])(__[A-Za-z0-9_]*)$/', $before, $matches) !== 1) {
			return [];
		}
		$prefix = $matches[1];
		$context = PhpDocumentContext::create($document);
		if ($context->classAt($offset) === null || $context->isInMethodBody($offset)) {
			return [];
		}
		// `function __con` — `function` уже набран, второй раз его не пишем.
		$prior = substr($before, 0, strlen($before) - strlen($prefix));
		$afterFunction = preg_match('/\bfunction\s+$/', $prior) === 1;
		$visibility = $afterFunction ? '' : 'public function ';
		$range = $document->range($offset - strlen($prefix), $offset);
		$items = [];
		foreach (self::MAGIC_METHODS as $name) {
			if (stripos($name, $prefix) !== 0) {
				continue;
			}
			$items[] = [
				'label' => $name,
				'kind' => 2,
				'detail' => 'объявление',
				'labelDetails' => ['detail' => '()'],
				'filterText' => $name,
				'sortText' => '0_' . strtolower($name),
				'textEdit' => [
					'range' => $range,
					'newText' => $visibility . $name . '($0)' . "\n{\n}",
				],
				'insertTextFormat' => 2,
				'documentation' => self::documentation(
					$visibility . $name . '()',
					'Магический метод: объявление с телом.',
					[],
				),
			];
		}
		return $items;
	}

	/** Часть сигнатуры для серой подписи в списке: `(params): return`. */
	private static function signatureDetail(string $signature): string
	{
		$open = strpos($signature, '(');
		return $open === false ? '' : trim(substr($signature, $open));
	}

	/** Короткое значение константы для подписи в списке. */
	private static function shortValue(string $value, int $limit = 38): string
	{
		$value = trim(preg_replace('/\s+/', ' ', $value) ?? '');
		if ($value === '') {
			return '';
		}
		$length = function_exists('mb_strlen') ? mb_strlen($value) : strlen($value);
		if ($length <= $limit) {
			return $value;
		}
		$cut = function_exists('mb_substr') ? mb_substr($value, 0, $limit - 1) : substr($value, 0, $limit - 1);
		return $cut . '…';
	}

	/** Модуль по пути файла: `/bitrix/modules/main/...` → `main`. */
	private static function moduleOf(?string $file): string
	{
		if ($file !== null && preg_match('#/modules/([A-Za-z0-9_.]+)/#', $file, $match) === 1) {
			return $match[1];
		}
		return 'bitrix';
	}

	/**
	 * Единая карточка подсказки: сигнатура, описание, происхождение, файл.
	 *
	 * @param array<string, string> $meta
	 * @return array{kind: string, value: string}
	 */
	private static function documentation(
		string $code,
		string $description,
		array $meta,
		?string $file = null,
		?int $line = null,
		bool $deprecated = false,
		?string $deprecatedNote = null,
		?string $paramsBlock = null,
	): array {
		$chunks = [HoverColor::signature($code)];
		if ($description !== '') {
			$chunks[] = $description;
		}
		if ($paramsBlock !== null && $paramsBlock !== '') {
			$chunks[] = $paramsBlock;
		}
		if ($deprecated) {
			$note = $deprecatedNote !== null && $deprecatedNote !== '' ? ' ' . $deprecatedNote : ' не используйте в новом коде.';
			$chunks[] = '**Устарело:**' . $note;
		}
		$metaLine = [];
		foreach ($meta as $label => $value) {
			if ($value !== '') {
				$metaLine[] = '**' . $label . ':** `' . $value . '`';
			}
		}
		if ($metaLine !== []) {
			$chunks[] = implode(' · ', $metaLine);
		}
		if ($file !== null && $file !== '') {
			$chunks[] = HoverColor::sourceLine($file, $line);
		}
		return ['kind' => 'markdown', 'value' => implode("\n\n", $chunks)];
	}

	private function lastExpression(string $text): string
	{
		$text = rtrim($text);
		$length = strlen($text);
		$depth = 0;
		$start = $length;
		$isChar = static function (string $char): bool {
			return $char === '\\' || $char === '$' || $char === '_' || $char === '>' || $char === '<' || $char === ':' || $char === '-'
				|| ($char >= 'A' && $char <= 'Z') || ($char >= 'a' && $char <= 'z')
				|| ($char >= '0' && $char <= '9');
		};
		for ($i = $length - 1; $i >= 0; $i--) {
			$char = $text[$i];
			if ($char === ')') {
				$depth++;
				$start = $i;
				continue;
			}
			if ($char === '(') {
				$depth--;
				$start = $i;
				continue;
			}
			if ($depth > 0) {
				$start = $i;
				continue;
			}
			if ($isChar($char)) {
				$start = $i;
				continue;
			}
			break;
		}
		return trim(substr($text, $start));
	}

	/**
	 * Глобальные функции и константы по префиксу.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function globalItems(TextDocument $document, int $offset, string $prefix): array
	{
		$range = $document->range($offset - strlen($prefix), $offset);
		$items = [];
		foreach ($this->repository->functionsByPrefix($prefix, 30) as $function) {
			$name = (string) $function['name'];
			$docInfo = DocBlock::parse((string) ($function['doc'] ?? ''));
			$signature = (string) ($function['signature'] ?? ($name . '()'));
			$module = self::moduleOf(isset($function['file']) ? (string) $function['file'] : null);
			$items[] = [
				'label' => $name,
				'kind' => 3,
				'detail' => $module,
				'labelDetails' => ['detail' => self::signatureDetail($signature)],
				'filterText' => $name,
				'sortText' => '3_' . strtolower($name),
				'textEdit' => ['range' => $range, 'newText' => $name . '($0)'],
				'insertTextFormat' => 2,
				'documentation' => self::documentation(
					'function ' . $signature,
					$docInfo['description'],
					['Модуль' => $module],
					$function['file'] ?? null,
					isset($function['line']) ? (int) $function['line'] : null,
					false,
					null,
					DocBlock::renderParams(
						(array) (json_decode((string) ($function['params_json'] ?? '[]'), true) ?: []),
						$docInfo['params'],
						$docInfo['paramTypes'] ?? [],
					),
				),
			];
		}
		foreach ($this->repository->globalConstantsByPrefix($prefix, 20) as $constant) {
			$name = (string) $constant['name'];
			$value = trim((string) ($constant['value'] ?? ''));
			$docInfo = DocBlock::parse((string) ($constant['doc'] ?? ''));
			$module = self::moduleOf(isset($constant['file']) ? (string) $constant['file'] : null);
			$items[] = [
				'label' => $name,
				'kind' => 21,
				'detail' => $module,
				'labelDetails' => ['detail' => $value !== '' ? '= ' . self::shortValue($value, 24) : ''],
				'filterText' => $name,
				'sortText' => '4_' . strtolower($name),
				'textEdit' => ['range' => $range, 'newText' => $name],
				'documentation' => self::documentation(
					'const ' . $name . ($value !== '' ? ' = ' . self::shortValue($value, 120) : ''),
					$docInfo['description'],
					['Модуль' => $module],
					$constant['file'] ?? null,
					isset($constant['line']) ? (int) $constant['line'] : null,
				),
			];
		}
		return $items;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function methodsForVariable(
		TextDocument $document,
		int $offset,
		PhpDocumentContext $context,
		string $variable,
		string $partial,
	): array {
		foreach ($this->inference->variableCandidates($context, '$' . $variable, $offset) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $this->memberItems(
					$document,
					$offset,
					$candidate,
					$partial,
					true,
					false,
					strtolower($variable) === 'this',
				);
			}
		}
		return [];
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function methodsForClassName(
		TextDocument $document,
		int $offset,
		PhpDocumentContext $context,
		string $name,
		string $partial,
	): array {
		$lower = strtolower($name);
		if ($lower === 'self' || $lower === 'static' || $lower === 'parent') {
			$class = $context->classAt($offset);
			if ($class === null) {
				return [];
			}
			$fqcn = $class['fqcn'];
			if ($lower === 'parent') {
				$row = $this->repository->classByName($fqcn);
				$parent = $row !== null ? $this->repository->parentClassName($row) : null;
				if ($parent === null) {
					return [];
				}
				$fqcn = $parent;
			}
			return $this->memberItems(
				$document,
				$offset,
				$fqcn,
				$partial,
				false,
				true,
				strcasecmp(ltrim($context->classAt($offset)['fqcn'] ?? '', '\\'), ltrim($fqcn, '\\')) === 0,
			);
		}
		foreach ($context->classCandidates($name) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $this->memberItems(
					$document,
					$offset,
					$candidate,
					$partial,
					false,
					true,
					strcasecmp(ltrim($context->classAt($offset)['fqcn'] ?? '', '\\'), ltrim($candidate, '\\')) === 0,
				);
			}
		}
		return [];
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function memberItems(
		TextDocument $document,
		int $offset,
		string $class,
		string $partial,
		bool $includeProperties,
		bool $includeConstants,
		bool $fromInside = false,
	): array {
		$range = $document->range($offset - strlen($partial), $offset);
		$items = [];
		$seen = [];
		// Фильтрацию по введённому префиксу делает VS Code (filterText): если
		// отфильтровать на сервере и не останется совпадений, редактор добавит
		// «слова» из всех открытых файлов — в большом проекте это сотни чужих имён.
		$matches = static fn (string $name): bool => true;
		// Порядок: свои члены класса (0) → унаследованные (1) → магические (2),
		// внутри каждой группы — по алфавиту.
		$owner = ltrim($class, '\\');
		$sortGroup = static function (string $name, string $declaredIn) use ($owner): string {
			if (str_starts_with($name, '__')) {
				return '2';
			}
			return strcasecmp(ltrim($declaredIn, '\\'), $owner) === 0 ? '0' : '1';
		};

		foreach ($this->repository->methodsForClassWithParents($class) as $method) {
			$name = (string) $method['name'];
			if (!$matches($name)) {
				continue;
			}
			// Магические методы (`__construct` и т.п.) не предлагаем после `->`/`::`:
			// вызвать их явно нельзя, а в списке они путают.
			if (str_starts_with($name, '__')) {
				continue;
			}
			if (!$fromInside && (string) ($method['visibility'] ?? 'public') !== 'public') {
				continue;
			}
			$declaredIn = ltrim((string) ($method['class_fqcn'] ?? $class), '\\');
			$signature = (string) ($method['signature'] ?? ($name . '()'));
			$isStatic = (int) ($method['is_static'] ?? 0) === 1;
			$isDeprecated = (int) ($method['deprecated'] ?? 0) === 1;
			$docInfo = DocBlock::parse((string) ($method['doc'] ?? ''));
			$item = [
				'label' => $name,
				'kind' => 2,
				'detail' => $declaredIn,
				'labelDetails' => ['detail' => self::signatureDetail($signature)],
				'filterText' => $name,
				'sortText' => $sortGroup($name, $declaredIn) . '_' . strtolower($name),
				'textEdit' => ['range' => $range, 'newText' => $name . '($0)'],
				'insertTextFormat' => 2,
				'documentation' => self::documentation(
					((string) ($method['visibility'] ?? 'public')) . ' ' . ($isStatic ? 'static ' : '') . 'function ' . $signature,
					$docInfo['description'],
					['Класс' => $declaredIn],
					$method['file'] ?? null,
					isset($method['line']) ? (int) $method['line'] : null,
					$isDeprecated,
					null,
					DocBlock::renderParams(
						(array) (json_decode((string) ($method['params_json'] ?? '[]'), true) ?: []),
						$docInfo['params'],
						$docInfo['paramTypes'] ?? [],
					),
				),
			];
			if ($isDeprecated) {
				$item['tags'] = [1];
			}
			$items[] = $item;
			$seen[$name] = true;
		}

		if ($includeProperties) {
			foreach ($this->repository->propertiesForClassWithParents($class) as $property) {
				$name = (string) $property['name'];
				if (!$matches($name) || isset($seen[$name])) {
					continue;
				}
				if (!$fromInside && (string) ($property['visibility'] ?? 'public') !== 'public') {
					continue;
				}
				$declaredIn = ltrim((string) ($property['class_fqcn'] ?? $class), '\\');
				$type = trim((string) ($property['type'] ?? ''));
				$isStatic = (int) ($property['is_static'] ?? 0) === 1;
				$docInfo = DocBlock::parse((string) ($property['doc'] ?? ''));
				$items[] = [
					'label' => $name,
					'kind' => 10,
					'detail' => $declaredIn,
					'labelDetails' => ['detail' => $type !== '' ? ': ' . $type : ''],
					'filterText' => $name,
					'sortText' => $sortGroup($name, $declaredIn) . '_' . strtolower($name),
					'textEdit' => ['range' => $range, 'newText' => $name],
					'documentation' => self::documentation(
						((string) ($property['visibility'] ?? 'public')) . ' ' . ($isStatic ? 'static ' : '')
							. ($type !== '' ? $type . ' ' : '') . '$' . $name,
						$docInfo['description'],
						['Класс' => $declaredIn],
						$property['file'] ?? null,
						isset($property['line']) ? (int) $property['line'] : null,
					),
				];
				$seen[$name] = true;
			}
		}

		if ($includeConstants) {
			foreach ($this->repository->constantsForClassWithParents($class) as $constant) {
				$name = (string) $constant['name'];
				if (!$matches($name) || isset($seen[$name])) {
					continue;
				}
				$declaredIn = ltrim((string) ($constant['class_fqcn'] ?? $class), '\\');
				$value = trim((string) ($constant['value'] ?? ''));
				$docInfo = DocBlock::parse((string) ($constant['doc'] ?? ''));
				$items[] = [
					'label' => $name,
					'kind' => 21,
					'detail' => $declaredIn,
					'labelDetails' => ['detail' => $value !== '' ? '= ' . self::shortValue($value, 24) : ''],
					'filterText' => $name,
					'sortText' => $sortGroup($name, $declaredIn) . '_' . strtolower($name),
					'textEdit' => ['range' => $range, 'newText' => $name],
					'documentation' => self::documentation(
						'const ' . $name . ($value !== '' ? ' = ' . self::shortValue($value, 120) : ''),
						$docInfo['description'],
						['Класс' => $declaredIn],
						$constant['file'] ?? null,
						isset($constant['line']) ? (int) $constant['line'] : null,
					),
				];
				$seen[$name] = true;
			}
		}

		return $items;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function classItems(TextDocument $document, int $offset, string $token): array
	{
		$prefix = ltrim($token, '\\');
		$rows = $this->repository->classesByPrefix($prefix, 50);
		if ($rows === []) {
			return [];
		}
		$items = [];
		foreach ($rows as $row) {
			$fqcn = (string) $row['fqcn'];
			$documentation = null;
			if (!empty($row['doc'])) {
				$documentation = ['kind' => 'markdown', 'value' => (string) $row['doc']];
			}
			$item = [
				'label' => (string) $row['name'],
				'kind' => 7,
				'detail' => $fqcn,
				'filterText' => $fqcn,
				'sortText' => $fqcn,
				// Заменяем только текущее слово (`CF`), не трогая `\` перед ним:
				// иначе VS Code может отбросить textEdit, пересекающий разделитель.
				'insertText' => $fqcn,
			];
			if ($documentation !== null) {
				$item['documentation'] = $documentation;
			}
			$items[] = $item;
		}
		return $items;
	}

	/**
	 * Автодополнение классов по короткому имени: `CFile`, `CMain` и т.п.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function classItemsByShortName(TextDocument $document, int $offset, string $token): array
	{
		$rows = $this->repository->classesByShortNamePrefix($token, 50);
		if ($rows === []) {
			return [];
		}
		$items = [];
		foreach ($rows as $row) {
			$fqcn = (string) $row['fqcn'];
			$item = [
				'label' => (string) $row['name'],
				'kind' => 7,
				'detail' => $fqcn,
				'filterText' => $fqcn,
				'sortText' => $fqcn,
				'insertText' => (string) $row['name'],
			];
			if (!empty($row['doc'])) {
				$item['documentation'] = ['kind' => 'markdown', 'value' => (string) $row['doc']];
			}
			$items[] = $item;
		}
		return $items;
	}

	/**
	 * Локальные переменные документа: все `$name` в PHP-коде плюс superglobal.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function variableItems(TextDocument $document, int $offset, string $prefix): array
	{
		$code = PhpSource::phpOnly($document->text);
		$names = [];
		$scope = $this->functionScopeAt($code, $offset);
		if ($scope !== null) {
			$body = substr($code, $scope['open'] + 1, $scope['close'] - $scope['open'] - 1);
			$this->collectVariables($body, $names);
			foreach ($scope['params'] as $name) {
				$names[$name] = true;
			}
		} else {
			$this->collectVariables($this->withoutFunctionBodies($code), $names);
		}
		$context = PhpDocumentContext::create($document);
		if ($context->classAt($offset) !== null) {
			$names['this'] = true;
		}
		$superglobals = [
			'GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION',
			'_REQUEST', '_ENV', 'APPLICATION', 'USER', 'DB', 'arParams', 'arResult',
		];
		foreach ($superglobals as $name) {
			$names[$name] = true;
		}
		$range = $document->range($offset - strlen($prefix) - 1, $offset);
		$items = [];
		foreach (array_keys($names) as $name) {
			if ($prefix !== '' && stripos($name, $prefix) !== 0) {
				continue;
			}
			$isSuper = in_array($name, $superglobals, true);
			$items[] = [
				'label' => '$' . $name,
				'kind' => 6,
				'detail' => $isSuper ? 'superglobal variable' : 'local variable',
				'filterText' => '$' . $name,
				'sortText' => strtolower($name),
				'textEdit' => ['range' => $range, 'newText' => '$' . $name],
			];
		}
		usort($items, static fn (array $a, array $b): int => strcmp((string) $a['sortText'], (string) $b['sortText']));
		return $items;
	}

	/**
	 * @param array<string, bool> $names
	 */
	private function collectVariables(string $code, array &$names): void
	{
		if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $code, $matches) > 0) {
			foreach ($matches[1] as $name) {
				$names[$name] = true;
			}
		}
	}

	/**
	 * Ближайшая функция/метод, внутри тела которой находится offset.
	 *
	 * @return array{open: int, close: int, params: array<int, string>}|null
	 */
	private function functionScopeAt(string $code, int $offset): ?array
	{
		$best = null;
		if (preg_match_all('/\bfunction\s+&?\s*[A-Za-z_$]?[\w$]*\s*\(/', $code, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		foreach ($matches[0] as $match) {
			$openParen = $match[1] + strpos($match[0], '(');
			$closeParen = $this->matchingDelimiter($code, $openParen, '(', ')');
			if ($closeParen <= $openParen) {
				continue;
			}
			$bodyOpen = $closeParen + 1;
			while ($bodyOpen < strlen($code) && ctype_space($code[$bodyOpen])) {
				$bodyOpen++;
			}
			if (($code[$bodyOpen] ?? '') !== '{') {
				continue;
			}
			$bodyClose = $this->matchingDelimiter($code, $bodyOpen, '{', '}');
			if ($offset <= $bodyOpen || $offset >= $bodyClose) {
				continue;
			}
			$params = [];
			if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', substr($code, $openParen + 1, $closeParen - $openParen - 1), $paramMatches) > 0) {
				$params = $paramMatches[1];
			}
			$span = $bodyClose - $bodyOpen;
			if ($best === null || $span < $best['close'] - $best['open']) {
				$best = ['open' => $bodyOpen, 'close' => $bodyClose, 'params' => $params];
			}
		}
		return $best;
	}

	/** Маскирует тела всех функций, оставляя код верхнего уровня. */
	private function withoutFunctionBodies(string $code): string
	{
		$out = $code;
		$offset = 0;
		while (preg_match('/\bfunction\s+&?\s*[A-Za-z_$]?[\w$]*\s*\(/', $out, $match, PREG_OFFSET_CAPTURE, $offset) === 1) {
			$openParen = $match[0][1] + strpos($match[0][0], '(');
			$closeParen = $this->matchingDelimiter($out, $openParen, '(', ')');
			if ($closeParen <= $openParen) {
				break;
			}
			$bodyOpen = $closeParen + 1;
			while ($bodyOpen < strlen($out) && ctype_space($out[$bodyOpen])) {
				$bodyOpen++;
			}
			if (($out[$bodyOpen] ?? '') !== '{') {
				$offset = $closeParen + 1;
				continue;
			}
			$bodyClose = $this->matchingDelimiter($out, $bodyOpen, '{', '}');
			if ($bodyClose <= $bodyOpen) {
				break;
			}
			$out = substr($out, 0, $bodyOpen) . str_repeat(' ', $bodyClose - $bodyOpen + 1) . substr($out, $bodyClose + 1);
			$offset = $bodyClose + 1;
		}
		return $out;
	}

	private function matchingDelimiter(string $code, int $open, string $openChar, string $closeChar): int
	{
		$depth = 0;
		$length = strlen($code);
		for ($i = $open; $i < $length; $i++) {
			if ($code[$i] === $openChar) {
				$depth++;
			} elseif ($code[$i] === $closeChar) {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}

	/**
	 * Ключи `$arResult['...']`, найденные в class.php компонента.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function resultItems(TextDocument $document, int $offset, string $prefix): array
	{
		$path = Paths::uriToPath($document->uri);
		if ($path === null) {
			return [];
		}
		$component = $this->repository->componentForFile($path);
		if ($component === null) {
			return [];
		}
		$range = $document->range($offset - strlen($prefix), $offset);
		$items = [];
		foreach ($this->repository->resultKeysForComponent($component) as $name) {
			if ($prefix !== '' && stripos($name, $prefix) !== 0) {
				continue;
			}
			$items[] = [
				'label' => $name,
				'kind' => 10,
				'detail' => '$arResult[\'' . $name . '\']',
				'filterText' => $name,
				'sortText' => strtolower($name),
				'textEdit' => ['range' => $range, 'newText' => $name],
				'documentation' => [
					'kind' => 'markdown',
					'value' => "Ключ результата компонента `{$component['name']}`",
				],
			];
		}
		return $items;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function paramItems(TextDocument $document, int $offset, string $prefix): array
	{
		$path = Paths::uriToPath($document->uri);
		if ($path === null) {
			return [];
		}
		$component = $this->repository->componentForFile($path);
		if ($component === null) {
			return [];
		}
		$items = [];
		foreach ($this->repository->paramsForComponent((string) $component['name']) as $param) {
			$name = (string) $param['name'];
			if ($prefix !== '' && strncasecmp($name, $prefix, strlen($prefix)) !== 0) {
				continue;
			}
			$detail = trim(
				(string) ($param['type'] ?? '')
				. (($param['default_value'] !== null && $param['default_value'] !== '')
					? ' = ' . $param['default_value']
					: ''),
			);
			$items[] = [
				'label' => $name,
				'kind' => 10,
				'detail' => $detail === '' ? 'параметр компонента' : $detail,
				'documentation' => ['kind' => 'markdown', 'value' => "Параметр компонента `{$component['name']}`"],
				'filterText' => $name,
				'sortText' => $name,
			];
		}
		return array_slice($items, 0, 100);
	}
}
