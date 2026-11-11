<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Support\PhpSource;

/** Разбор `use`-алиасов и ссылок на классы в PHP-документе. */
final class PhpUseMap
{
	/**
	 * @return array<string, string> alias => FQCN
	 */
	public static function parse(string $text): array
	{
		$masked = \BitrixLsp\Analyzer\JsAnalyzer\JsScanner::maskCode(PhpSource::phpOnly($text), true);
		$map = [];
		if (preg_match_all('/\buse\s+([A-Za-z0-9_\\\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;/', $masked, $matches, PREG_SET_ORDER) === false) {
			return [];
		}
		foreach ($matches as $match) {
			$fqcn = ltrim($match[1], '\\');
			$alias = $match[2] ?? '';
			if ($alias === '') {
				$segments = explode('\\', $fqcn);
				$alias = end($segments) ?: $fqcn;
			}
			if (!isset($map[$alias])) {
				$map[$alias] = $fqcn;
			}
		}
		return $map;
	}

	/**
	 * Ссылки на классы: `new X`, `X::`, `extends X`, `implements X`, `instanceof X`.
	 *
	 * @return array<int, array{name: string, start: int, end: int}>
	 */
	public static function classReferences(string $text): array
	{
		$masked = \BitrixLsp\Analyzer\JsAnalyzer\JsScanner::maskCode(PhpSource::phpOnly($text), true);
		$references = [];
		$seen = [];
		$patterns = [
			'/\b(?:new|extends|implements|instanceof)\s+\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)/',
			'/\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)::/',
		];
		foreach ($patterns as $pattern) {
			if (preg_match_all($pattern, $masked, $matches, PREG_OFFSET_CAPTURE) === false) {
				continue;
			}
			foreach ($matches[0] as $index => $whole) {
				$name = $matches[1][$index][0] ?? '';
				if ($name === '') {
					continue;
				}
				$nameOffset = strpos($whole[0], $name);
				$start = $whole[1] + ($nameOffset === false ? 0 : $nameOffset);
				$key = $start . ':' . $name;
				if (isset($seen[$key])) {
					continue;
				}
				$seen[$key] = true;
				$references[] = ['name' => $name, 'start' => $start, 'end' => $start + strlen($name)];
			}
		}
		usort($references, static fn (array $a, array $b): int => $a['start'] <=> $b['start']);
		return $references;
	}

	/**
	 * @param array<string, string> $uses
	 */
	public static function resolve(string $name, array $uses): string
	{
		if (str_starts_with($name, '\\')) {
			return ltrim($name, '\\');
		}
		$segments = explode('\\', $name);
		$first = $segments[0];
		if (isset($uses[$first])) {
			$segments[0] = $uses[$first];
			return implode('\\', $segments);
		}
		return $name;
	}

	/**
	 * @return array{name: string, start: int, end: int}|null
	 */
	public static function tokenAt(string $text, int $offset): ?array
	{
		$length = strlen($text);
		if ($length === 0) {
			return null;
		}
		$offset = max(0, min($offset, $length));
		$isNameChar = static fn (string $ch): bool => preg_match('/[A-Za-z0-9_\\\\]/', $ch) === 1;
		$start = $offset;
		while ($start > 0 && $isNameChar($text[$start - 1])) {
			$start--;
		}
		$end = $offset;
		while ($end < $length && $isNameChar($text[$end])) {
			$end++;
		}
		if ($end <= $start) {
			return null;
		}
		return ['name' => substr($text, $start, $end - $start), 'start' => $start, 'end' => $end];
	}
}
