<?php

declare(strict_types=1);

namespace BitrixLsp\Support;

/** Разбор PHPDoc: описание, `@param`, `@return`, `@deprecated`. */
final class DocBlock
{
	/**
	 * Таблица параметров: колонки только заполненные, ячейки с рамками,
	 * значения подсвечены. Тип берётся из сигнатуры, а если её нет — из `@param`.
	 *
	 * @param array<int, array<string, mixed>> $params из `params_json`
	 * @param array<string, string> $docParams описания `@param`
	 * @param array<string, string> $docTypes типы `@param`
	 */
	public static function renderParams(array $params, array $docParams = [], array $docTypes = []): string
	{
		$rows = [];
		foreach (array_slice($params, 0, 30) as $param) {
			if (!is_array($param)) {
				continue;
			}
			$name = trim((string) ($param['name'] ?? ''));
			if ($name === '') {
				continue;
			}
			$type = trim((string) ($param['type'] ?? ''));
			if ($type === '') {
				$type = trim((string) ($docTypes[$name] ?? ''));
			}
			$rows[] = [
				'name' => $name,
				'type' => $type,
				'default' => trim((string) ($param['default'] ?? '')),
				'description' => trim((string) ($docParams[$name] ?? '')),
			];
		}
		if ($rows === []) {
			return '';
		}

		// Колонка «Тип» показывается всегда: пустая ячейка честнее отсутствия колонки.
		$hasType = true;
		$hasDefault = false;
		$hasDescription = false;
		foreach ($rows as $row) {
			$hasDefault = $hasDefault || $row['default'] !== '';
			$hasDescription = $hasDescription || $row['description'] !== '';
		}

		// Отступы внутри ячеек делаем неразрывными пробелами: `padding` в style
		// санитайзер hover вырезает, а `align` в белом списке атрибутов есть.
		$pad = '&nbsp;&nbsp;';
		$head = static fn (string $text, bool $center = false): string =>
			'<th' . ($center ? ' align="center"' : '') . '>' . $pad . $text . $pad . '</th>';
		$cell = static fn (string $html, bool $center = false): string =>
			'<td' . ($center ? ' align="center"' : '') . '>' . $pad . $html . $pad . '</td>';

		$header = $head('Параметр');
		if ($hasType) {
			$header .= $head('Тип', true);
		}
		if ($hasDefault) {
			$header .= $head('По умолчанию', true);
		}
		if ($hasDescription) {
			$header .= $head('Описание');
		}

		$body = '';
		foreach ($rows as $row) {
			$line = $cell(HoverColor::span('$' . $row['name'], 'variable'));
			if ($hasType) {
				$line .= $cell($row['type'] !== '' ? HoverColor::span($row['type'], 'class') : '&nbsp;', true);
			}
			if ($hasDefault) {
				$line .= $cell($row['default'] !== '' ? HoverColor::span($row['default'], 'value') : '&nbsp;', true);
			}
			if ($hasDescription) {
				$line .= $cell($row['description'] !== '' ? htmlspecialchars($row['description'], ENT_QUOTES, 'UTF-8') : '&nbsp;');
			}
			$body .= '<tr>' . $line . '</tr>';
		}

		$table = '<table border="1" cellspacing="0" style="border-collapse:collapse;border:1px solid #3c3c3c;margin:4px 0;">'
			. '<thead><tr>' . $header . '</tr></thead><tbody>' . $body . '</tbody></table>';

		return "**Параметры**\n\n" . $table;
	}

	/**
	 * @return array{
	 *   description: string,
	 *   params: array<string, string>,
	 *   paramTypes: array<string, string>,
	 *   return: ?string,
	 *   deprecated: bool,
	 *   deprecatedNote: ?string
	 * }
	 */
	public static function parse(?string $doc): array
	{
		$description = [];
		$params = [];
		$paramTypes = [];
		$return = null;
		$deprecated = false;
		$deprecatedNote = null;
		if ($doc === null || trim($doc) === '') {
			return [
				'description' => '',
				'params' => [],
				'paramTypes' => [],
				'return' => null,
				'deprecated' => false,
				'deprecatedNote' => null,
			];
		}
		$inTags = false;
		foreach (explode("\n", $doc) as $rawLine) {
			$line = trim(preg_replace('/^\s*\*\s?/', '', $rawLine) ?? $rawLine);
			if ($line === '') {
				if (!$inTags && $description !== []) {
					$description[] = '';
				}
				continue;
			}
			if (str_starts_with($line, '@')) {
				$inTags = true;
			}
			if (preg_match('/^@param\s+([^$\n]*?)\s*\$(\w+)\s*(.*)$/', $line, $match) === 1) {
				$name = $match[2];
				$params[$name] = trim($match[3]);
				$type = trim($match[1]);
				if ($type !== '') {
					$paramTypes[$name] = $type;
				}
				continue;
			}
			if (preg_match('/^@return\s+(.+)$/', $line, $match) === 1) {
				$return = trim($match[1]);
				continue;
			}
			if (preg_match('/^@deprecated\b\s*(.*)$/', $line, $match) === 1) {
				$deprecated = true;
				$deprecatedNote = trim($match[1]) !== '' ? trim($match[1]) : null;
				continue;
			}
			if (!$inTags) {
				$description[] = $line;
			}
		}
		return [
			'description' => trim(implode("\n", $description)),
			'params' => $params,
			'paramTypes' => $paramTypes,
			'return' => $return,
			'deprecated' => $deprecated,
			'deprecatedNote' => $deprecatedNote,
		];
	}
}
