<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * Кликабельные ссылки в `require`/`include`:
 * `require_once __DIR__ . '/lib/foo.php';` → ссылка на файл.
 *
 * Ссылка создаётся только на существующий файл: битые пути и вычисляемые
 * выражения не превращаются в мёртвые ссылки.
 */
final class PhpDocumentLinkProvider
{
	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document): array
	{
		$path = Paths::uriToPath($document->uri);
		if ($path === null) {
			return [];
		}
		$masked = JsScanner::maskCode(PhpSource::phpOnly($document->text), true);
		if (preg_match_all('/\b(?:require|include)(?:_once)?\b\s*\(?\s*([^;]{1,300});/', $masked, $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		$links = [];
		$directory = dirname($path);
		foreach ($matches[0] as $index => $whole) {
			$expressionStart = $matches[1][$index][1];
			// Маска заменяет строку пробелами, её длина не равна исходнику:
			// границу выражения берём по позиции `;` в маске.
			$semicolon = $whole[1] + strlen($whole[0]) - 1;
			$expression = substr($document->text, $expressionStart, max(0, $semicolon - $expressionStart));
			$target = $this->resolveTarget($expression, $directory);
			if ($target === null) {
				continue;
			}
			$quote = $this->firstQuotedRange($expression);
			if ($quote === null) {
				continue;
			}
			$links[] = [
				'range' => $document->range($expressionStart + $quote[0], $expressionStart + $quote[1]),
				'target' => Paths::pathToUri($target),
				'tooltip' => $target,
			];
		}
		return $links;
	}

	/** Путь из выражения `__DIR__ . '/x.php'` / `'./x.php'` / `/abs/x.php`. */
	private function resolveTarget(string $expression, string $directory): ?string
	{
		$quote = $this->firstQuotedRange($expression);
		if ($quote === null) {
			return null;
		}
		$literal = substr($expression, $quote[0] + 1, $quote[1] - $quote[0] - 2);
		if ($literal === '' || str_contains($literal, '$')) {
			return null;
		}
		if (str_starts_with($literal, '/') && is_file($literal)) {
			return $literal;
		}
		$candidate = $directory . '/' . ltrim($literal, '/');
		$normalized = Paths::normalize($candidate);
		if (!is_file($normalized)) {
			return null;
		}
		return $normalized;
	}

	/**
	 * Байтовые границы первой строки в кавычках (включая кавычки).
	 *
	 * @return array{0: int, 1: int}|null
	 */
	private function firstQuotedRange(string $expression): ?array
	{
		if (preg_match('/[\'"]/', $expression, $match, PREG_OFFSET_CAPTURE) !== 1) {
			return null;
		}
		$start = $match[0][1];
		$quote = $expression[$start];
		$end = strpos($expression, $quote, $start + 1);
		if ($end === false) {
			return null;
		}
		return [$start, $end + 1];
	}
}
