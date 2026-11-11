<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;

/**
 * Вывод типа переменной по коду: `$x = new Foo()`, `$x = Class::method()`,
 * `$x = $this->method()`, `$x = $obj->method()` — с рекурсией по возвращаемым типам.
 */
final class PhpTypeInference
{
	private const MAX_DEPTH = 6;

	public function __construct(private readonly Repository $repository)
	{
	}

	/**
	 * @return array<int, string> FQCN-кандидаты
	 */
	public function variableCandidates(
		PhpDocumentContext $context,
		string $variable,
		int $offset,
		int $depth = 0,
	): array {
		$variable = ltrim($variable, '$');
		if ($variable === '' || $depth > self::MAX_DEPTH) {
			return [];
		}
		$base = $this->baseCandidates($context, $variable, $offset, $depth);
		$narrowed = $this->narrowedType($context, $variable, $offset);
		if ($narrowed === null) {
			return $base;
		}
		return array_values(array_unique(array_merge([$narrowed], $base)));
	}

	/**
	 * Вывод без учёта сужения типа (`instanceof`, `assert`).
	 *
	 * @return array<int, string>
	 */
	private function baseCandidates(PhpDocumentContext $context, string $variable, int $offset, int $depth): array
	{
		$base = $context->typeCandidatesOfVariable('$' . $variable, $offset);
		if ($base !== []) {
			return $base;
		}
		$rhs = $this->assignmentRightHandSide($context->text(), $variable, $offset);
		if ($rhs === null) {
			return [];
		}
		return $this->expressionCandidates($context, $rhs, $offset, $depth + 1);
	}

