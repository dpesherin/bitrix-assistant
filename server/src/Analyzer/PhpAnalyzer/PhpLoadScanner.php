<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

/** Извлечение подключений JS-библиотек из PHP-кода (CJSCore, Extension::load). */
final class PhpLoadScanner
{
	private const CALL_RE = '/\b(?:CJSCore::Init|Extension::load)\s*\(/';

	/**
	 * @return array<int, string>
	 */
	public static function loads(string $text): array
	{
		$masked = \BitrixLsp\Analyzer\JsAnalyzer\JsScanner::maskCode($text, true);
		if (preg_match_all(self::CALL_RE, $masked, $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		$found = [];
		foreach ($matches[0] as $match) {
			$open = strpos($masked, '(', $match[1]);
			if ($open === false) {
				continue;
			}
			$close = self::matchingParen($masked, $open);
			$args = substr($text, $open + 1, max(0, $close - $open - 1));
			preg_match_all("/['\"]([A-Za-z0-9_.\\-]+)['\"]/", $args, $strings);
			foreach ($strings[1] as $name) {
				$found[] = $name;
			}
		}
		return array_values(array_unique($found));
	}

	private static function matchingParen(string $text, int $open): int
	{
		$depth = 0;
		$length = strlen($text);
		for ($i = $open; $i < $length; $i++) {
			$ch = $text[$i];
			if ($ch === '(') {
				$depth++;
			} elseif ($ch === ')') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}
}
