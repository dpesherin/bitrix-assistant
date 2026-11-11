<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * Call hierarchy: `prepareCallHierarchy` → item символа, затем
 * `callHierarchy/incomingCalls` (кто вызывает) и `callHierarchy/outgoingCalls`
 * (кого вызывает сам метод/функция).
 *
 * Входящие вызовы ищутся по тексту проиндексированных файлов (как Find All
 * References), исходящие — разбором тела объявления. Обе стороны ограничены
 * лимитами, чтобы не сканировать проект целиком на каждый запрос.
 */
final class PhpCallHierarchyProvider
{
	private const MAX_FILES = 4000;
	private const MAX_INCOMING = 50;
	private const MAX_OUTGOING = 100;

	public function __construct(
		private readonly Repository $repository,
		private readonly PhpMethodResolver $resolver,
	) {
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function prepare(TextDocument $document, int $offset): array
	{
		$target = $this->targetAt($document, $offset);
		if ($target === null) {
			return [];
		}
		return [$this->item($target['name'], $target['kind'], $target['class'], $target['file'], $target['line'])];
	}

	/**
	 * @param array<string, mixed> $data `data` из prepareCallHierarchy
	 * @return array<int, array<string, mixed>>
	 */
	public function incoming(array $data): array
	{
		$name = (string) ($data['name'] ?? '');
		$class = (string) ($data['class'] ?? '');
		if ($name === '') {
			return [];
		}
		$pattern = $class !== ''
			? '/(?:->|::)\\s*' . preg_quote($name, '/') . '\\s*\\(/'
			: '/(?<![\\w$>:])' . preg_quote($name, '/') . '\\s*\\(/';
		$results = [];
		$seen = [];
		foreach ($this->repository->indexedPhpFiles(self::MAX_FILES, true) as $file) {
			if (count($results) >= self::MAX_INCOMING) {
				break;
			}
			if (str_starts_with($file, '<')) {
				continue;
			}
			$content = @file_get_contents($file);
			if (!is_string($content) || !str_contains($content, $name)) {
				continue;
			}
			$masked = JsScanner::maskCode(PhpSource::phpOnly($content), true);
			if (preg_match_all($pattern, $masked, $matches, PREG_OFFSET_CAPTURE) === false || $matches[0] === []) {
				continue;
			}
			$document = new TextDocument(Paths::pathToUri($file), 'php', $content);
			$context = PhpDocumentContext::create($document);
			foreach ($matches[0] as $match) {
				if (count($results) >= self::MAX_INCOMING) {
					break 2;
				}
				$callOffset = $match[1];
				$caller = $this->callerAt($document, $context, $callOffset, $file);
				$key = $caller['uri'] . ':' . $caller['selectionRange']['start']['line'] . ':' . $caller['name'];
				if (!isset($seen[$key])) {
					$seen[$key] = true;
					$results[] = [
						'from' => $caller,
						'fromRanges' => [$document->range($callOffset, $callOffset + strlen($name) + 2)],
					];
					continue;
				}
				// Тот же вызывающий — добавим диапазон к существующей записи.
				foreach ($results as $index => $existing) {
					if ($existing['from']['uri'] . ':' . $existing['from']['selectionRange']['start']['line'] . ':' . $existing['from']['name'] === $key) {
						$results[$index]['fromRanges'][] = $document->range($callOffset, $callOffset + strlen($name) + 2);
						break;
					}
				}
			}
		}
		return $results;
	}

	/**
	 * @param array<string, mixed> $data `data` из prepareCallHierarchy
	 * @return array<int, array<string, mixed>>
	 */
	public function outgoing(array $data): array
	{
		$file = (string) ($data['file'] ?? '');
		$line = (int) ($data['line'] ?? 0);
		$name = (string) ($data['name'] ?? '');
		if ($file === '' || $name === '' || str_starts_with($file, '<')) {
			return [];
		}
		$content = @file_get_contents($file);
		if (!is_string($content)) {
			return [];
		}
		$document = new TextDocument(Paths::pathToUri($file), 'php', $content);
		$body = $this->bodyOf($document, $name, $line);
		if ($body === null) {
			return [];
		}
		$masked = JsScanner::maskCode(PhpSource::phpOnly($body['text']), true);
		$results = [];
		$seen = [];
		$pattern = '/(?:->|::)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(|(?<![\\w$>:])([A-Za-z_][A-Za-z0-9_]*)\\s*\\(/';
		if (preg_match_all($pattern, $masked, $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		foreach ($matches[0] as $index => $whole) {
			if (count($results) >= self::MAX_OUTGOING) {
				break;
			}
			$called = ($matches[1][$index][0] ?? '') !== '' ? $matches[1][$index][0] : ($matches[2][$index][0] ?? '');
			if ($called === '' || in_array(strtolower($called), $this->keywords(), true)) {
				continue;
			}
			$calleeOffset = $body['start'] + $whole[1] + (strpos($whole[0], $called) ?: 0);
			$target = $this->targetAt($document, $calleeOffset);
			if ($target === null) {
				continue;
			}
			if ($target['kind'] === 5) {
				$constructor = $this->repository->findMethodInHierarchy($target['class'], '__construct');
				if ($constructor === null) {
					continue; // `new Foo()` без конструктора — не вызов
				}
				$target = [
					'name' => '__construct',
					'kind' => 6,
					'class' => $target['class'],
					'file' => (string) ($constructor['file'] ?? ''),
					'line' => (int) ($constructor['line'] ?? 0),
				];
			}
			$key = $target['class'] . '::' . $target['name'];
			if (isset($seen[$key])) {
				continue;
			}
			$seen[$key] = true;
			$results[] = [
				'to' => $this->item($target['name'], $target['kind'], $target['class'], $target['file'], $target['line']),
				'fromRanges' => [$document->range($body['start'] + $whole[1], $body['start'] + $whole[1] + strlen($called))],
			];
		}
		return $results;
	}

	/**
	 * Объявление под курсором: метод, функция или класс.
	 *
	 * @return array{name: string, kind: int, class: string, file: string, line: int}|null
	 */
	private function targetAt(TextDocument $document, int $offset): ?array
	{
		$reference = $this->resolver->resolve($document, $offset);
		if ($reference !== null) {
			$method = $reference['method'];
			return [
				'name' => (string) ($method['name'] ?? ''),
				'kind' => 6,
				'class' => ltrim((string) $reference['class'], '\\'),
				'file' => (string) ($method['file'] ?? ''),
				'line' => (int) ($method['line'] ?? 0),
			];
		}
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		$context = PhpDocumentContext::create($document);
		// Курсор на объявлении метода: `public function getMap(): array`.
		$method = $context->methodAt($offset);
		if ($method !== null && (string) $method['name'] === $token['name']) {
			$class = $context->classAt($offset);
			$fqcn = $class !== null ? (string) $class['fqcn'] : '';
			$row = $fqcn === '' ? null : $this->repository->methodByName($fqcn, (string) $method['name']);
			$line = $document->positionAt($method['start'])['line'] + 1;
			return [
				'name' => (string) $method['name'],
				'kind' => 6,
				'class' => $fqcn,
				'file' => $row !== null ? (string) ($row['file'] ?? '') : Paths::uriToPath($document->uri) ?? '',
				'line' => $row !== null ? (int) ($row['line'] ?? $line) : $line,
			];
		}
		$function = $this->repository->findFunction($token['name']);
		if ($function !== null) {
			return [
				'name' => (string) ($function['name'] ?? $token['name']),
				'kind' => 12,
				'class' => '',
				'file' => (string) ($function['file'] ?? ''),
				'line' => (int) ($function['line'] ?? 0),
			];
		}
		$class = $context->classAt($offset);
		if ($class !== null) {
			$row = $this->repository->classByName($class['fqcn']);
			if ($row !== null) {
				return [
					'name' => (string) ($row['name'] ?? $class['name']),
					'kind' => 5,
					'class' => (string) $class['fqcn'],
					'file' => (string) ($row['file'] ?? ''),
					'line' => (int) ($row['line'] ?? 0),
				];
			}
		}
		return null;
	}

	/**
	 * Вызывающий метод (или файл, если вызов на верхнем уровне).
	 *
	 * @return array<string, mixed>
	 */
	private function callerAt(TextDocument $document, PhpDocumentContext $context, int $offset, string $file): array
	{
		$method = $context->methodAt($offset);
		$class = $context->classAt($offset);
		if ($method !== null) {
			$fqcn = $class !== null ? (string) $class['fqcn'] : '';
			$line = $document->positionAt($method['start'])['line'];
			return $this->item((string) $method['name'], 6, $fqcn, $file, $line + 1);
		}
		$function = $context->enclosingFunctionAt($offset);
		if ($function !== null) {
			$line = $document->positionAt($function['start'])['line'];
			return $this->item((string) $function['name'], 12, '', $file, $line + 1);
		}
		$name = basename($file);
		return $this->item($name, 1, '', $file, 1);
	}

	/**
	 * Тело объявления метода/функции: текст и смещение в документе.
	 *
	 * @return array{text: string, start: int}|null
	 */
	private function bodyOf(TextDocument $document, string $name, int $line): ?array
	{
		$masked = JsScanner::maskCode(PhpSource::phpOnly($document->text), true);
		$pattern = '/\\bfunction\\s+&?\\s*' . preg_quote($name, '/') . '\\s*\\(/';
		if (preg_match_all($pattern, $masked, $matches, PREG_OFFSET_CAPTURE) === false || $matches[0] === []) {
			return null;
		}
		$start = null;
		$targetOffset = $line > 0 ? $document->lineStart($line - 1) : 0;
		foreach ($matches[0] as $match) {
			if ($match[1] <= $targetOffset + 5000) {
				$start = $match[1];
			}
		}
		if ($start === null) {
			return null;
		}
		$open = strpos($masked, '{', $start);
		if ($open === false) {
			return null;
		}
		$close = $this->matchingBrace($masked, $open);
		if ($close <= $open) {
			return null;
		}
		return ['text' => substr($document->text, $open + 1, $close - $open - 1), 'start' => $open + 1];
	}

	/**
	 * @return array<string, mixed>
	 */
	private function item(string $name, int $kind, string $class, string $file, int $line): array
	{
		$zeroBased = max(0, $line - 1);
		$range = [
			'start' => ['line' => $zeroBased, 'character' => 0],
			'end' => ['line' => $zeroBased, 'character' => 0],
		];
		return [
			'name' => $name,
			'kind' => $kind,
			'detail' => $class !== '' ? $class : null,
			'uri' => $file === '' ? '' : Paths::pathToUri($file),
			'range' => $range,
			'selectionRange' => $range,
			'data' => ['name' => $name, 'class' => $class, 'file' => $file, 'line' => $line],
		];
	}

	/** @return array<int, string> */
	private function keywords(): array
	{
		return [
			'if', 'elseif', 'while', 'for', 'foreach', 'switch', 'catch', 'function', 'new',
			'isset', 'empty', 'unset', 'array', 'list', 'echo', 'print', 'include', 'include_once',
			'require', 'require_once', 'eval', 'match', 'return', 'exit', 'die', 'clone', 'yield',
			'static', 'global', 'declare', 'namespace', 'use', 'class', 'interface', 'trait', 'enum', 'fn',
		];
	}

	private function matchingBrace(string $text, int $open): int
	{
		$depth = 0;
		$length = strlen($text);
		for ($i = $open; $i < $length; $i++) {
			if ($text[$i] === '{') {
				$depth++;
			} elseif ($text[$i] === '}') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}
}
