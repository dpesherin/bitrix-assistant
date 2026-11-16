<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\TextDocument;

/**
 * Inlay hints с именами параметров в вызовах JS:
 * `overlay.setAttribute('role', 'alertdialog')` →
 * `overlay.setAttribute(name: 'role', value: 'alertdialog')`.
 *
 * Источники имён: встроенный каталог (DOM, `JSON`, `Math`, `console`, jQuery),
 * функции из этого же файла и индекс проекта (`BX.*`, модули).
 */
final class JsInlayHintProvider
{
	private const MAX_HINTS = 200;

	/** Не вызовы: управляющие конструкции и ключевые слова. */
	private const NOT_CALLS = [
		'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
		'new', 'delete', 'void', 'await', 'do', 'else', 'try', 'finally', 'throw',
		'const', 'let', 'var', 'class', 'import', 'export', 'default', 'of', 'in',
	];

	private readonly JsTypeInference $types;

	public function __construct(private readonly Repository $repository)
	{
		$this->types = new JsTypeInference(new JsModuleResolver(), $repository);
	}

	/**
	 * @param array<string, mixed> $range LSP-Range, в котором запрошены подсказки
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, array $range): array
	{
		$masked = JsScanner::maskCode($document->text, true);
		$start = $this->offsetOf($document, $range['start'] ?? null, 0);
		$end = $this->offsetOf($document, $range['end'] ?? null, strlen($document->text));
		if ($end <= $start) {
			return [];
		}
		$hints = [];
		foreach ($this->callSites($masked) as [$open, $callee]) {
			if ($open < $start || $open > $end || $callee === '') {
				continue;
			}
			$close = $this->matchingParen($masked, $open);
			if ($close <= $open + 1) {
				continue;
			}
			$params = $this->paramsFor($document, $callee, $open);
			if ($params === []) {
				continue;
			}
			foreach ($this->splitArguments($masked, $open + 1, $close) as $index => [$argStart, $argEnd]) {
				if (count($hints) >= self::MAX_HINTS) {
					return array_values($hints);
				}
				if (isset($hints[$argStart])) {
					continue;
				}
				$argument = trim(substr($document->text, $argStart, $argEnd - $argStart));
				if ($argument === '' || str_starts_with($argument, '...')) {
					continue;
				}
				$param = $params[$index] ?? null;
				if ($param === null) {
					$last = end($params);
					$param = is_array($last) && !empty($last['variadic']) ? $last : null;
				}
				if (!is_array($param)) {
					continue;
				}
				$name = (string) ($param['name'] ?? '');
				if ($name === '' || str_contains($name, '.')) {
					continue; // деструктуризация в параметрах — не подписываем
				}
				$type = trim((string) ($param['type'] ?? ''));
				$hints[$argStart] = [
					'position' => $document->positionAt($argStart),
					'label' => $name . ': ',
					'kind' => 2,
					'paddingRight' => true,
					'tooltip' => [
						'kind' => 'markdown',
						'value' => $type !== '' ? "{$type} {$name}" : $name,
					],
				];
			}
		}
		ksort($hints);
		return array_values($hints);
	}

	/**
	 * Параметры вызываемого символа в нормализованном виде.
	 *
	 * @return array<int, array{name: string, type: string, variadic: bool}>
	 */
	private function paramsFor(TextDocument $document, string $callee, int $offset): array
	{
		$dot = strrpos($callee, '.');
		if ($dot !== false) {
			$owner = substr($callee, 0, $dot);
			$method = substr($callee, $dot + 1);
			if (JsNativeCatalog::isNamespace($owner)) {
				return $this->normalize(JsNativeCatalog::namespaceMember($owner, $method));
			}
			if ($owner === 'document' || $owner === 'window') {
				return $this->normalize(JsNativeCatalog::domMembers('document')[$method] ?? null);
			}
			if (preg_match('/^[A-Za-z_$][\w$]*$/', $owner) === 1) {
				$nativeOwner = $this->types->nativeOwnerForVariable($document, $owner, $offset);
				if ($nativeOwner === 'jquery') {
					return $this->normalize(JsNativeCatalog::prototypeMember('jquery', $method));
				}
				if ($nativeOwner === 'element') {
					return $this->normalize(JsNativeCatalog::domMembers('element')[$method] ?? null);
				}
			}
			return [];
		}
		$native = JsNativeCatalog::globalFunction($callee);
		if ($native !== null) {
			return $this->normalize($native);
		}
		$local = $this->localFunctionParams($document, $callee);
		if ($local !== []) {
			return $local;
		}
		return [];
	}

