<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\TextDocument;

/**
 * Определяет, на какой метод указывает позиция: `Class::method()`,
 * `$this->method()`, `$var->method()` (тип из `new` или параметра).
 */
final class PhpMethodResolver
{
	private readonly PhpTypeInference $inference;

	public function __construct(
		private readonly Repository $repository,
		?PhpTypeInference $inference = null,
	) {
		$this->inference = $inference ?? new PhpTypeInference($repository);
	}

	/**
	 * @return array{
	 *   token: array{name: string, start: int, end: int},
	 *   class: string,
	 *   method: array<string, mixed>
	 * }|null
	 */
	public function resolve(TextDocument $document, int $offset, ?PhpDocumentContext $context = null): ?array
	{
		$target = $this->resolveMemberTarget($document, $offset, $context);
		if ($target === null) {
			return null;
		}
		$method = $this->repository->findMethodInHierarchy($target['class'], $target['token']['name']);
		if ($method === null) {
			return null;
		}
		return [
			'token' => $target['token'],
			'class' => $target['class'],
			'method' => $method,
		];
	}

	/**
	 * Получатель и вид доступа без поиска метода:
	 * `::` (метод/константа), `::$` (статическое свойство), `->` (метод/свойство).
	 *
	 * @return array{
	 *   token: array{name: string, start: int, end: int},
	 *   class: string,
	 *   operator: string
	 * }|null
	 */
	public function resolveMemberTarget(TextDocument $document, int $offset, ?PhpDocumentContext $context = null): ?array
	{
		$text = $document->text;
		$token = PhpUseMap::tokenAt($text, $offset);
		if ($token === null) {
			return null;
		}
		$before = rtrim(substr($text, 0, $token['start']));
		$operator = '';
		if (str_ends_with($before, '::$')) {
			$operator = '::$';
		} elseif (str_ends_with($before, '::')) {
			$operator = '::';
		} elseif (str_ends_with($before, '->')) {
			$operator = '->';
		} else {
			return null;
		}

		$receiverEnd = strlen($before) - strlen($operator);
		$receiverStart = $receiverEnd;
		$isNameChar = static function (string $char): bool {
			if ($char === '\\' || $char === '$' || $char === '_') {
				return true;
			}
			return ($char >= 'A' && $char <= 'Z')
				|| ($char >= 'a' && $char <= 'z')
				|| ($char >= '0' && $char <= '9');
		};
		while ($receiverStart > 0 && $isNameChar($before[$receiverStart - 1])) {
			$receiverStart--;
		}
		$receiver = substr($before, $receiverStart, $receiverEnd - $receiverStart);
		$context ??= PhpDocumentContext::create($document);
		if ($operator === '->') {
			$receiverText = $this->lastExpression(substr($before, 0, $receiverEnd));
			if (str_contains($receiverText, '(') || str_contains($receiverText, '->')) {
				$candidates = $this->inference->expressionCandidatesFor($context, $receiverText, $offset);
				if ($candidates !== []) {
					return ['token' => $token, 'class' => $candidates[0], 'operator' => $operator];
				}
			}
		}
		if ($receiver === '') {
			return null;
		}

		$context ??= PhpDocumentContext::create($document);


		$class = $operator === '->'
			? $this->resolveInstanceReceiver($receiver, $context, $offset)
			: $this->resolveStaticReceiver($receiver, $context, $offset);
		if ($class === null) {
			return null;
		}
		return ['token' => $token, 'class' => $class, 'operator' => $operator];
	}

	private function lastExpression(string $text): string
	{
		$text = rtrim($text);
		$length = strlen($text);
		$depth = 0;
		$start = $length;
		$isChar = static function (string $char): bool {
			return $char === '\\' || $char === '$' || $char === '_' || $char === '>' || $char === '<' || $char === ':' || $char === '-'
				|| ($char >= 'A' && $char <= 'Z') || ($char >= 'a' && $char <= 'z')
				|| ($char >= '0' && $char <= '9');
		};
		for ($i = $length - 1; $i >= 0; $i--) {
			$char = $text[$i];
			if ($char === ')') {
				$depth++;
				$start = $i;
				continue;
			}
			if ($char === '(') {
				$depth--;
				$start = $i;
				continue;
			}
			if ($depth > 0) {
				$start = $i;
				continue;
			}
			if ($isChar($char)) {
				$start = $i;
				continue;
			}
			break;
		}
		return trim(substr($text, $start));
	}

	private function resolveStaticReceiver(string $receiver, PhpDocumentContext $context, int $offset): ?string
	{
		$lower = strtolower($receiver);
		if ($lower === 'self' || $lower === 'static') {
			$class = $context->classAt($offset);
			return $class['fqcn'] ?? null;
		}
		if ($lower === 'parent') {
			$class = $context->classAt($offset);
			if ($class === null) {
				return null;
			}
			$row = $this->repository->classByName($class['fqcn']);
			return $row !== null ? $this->repository->parentClassName($row) : null;
		}
		if (str_starts_with($receiver, '$')) {
			return $this->resolveInstanceReceiver($receiver, $context, $offset);
		}
		foreach ($context->classCandidates($receiver) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return null;
	}

	private function resolveInstanceReceiver(string $receiver, PhpDocumentContext $context, int $offset): ?string
	{
		if (!str_starts_with($receiver, '$')) {
			return null;
		}
		foreach ($this->inference->variableCandidates($context, $receiver, $offset) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return null;
	}
}
