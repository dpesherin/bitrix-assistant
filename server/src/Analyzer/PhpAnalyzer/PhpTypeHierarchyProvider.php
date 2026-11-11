<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/**
 * Type hierarchy: `prepareTypeHierarchy` → item класса/интерфейса,
 * `typeHierarchy/supertypes` (родители и интерфейсы) и
 * `typeHierarchy/subtypes` (наследники и реализации).
 *
 * Возвращаются только прямые связи — клиент сам раскрывает дерево рекурсивно.
 */
final class PhpTypeHierarchyProvider
{
	private const MAX_ITEMS = 200;

	public function __construct(private readonly Repository $repository)
	{
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function prepare(TextDocument $document, int $offset): array
	{
		$fqcn = $this->classAt($document, $offset);
		if ($fqcn === null) {
			return [];
		}
		$row = $this->repository->classByName($fqcn);
		if ($row === null) {
			return [];
		}
		return [$this->item($row)];
	}

	/**
	 * @param array<string, mixed> $data
	 * @return array<int, array<string, mixed>>
	 */
	public function supertypes(array $data): array
	{
		$fqcn = (string) ($data['fqcn'] ?? '');
		if ($fqcn === '') {
			return [];
		}
		$items = [];
		foreach ($this->repository->directAncestorsOf($fqcn) as $ancestor) {
			$row = $this->repository->classByName($ancestor);
			if ($row !== null) {
				$items[] = $this->item($row);
			}
			if (count($items) >= self::MAX_ITEMS) {
				break;
			}
		}
		return $items;
	}

	/**
	 * @param array<string, mixed> $data
	 * @return array<int, array<string, mixed>>
	 */
	public function subtypes(array $data): array
	{
		$fqcn = (string) ($data['fqcn'] ?? '');
		if ($fqcn === '') {
			return [];
		}
		$items = [];
		foreach ($this->repository->directChildrenOf($fqcn, self::MAX_ITEMS) as $row) {
			$items[] = $this->item($row);
		}
		return $items;
	}

	/**
	 * FQCN класса/интерфейса под курсором: имя класса, `new X`, `extends X`,
	 * тип параметра, `$this` или переменная с известным типом.
	 */
	private function classAt(TextDocument $document, int $offset): ?string
	{
		$context = PhpDocumentContext::create($document);
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		if ($token['start'] > 0 && $document->text[$token['start'] - 1] === '$') {
			if ($token['name'] === 'this') {
				$class = $context->classAt($offset);
				return $class === null ? null : (string) $class['fqcn'];
			}
			return null;
		}
		foreach ($context->classCandidates($token['name']) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return null;
	}

	/**
	 * @param array<string, mixed> $row
	 * @return array<string, mixed>
	 */
	private function item(array $row): array
	{
		$file = (string) ($row['file'] ?? '');
		$line = max(0, (int) ($row['line'] ?? 1) - 1);
		$position = ['line' => $line, 'character' => 0];
		$kind = strtolower((string) ($row['kind'] ?? 'class')) === 'interface' ? 11 : 5;
		return [
			'name' => (string) ($row['name'] ?? ''),
			'kind' => $kind,
			'detail' => (string) ($row['fqcn'] ?? ''),
			'uri' => $file === '' || str_starts_with($file, '<') ? '' : Paths::pathToUri($file),
			'range' => ['start' => $position, 'end' => $position],
			'selectionRange' => ['start' => $position, 'end' => $position],
			'data' => ['fqcn' => (string) ($row['fqcn'] ?? '')],
		];
	}
}
