<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\HoverColor;
use BitrixLsp\Support\TextDocument;

/** Signature help для JS-вызовов `BX.*`, `this.*` и частых DOM-методов. */
final class JsSignatureHelpProvider
{
	private readonly JsMemberResolver $memberResolver;

	public function __construct(private readonly Repository $repository)
	{
		$this->memberResolver = new JsMemberResolver($repository);
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function provide(TextDocument $document, int $offset): ?array
	{
		$masked = JsScanner::maskCode($document->text, true);
		$open = $this->findOpenParen($masked, $offset);
		if ($open === null) {
			return null;
		}
		$before = rtrim(substr($masked, 0, $open));
		$active = $this->activeParameter($masked, $open, $offset);

		// Метод jQuery-объекта: `$('.x').on(`, `$.ajax(...).done(`.
		$raw = rtrim(substr($document->text, 0, $open));
		if (preg_match('/(?:\$|jQuery)\s*\([^()]*\)\s*\.\s*([A-Za-z_$][\w$]*)$/', $raw, $jquery) === 1) {
			$native = JsNativeCatalog::prototypeMember('jquery', $jquery[1]);
			if ($native !== null) {
				return $this->fromNative($native, $jquery[1], $active);
			}
		}
		// `$.ajax(...).done(` — результат вызова тоже jQuery-объект.
		if (preg_match('/\$\.[A-Za-z_$][\w$]*\s*\([^()]*\)\s*\.\s*([A-Za-z_$][\w$]*)$/', $raw, $jquery2) === 1) {
			$native = JsNativeCatalog::prototypeMember('jquery', $jquery2[1]);
			if ($native !== null) {
				return $this->fromNative($native, $jquery2[1], $active);
			}
		}
		// Вызов метода на литерале: `'строка'.replace(`, `[...].map(`.
		// Литералы ищем в исходном тексте: в маске строка заменена пробелами.
		$literal = $this->literalCall(rtrim(substr($document->text, 0, $open)));
		if ($literal !== null) {
			$native = JsNativeCatalog::prototypeMember($literal['type'], $literal['method']);
			if ($native !== null) {
				return $this->fromNative($native, $literal['method'], $active);
			}
		}

		if (preg_match('/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/', $before, $match) !== 1) {
			return null;
		}
		$callee = $match[1];

		if (str_starts_with($callee, 'BX.')) {
			$row = $this->repository->globalByName($callee);
			return $row !== null ? $this->fromRow($row, $callee, $active) : null;
		}

		// Встроенные объекты и функции: `JSON.stringify`, `Math.max`, `parseInt`.
		$dot = strrpos($callee, '.');
		if ($dot !== false) {
			$owner = substr($callee, 0, $dot);
			if (JsNativeCatalog::isNamespace($owner)) {
				$native = JsNativeCatalog::namespaceMember($owner, substr($callee, $dot + 1));
				return $native !== null ? $this->fromNative($native, $callee, $active) : null;
			}
		} else {
			$native = JsNativeCatalog::globalFunction($callee);
			if ($native !== null) {
				return $this->fromNative($native, $callee, $active);
			}
		}

		// Функция или стрелочная функция из этого же файла: `function foo(a, b)`,
		// `const foo = (a, b) => …`. В индекс они не попадают, поэтому раньше
		// подписи параметров для них не было вовсе.
		$local = $this->localFunctionParams($masked, $callee);
		if ($local !== null) {
			return $this->fromParams($local, $callee, $active);
		}

		// `overlay.setAttribute(` где `overlay` — DOM-элемент из объявления.
		if ($dot !== false) {
			$receiver = substr($callee, 0, $dot);
			if (preg_match('/^[A-Za-z_$][\w$]*$/', $receiver) === 1) {
				$nativeOwner = $this->memberResolver->nativeOwnerForVariable($document, $receiver, $open);
				if ($nativeOwner !== null) {
					$method = substr($callee, $dot + 1);
					$native = $nativeOwner === 'jquery'
						? JsNativeCatalog::prototypeMember('jquery', $method)
						: (JsNativeCatalog::domMembers('element')[$method] ?? null);
					if ($native !== null) {
						return $this->fromNative($native, $callee, $active);
					}
				}
			}
		}

		$member = $this->memberResolver->resolve($document, $open, $callee);
		if ($member === null) {
			return null;
		}
		if ($member['kind'] === 'native') {
			return $this->fromNative($member['data'], $callee, $active);
		}
		return $this->fromRow($member['row'], $callee, $active);
	}

	/**
	 * @param array<string, mixed> $row
	 * @return array<string, mixed>
	 */
	private function fromRow(array $row, string $callee, int $active): array
	{
		$params = json_decode((string) ($row['params_json'] ?? '[]'), true);
		if (!is_array($params)) {
			$params = [];
		}
		$labels = [];
		foreach ($params as $param) {
			$name = (string) ($param['name'] ?? '');
			if ($name === '' || str_contains($name, '.')) {
				continue;
			}
			$label = $name;
			$label .= !empty($param['optional']) ? '?' : '';
			$type = trim((string) ($param['type'] ?? ''));
			if ($type !== '') {
				$label .= ': ' . $type;
			}
			$default = trim((string) ($param['defaultValue'] ?? ''));
			if ($default !== '') {
				$label .= ' = ' . $default;
			}
			$labels[] = ['label' => $label];
		}

		$signature = trim((string) ($row['signature'] ?? ''));
		$base = substr($callee, (int) strrpos($callee, '.') + 1);
		if ($signature === '') {
			$signature = $base . '(' . implode(', ', array_map(
				static fn (array $label): string => (string) $label['label'],
				$labels,
			)) . ')';
		}
		$active = $labels === [] ? 0 : min($active, count($labels) - 1);

		$prefix = substr($callee, 0, (int) strrpos($callee, '.') + 1);
		$fullSignature = str_starts_with($signature, $base . '(') ? $prefix . $signature : $signature;
		$returnType = trim((string) ($row['return_type'] ?? ''));
		if ($returnType !== '') {
			$fullSignature .= ': ' . $returnType;
		}
		$documentation = "```ts\n{$fullSignature}\n```";
		$rowDoc = trim((string) ($row['doc'] ?? ''));
		if ($rowDoc !== '') {
			$documentation .= "\n\n" . $rowDoc;
		}
		if ($returnType !== '') {
			$documentation .= "\n\n**Возвращает:** `{$returnType}`";
		}
		if (!empty($row['source_file'])) {
			$documentation .= "\n\n" . HoverColor::sourceLine((string) $row['source_file'], (int) $row['line']);
		}
		return $this->result($signature, $labels, $documentation, $active);
	}

	/**
	 * @param array<string, mixed> $data
	 * @return array<string, mixed>
	 */
	private function fromNative(array $data, string $callee, int $active): array
	{
		$params = is_array($data['params'] ?? null) ? $data['params'] : [];
		$labels = [];
		foreach ($params as $param) {
			$labels[] = ['label' => (string) ($param['label'] ?? $param['name'] ?? '')];
		}
		$active = $labels === [] ? 0 : min($active, count($labels) - 1);
		$owner = (string) ($data['owner'] ?? '');
		// `document.querySelector(` важнее владельца из каталога (`element`).
		if (str_contains($callee, '.')) {
			$owner = substr($callee, 0, (int) strrpos($callee, '.'));
		}
		$signature = (string) ($data['signature'] ?? $callee);
		// У глобальных функций владельца нет: `parseInt(...)`, а не `.parseInt(...)`.
		$fullSignature = $owner !== '' ? "{$owner}.{$signature}" : $signature;
		$returnType = (string) ($data['return_type'] ?? '');
		if ($returnType !== '') {
			$fullSignature .= ': ' . $returnType;
		}
		$documentation = "```ts\n{$fullSignature}\n```";
		$doc = trim((string) ($data['doc'] ?? ''));
		if ($doc !== '') {
			$documentation .= "\n\n" . $doc;
		}
		if ($returnType !== '') {
			$documentation .= "\n\n**Возвращает:** `{$returnType}`";
		}
		return $this->result($signature, $labels, $documentation, $active);
	}

	/**
	 * Параметры функции, объявленной в текущем файле.
	 *
	 * @return array<int, array{label: string, name: string, optional: bool}>|null
	 */
	private function localFunctionParams(string $masked, string $callee): ?array
	{
		if ($callee === '' || str_contains($callee, '.')) {
			return null;
		}
		$name = preg_quote($callee, '/');
		$patterns = [
			'/\bfunction\s+' . $name . '\s*\(([^)]*)\)/',
			'/\b(?:const|let|var)\s+' . $name . '\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/',
			'/\b(?:const|let|var)\s+' . $name . '\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/',
		];
		foreach ($patterns as $index => $pattern) {
			if (preg_match($pattern, $masked, $match) !== 1) {
				continue;
			}
			// Один аргумент без скобок: `const f = x => …`.
			$raw = $index === 2 ? $match[1] : $match[1];
			$params = [];
			foreach (explode(',', $raw) as $part) {
				$part = trim($part);
				if ($part === '') {
					continue;
				}
				$optional = str_contains($part, '=');
				$paramName = preg_replace('/\s*=.*$/', '', $part);
				$paramName = trim((string) $paramName);
				$params[] = [
					'label' => $paramName . ($optional ? '?' : ''),
					'name' => $paramName,
					'optional' => $optional,
				];
			}
			return $params;
		}
		return null;
	}

	/**
	 * Подпись по списку параметров (для функций текущего файла).
	 *
	 * @param array<int, array{label: string, name: string, optional: bool}> $params
	 * @return array<string, mixed>
	 */
	private function fromParams(array $params, string $callee, int $active): array
	{
		$labels = array_map(static fn (array $param): array => ['label' => $param['label']], $params);
		$active = $labels === [] ? 0 : min($active, count($labels) - 1);
		$signature = $callee . '(' . implode(', ', array_map(
			static fn (array $param): string => (string) $param['label'],
			$params,
		)) . ')';
		return $this->result($signature, $labels, "```ts\n{$signature}\n```", $active);
	}

	/**
	 * Вызов метода на литерале: `'строка'.replace(` или `[...].map(`.
	 *
	 * @return array{type: string, method: string}|null
	 */
	private function literalCall(string $before): ?array
	{
		if (preg_match('/([\'`"])[^\'`"]*\1\s*\.\s*([A-Za-z_$][\w$]*)$/', $before, $match) === 1) {
			return ['type' => 'string', 'method' => $match[2]];
		}
		if (preg_match('/(?<![\w$)\]])\[[^\[\]]*\]\s*\.\s*([A-Za-z_$][\w$]*)$/', $before, $match) === 1) {
			return ['type' => 'array', 'method' => $match[1]];
		}
		if (preg_match('/(?<![\w$.])\d+(?:\.\d+)?\s*\.\s*([A-Za-z_$][\w$]*)$/', $before, $match) === 1) {
			return ['type' => 'number', 'method' => $match[1]];
		}
		return null;
	}

	/**
	 * @param array<int, array{label: string}> $params
	 * @return array<string, mixed>
	 */
	private function result(string $signature, array $params, string $documentation, int $active): array
	{
		return [
			'signatures' => [[
				'label' => $signature,
				'documentation' => ['kind' => 'markdown', 'value' => trim($documentation)],
				'parameters' => $params,
			]],
			'activeSignature' => 0,
			'activeParameter' => $active,
		];
	}

	private function findOpenParen(string $masked, int $offset): ?int
	{
		$depth = 0;
		$limit = min($offset, strlen($masked));
		for ($i = $limit - 1; $i >= 0; $i--) {
			$ch = $masked[$i];
			if ($ch === ')') {
				$depth++;
			} elseif ($ch === '(') {
				if ($depth === 0) {
					return $i;
				}
				$depth--;
			}
		}
		return null;
	}

	private function activeParameter(string $masked, int $open, int $offset): int
	{
		$depth = 0;
		$commas = 0;
		$limit = min($offset, strlen($masked));
		for ($i = $open + 1; $i < $limit; $i++) {
			$ch = $masked[$i];
			if ($ch === '(' || $ch === '[' || $ch === '{') {
				$depth++;
			} elseif ($ch === ')' || $ch === ']' || $ch === '}') {
				$depth--;
			} elseif ($ch === ',' && $depth === 0) {
				$commas++;
			}
		}
		return $commas;
	}
}
