<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

/** Сканер JS-кода: маскирование комментариев/строк, поиск использований `BX.*`. */
final class JsScanner
{
	/**
	 * Возвращает копию текста той же длины, где комментарии (и, опционально,
	 * строки) заменены пробелами — чтобы не ловить `BX.Foo` в строке.
	 */
	public static function maskCode(string $text, bool $maskStrings = true): string
	{
		$length = strlen($text);
		$out = '';
		$i = 0;
		while ($i < $length) {
			$ch = $text[$i];
			$next = $i + 1 < $length ? $text[$i + 1] : '';
			if ($ch === '/' && $next === '/') {
				while ($i < $length && $text[$i] !== "\n") {
					$out .= ' ';
					$i++;
				}
				continue;
			}
			if ($ch === '/' && $next === '*') {
				$close = strpos($text, '*/', $i + 2);
				$stop = $close === false ? $length : $close + 2;
				for (; $i < $stop; $i++) {
					$out .= $text[$i] === "\n" ? "\n" : ' ';
				}
				continue;
			}
			if ($maskStrings && ($ch === '"' || $ch === "'" || $ch === '`')) {
				$quote = $ch;
				$out .= ' ';
				$i++;
				while ($i < $length && $text[$i] !== $quote) {
					if ($text[$i] === '\\') {
						$out .= ' ';
						$i++;
						if ($i < $length) {
							$out .= $text[$i] === "\n" ? "\n" : ' ';
							$i++;
						}
						continue;
					}
					$out .= $text[$i] === "\n" ? "\n" : ' ';
					$i++;
				}
				if ($i < $length) {
					$out .= ' ';
					$i++;
				}
				continue;
			}
			$out .= $ch;
			$i++;
		}
		return $out;
	}

	/**
	 * @return array<int, array{name: string, start: int, end: int}>
	 */
	public static function usages(string $text): array
	{
		$masked = self::maskCode($text, true);
		preg_match_all('/\bBX((?:\.[A-Za-z_$][\w$]*)+)/', $masked, $matches, PREG_OFFSET_CAPTURE);
		$result = [];
		foreach ($matches[0] as $match) {
			$name = $match[0];
			$start = $match[1];
			$result[] = ['name' => $name, 'start' => $start, 'end' => $start + strlen($name)];
		}
		return $result;
	}

	/**
	 * Явные подключения библиотек в JS: `BX.loadExt('x')`, `BX.require('x')`.
	 *
	 * @return array<int, string>
	 */
	public static function explicitLoads(string $text): array
	{
		$masked = self::maskCode($text, false);
		preg_match_all("/BX\.(?:loadExt|require|include)\s*\(\s*['\"]([A-Za-z0-9_.\\-]+)['\"]/", $masked, $matches);
		return array_values(array_unique($matches[1] ?? []));
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
		$isNameChar = static fn (string $ch): bool => preg_match('/[A-Za-z0-9_.$\\\\]/', $ch) === 1;
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
