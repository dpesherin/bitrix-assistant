<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/**
 * Find All References и Document Highlight для PHP.
 *
 * Индекс хранит только объявления, поэтому вхождения ищутся по тексту файлов
 * (список файлов берём из `file_hashes`). Это сознательный компромисс: без
 * таблицы использований поиск по имени с контекстным шаблоном дешевле и точнее,
 * чем обход всех классов на каждый запрос.
 */
final class PhpReferenceProvider
{
	private const MAX_FILES = 4000;
	private const MAX_RESULTS = 400;

	public function __construct(
		private readonly Repository $repository,
		private readonly PhpMethodResolver $resolver,
	) {
	}

	/**
	 * Вхождения символа под курсором в текущем документе.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function highlight(TextDocument $document, int $offset): array
	{
		$symbol = $this->symbolAt($document, $offset);
		if ($symbol === null) {
			return [];
		}
		$ranges = [];
		foreach ($this->find($document->text, $symbol) as [$start, $length]) {
			$ranges[] = [
				'range' => $document->range($start, $start + $length),
				'kind' => 1,
			];
		}
		return $ranges;
	}

	/**
	 * Все вхождения символа в проиндексированных PHP-файлах.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function references(TextDocument $document, int $offset, bool $includeDeclaration): array
	{
		$symbol = $this->symbolAt($document, $offset);
		if ($symbol === null) {
			return [];
		}
		$locations = [];
		if ($includeDeclaration && $symbol['file'] !== null) {
			$declaration = $this->declarationLocation((string) $symbol['file'], (int) $symbol['line'], $symbol['name']);
			if ($declaration !== null) {
				$locations[] = $declaration;
			}
		}
		$files = $this->repository->indexedPhpFiles(self::MAX_FILES);
		$seen = [];
		foreach ($files as $file) {
			$content = @file_get_contents($file);
			if (!is_string($content) || !str_contains($content, $symbol['name'])) {
				continue;
			}
			$uri = Paths::pathToUri($file);
			if (isset($seen[$uri])) {
				continue;
			}
			$seen[$uri] = true;
			$starts = $this->lineStarts($content);
			foreach ($this->find($content, $symbol) as [$start, $length]) {
				$line = $this->lineOf($starts, $start);
				$locations[] = [
					'uri' => $uri,
					'range' => [
						'start' => ['line' => $line, 'character' => $start - $starts[$line]],
						'end' => ['line' => $line, 'character' => $start - $starts[$line] + $length],
					],
				];
				if (count($locations) >= self::MAX_RESULTS) {
					return $locations;
				}
			}
		}
		return $locations;
	}


	/**
	 * Точное место объявления: строка из индекса + колонка по имени.
	 *
	 * @return array<string, mixed>|null
	 */
	private function declarationLocation(string $file, int $line, string $name): ?array
	{
		$line = max(0, $line - 1);
		$content = @file_get_contents($file);
		$character = 0;
		$length = strlen($name);
		if (is_string($content)) {
			$starts = $this->lineStarts($content);
			if (isset($starts[$line])) {
				$end = $starts[$line + 1] ?? strlen($content);
				$text = substr($content, $starts[$line], $end - $starts[$line]);
				$position = strpos($text, $name);
				if ($position !== false) {
					$character = $position;
				} else {
					$length = 0;
				}
			}
		}
		return [
			'uri' => Paths::pathToUri($file),
			'range' => [
				'start' => ['line' => $line, 'character' => $character],
				'end' => ['line' => $line, 'character' => $character + $length],
			],
		];
	}

	/**
	 * Символ под курсором: имя, вид, шаблон поиска и объявление.
	 *
	 * @return array{name: string, pattern: string, file: ?string, line: ?int}|null
	 */
	private function symbolAt(TextDocument $document, int $offset): ?array
	{
		$reference = $this->resolver->resolve($document, $offset);
		if ($reference !== null) {
			$method = $reference['method'];
			$name = (string) ($method['name'] ?? '');
			if ($name === '') {
				return null;
			}
			return [
				'name' => $name,
				'pattern' => '/(?:->|::)\s*' . preg_quote($name, '/') . '\b/',
				'file' => isset($method['file']) ? (string) $method['file'] : null,
				'line' => isset($method['line']) ? (int) $method['line'] : null,
			];
		}

		$target = $this->resolver->resolveMemberTarget($document, $offset);
		if ($target !== null) {
			$token = $target['token']['name'];
			if ($target['operator'] === '::$' || $target['operator'] === '->') {
				$property = $this->repository->findPropertyInHierarchy($target['class'], $token);
				if ($property !== null) {
					return [
						'name' => $token,
						'pattern' => '/(?:->|::)\s*\$?' . preg_quote($token, '/') . '\b/',
						'file' => isset($property['file']) ? (string) $property['file'] : null,
						'line' => isset($property['line']) ? (int) $property['line'] : null,
					];
				}
			}
		}

		$early = PhpUseMap::tokenAt($document->text, $offset);
		if ($early === null) {
			return null;
		}
		$name = $early['name'];
		$context = PhpDocumentContext::create($document);
		$class = $this->repository->classByName($context->classCandidates($name)[0] ?? $name);
		if ($class !== null) {
			$short = (string) ($class['name'] ?? $name);
			return [
				'name' => $short,
				'pattern' => '/\b' . preg_quote($short, '/') . '\b/',
				'file' => isset($class['file']) ? (string) $class['file'] : null,
				'line' => isset($class['line']) ? (int) $class['line'] : null,
			];
		}
		$function = $this->repository->findFunction($name);
		if ($function !== null) {
			return [
				'name' => (string) ($function['name'] ?? $name),
				'pattern' => '/(?<![\\w$>:])' . preg_quote((string) ($function['name'] ?? $name), '/') . '\s*\(/',
				'file' => isset($function['file']) ? (string) $function['file'] : null,
				'line' => isset($function['line']) ? (int) $function['line'] : null,
			];
		}
		return null;
	}

	/**
	 * @param array{name: string, pattern: string} $symbol
	 * @return array<int, array{0: int, 1: int}>
	 */
	private function find(string $text, array $symbol): array
	{
		$result = [];
		if (preg_match_all($symbol['pattern'], $text, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $match) {
				$namePos = strpos($match[0], $symbol['name']);
				if ($namePos === false) {
					continue;
				}
				$result[] = [$match[1] + $namePos, strlen($symbol['name'])];
			}
		}
		return $result;
	}

	/** @return array<int, int> */
	private function lineStarts(string $text): array
	{
		$starts = [0];
		$offset = 0;
		while (($pos = strpos($text, "\n", $offset)) !== false) {
			$starts[] = $pos + 1;
			$offset = $pos + 1;
		}
		return $starts;
	}

	/** @param array<int, int> $starts */
	private function lineOf(array $starts, int $offset): int
	{
		$low = 0;
		$high = count($starts) - 1;
		while ($low < $high) {
			$mid = intdiv($low + $high + 1, 2);
			if ($starts[$mid] <= $offset) {
				$low = $mid;
			} else {
				$high = $mid - 1;
			}
		}
		return $low;
	}
}
