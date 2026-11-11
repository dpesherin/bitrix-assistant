<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * Folding ranges для PHP: тела классов/функций (по фигурным скобкам),
 * `#region`/`// #region` и многострочные блочные комментарии.
 *
 * Разбор построчный и без настоящего парсера: сначала маскируются строки,
 * комментарии и heredoc/nowdoc, чтобы скобки внутри них не ломали счётчик,
 * затем по маске собираются пары `{ … }`.
 */
final class PhpFoldingProvider
{
	/** Строки, которые редактор всё равно свернёт по отступам, не дублируем. */
	private const MAX_RANGES = 2000;

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function folding(TextDocument $document): array
	{
		$text = $document->text;
		$masked = $this->mask(PhpSource::phpOnly($text));
		$ranges = [];

		$stack = [];
		$length = strlen($masked);
		for ($i = 0; $i < $length; $i++) {
			$ch = $masked[$i];
			if ($ch === '{') {
				$stack[] = $i;
				continue;
			}
			if ($ch !== '}' || $stack === []) {
				continue;
			}
			$startOffset = array_pop($stack);
			$start = $document->positionAt($startOffset);
			$end = $document->positionAt($i);
			if ($end['line'] <= $start['line']) {
				continue; // однострочный блок сворачивать нечего
			}
			$ranges[] = [
				'startLine' => $this->blockStartLine($document, $start['line']),
				'endLine' => $end['line'],
			];
		}

		$ranges = array_merge($ranges, $this->regions($document), $this->blockComments($document));
		if (count($ranges) > self::MAX_RANGES) {
			$ranges = array_slice($ranges, 0, self::MAX_RANGES);
		}
		return $ranges;
	}

	/**
	 * Для «оллмановских» скобок (`{` на отдельной строке) сворачиваем
	 * с строки объявления, а не с одинокой скобки.
	 */
	private function blockStartLine(TextDocument $document, int $braceLine): int
	{
		if (trim($document->line($braceLine)) !== '{' || $braceLine === 0) {
			return $braceLine;
		}
		$line = $braceLine - 1;
		while ($line > 0 && trim($document->line($line)) === '') {
			$line--;
		}
		$previous = trim($document->line($line));
		if ($previous === '' || $previous === '{' || $previous === '}' || str_ends_with($previous, '*/')) {
			return $braceLine;
		}
		return $line;
	}

	/**
	 * `#region` … `#endregion` (в PHP это `#`-комментарий, в JS-вставках — `//`).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function regions(TextDocument $document): array
	{
		$ranges = [];
		$open = null;
		for ($line = 0; $line < $document->lineCount(); $line++) {
			$text = $document->line($line);
			$isOpen = preg_match('/^\s*(?:\/\/+|#)\s*#?region\b/i', $text) === 1;
			$isClose = preg_match('/^\s*(?:\/\/+|#)\s*#?endregion\b/i', $text) === 1;
			if ($isOpen) {
				if ($open !== null && $line - 1 > $open) {
					$ranges[] = ['startLine' => $open, 'endLine' => $line - 1, 'kind' => 'region'];
				}
				$open = $line;
				continue;
			}
			if ($isClose && $open !== null) {
				if ($line > $open) {
					$ranges[] = ['startLine' => $open, 'endLine' => $line, 'kind' => 'region'];
				}
				$open = null;
			}
		}
		return $ranges;
	}

	/**
	 * Многострочные `/* … *\/` — сворачиваются как комментарии.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function blockComments(TextDocument $document): array
	{
		$ranges = [];
		$start = null;
		for ($line = 0; $line < $document->lineCount(); $line++) {
			$text = $document->line($line);
			if ($start === null) {
				$position = strpos($text, '/*');
				if ($position === false) {
					continue;
				}
				// `/** … */` в одну строку и `/*!` (лицензия) не трогаем.
				if (strpos($text, '*/', $position + 2) !== false) {
					continue;
				}
				$start = $line;
				continue;
			}
			if (strpos($text, '*/') !== false) {
				if ($line > $start) {
					$ranges[] = ['startLine' => $start, 'endLine' => $line, 'kind' => 'comment'];
				}
				$start = null;
			}
		}
		return $ranges;
	}

	/**
	 * Заменяет содержимое строк, комментариев и heredoc пробелами,
	 * сохраняя длину и переводы строк — смещения остаются валидными.
	 */
	private function mask(string $text): string
	{
		$length = strlen($text);
		$out = $text;
		$blank = static function (int $from, int $to) use (&$out, $length): void {
			for (; $from < $to && $from < $length; $from++) {
				if ($out[$from] !== "\n") {
					$out[$from] = ' ';
				}
			}
		};

		$i = 0;
		while ($i < $length) {
			$ch = $text[$i];
			$next = $text[$i + 1] ?? '';

			if ($ch === '/' && $next === '/') {
				$end = strpos($text, "\n", $i) ?: $length;
				$blank($i, $end);
				$i = $end;
				continue;
			}
			if ($ch === '#' && $next !== '[') {
				$end = strpos($text, "\n", $i) ?: $length;
				$blank($i, $end);
				$i = $end;
				continue;
			}
			if ($ch === '/' && $next === '*') {
				$end = strpos($text, '*/', $i + 2);
				$end = $end === false ? $length : $end + 2;
				$blank($i, $end);
				$i = $end;
				continue;
			}
			if (substr($text, $i, 3) === '<<<') {
				$end = $this->heredocEnd($text, $i);
				if ($end !== null) {
					$blank($i, $end);
					$i = $end;
					continue;
				}
			}
			if ($ch === '"' || $ch === "'" || $ch === '`') {
				$end = $i + 1;
				while ($end < $length) {
					if ($text[$end] === '\\') {
						$end += 2;
						continue;
					}
					if ($text[$end] === $ch) {
						$end++;
						break;
					}
					$end++;
				}
				$blank($i, $end);
				$i = $end;
				continue;
			}
			$i++;
		}
		return $out;
	}

	/** Позиция сразу после закрывающего идентификатора heredoc/nowdoc. */
	private function heredocEnd(string $text, int $start): ?int
	{
		if (preg_match('/\G<<<[ \t]*(?:"([A-Za-z_][A-Za-z0-9_]*)"|\'([A-Za-z_][A-Za-z0-9_]*)\'|([A-Za-z_][A-Za-z0-9_]*))\r?\n/', $text, $match, 0, $start) !== 1) {
			return null;
		}
		$label = $match[1] !== '' ? $match[1] : ($match[2] !== '' ? $match[2] : $match[3]);
		$bodyStart = $start + strlen($match[0]);
		if (preg_match('/^[ \t]*' . preg_quote($label, '/') . '\b/m', substr($text, $bodyStart), $close, PREG_OFFSET_CAPTURE) !== 1) {
			return strlen($text);
		}
		return $bodyStart + $close[0][1] + strlen($close[0][0]);
	}
}
