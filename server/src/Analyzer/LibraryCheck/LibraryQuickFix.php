<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\LibraryCheck;

use BitrixLsp\Support\TextDocument;

/**
 * Quick Fix для диагностики «библиотека не подключена»:
 * PHP — вставка `CJSCore::Init([...])` или `Extension::load(...)` после
 * `use`-блок/`declare`/`<?php`; JS — `BX.loadExt(...)` в начало файла.
 */
final class LibraryQuickFix
{
	/**
	 * @param array<int, array<string, mixed>> $diagnostics
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, array $diagnostics): array
	{
		$actions = [];
		$seen = [];
		foreach ($diagnostics as $diagnostic) {
			if (!is_array($diagnostic)) {
				continue;
			}
			$data = $diagnostic['data'] ?? null;
			if (!is_array($data) || ($data['kind'] ?? '') !== 'library-not-loaded') {
				continue;
			}
			$extension = $data['extension'] ?? null;
			if (!is_string($extension) || $extension === '' || isset($seen[$extension])) {
				continue;
			}
			$seen[$extension] = true;
			$actions = array_merge($actions, $this->actionsFor($document, $extension, $diagnostic));
		}
		return $actions;
	}

	/**
	 * @param array<string, mixed> $diagnostic
	 * @return array<int, array<string, mixed>>
	 */
	private function actionsFor(TextDocument $document, string $extension, array $diagnostic): array
	{
		$quoted = str_replace("'", "\\'", $extension);
		if ($document->languageId === 'php') {
			[$offset, $indent, $prefix] = $this->phpInsertionPoint($document->text);
			$range = $document->range($offset, $offset);
			$actions = [];
			$actions[] = $this->action(
				sprintf('Добавить \\Bitrix\\Main\\UI\\Extension::load(\'%s\')', $extension),
				$document->uri,
				$range,
				$prefix . $indent . "\\Bitrix\\Main\\UI\\Extension::load('" . $quoted . "');\n",
				$diagnostic,
				true,
			);
			$actions[] = $this->action(
				sprintf('Добавить CJSCore::Init([\'%s\'])', $extension),
				$document->uri,
				$range,
				$prefix . $indent . "CJSCore::Init(['" . $quoted . "']);\n",
				$diagnostic,
				false,
			);
			return $actions;
		}

		$range = $document->range(0, 0);
		return [
			$this->action(
				sprintf('Добавить BX.loadExt(\'%s\')', $extension),
				$document->uri,
				$range,
				"BX.loadExt('" . $quoted . "');\n",
				$diagnostic,
				true,
			),
		];
	}

	/**
	 * @param array<string, mixed> $diagnostic
	 * @return array<string, mixed>
	 */
	private function action(
		string $title,
		string $uri,
		array $range,
		string $newText,
		array $diagnostic,
		bool $preferred,
	): array {
		return [
			'title' => $title,
			'kind' => 'quickfix',
			'isPreferred' => $preferred,
			'diagnostics' => [$diagnostic],
			'edit' => [
				'changes' => [
					$uri => [
						['range' => $range, 'newText' => $newText],
					],
				],
			],
		];
	}

	/**
	 * Безопасная точка вставки PHP-оператора.
	 *
	 * @return array{0: int, 1: string, 2: string} offset, отступ, префикс (`<?php\n` при необходимости)
	 */
	private function phpInsertionPoint(string $text): array
	{
		// Учитываем только top-level `use`/`declare`: `use TraitName;` внутри класса
		// вставлять после себя PHP-оператор нельзя.
		$masked = \BitrixLsp\Analyzer\JsAnalyzer\JsScanner::maskCode($text, true);
		$anchors = [];
		if (preg_match_all('/^[ \t]*use\s+[^;]+;/m', $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $match) {
				if ($this->braceDepth($masked, $match[1]) === 0) {
					$anchors[] = $match;
				}
			}
		}
		if (preg_match_all('/^[ \t]*declare\s*\([^;]*\);/m', $masked, $declares, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($declares[0] as $match) {
				if ($this->braceDepth($masked, $match[1]) === 0) {
					$anchors[] = $match;
				}
			}
		}
		if ($anchors !== []) {
			$anchor = $anchors[0];
			foreach ($anchors as $candidate) {
				if ($candidate[1] > $anchor[1]) {
					$anchor = $candidate;
				}
			}
			$end = strpos($text, "\n", $anchor[1] + strlen($anchor[0]));
			$offset = $end === false ? strlen($text) : $end + 1;
			return [$offset, '', ''];
		}
		$open = strpos($text, '<?php');
		if ($open !== false) {
			$end = strpos($text, "\n", $open);
			$offset = $end === false ? strlen($text) : $end + 1;
			return [$offset, '', ''];
		}
		return [0, '', "<?php\n"];
	}

	private function braceDepth(string $masked, int $offset): int
	{
		$prefix = substr($masked, 0, $offset);
		return substr_count($prefix, '{') - substr_count($prefix, '}');
	}
}
