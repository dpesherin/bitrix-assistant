<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\TextDocument;

/**
 * Автодополнение `BX.` и `BX.Main.` по индексу глобальных объектов.
 * `BX.` → следующий сегмент, `BX.Main.` → члены main.*.
 */
final class JsCompletionProvider
{
	private const KIND = [
		'method' => 2,
		'function' => 3,
		'property' => 10,
		'object' => 9,
		'namespace' => 9,
		'class' => 7,
		'export' => 3,
	];

	private readonly JsTypeInference $types;

	public function __construct(
		private readonly Repository $repository,
		private readonly JsModuleResolver $modules = new JsModuleResolver(),
	) {
		$this->types = new JsTypeInference($modules, $repository);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, int $offset): array
	{
		$from = max(0, $offset - 300);
		$before = substr($document->text, $from, $offset - $from);
		if (preg_match('/(?:\bnew\s+)?(BX(?:\.[A-Za-z_$][\w$]*)+)\s*\(\s*\{([^{}]*)$/', $before, $callMatch) === 1) {
			$items = $this->objectKeyItems($document, $offset, $callMatch[1], $callMatch[2]);
			if ($items !== []) {
				return $items;
			}
		}
		if (preg_match('/\bnew\s+([A-Za-z_$][\w$]*)?$/', $before, $newMatch) === 1) {
			$items = $this->importItems($document, $offset, $newMatch[1] ?? '');
			if ($items !== []) {
				return $items;
			}
		}
		if (preg_match('/\bnew\s+\\\\?([A-Za-z_$][\w$\\\\]*)\s*\([^()]*\)\s*\.\s*([A-Za-z_$][\w$]*)?$/', $before, $directMatch) === 1) {
			$class = $directMatch[1];
			$resolved = $this->modules->resolve($document, $class);
			$class = $resolved !== null ? (string) $resolved['name'] : $class;
			$items = $this->indexedMemberItems($document, $offset, $class, $directMatch[2] ?? '');
			if ($items !== []) {
				return $items;
			}
		}
		if (
			preg_match('/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)?$/', $before, $memberMatch) === 1 &&
			$memberMatch[1] !== 'this' &&
			!str_starts_with($memberMatch[1], 'BX')
		) {
			$items = $this->moduleMemberItems($document, $offset, $memberMatch[1], $memberMatch[2] ?? '');
			if ($items !== []) {
				return $items;
			}
			$class = $this->types->classForVariable($document, $memberMatch[1], $offset);
			if ($class !== null) {
				$items = $this->indexedMemberItems($document, $offset, $class, $memberMatch[2] ?? '');
				if ($items !== []) {
					return $items;
				}
			}
		}
		if (preg_match('/(?<![\w$.])([A-Za-z_$][\w$]*)?$/', $before, $localMatch) === 1) {
			$prior = substr($before, 0, strlen($before) - strlen($localMatch[0]));
			if (preg_match('/(?:^|[^\w$])(?:new|import|from|class|function)\s*$/', $prior) !== 1) {
				$items = $this->localItems($document, $offset, $localMatch[1] ?? '');
				if ($items !== []) {
					return $items;
				}
			}
		}
		$isNew = false;
		$container = null;
		$partial = '';
		if (preg_match('/\bthis\.([A-Za-z_$][\w$]*)?$/', $before, $matches) === 1) {
			$context = JsDocumentContext::create($document);
			$base = $context->baseAt($offset);
			if ($base !== null) {
				$container = $base . '.';
				$partial = $matches[1] ?? '';
			}
		}
		if ($container === null) {
			if (preg_match('/(?:\bnew\s+)BX((?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)?$/', $before, $matches) === 1) {
				$isNew = true;
			} elseif (preg_match('/\bBX((?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)?$/', $before, $matches) !== 1) {
				return [];
			}
			$container = 'BX' . ($matches[1] ?? '') . '.';
			$partial = $matches[2] ?? '';
		}
		$rows = $this->repository->childSegments($container, 2000, $partial);
		if ($rows === []) {
			return [];
		}
		$extensions = [];
		foreach ($this->repository->allExtensions() as $extension) {
			$extensions[(string) $extension['name']] = $extension;
		}

		$start = $offset - strlen($partial);
		$range = $document->range($start, $offset);
		$items = [];
		foreach ($rows as $row) {
			$segment = (string) ($row['segment'] ?? '');
			if ($segment === '') {
				continue;
			}
			$name = $container . $segment;
			$type = (string) ($row['type'] ?? 'property');
			$extensionName = $row['extension_name'] ?? null;
			$documentation = '';
			$signature = trim((string) ($row['signature'] ?? ''));
			if ($signature !== '') {
				$prefix = substr($name, 0, (int) strrpos($name, '.') + 1);
				$documentation .= "```ts\n{$prefix}{$signature}\n```\n";
			}
			$doc = trim((string) ($row['doc'] ?? ''));
			if ($doc !== '') {
				$documentation .= "\n" . mb_substr($doc, 0, 600) . "\n";
			}
			$returnType = trim((string) ($row['return_type'] ?? ''));
			if ($returnType !== '') {
				$documentation .= "\n**Возвращает:** `{$returnType}`\n";
			}
			if (is_string($extensionName) && $extensionName !== '' && isset($extensions[$extensionName])) {
				$extension = $extensions[$extensionName];
				$rel = json_decode((string) ($extension['rel_json'] ?? '[]'), true);
				$documentation .= "\n**Расширение:** `{$extensionName}`\n";
				if (!empty($extension['config_path'])) {
					$documentation .= "**Конфигурация:** `{$extension['config_path']}`\n";
				}
				if (is_array($rel) && $rel !== []) {
					$documentation .= "**Зависимости (rel):** " . implode(', ', $rel) . "\n";
				}
			}
						$item = [
				'label' => $segment,
				'kind' => $isNew ? 7 : (self::KIND[$type] ?? 10),
				'detail' => $isNew ? ('new ' . $name) : ($name . ' — ' . $type),
				'filterText' => $segment,
				'sortText' => strtolower($segment),
				'textEdit' => ['range' => $range, 'newText' => $segment],
			];
			if (trim($documentation) !== '') {
				$item['documentation'] = ['kind' => 'markdown', 'value' => trim($documentation)];
			}
			$items[] = $item;
		}
		usort($items, static fn (array $a, array $b): int => strcmp((string) $a['sortText'], (string) $b['sortText']));
		return $items;
	}


