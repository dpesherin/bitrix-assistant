<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * Переименование локальных переменных в текущем файле.
 *
 * Сознательно узкая область: переименование классов/методов/свойств задевает
 * строковые литералы, `class_alias`, конфиги и динамические вызовы, поэтому
 * такие символы не переименовываются (prepareRename вернёт `null`).
 *
 * Переменная не переименовывается, если она встречается в строке или комментарии
 * (`"{$name}"`, `'$name'`), используется как переменная переменной (`$$name`,
 * `${name}`) или совпадает с суперглобальной.
 */
final class PhpRenameProvider
{
	private const SUPERGLOBALS = [
		'GLOBALS', 'this', '_POST', '_GET', '_SERVER', '_SESSION', '_COOKIE',
		'_FILES', '_ENV', '_REQUEST',
	];

	/**
	 * @return array{range: array<string, mixed>, placeholder: string}|null
	 */
	public function prepare(TextDocument $document, int $offset): ?array
	{
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		$name = $token['name'];
		if (!$this->isVariable($document, $token) || !$this->isSafeName($name)) {
			return null;
		}
		if ($this->occurrences($document, $name) === null) {
			return null;
		}
		return [
			'range' => $document->range($token['start'] - 1, $token['end']),
			'placeholder' => $name,
		];
	}

	/**
	 * @return array<string, mixed>|null WorkspaceEdit для одного документа
	 */
	public function rename(TextDocument $document, int $offset, string $newName): ?array
	{
		if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $newName) !== 1) {
			return null;
		}
		$newName = ltrim($newName, '$');
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		$name = $token['name'];
		if (!$this->isVariable($document, $token) || !$this->isSafeName($name) || !$this->isSafeName($newName)) {
			return null;
		}
		$occurrences = $this->occurrences($document, $name);
		if ($occurrences === null || $name === $newName) {
			return null;
		}
		if (preg_match('/\$' . preg_quote($newName, '/') . '(?![A-Za-z0-9_])/', $document->text) === 1) {
			return null; // такая переменная уже есть — не сливаем два разных значения
		}
		$edits = [];
		foreach ($occurrences as [$start, $length]) {
			$edits[] = [
				'range' => $document->range($start, $start + $length),
				'newText' => $newName,
			];
		}
		return ['changes' => [$document->uri => $edits]];
	}

	/** @param array{name: string, start: int, end: int} $token */
	private function isVariable(TextDocument $document, array $token): bool
	{
		return $token['start'] > 0 && $document->text[$token['start'] - 1] === '$' && $token['name'] !== '';
	}

	private function isSafeName(string $name): bool
	{
		return !in_array($name, self::SUPERGLOBALS, true);
	}

	/**
	 * Все вхождения `$name` в коде. `null` — если переименование небезопасно.
	 *
	 * @return array<int, array{0: int, 1: int}>|null
	 */
	private function occurrences(TextDocument $document, string $name): ?array
	{
		$masked = JsScanner::maskCode(PhpSource::phpOnly($document->text), true);
		$pattern = '/\\$' . preg_quote($name, '/') . '(?![A-Za-z0-9_])/';
		if (preg_match_all($pattern, $masked, $matches, PREG_OFFSET_CAPTURE) === false || $matches[0] === []) {
			return null;
		}
		// Вхождения в строках/комментариях: замена по коду их не тронет → код сломается.
		$inCode = count($matches[0]);
		$total = preg_match_all($pattern, $document->text);
		if ($total !== $inCode) {
			return null;
		}
		// Переменные переменных: `$$name`, `${name}`, `{$name}` внутри строки.
		if (preg_match('/(?:\\$\\$|\\$\\{)' . preg_quote($name, '/') . '(?![A-Za-z0-9_])/', $masked) === 1) {
			return null;
		}
		// Имя строкой рядом с кодом: `compact('name')`, `extract()`, массивы имён.
		if (preg_match('/[\'"]' . preg_quote($name, '/') . '[\'"]/', $document->text) === 1) {
			return null;
		}
		$result = [];
		foreach ($matches[0] as $match) {
			$result[] = [$match[1], strlen($name) + 1];
		}
		return $result;
	}
}
