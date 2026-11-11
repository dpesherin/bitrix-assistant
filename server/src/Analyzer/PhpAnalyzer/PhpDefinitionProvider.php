<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/** Переход к определению PHP-класса или метода по индексу. */
final class PhpDefinitionProvider
{
	public function __construct(
		private readonly Repository $repository,
		private readonly PhpMethodResolver $resolver,
	) {
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, int $offset): array
	{
		$earlyToken = PhpUseMap::tokenAt($document->text, $offset);
		if (
			$earlyToken !== null &&
			$earlyToken['start'] > 0 &&
			$document->text[$earlyToken['start'] - 1] === '$'
		) {
			return [];
		}
		$reference = $this->resolver->resolve($document, $offset);
		if ($reference !== null) {
			return [$this->location((string) $reference['method']['file'], (int) $reference['method']['line'])];
		}

		$target = $this->resolver->resolveMemberTarget($document, $offset);
		if ($target !== null) {
			$row = null;
			if ($target['operator'] === '->' || $target['operator'] === '::$') {
				$row = $this->repository->findPropertyInHierarchy($target['class'], $target['token']['name']);
			} elseif ($target['operator'] === '::') {
				$row = $this->repository->findConstantInHierarchy($target['class'], $target['token']['name']);
			}
			if ($row !== null) {
				return [$this->location((string) $row['file'], (int) $row['line'])];
			}
		}

		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return [];
		}
		$uses = PhpUseMap::parse($document->text);
		$candidates = array_unique([
			PhpUseMap::resolve($token['name'], $uses),
			ltrim($token['name'], '\\'),
		]);
		foreach ($candidates as $candidate) {
			$class = $this->repository->classByName($candidate);
			if ($class === null) {
				continue;
			}
			return [$this->location((string) $class['file'], (int) $class['line'])];
		}
		$function = $this->repository->findFunction($token['name']);
		if ($function !== null) {
			return [$this->location((string) $function['file'], (int) $function['line'])];
		}
		$constant = $this->repository->findGlobalConstant($token['name']);
		if ($constant !== null) {
			return [$this->location((string) $constant['file'], (int) $constant['line'])];
		}
		return [];
	}

	/**
	 * @return array<string, mixed>
	 */
	private function location(string $file, int $line): array
	{
		$zeroBased = max(0, $line - 1);
		return [
			'uri' => Paths::pathToUri($file),
			'range' => [
				'start' => ['line' => $zeroBased, 'character' => 0],
				'end' => ['line' => $zeroBased, 'character' => 0],
			],
		];
	}
}
