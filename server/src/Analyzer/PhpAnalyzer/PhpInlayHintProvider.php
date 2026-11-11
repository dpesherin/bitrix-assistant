<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * Inlay hints с именами параметров в вызовах PHP:
 * `sendMail($to, $subject)` → `sendMail(to: $to, subject: $subject)`.
 *
 * Подсказка не появляется, если аргумент и так называется как параметр
 * (`foo($value)` → `foo(value: $value)`), если аргумент именованный
 * (`foo(name: 1)`) и для непрозрачных вызовов (`$fn()`, `$obj->$method()`).
 */
final class PhpInlayHintProvider
{
	private const MAX_HINTS = 200;

	public function __construct(
		private readonly Repository $repository,
		private readonly PhpMethodResolver $resolver,
	) {
	}

	/**
	 * @param array<string, mixed> $range LSP-Range (позиции), в котором запрошены подсказки
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, array $range): array
	{
		$masked = JsScanner::maskCode(PhpSource::phpOnly($document->text), true);
		$start = $this->offsetOf($document, $range['start'] ?? null, 0);
		$end = $this->offsetOf($document, $range['end'] ?? null, strlen($document->text));
		if ($end <= $start) {
			return [];
		}
		$context = PhpDocumentContext::create($document);
		$hints = [];
		$seen = [];

		foreach ($this->callSites($masked) as [$open, $calleeOffset]) {
			if ($open < $start || $open > $end) {
				continue;
			}
			if (isset($seen[$open])) {
				continue;
			}
			$seen[$open] = true;
			$close = $this->matchingParen($masked, $open);
			if ($close <= $open + 1) {
				continue;
			}
			$reference = $this->referenceAt($document, $masked, $calleeOffset, $context);
			if ($reference === null) {
				continue;
			}
			$params = json_decode((string) ($reference['method']['params_json'] ?? '[]'), true);
			if (!is_array($params) || $params === []) {
				continue;
			}
			foreach ($this->splitArguments($masked, $open + 1, $close) as $index => [$argStart, $argEnd]) {
				if (count($hints) >= self::MAX_HINTS) {
					return $hints;
				}
				$arg = substr($document->text, $argStart, $argEnd - $argStart);
				if ($this->isNamedArgument($arg) || str_starts_with(trim($arg), '...')) {
					continue;
				}
				$param = $params[$index] ?? null;
				if (!is_array($param)) {
					$last = end($params);
					$param = is_array($last) && !empty($last['variadic']) ? $last : null;
				}
				if (!is_array($param)) {
					continue;
				}
				$name = (string) ($param['name'] ?? '');
				if ($name === '' || preg_match('/^_\d+$/', $name) === 1) {
					continue; // сгенерированные имена из стабов (`$_1189783644`) — шум
				}
				if ($this->argumentRepeatsName($arg, $name)) {
					continue;
				}
				$hints[$argStart] = [
					'position' => $document->positionAt($argStart),
					'label' => $name . ': ',
					'kind' => 2,
					'paddingRight' => true,
					'tooltip' => [
						'kind' => 'markdown',
						'value' => trim((string) ($param['type'] ?? 'mixed')) . ' $' . $name,
					],
				];
			}
		}
		ksort($hints);
		return array_values($hints);
	}

	/** Комбинация аргумента и параметра может совпадать — такую подсказку не показываем. */
	private function argumentRepeatsName(string $argument, string $name): bool
	{
		$trimmed = trim($argument);
		if ('$' . $name === $trimmed) {
			return true;
		}
		// `$this->value` / `$item->name` для параметра `$value`/`$name` — тоже очевидно
		return preg_match('/^(?:\\$this|\\$[A-Za-z_][A-Za-z0-9_]*)\\s*(?:->|::)\\s*\\$?' . preg_quote($name, '/') . '$/', $trimmed) === 1;
	}

	private function isNamedArgument(string $argument): bool
	{
		return preg_match('/^\\s*[A-Za-z_][A-Za-z0-9_]*\\s*:(?!:)/', $argument) === 1;
	}

