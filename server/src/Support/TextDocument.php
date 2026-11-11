<?php

declare(strict_types=1);

namespace BitrixLsp\Support;

/**
 * Документ редактора с пересчётом позиций LSP (UTF-16 code units)
 * в байтовые смещения PHP.
 */
final class TextDocument
{
	/** @var int[] */
	private array $lineStarts = [0];

	public function __construct(
		public readonly string $uri,
		public readonly string $languageId,
		public string $text,
		public int $version = 0,
	) {
		$offset = 0;
		while (($pos = strpos($text, "\n", $offset)) !== false) {
			$offset = $pos + 1;
			$this->lineStarts[] = $offset;
		}
	}

	public function lineCount(): int
	{
		return count($this->lineStarts);
	}

	public function line(int $line): string
	{
		$start = $this->lineStarts[$line] ?? null;
		if ($start === null) {
			return '';
		}
		$end = $this->lineStarts[$line + 1] ?? null;
		$lineText = $end === null ? substr($this->text, $start) : substr($this->text, $start, $end - $start - 1);
		return rtrim($lineText, "\r");
	}

	public function lineStart(int $line): int
	{
		return $this->lineStarts[$line] ?? strlen($this->text);
	}

	/** Позиция LSP → байтовое смещение. */
	public function offsetAt(int $line, int $character): int
	{
		$start = $this->lineStart($line);
		if ($start >= strlen($this->text)) {
			return strlen($this->text);
		}
		$lineText = $this->line($line);
		$byte = 0;
		$units = 0;
		if (preg_match_all('/./us', $lineText, $matches) === false) {
			return $start + min($character, strlen($lineText));
		}
		foreach ($matches[0] as $char) {
			if ($units >= $character) {
				break;
			}
			$byte += strlen($char);
			$units += self::utf16Length($char);
		}
		return $start + $byte;
	}

	/**
	 * @return array{line: int, character: int}
	 */
	public function positionAt(int $offset): array
	{
		$offset = max(0, min($offset, strlen($this->text)));
		$low = 0;
		$high = count($this->lineStarts) - 1;
		while ($low < $high) {
			$mid = intdiv($low + $high + 1, 2);
			if ($this->lineStarts[$mid] <= $offset) {
				$low = $mid;
			} else {
				$high = $mid - 1;
			}
		}
		$lineStart = $this->lineStarts[$low];
		$prefix = substr($this->text, $lineStart, $offset - $lineStart);
		return ['line' => $low, 'character' => self::utf16Length($prefix)];
	}

	public function range(int $start, int $end): array
	{
		return ['start' => $this->positionAt($start), 'end' => $this->positionAt($end)];
	}

	private static function utf16Length(string $text): int
	{
		if ($text === '') {
			return 0;
		}
		$converted = @mb_convert_encoding($text, 'UTF-16LE', 'UTF-8');
		if (!is_string($converted)) {
			return strlen($text);
		}
		return intdiv(strlen($converted), 2);
	}
}
