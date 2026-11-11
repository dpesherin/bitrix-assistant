<?php

declare(strict_types=1);

namespace BitrixLsp\Support;

/** Цветные HTML-вставки для hover (VS Code trusted markdown). */
final class HoverColor
{
	private const COLORS = [
		'class' => '#4EC9B0',
		'variable' => '#CE9178',
		'constant' => '#F44747',
		'method' => '#C586C0',
		'function' => '#C586C0',
		'keyword' => '#569CD6',
		'value' => '#B5CEA8',
	];

	/**
	 * Подвал карточки: отделён горизонтальной чертой, приглушённый и мельче
	 * основного текста.
	 *
	 * Почему `<sub>`: в hover VS Code атрибут `style` разрешён только у `<span>`
	 * и только со строго заданным набором свойств (color, background-color,
	 * display:inline-block, border-radius) — `font-size` вырезается санитайзером.
	 * Уменьшает текст только `<sub>`/`<sup>` из разрешённых тегов.
	 */
	public static function sourceLine(string $file, ?int $line = null, bool $withDivider = true): string
	{
		$location = str_replace('`', "'", $file . ($line !== null && $line > 0 ? ':' . $line : ''));
		$line = '<sub><span style="color:#8B949E;">Определение:</span> `' . $location . '`</sub>';
		return $withDivider ? "---\n\n" . $line : $line;
	}

	/** Служебные слова сигнатуры. */
	private const SIGNATURE_KEYWORDS = [
		'public', 'protected', 'private', 'static', 'abstract', 'final', 'readonly',
		'function', 'class', 'interface', 'trait', 'enum', 'extends', 'implements',
		'new', 'const', 'define', 'return', 'fn', 'use',
	];

	/** Литералы, которые подсвечиваем как значения. */
	private const SIGNATURE_VALUES = ['true', 'false', 'null', 'array'];

	/**
	 * Сигнатура метода/функции/объявления в тех же цветах, что и остальной hover:
	 * ключевые слова, имя метода, `$параметры`, типы и значения.
	 * Моноширинный — через `<code>` (block-фенс в hover выглядел слишком крупно).
	 */
	public static function signature(string $code): string
	{
		$html = '';
		$offset = 0;
		$length = strlen($code);
		while ($offset < $length) {
			$rest = substr($code, $offset);
			if (preg_match('/^\s+/', $rest, $match) === 1) {
				$html .= $match[0];
				$offset += strlen($match[0]);
				continue;
			}
			if (preg_match('/^\$[A-Za-z_][A-Za-z0-9_]*/', $rest, $match) === 1) {
				$html .= self::span($match[0], 'variable');
				$offset += strlen($match[0]);
				continue;
			}
			if (preg_match('/^(\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*")/', $rest, $match) === 1) {
				$html .= self::span($match[0], 'value');
				$offset += strlen($match[0]);
				continue;
			}
			if (preg_match('/^\\\\?[A-Za-z_][A-Za-z0-9_]*(?:\\\\[A-Za-z_][A-Za-z0-9_]*)*/', $rest, $match) === 1) {
				$word = $match[0];
				$offset += strlen($word);
				$lower = strtolower(ltrim($word, '\\'));
				$after = ltrim(substr($code, $offset));
				if (in_array($lower, self::SIGNATURE_KEYWORDS, true)) {
					$html .= self::span($word, 'keyword');
				} elseif (str_starts_with($after, '(')) {
					$html .= self::span($word, 'method');
				} elseif (in_array($lower, self::SIGNATURE_VALUES, true)) {
					$html .= self::span($word, 'value');
				} else {
					$html .= self::span($word, 'class');
				}
				continue;
			}
			if (str_starts_with($rest, '[]')) {
				$html .= self::span('[]', 'value');
				$offset += 2;
				continue;
			}
			if (preg_match('/^\d+(?:\.\d+)?/', $rest, $match) === 1) {
				$html .= self::span($match[0], 'value');
				$offset += strlen($match[0]);
				continue;
			}
			$html .= htmlspecialchars($code[$offset], ENT_QUOTES, 'UTF-8');
			$offset++;
		}
		return '<code>' . $html . '</code>';
	}

	public static function span(string $text, string $kind): string
	{
		$color = self::COLORS[$kind] ?? '#D4D4D4';
		return '<span style="color:' . $color . ';">' . htmlspecialchars($text, ENT_QUOTES, 'UTF-8') . '</span>';
	}
}
