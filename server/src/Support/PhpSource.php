<?php

declare(strict_types=1);

namespace BitrixLsp\Support;

/** Оставляет только PHP-код (`<?php … ?>`), не трогая смещения. */
final class PhpSource
{
	public static function phpOnly(string $text): string
	{
		if (strpos($text, '<?') === false) {
			return $text;
		}
		$out = $text;
		$length = strlen($text);
		$blank = static function (int $from, int $to) use (&$out, $length): void {
			for (; $from < $to && $from < $length; $from++) {
				if ($out[$from] !== "\n") {
					$out[$from] = ' ';
				}
			}
		};
		$i = 0;
		$inPhp = false;
		$quote = null;
		$lineComment = false;
		$blockComment = false;
		while ($i < $length) {
			if (!$inPhp) {
				$open = strpos($text, '<?', $i);
				if ($open === false) {
					$blank($i, $length);
					break;
				}
				$blank($i, $open);
				$inPhp = true;
				$i = $open + 2;
				continue;
			}
			$ch = $text[$i];
			$next = $text[$i + 1] ?? '';
			if ($lineComment) {
				if ($ch === "\n") {
					$lineComment = false;
				}
				$i++;
				continue;
			}
			if ($blockComment) {
				if ($ch === '*' && $next === '/') {
					$blockComment = false;
					$i += 2;
					continue;
				}
				$i++;
				continue;
			}
			if ($quote !== null) {
				if ($ch === '\\') {
					$i += 2;
					continue;
				}
				if ($ch === $quote) {
					$quote = null;
				}
				$i++;
				continue;
			}
			if ($ch === '/' && $next === '/') {
				$lineComment = true;
				$i += 2;
				continue;
			}
			if ($ch === '/' && $next === '*') {
				$blockComment = true;
				$i += 2;
				continue;
			}
			if ($ch === '#' && $next !== '[') {
				$lineComment = true;
				$i++;
				continue;
			}
			if ($ch === '"' || $ch === "'" || $ch === '`') {
				$quote = $ch;
				$i++;
				continue;
			}
			if ($ch === '?' && $next === '>') {
				$inPhp = false;
				$i += 2;
				continue;
			}
			$i++;
		}
		return $out;
	}
}