	/**
	 * Локальные переменные документа: `const/let/var`, параметры, catch,
	 * импорты. Работает по тексту, без сохранения и индекса.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function localItems(TextDocument $document, int $offset, string $prefix): array
	{
		$masked = JsScanner::maskCode($document->text, true);
		$names = [];
		$scope = $this->jsScopeAt($masked, $offset);
		if ($scope !== null) {
			$body = substr($masked, $scope['open'] + 1, $scope['close'] - $scope['open'] - 1);
			$this->collectJsDeclarations($this->withoutJsBodies($body), $names);
			foreach ($scope['params'] as $name) {
				$names[$name] = true;
			}
		} else {
			$this->collectJsDeclarations($this->withoutJsBodies($masked), $names);
		}
		foreach ($this->modules->imports($document->text) as $import) {
			$names[$import['local']] = true;
		}
		unset($names['this']);
		$range = $document->range($offset - strlen($prefix), $offset);
		$items = [];
		foreach (array_keys($names) as $name) {
			if ($prefix !== '' && stripos($name, $prefix) !== 0) {
				continue;
			}
			$items[] = [
				'label' => $name,
				'kind' => 6,
				'detail' => 'local variable',
				'filterText' => $name,
				'sortText' => '0_' . strtolower($name),
				'textEdit' => ['range' => $range, 'newText' => $name],
			];
		}
		usort($items, static fn (array $a, array $b): int => strcmp((string) $a['sortText'], (string) $b['sortText']));
		return $items;
	}

	/**
	 * @param array<string, bool> $names
	 */
	private function collectJsDeclarations(string $code, array &$names): void
	{
		if (preg_match_all('/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/', $code, $matches) > 0) {
			foreach ($matches[1] as $name) {
				$names[$name] = true;
			}
		}
		if (preg_match_all('/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/', $code, $matches) > 0) {
			foreach ($matches[1] as $name) {
				$names[$name] = true;
			}
		}
	}