	/**
	 * Сужение типа по guard-проверкам до позиции курсора:
	 * `if ($x instanceof Foo) { … }`, `if (!$x instanceof Foo) { return; }`,
	 * `assert($x instanceof Foo);` — тип после проверки.
	 */
	private function narrowedType(PhpDocumentContext $context, string $variable, int $offset): ?string
	{
		$text = $context->masked();
		$pattern = '/\$' . preg_quote($variable, '/') . '\s+instanceof\s+(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)/';
		if (preg_match_all($pattern, $text, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		$best = null;
		$bestStart = -1;
		foreach ($matches[0] as $index => $whole) {
			$start = $whole[1];
			if ($start >= $offset || $start < $bestStart) {
				continue;
			}
			$class = $this->narrowedClass($context, $matches[1][$index][0]);
			if ($class === null) {
				continue;
			}
			$after = $start + strlen($whole[0]);
			if ($this->isNegated($text, $start)) {
				if ($this->afterEarlyExit($text, $after, $offset)) {
					$best = $class;
					$bestStart = $start;
				}
				continue;
			}
			if ($this->insideGuardedBlock($text, $after, $offset) || $this->afterAssert($text, $start, $after, $offset)) {
				$best = $class;
				$bestStart = $start;
			}
		}
		return $best;
	}

	/** @return string|null FQCN класса из индекса */
	private function narrowedClass(PhpDocumentContext $context, string $name): ?string
	{
		foreach ($context->classCandidates(ltrim($name, '\\')) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		return null;
	}

	/** `!$x instanceof Foo` / `!($x instanceof Foo)` — отрицание именно этой переменной. */
	private function isNegated(string $text, int $start): bool
	{
		return str_contains(substr($text, max(0, $start - 2), min(2, $start)), '!');
	}

	/** Курсор внутри блока `if (… instanceof …) { … }`. */
	private function insideGuardedBlock(string $text, int $after, int $offset): bool
	{
		$brace = strpos($text, '{', $after);
		if ($brace === false) {
			return false;
		}
		$semicolon = strpos($text, ';', $after);
		if ($semicolon !== false && $semicolon < $brace) {
			return false;
		}
		$close = $this->matchingBrace($text, $brace);
		return $close > $brace && $offset > $brace && $offset < $close;
	}

	/** После `if (!$x instanceof Foo) { return; }` тип сужается до Foo. */
	private function afterEarlyExit(string $text, int $after, int $offset): bool
	{
		$semicolon = strpos($text, ';', $after);
		if ($semicolon === false) {
			return false;
		}
		$brace = strpos($text, '{', $after);
		if ($brace !== false && $brace < $semicolon) {
			$close = $this->matchingBrace($text, $brace);
			if ($close <= $brace || $offset <= $close) {
				return false;
			}
			$block = substr($text, $brace, $close - $brace);
			return preg_match('/\b(?:return|throw|continue|break)\b/', $block) === 1;
		}
		$statement = substr($text, $after, $semicolon - $after);
		if (preg_match('/\b(?:return|throw|continue|break)\b/', $statement) !== 1) {
			return false;
		}
		return $offset > $semicolon;
	}

	/** `assert($x instanceof Foo);` — сужение после оператора. */
	private function afterAssert(string $text, int $start, int $after, int $offset): bool
	{
		$lineStart = strrpos(substr($text, 0, $start), "\n");
		$from = $lineStart === false ? 0 : $lineStart;
		$prefix = substr($text, $from, $start - $from);
		if (preg_match('/\bassert\s*\(/', $prefix) !== 1) {
			return false;
		}
		$semicolon = strpos($text, ';', $after);
		return $semicolon !== false && $offset > $semicolon;
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

	/**
	 * @return array<int, string>
	 */
	public function expressionCandidatesFor(
		PhpDocumentContext $context,
		string $expression,
		int $offset,
	): array {
		return $this->expressionCandidates($context, $expression, $offset, 0);
	}

	private function assignmentRightHandSide(string $text, string $variable, int $offset): ?string
	{
		$pattern = '/\$' . preg_quote($variable, '/') . '\s*=\s*(?![=>])/';
		if (preg_match_all($pattern, $text, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		$start = null;
		foreach ($matches[0] as $match) {
			if ($match[1] >= $offset) {
				break;
			}
			$start = $match[1] + strlen($match[0]);
		}
		if ($start === null) {
			return null;
		}
		$semicolon = strpos($text, ';', $start);
		$end = $semicolon === false ? strlen($text) : $semicolon;
		$rhs = trim(substr($text, $start, min($end - $start, 400)));
		return $rhs === '' ? null : $rhs;
	}

	/**
	 * @return array<int, string>
	 */
	private function expressionCandidates(
		PhpDocumentContext $context,
		string $expression,
		int $offset,
		int $depth,
	): array {
		if ($depth > self::MAX_DEPTH) {
			return [];
		}
		// `(new StatusChanged([...]))->fillNillable()`: скобки вокруг выражения
		// не меняют тип, но мешают разбору — снимаем внешние.
		$current = self::stripOuterParens(trim($expression));
		$candidates = [];
		if (preg_match('/^\$([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)$/', $current, $propertyMatch) === 1) {
			$receivers = $propertyMatch[1] === 'this'
				? [($context->classAt($offset)['fqcn'] ?? '')]
				: $this->variableCandidates($context, '$' . $propertyMatch[1], $offset, $depth + 1);
			$result = [];
			foreach (array_filter($receivers) as $receiver) {
				$property = $this->repository->findPropertyInHierarchy((string) $receiver, $propertyMatch[2]);
				if ($property !== null) {
					$result = array_merge($result, $this->typeCandidatesFor((string) ($property['type'] ?? ''), (string) $receiver, $context));
				}
			}
			return array_values(array_unique($result));
		}
		for ($guard = 0; $guard < self::MAX_DEPTH; $guard++) {
			$next = null;
			if (preg_match('/^\$GLOBALS\s*\[\s*[\'"]([A-Za-z_][A-Za-z0-9_]*)[\'"]\s*\]$/', $current, $globalsMatch) === 1) {
			$class = PhpDocumentContext::globalClass($globalsMatch[1]);
			return $class !== null ? [$class] : [];
		}
		if (preg_match('/^new\s+([\\\\A-Za-z_][\\\\A-Za-z0-9_]*)/', $current, $match) === 1) {
				$candidates = $this->existing($context->classCandidates($match[1]));
				$next = $this->afterCall($current, strlen($match[0]));
			} elseif (preg_match(
				'/^(?:(self|static|parent)|(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*))::([A-Za-z_][A-Za-z0-9_]*)\s*\(/',
				$current,
				$match,
			) === 1) {
				$receivers = [];
				if (($match[1] ?? '') !== '') {
					$class = $context->classAt($offset);
					if ($class !== null) {
						if (strtolower($match[1]) === 'parent') {
							$row = $this->repository->classByName($class['fqcn']);
							$parent = $row !== null ? $this->repository->parentClassName($row) : null;
							if ($parent !== null) {
								$receivers[] = $parent;
							}
						} else {
							$receivers[] = $class['fqcn'];
						}
					}
				} else {
					$receivers = $context->classCandidates($match[2]);
				}
				$candidates = $this->methodCallReturnCandidates($receivers, $match[3], $context);
				$next = $this->afterCall($current, strlen($match[0]) - 1);
			} elseif (preg_match('/^\$([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/', $current, $match) === 1) {
				$receivers = $this->variableCandidates($context, '$' . $match[1], $offset, $depth + 1);
				$candidates = $this->methodCallReturnCandidates($receivers, $match[2], $context);
				$next = $this->afterCall($current, strlen($match[0]) - 1);
			} else {
				return $candidates;
			}
			if ($candidates === []) {
				return [];
			}
			if ($next === null || preg_match('/^\s*->\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/', $next, $chain) !== 1) {
				return $candidates;
			}
			$candidates = $this->methodCallReturnCandidates($candidates, $chain[1], $context);
			$current = $this->afterCall($next, strlen($chain[0]) - 1);
			if ($current === null) {
				return $candidates;
			}
		}
		return $candidates;
	}

	private static function stripOuterParens(string $expression): string
	{
		$current = $expression;
		while (strlen($current) > 2 && $current[0] === '(' && str_ends_with($current, ')')) {
			$depth = 0;
			$closesAtStart = false;
			$length = strlen($current);
			for ($i = 0; $i < $length; $i++) {
				if ($current[$i] === '(') {
					$depth++;
				} elseif ($current[$i] === ')') {
					$depth--;
					if ($depth === 0) {
						$closesAtStart = $i === $length - 1;
						break;
					}
				}
			}
			if (!$closesAtStart) {
				return $current;
			}
			$current = trim(substr($current, 1, -1));
		}
		return $current;
	}

	private function afterCall(string $expression, int $openOrPrefixLength): ?string
	{
		$open = strpos($expression, '(', max(0, $openOrPrefixLength - 1));
		if ($open === false) {
			return null;
		}
		$depth = 0;
		$length = strlen($expression);
		for ($i = $open; $i < $length; $i++) {
			if ($expression[$i] === '(') {
				$depth++;
			} elseif ($expression[$i] === ')') {
				$depth--;
				if ($depth === 0) {
					return substr($expression, $i + 1);
				}
			}
		}
		return null;
	}

	private function methodCallReturnCandidates(array $receivers, string $methodName, PhpDocumentContext $context): array
	{
		foreach (array_values(array_unique($receivers)) as $receiver) {
			if ($this->repository->classByName($receiver) === null) {
				continue;
			}
			$method = $this->repository->findMethodInHierarchy($receiver, $methodName);
			if ($method === null) {
				continue;
			}
			$candidates = $this->returnTypeCandidates($receiver, $method, $context);
			if ($candidates !== []) {
				return $candidates;
			}
		}
		return [];
	}

	/**
	 * @param array<string, mixed> $method
	 * @return array<int, string>
	 */
	private function returnTypeCandidates(string $declaringClass, array $method, PhpDocumentContext $context): array
	{
		return $this->typeCandidatesFor((string) ($method['return_type'] ?? ''), $declaringClass, $context);
	}

	/**
	 * @return array<int, string>
	 */
	private function typeCandidatesFor(string $type, string $declaringClass, PhpDocumentContext $context): array
	{
		$type = trim($type);
		if ($type === '') {
			return [];
		}
		$namespace = $this->namespaceOf($declaringClass);
		$result = [];
		foreach (preg_split('/[|&]/', $type) ?: [] as $part) {
			$part = trim($part, " \t\n\r\0\x0B?");
			if ($part === '') {
				continue;
			}
			$lower = strtolower($part);
			if ($lower === 'self' || $lower === 'static') {
				$result[] = $declaringClass;
				continue;
			}
			if ($lower === 'parent') {
				$row = $this->repository->classByName($declaringClass);
				$parent = $row !== null ? $this->repository->parentClassName($row) : null;
				if ($parent !== null) {
					$result[] = $parent;
				}
				continue;
			}
			if ($this->isBuiltin($part)) {
				continue;
			}
			$picked = $this->pickClassForType($part, $namespace, $context);
			if ($picked !== null) {
				$result[] = $picked;
			}
		}
		return array_values(array_unique($result));
	}

	/**
	 * Для короткого типа (`Item`) приоритет: namespace объявляющего класса →
	 * алиасы документа → поиск по короткому имени → глобальное имя.
	 * Глобальное `Item` может быть посторонним классом из другого файла.
	 */
	private function pickClassForType(string $part, string $namespace, PhpDocumentContext $context): ?string
	{
		if (str_starts_with($part, '\\')) {
			$absolute = ltrim($part, '\\');
			return $this->repository->classByName($absolute) !== null ? $absolute : null;
		}
		$ordered = [];
		if ($namespace !== '' && !str_contains($part, '\\')) {
			$ordered[] = $namespace . '\\' . $part;
		}
		foreach ($context->classCandidates($part) as $candidate) {
			if ($candidate !== $part) {
				$ordered[] = $candidate;
			}
		}
		foreach (array_unique($ordered) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				return $candidate;
			}
		}
		$short = $this->repository->findClassByShortName($part);
		if ($short !== null) {
			return (string) $short['fqcn'];
		}
		return $this->repository->classByName($part) !== null ? $part : null;
	}

	/**
	 * @param array<int, string> $candidates
	 * @return array<int, string>
	 */
	private function existing(array $candidates): array
	{
		$result = [];
		foreach (array_unique($candidates) as $candidate) {
			if ($this->repository->classByName($candidate) !== null) {
				$result[] = $candidate;
			}
		}
		return $result;
	}

	private function namespaceOf(string $fqcn): string
	{
		$segments = explode('\\', ltrim($fqcn, '\\'));
		array_pop($segments);
		return implode('\\', $segments);
	}

	private function isBuiltin(string $type): bool
	{
		return in_array(strtolower($type), [
			'int', 'integer', 'float', 'double', 'string', 'bool', 'boolean', 'array',
			'object', 'mixed', 'void', 'null', 'never', 'callable', 'iterable', 'self',
			'static', 'parent', 'false', 'true',
		], true);
	}
}