	/**
	 * Позиции `(` вызовов и байтовые смещения вызываемого имени.
	 *
	 * @return array<int, array{0: int, 1: int}>
	 */
	private function callSites(string $masked): array
	{
		$keywords = array_fill_keys([
			'if', 'elseif', 'while', 'for', 'foreach', 'switch', 'catch', 'function',
			'new', 'isset', 'empty', 'unset', 'array', 'list', 'echo', 'print', 'include',
			'include_once', 'require', 'require_once', 'eval', 'match', 'return', 'exit',
			'die', 'clone', 'yield', 'static', 'global', 'declare', 'namespace', 'use',
			'class', 'interface', 'trait', 'enum', 'fn',
		], true);
		$sites = [];
		$pattern = '/(?<![>\\w$:])\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)\\s*\\(/';
		$methodPattern = '/(?:->|::)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(/';
		if (preg_match_all($pattern, $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$name = $matches[1][$index][0];
				if (isset($keywords[strtolower($name)]) || str_contains($name, '\\')) {
					continue;
				}
				$before = substr($masked, max(0, $whole[1] - 60), min(60, $whole[1]));
				if (preg_match('/\\b(?:new|function|fn)\\s+&?\\s*$/', $before) === 1) {
					continue;
				}
				$open = $whole[1] + strrpos($whole[0], '(');
				$sites[] = [$open, $whole[1]];
			}
		}
		if (preg_match_all($methodPattern, $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $whole) {
				$open = $whole[1] + strrpos($whole[0], '(');
				$sites[] = [$open, $whole[1] + 2];
			}
		}
		// `new Foo(...)`: имя класса — вызываемый символ, параметры — конструктор
		if (preg_match_all('/\bnew\s+(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)\s*\(/', $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$open = $whole[1] + strlen($whole[0]) - 1;
				$sites[] = [$open, $matches[1][$index][1]];
			}
		}
		return $sites;
	}

	/**
	 * Ссылка на вызываемый метод/функцию.
	 *
	 * @return array{method: array<string, mixed>, class: string}|null
	 */
	private function referenceAt(TextDocument $document, string $masked, int $calleeOffset, PhpDocumentContext $context): ?array
	{
		$newClass = $this->newExpressionClass($masked, $calleeOffset, $context);
		if ($newClass !== null) {
			$row = $this->repository->classByName($newClass);
			if ($row === null) {
				return null;
			}
			$constructor = $this->repository->findMethodInHierarchy($newClass, '__construct');
			return $constructor === null ? null : ['method' => $constructor, 'class' => $newClass];
		}
		$reference = $this->resolver->resolve($document, $calleeOffset, $context);
		if ($reference !== null) {
			return $reference;
		}
		$token = PhpUseMap::tokenAt($document->text, $calleeOffset);
		if ($token === null) {
			return null;
		}
		$function = $this->repository->findFunction($token['name']);
		if ($function !== null) {
			return ['method' => $function, 'class' => ''];
		}
		$class = $context->classAt($calleeOffset);
		if ($class === null) {
			return null;
		}
		$method = $this->repository->findMethodInHierarchy($class['fqcn'], $token['name']);
		return $method === null ? null : ['method' => $method, 'class' => $class['fqcn']];
	}

	private function newExpressionClass(string $masked, int $calleeOffset, PhpDocumentContext $context): ?string
	{
		$token = PhpUseMap::tokenAt($masked, $calleeOffset);
		if ($token === null) {
			return null;
		}
		$before = rtrim(substr($masked, 0, $token['start']));
		if (preg_match('/(?:^|[^A-Za-z0-9_$>])new$/', $before) !== 1) {
			return null;
		}
		foreach ($context->classCandidates($token['name']) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return null;
	}

	/**
	 * @return array<int, array{0: int, 1: int}> [начало, конец] каждого аргумента
	 */
	private function splitArguments(string $text, int $start, int $end): array
	{
		$parts = [];
		$depth = 0;
		$argumentStart = $start;
		for ($i = $start; $i < $end; $i++) {
			$ch = $text[$i];
			if ($ch === '(' || $ch === '[' || $ch === '{') {
				$depth++;
				continue;
			}
			if ($ch === ')' || $ch === ']' || $ch === '}') {
				$depth--;
				continue;
			}
			if ($ch === ',' && $depth === 0) {
				$parts[] = [$argumentStart, $i];
				$argumentStart = $i + 1;
			}
		}
		if (trim(substr($text, $argumentStart, $end - $argumentStart)) !== '') {
			$parts[] = [$argumentStart, $end];
		}
		$result = [];
		foreach ($parts as [$from, $to]) {
			while ($from < $to && ctype_space($text[$from])) {
				$from++;
			}
			while ($to > $from && ctype_space($text[$to - 1])) {
				$to--;
			}
			$result[] = [$from, $to];
		}
		return $result;
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
	 * @param array<string, mixed>|null $position
	 */
	private function offsetOf(TextDocument $document, ?array $position, int $fallback): int
	{
		if (!is_array($position) || !isset($position['line'], $position['character'])) {
			return $fallback;
		}
		return $document->offsetAt((int) $position['line'], (int) $position['character']);
	}
}