	/**
	 * Ближайшая функция/метод/стрелка, внутри тела которой offset.
	 *
	 * @return array{open: int, close: int, params: array<int, string>}|null
	 */
	private function jsScopeAt(string $code, int $offset): ?array
	{
		$best = null;
		foreach ($this->jsBodyCandidates($code) as $candidate) {
			if ($offset <= $candidate['open'] || $offset >= $candidate['close']) {
				continue;
			}
			$span = $candidate['close'] - $candidate['open'];
			if ($best === null || $span < $best['close'] - $best['open']) {
				$best = $candidate;
			}
		}
		return $best;
	}

	/**
	 * @return array<int, array{open: int, close: int, params: array<int, string>}>
	 */
	private function jsBodyCandidates(string $code): array
	{
		$candidates = [];
		$keywords = array_fill_keys([
			'if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'do', 'else',
		], true);
		$patterns = [
			'/\bfunction\s*[A-Za-z_$]?[\w$]*\s*\(([^)]*)\)\s*\{/',
			'/(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{/',
			'/(?:^|[;{}])\s*(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/',
		];
		foreach ($patterns as $index => $pattern) {
			if (preg_match_all($pattern, $code, $matches, PREG_OFFSET_CAPTURE) === false) {
				continue;
			}
			foreach ($matches[0] as $matchIndex => $whole) {
				$open = $whole[1] + strrpos($whole[0], '{');
				if ($open < 0) {
					continue;
				}
				if ($index === 2) {
					$name = $matches[1][$matchIndex][0] ?? '';
					if (isset($keywords[$name])) {
						continue;
					}
					$paramText = $matches[2][$matchIndex][0] ?? '';
				} elseif ($index === 1) {
					$paramText = ($matches[1][$matchIndex][0] ?? '') !== ''
						? $matches[1][$matchIndex][0]
						: ($matches[2][$matchIndex][0] ?? '');
				} else {
					$paramText = $matches[1][$matchIndex][0] ?? '';
				}
				$params = [];
				foreach (explode(',', $paramText) as $part) {
					if (preg_match('/^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/', $part, $param) === 1) {
						$params[] = $param[1];
					}
				}
				$close = $this->matchingBrace($code, $open);
				if ($close <= $open) {
					continue;
				}
				$candidates[] = ['open' => $open, 'close' => $close, 'params' => $params];
			}
		}
		return $candidates;
	}

	private function withoutJsBodies(string $code): string
	{
		$ranges = $this->jsBodyCandidates($code);
		usort($ranges, static fn (array $a, array $b): int => $b['open'] <=> $a['open']);
		foreach ($ranges as $range) {
			$length = $range['close'] - $range['open'] + 1;
			$code = substr($code, 0, $range['open']) . str_repeat(' ', $length) . substr($code, $range['close'] + 1);
		}
		return $code;
	}

