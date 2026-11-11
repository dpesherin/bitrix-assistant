<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * Форматирование PHP: намеренно консервативное.
 *
 * Правила (не меняют отступы и стиль скобок — это личное дело проекта):
 * — убирает пробелы в конце строк, если строка заканчивается кодом
 *   (строки внутри строк/комментариев не трогаются);
 * — оставляет ровно один перевод строки в конце файла.
 *
 * Файлы с heredoc/nowdoc пропускаются целиком: маска не различает их границы,
 * а лишняя правка внутри строки дороже, чем отсутствие форматирования.
 * Полный PSR-12/Битрикс-стиль сознательно не навязывается — для этого нужен
 * отдельный форматтер, который перепишет весь файл.
 */
final class PhpFormattingProvider
{
	/**
	 * @param array<string, mixed>|null $range LSP-Range (позиции) или null для всего файла
	 * @return array<int, array<string, mixed>>
	 */
	public function format(TextDocument $document, ?array $range): array
	{
		$text = $document->text;
		if ($text === '' || str_contains($text, '<<<')) {
			return [];
		}
		$masked = JsScanner::maskCode(PhpSource::phpOnly($text), true);
		$rawLines = explode("\n", $text);
		$maskedLines = explode("\n", $masked);
		$from = 0;
		$to = count($rawLines) - 1;
		if (is_array($range)) {
			$from = max(0, (int) ($range['start']['line'] ?? 0));
			$to = min($to, (int) ($range['end']['line'] ?? $to));
		}
		$edits = [];
		for ($line = $from; $line <= $to && $line < count($rawLines); $line++) {
			$raw = rtrim($rawLines[$line], "\r");
			$trimmed = rtrim($raw, " \t");
			if ($trimmed === $raw) {
				continue;
			}
			// Пустые строки и строки, где последний символ скрыт маской
			// (строка/комментарий), не трогаем.
			if ($trimmed === '') {
				continue;
			}
			$maskedLine = $maskedLines[$line] ?? '';
			$lastIndex = strlen($trimmed) - 1;
			if (!isset($maskedLine[$lastIndex]) || $maskedLine[$lastIndex] === ' ') {
				continue;
			}
			$start = $document->lineStart($line) + strlen($trimmed);
			$edits[] = [
				'range' => $document->range($start, $start + (strlen($raw) - strlen($trimmed))),
				'newText' => '',
			];
		}
		if (is_array($range)) {
			return $edits; // хвост файла правим только при форматировании всего документа
		}
		$trailing = strlen($text) - strlen(rtrim($text, "\n"));
		if ($trailing !== 1) {
			$start = strlen(rtrim($text, "\n"));
			$edits[] = [
				'range' => $document->range($start, strlen($text)),
				'newText' => "\n",
			];
		}
		return $edits;
	}
}