	/**
	 * Имена параметров функции, объявленной в этом файле.
	 *
	 * @return array<int, array{name: string, type: string, variadic: bool}>
	 */
	private function localFunctionParams(TextDocument $document, string $callee): array
	{
		$masked = JsScanner::maskCode($document->text, true);
		$name = preg_quote($callee, '/');
		$patterns = [
			'/\bfunction\s+' . $name . '\s*\(([^)]*)\)/',
			'/\b(?:const|let|var)\s+' . $name . '\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/',
		];
		foreach ($patterns as $pattern) {
			if (preg_match($pattern, $masked, $match) !== 1) {
				continue;
			}
			$params = [];
			foreach (explode(',', $match[1]) as $part) {
				$part = trim($part);
				if ($part === '' || str_starts_with($part, '{') || str_starts_with($part, '[')) {
					continue;
				}
				$variadic = str_starts_with($part, '...');
				$part = ltrim($part, '.');
				$part = preg_replace('/\s*=.*$/', '', $part) ?? $part;
				$part = trim($part);
				if ($part === '') {
					continue;
				}
				$params[] = ['name' => $part, 'type' => '', 'variadic' => $variadic];
			}
			return $params;
		}
		return [];
	}

	/**
	 * @param array<string, mixed>|null $entry запись каталога
	 * @return array<int, array{name: string, type: string, variadic: bool}>
	 */
	private function normalize(?array $entry): array
	{
		if ($entry === null) {
			return [];
		}
		$result = [];
		foreach ($entry['params'] ?? [] as $param) {
			if (!is_array($param)) {
				continue;
			}
			$name = (string) ($param['name'] ?? '');
			if ($name === '') {
				continue;
			}
			$result[] = [
				'name' => $name,
				'type' => trim((string) ($param['type'] ?? '')),
				'variadic' => str_starts_with((string) ($param['label'] ?? ''), '...'),
			];
		}
		return $result;
	}

	/**
	 * Позиции `(` вызовов и вызываемое имя.
	 *
	 * @return array<int, array{0: int, 1: string}>
	 */
	private function callSites(string $masked): array
	{
		$sites = [];
		$pattern = '/(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/';
		if (preg_match_all($pattern, $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$name = (string) $matches[1][$index][0];
				$short = strtolower((string) (strrpos($name, '.') === false ? $name : substr($name, (int) strrpos($name, '.') + 1)));
				if (in_array($short, self::NOT_CALLS, true)) {
					continue;
				}
				$before = substr($masked, max(0, $whole[1] - 40), min(40, $whole[1]));
				if (preg_match('/\b(?:function|new|typeof|instanceof)\s*$/', $before) === 1) {
					continue;
				}
				$open = $whole[1] + strrpos($whole[0], '(');
				$sites[] = [$open, $name];
			}
		}
		// Метод на результате вызова: `$('.x').on(`, `document.querySelector(…).add…(`.
		$chained = '/(?<=\))\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/';
		if (preg_match_all($chained, $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$method = (string) $matches[1][$index][0];
				$open = $whole[1] + strrpos($whole[0], '(');
				$receiver = $this->receiverBefore($masked, $whole[1]);
				if ($receiver === null) {
					continue;
				}
				$sites[] = [$open, $receiver . '.' . $method];
			}
		}
		return $sites;
	}

	/**
	 * Что за объект перед точкой: `$`/`jQuery` → jquery, `document.querySelector` →
	 * переменная или вызов, тип которого знает вывод типов.
	 */
	private function receiverBefore(string $masked, int $dot): ?string
	{
		$close = $dot - 1;
		while ($close >= 0 && $masked[$close] !== ')') {
			$close--;
		}
		if ($close < 0) {
			return null;
		}
		$depth = 0;
		$open = $close;
		for (; $open >= 0; $open--) {
			if ($masked[$open] === ')') {
				$depth++;
			} elseif ($masked[$open] === '(') {
				$depth--;
				if ($depth === 0) {
					break;
				}
			}
		}
		if ($open < 0) {
			return null;
		}
		$head = rtrim(substr($masked, 0, $open));
		if ($head === '$' || $head === 'jQuery') {
			return '$';
		}
		if (preg_match('/([A-Za-z_$][\w$]*)$/', $head, $match) === 1) {
			return $match[1];
		}
		return null;
	}

	/** @return array{0: int, 1: int} */
	private function splitArguments(string $masked, int $from, int $to): array
	{
		$args = [];
		$depth = 0;
		$start = $from;
		for ($i = $from; $i < $to; $i++) {
			$ch = $masked[$i];
			if ($ch === '(' || $ch === '[' || $ch === '{') {
				$depth++;
			} elseif ($ch === ')' || $ch === ']' || $ch === '}') {
				$depth--;
			} elseif ($ch === ',' && $depth === 0) {
				$args[] = [$start, $i];
				$start = $i + 1;
			}
		}
		$args[] = [$start, $to];
		return $args;
	}

	private function matchingParen(string $masked, int $open): int
	{
		$depth = 0;
		$length = strlen($masked);
		for ($i = $open; $i < $length; $i++) {
			if ($masked[$i] === '(') {
				$depth++;
			} elseif ($masked[$i] === ')') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}

	/**
	 * @param array<string, mixed>|null $position LSP-Position
	 */
	private function offsetOf(TextDocument $document, ?array $position, int $default): int
	{
		if (!is_array($position) || !isset($position['line'], $position['character'])) {
			return $default;
		}
		return $document->offsetAt((int) $position['line'], (int) $position['character']);
	}
}
