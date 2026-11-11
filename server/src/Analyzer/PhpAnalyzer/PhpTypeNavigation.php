<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/**
 * `textDocument/typeDefinition` и `textDocument/implementation` для PHP.
 *
 * typeDefinition: тип выражения под курсором — переменная (вывод по присваиванию),
 * метод (объявленный return type), свойство (тип из индекса) или сам класс.
 * implementation: наследники и реализации интерфейсов, а для метода — его
 * переопределения в наследниках.
 */
final class PhpTypeNavigation
{
	private const BUILTIN_TYPES = [
		'int', 'integer', 'float', 'double', 'string', 'bool', 'boolean', 'array',
		'object', 'mixed', 'void', 'never', 'null', 'callable', 'iterable', 'false',
		'true', 'static', 'self', 'parent', '$this',
	];

	/** @var array<string, array<string, string>> use-карты файлов (кэш) */
	private array $usesCache = [];

	public function __construct(
		private readonly Repository $repository,
		private readonly PhpMethodResolver $resolver,
		private readonly PhpTypeInference $inference,
	) {
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function typeDefinition(TextDocument $document, int $offset): array
	{
		$class = $this->typeClassAt($document, $offset);
		if ($class === null) {
			return [];
		}
		$row = $this->repository->classByName($class);
		if ($row === null) {
			return [];
		}
		return $this->locations([$row]);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function implementations(TextDocument $document, int $offset): array
	{
		$reference = $this->resolver->resolve($document, $offset);
		if ($reference !== null) {
			$class = ltrim((string) $reference['class'], '\\');
			$name = (string) ($reference['method']['name'] ?? '');
			if ($class !== '' && $name !== '') {
				return $this->locations($this->repository->methodImplementations($class, $name));
			}
		}
		$class = $this->typeClassAt($document, $offset);
		if ($class === null) {
			return [];
		}
		return $this->locations($this->repository->descendantsOf($class));
	}

	/** FQCN типа, к которому относится выражение под курсором. */
	private function typeClassAt(TextDocument $document, int $offset): ?string
	{
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		$context = PhpDocumentContext::create($document);

		// Переменная: `$model->` — тип выводим по присваиванию/параметру.
		if ($token['start'] > 0 && $document->text[$token['start'] - 1] === '$') {
			foreach ($this->inference->variableCandidates($context, $token['name'], $offset) as $candidate) {
				if ($this->repository->classByName($candidate) !== null) {
					return $candidate;
				}
			}
			return null;
		}

		// Метод: тип результата — объявленный return type, иначе сам класс.
		$reference = $this->resolver->resolve($document, $offset);
		if ($reference !== null) {
			$method = $reference['method'];
			$returnType = strtolower(trim((string) ($method['return_type'] ?? '')));
			if ($returnType === '' || in_array($returnType, ['static', 'self', '$this'], true)) {
				// fluent-интерфейс: тип результата — класс получателя вызова
				$receiver = $this->receiverClass($document, $context, $offset);
				if ($receiver !== null) {
					return $receiver;
				}
			}
			$returned = $this->classFromTypeString(
				(string) ($method['return_type'] ?? ''),
				(string) ($method['file'] ?? ''),
				(string) $reference['class'],
			);
			if ($returned !== null) {
				return $returned;
			}
			return ltrim((string) $reference['class'], '\\');
		}

		// Свойство: тип из индекса.
		$target = $this->resolver->resolveMemberTarget($document, $offset);
		if ($target !== null) {
			if ($target['operator'] === '->' || $target['operator'] === '::$') {
				$property = $this->repository->findPropertyInHierarchy($target['class'], $target['token']['name']);
				if ($property !== null) {
					return $this->classFromTypeString(
						(string) ($property['type'] ?? ''),
						(string) ($property['file'] ?? ''),
						(string) $target['class'],
					);
				}
			}
			return null; // константы и статические свойства без типа — не гадаем
		}

		// Имя класса: `new X`, `X::`, тип параметра, `use X`.
		foreach ($this->documentCandidates($document, $token['name']) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return null;
	}

	/** Класс получателя вызова: `$child->` перед позицией курсора. */
	private function receiverClass(TextDocument $document, PhpDocumentContext $context, int $offset): ?string
	{
		$prefix = substr($document->text, max(0, $offset - 200), min(200, $offset));
		if (preg_match('/(\$[A-Za-z_][A-Za-z0-9_]*)\s*->\s*$/', $prefix, $match) !== 1) {
			return null;
		}
		foreach ($this->inference->variableCandidates($context, $match[1], $offset) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return null;
	}

	/**
	 * Кандидаты FQCN для имени типа, объявленного в конкретном файле.
	 *
	 * @return array<int, string>
	 */
	private function documentCandidates(TextDocument $document, string $name): array
	{
		$uses = PhpUseMap::parse($document->text);
		$namespace = PhpDocumentContext::create($document)->namespaceName();
		return $this->resolveTypeName($name, $uses, $namespace);
	}

	/**
	 * @param array<string, string> $uses
	 * @return array<int, string>
	 */
	private function resolveTypeName(string $name, array $uses, string $namespace): array
	{
		$clean = ltrim(trim($name), '?\\');
		if ($clean === '' || in_array(strtolower($clean), self::BUILTIN_TYPES, true)) {
			return [];
		}
		$candidates = [];
		$resolved = PhpUseMap::resolve($clean, $uses);
		if ($resolved !== $clean) {
			$candidates[] = $resolved;
		}
		if (str_contains($clean, '\\')) {
			$candidates[] = $clean;
			if ($namespace !== '') {
				$candidates[] = $namespace . '\\' . $clean;
			}
		} else {
			if ($namespace !== '') {
				$candidates[] = $namespace . '\\' . $clean;
			}
			$candidates[] = $clean;
		}
		return array_values(array_unique($candidates));
	}

	/** Первый класс из строки типа (`?Foo`, `Foo|Bar`, `Foo[]`). */
	private function classFromTypeString(string $type, string $file, string $declaringClass): ?string
	{
		$namespace = '';
		$row = $declaringClass === '' ? null : $this->repository->classByName(ltrim($declaringClass, '\\'));
		if ($row !== null) {
			$namespace = (string) ($row['namespace'] ?? '');
		}
		$uses = $this->usesOf($file);
		foreach (preg_split('/[|&]/', $type) ?: [] as $part) {
			foreach ($this->resolveTypeName($part, $uses, $namespace) as $candidate) {
				if ($this->repository->classByName($candidate) !== null) {
					return $candidate;
				}
			}
		}
		return null;
	}

	/** @return array<string, string> */
	private function usesOf(string $file): array
	{
		if ($file === '' || str_starts_with($file, '<')) {
			return [];
		}
		if (!isset($this->usesCache[$file])) {
			$text = @file_get_contents($file);
			$this->usesCache[$file] = is_string($text) ? PhpUseMap::parse($text) : [];
		}
		return $this->usesCache[$file];
	}

	/**
	 * @param array<int, array<string, mixed>> $rows
	 * @return array<int, array<string, mixed>>
	 */
	private function locations(array $rows): array
	{
		$locations = [];
		$seen = [];
		foreach ($rows as $row) {
			$file = (string) ($row['file'] ?? '');
			$line = (int) ($row['line'] ?? 0);
			if ($file === '' || str_starts_with($file, '<')) {
				continue;
			}
			$key = $file . ':' . $line;
			if (isset($seen[$key])) {
				continue;
			}
			$seen[$key] = true;
			$zeroBased = max(0, $line - 1);
			$locations[] = [
				'uri' => Paths::pathToUri($file),
				'range' => [
					'start' => ['line' => $zeroBased, 'character' => 0],
					'end' => ['line' => $zeroBased, 'character' => 0],
				],
			];
		}
		return $locations;
	}
}
