<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\TextDocument;

/** Минимальный вывод типа JS-переменной из `const x = new Foo()`. */
final class JsTypeInference
{
	public function __construct(
		private readonly JsModuleResolver $modules = new JsModuleResolver(),
		private readonly ?Repository $repository = null,
	) {
	}

	public function classFromNewExpression(string $before): ?string
	{
		if (preg_match('/\bnew\s+\\\\?([A-Za-z_$][\w$\\\\]*(?:\.[A-Za-z_$][\w$]*)*)\s*\([^()]*\)\s*\.\s*$/', $before, $match) !== 1) {
			return null;
		}
		$class = $match[1];
		if (str_contains($class, '.')) {
			return $class; // BX.Main.Popup — путь по сегментам индекса
		}
		$position = strrpos($class, '\\');
		return $position === false ? $class : substr($class, $position + 1);
	}

	public function classForVariable(TextDocument $document, string $variable, int $offset): ?string
	{
		if ($variable === '' || $variable === 'this') {
			return null;
		}
		$pattern = '/\\b(?:const|let|var)\\s+' . preg_quote($variable, '/')
			. '\\s*=\\s*new\\s+\\\\?([A-Za-z_$][\\w$\\\\]*(?:\\.[A-Za-z_$][\\w$]*)*)/';
		if (preg_match_all($pattern, $document->text, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		$class = null;
		foreach ($matches[0] as $index => $match) {
			if ($match[1] >= $offset) {
				break;
			}
			$class = $matches[1][$index][0] ?? null;
		}
		if ($class === null || $class === '') {
			$class = $this->classFromDocblock($document, $variable, $offset);
		}
		if ($class === null || $class === '') {
			$class = $this->classFromFactoryCall($document, $variable, $offset);
		}
		if ($class === null || $class === '') {
			return null;
		}
		return $this->resolveName($document, $class);
	}

	/** `const x = createFoo()` → `@returns {Foo}` из индекса. */
	private function classFromFactoryCall(TextDocument $document, string $variable, int $offset): ?string
	{
		if ($this->repository === null) {
			return null;
		}
		$pattern = '/\b(?:const|let|var)\s+' . preg_quote($variable, '/')
			. '\s*=\s*([A-Za-z_$][\w$.]*)\s*\(/';
		if (preg_match_all($pattern, $document->text, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		$callee = null;
		foreach ($matches[0] as $index => $match) {
			if ($match[1] >= $offset) {
				break;
			}
			$callee = $matches[1][$index][0] ?? null;
		}
		if (!is_string($callee) || $callee === '') {
			return null;
		}
		$row = $this->repository->globalByName($callee);
		if ($row === null) {
			return null;
		}
		$returnType = trim((string) ($row['return_type'] ?? ''));
		if ($returnType === '') {
			return null;
		}
		$returnType = trim($returnType, '?');
		$returnType = preg_replace('/<.*$/', '', $returnType) ?? $returnType;
		if (preg_match('/^[A-Za-z_$][\\w$\\\\]*$/', $returnType) !== 1) {
			return null;
		}
		return $returnType;
	}

	private function resolveName(TextDocument $document, string $class): string
	{
		// Путь по сегментам (`BX.Main.Popup`) — не имя из namespace/импортов.
		if (str_contains($class, '.')) {
			return $class;
		}
		$position = strrpos($class, '\\');
		$short = $position === false ? $class : substr($class, $position + 1);
		$resolved = $this->modules->resolve($document, $short);
		if ($resolved !== null) {
			return (string) $resolved['name'];
		}
		// JSDoc может ссылаться на экспортируемое имя, а локальный алиас другой.
		foreach ($this->modules->imports($document->text) as $import) {
			if ($import['imported'] !== $short) {
				continue;
			}
			$viaAlias = $this->modules->resolve($document, $import['local']);
			if ($viaAlias !== null) {
				return (string) $viaAlias['name'];
			}
		}
		return $short;
	}

	/** JSDoc-аннотация @type {Foo} перед `const x = ...` — запасной источник типа. */
	private function classFromDocblock(TextDocument $document, string $variable, int $offset): ?string
	{
		$pattern = '/\/\*\*([\s\S]*?)\*\/\s*(?:const|let|var)\s+'
			. preg_quote($variable, '/') . '\b/';
		if (preg_match_all($pattern, $document->text, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		$class = null;
		foreach ($matches[0] as $index => $match) {
			if ($match[1] >= $offset) {
				break;
			}
			if (preg_match('/@type\s*\{([^}]+)\}/', $matches[1][$index][0], $type) === 1) {
				$clean = trim(explode('|', $type[1])[0]);
				$clean = trim($clean, '?');
				if ($clean !== '' && preg_match('/^[A-Za-z_$][\\w$\\\\]*$/', $clean) === 1) {
					$class = $clean;
				}
			}
		}
		return $class;
	}
}
