<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Support\TextDocument;

/**
 * Контекст JS-документа для `this.*`: находит ближайшее присваивание
 * `BX.X = function(...) {...}` или `BX.X.prototype = {...}` и возвращает
 * базовое имя (`BX.X`), чтобы методы экземпляра искались как `BX.X.method`.
 */
final class JsDocumentContext
{
	/** @var array<int, array{name: string, start: int, end: int}> */
	private array $scopes = [];

	private function __construct(string $text)
	{
		$masked = JsScanner::maskCode($text, true);
		$pattern = '/(?:^|[;{}\\n])\\s*(?:var\\s+|let\\s+|const\\s+)?(?:window\\.)?'
			. 'BX((?:\\.[A-Za-z_$][\\w$]*)+)\\s*=\\s*'
			. '(?=(?:async\\s+)?function\\b|\\{)/';
		if (preg_match_all($pattern, $masked, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE) === false) {
			$matches = [];
		}
		foreach ($matches as $match) {
			$name = preg_replace('/\\.prototype$/', '', 'BX' . $match[1][0]) ?? 'BX' . $match[1][0];
			$valueStart = $match[0][1] + strlen($match[0][0]);
			$brace = $masked[$valueStart] === '{'
				? $valueStart
				: $this->firstBrace($masked, $valueStart);
			if ($brace === null) {
				continue;
			}
			$end = $this->matchingBrace($masked, $brace);
			$this->scopes[] = ['name' => $name, 'start' => $brace, 'end' => $end];
		}

		// ES-классы: `this.method()` внутри `class Foo { ... }` → `Foo.method`.
		$classPattern = '/(?:^|[;{}\n])\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?'
			. 'class\s+([A-Za-z_$][\w$]*)([^{]*)\{/';
		if (preg_match_all($classPattern, $masked, $classMatches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE) === false) {
			return;
		}
		foreach ($classMatches as $match) {
			$brace = $match[0][1] + strlen($match[0][0]) - 1;
			$end = $this->matchingBrace($masked, $brace);
			$this->scopes[] = ['name' => $match[1][0], 'start' => $brace, 'end' => $end];
		}
	}

	public static function create(TextDocument $document): self
	{
		return new self($document->text);
	}

	/** Базовое имя ближайшего `BX.X`-контекста, содержащего позицию. */
	public function baseAt(int $offset): ?string
	{
		$best = null;
		foreach ($this->scopes as $scope) {
			if ($offset < $scope['start'] || $offset > $scope['end']) {
				continue;
			}
			if ($best === null || ($scope['end'] - $scope['start']) < ($best['end'] - $best['start'])) {
				$best = $scope;
			}
		}
		return $best['name'] ?? null;
	}

	private function firstBrace(string $masked, int $offset): ?int
	{
		$length = strlen($masked);
		for ($i = $offset; $i < $length; $i++) {
			$ch = $masked[$i];
			if ($ch === '{') {
				return $i;
			}
			if ($ch === ';') {
				return null;
			}
		}
		return null;
	}

	private function matchingBrace(string $masked, int $open): int
	{
		$depth = 0;
		$length = strlen($masked);
		for ($i = $open; $i < $length; $i++) {
			$ch = $masked[$i];
			if ($ch === '{') {
				$depth++;
			} elseif ($ch === '}') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}
}