	private function matchingBrace(string $code, int $open): int
	{
		$depth = 0;
		$length = strlen($code);
		for ($i = $open; $i < $length; $i++) {
			if ($code[$i] === '{') {
				$depth++;
			} elseif ($code[$i] === '}') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}

	/**
	 * Ключи объекта-аргумента: `BX.UI.Button({ … })`. Ключи собраны сканером
	 * из обращений `options.key` в теле объявления (params_json → keys).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function objectKeyItems(TextDocument $document, int $offset, string $callee, string $tail): array
	{
		if (preg_match('/:\s*[^,{}]*$/', $tail) === 1) {
			return [];
		}
		// Внутри объекта уже начался код/другая строка — это не список ключей.
		if (str_contains($tail, ';') || preg_match('/[{}()]/', $tail) === 1) {
			return [];
		}
		$rows = $this->repository->globalsByName($callee);
		if ($rows === []) {
			return [];
		}
		$keys = [];
		foreach ($rows as $global) {
			$params = json_decode((string) ($global['params_json'] ?? '[]'), true);
			if (!is_array($params)) {
				continue;
			}
			$sourceFile = (string) ($global['source_file'] ?? '');
			foreach ($params as $param) {
				if (is_array($param['keys'] ?? null)) {
					foreach ($param['keys'] as $key) {
						if (is_string($key) && $key !== '') {
							$keys[$key] = true;
						}
					}
				}
				$type = trim((string) ($param['type'] ?? ''));
				if ($type === '') {
					continue;
				}
				// `ButtonOptions | null`, `?ButtonOptions` — объединяем формы.
				foreach (preg_split('/[|&]/', $type) ?: [] as $part) {
					$part = trim(trim($part), '?');
					if (preg_match('/^[A-Za-z_$][\w$]*$/', $part) !== 1) {
						continue;
					}
					foreach ($this->repository->typeKeys($part, $sourceFile) as $key) {
						$keys[$key] = true;
					}
				}
			}
		}
		if ($keys === []) {
			return [];
		}
		$partial = preg_match('/([A-Za-z_$][\w$]*)$/', $tail, $partialMatch) === 1 ? $partialMatch[1] : '';
		$range = $document->range($offset - strlen($partial), $offset);
		$items = [];
		foreach (array_keys($keys) as $key) {
			$items[] = [
				'label' => $key,
				'kind' => 10,
				'detail' => $callee . ' — ключ options',
				'filterText' => $key,
				'sortText' => strtolower($key),
				'textEdit' => ['range' => $range, 'newText' => $key],
			];
		}
		return $items;
	}

	/**
	 * Локальные имена из `import`/`require` для `new ...`.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function importItems(TextDocument $document, int $offset, string $prefix): array
	{
		$range = $document->range($offset - strlen($prefix), $offset);
		$items = [];
		foreach ($this->modules->imports($document->text) as $import) {
			$local = $import['local'];
			if ($prefix !== '' && stripos($local, $prefix) !== 0) {
				continue;
			}
			$items[] = [
				'label' => $local,
				'kind' => 7,
				'detail' => $import['source'] . ' → ' . $import['imported'],
				'filterText' => $local,
				'sortText' => '0_' . strtolower($local),
				'textEdit' => ['range' => $range, 'newText' => $local],
			];
		}
		return $items;
	}


	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function indexedMemberItems(TextDocument $document, int $offset, string $class, string $prefix): array
	{
		$range = $document->range($offset - strlen($prefix), $offset);
		$items = [];
		foreach ($this->repository->childSegments($class . '.', 2000, $prefix) as $row) {
			$name = (string) ($row['segment'] ?? '');
			if ($name === '') {
				continue;
			}
			$type = (string) ($row['type'] ?? 'property');
			$signature = trim((string) ($row['signature'] ?? ''));
			$items[] = [
				'label' => $name,
				'kind' => $type === 'method' ? 2 : 10,
				'detail' => ($signature !== '' ? $signature : $name),
				'filterText' => $name,
				'sortText' => strtolower($name),
				'textEdit' => ['range' => $range, 'newText' => $name],
			];
		}
		return $items;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function moduleMemberItems(
		TextDocument $document,
		int $offset,
		string $local,
		string $prefix,
	): array {
		$status = $this->modules->resolve($document, $local);
		if ($status === null) {
			return [];
		}
		$range = $document->range($offset - strlen($prefix), $offset);
		$items = [];
		foreach ($this->modules->members($document, $local) as $member) {
			$name = $member['name'];
			if ($prefix !== '' && stripos($name, $prefix) !== 0) {
				continue;
			}
			$signature = $member['signature'];
			$items[] = [
				'label' => $name,
				'kind' => $member['kind'] === 'method' ? 2 : 10,
				'detail' => $signature,
				'filterText' => $name,
				'sortText' => strtolower($name),
				'textEdit' => ['range' => $range, 'newText' => $name],
				'documentation' => [
					'kind' => 'markdown',
					'value' => "```ts\n{$signature}\n```\n\nИмпорт: `{$status['source']}`",
				],
			];
		}
		return $items;
	}

}
