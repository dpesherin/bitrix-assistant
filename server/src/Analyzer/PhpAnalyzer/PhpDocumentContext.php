<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * Лёгкий контекст PHP-документа: классы, методы, параметры, `use`-алиасы.
 * Нужен, чтобы понимать `$this->method()`, `Class::method()` и типы переменных.
 */
final class PhpDocumentContext
{
	/** @var array<int, array{name: string, fqcn: string, namespace: string, extends: ?string, start: int, end: int, methods: array<int, array{name: string, start: int, end: int, params: array<string, string>}>}> */
	private array $classes = [];
	/** @var array<string, string> */
	private array $uses = [];
	private string $namespace = '';
	private string $masked;
	private string $text;

	/** Глобальные переменные ядра Битрикса: имя => класс. */
	private const GLOBAL_VARIABLES = [
		'APPLICATION' => 'CMain',
		'USER' => 'CUser',
		'DB' => 'CDatabase',
	];

	/** Класс известной глобальной переменной ядра (`$APPLICATION`, `$GLOBALS['USER']`). */
	public static function globalClass(string $name): ?string
	{
		return self::GLOBAL_VARIABLES[$name] ?? null;
	}

	private function __construct(string $text)
	{
		$this->text = $text;
		$this->masked = JsScanner::maskCode(PhpSource::phpOnly($text), true);
		if (preg_match('/\bnamespace\s+([A-Za-z0-9_\\\\]+)\s*[;{]/', $this->masked, $match) === 1) {
			$this->namespace = ltrim($match[1], '\\');
		}
		$this->uses = PhpUseMap::parse($text);
		$this->parseClasses();
	}

	public static function create(TextDocument $document): self
	{
		return new self($document->text);
	}

	public function namespaceName(): string
	{
		return $this->namespace;
	}

	public function text(): string
	{
		return $this->text;
	}

	/**
	 * @return array<string, string>
	 */
	public function uses(): array
	{
		return $this->uses;
	}

	/**
	 * @return array{name: string, fqcn: string, namespace: string, extends: ?string, start: int, end: int, methods: array<int, array{name: string, start: int, end: int, params: array<string, string>}>}|null
	 */
	public function classAt(int $offset): ?array
	{
		$best = null;
		foreach ($this->classes as $class) {
			if ($offset >= $class['start'] && $offset <= $class['end']) {
				if ($best === null || ($class['end'] - $class['start']) < ($best['end'] - $best['start'])) {
					$best = $class;
				}
			}
		}
		return $best;
	}

	/**
	 * @return array{name: string, start: int, end: int, params: array<string, string>}|null
	 */
	public function methodAt(int $offset): ?array
	{
		$class = $this->classAt($offset);
		if ($class === null) {
			return null;
		}
		foreach ($class['methods'] as $method) {
			if ($offset >= $method['start'] && $offset <= $method['end']) {
				return $method;
			}
		}
		return null;
	}

	/** Внутри тела метода (между `{` после сигнатуры и парной `}`). */
	public function isInMethodBody(int $offset): bool
	{
		$class = $this->classAt($offset);
		if ($class === null) {
			return false;
		}
		foreach ($class['methods'] as $method) {
			$bodyOpen = strpos($this->masked, '{', $method['end']);
			if ($bodyOpen === false) {
				continue;
			}
			$bodyClose = $this->matchingBrace($bodyOpen);
			if ($offset > $bodyOpen && $offset <= $bodyClose) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Кандидаты FQCN: алиас из `use`, текущий namespace, глобальное имя.
	 *
	 * @return array<int, string>
	 */
	public function classCandidates(string $name): array
	{
		$name = trim($name);
		if ($name === '') {
			return [];
		}
		if (str_starts_with($name, '\\')) {
			return [ltrim($name, '\\')];
		}
		$candidates = [];
		$segments = explode('\\', $name);
		$first = $segments[0];
		if (isset($this->uses[$first])) {
			$segments[0] = $this->uses[$first];
			$candidates[] = implode('\\', $segments);
		}
		if (str_contains($name, '\\')) {
			$candidates[] = $name;
			if ($this->namespace !== '') {
				$candidates[] = $this->namespace . '\\' . $name;
			}
		} else {
			if ($this->namespace !== '') {
				$candidates[] = $this->namespace . '\\' . $name;
			}
			$candidates[] = $name;
		}
		return array_values(array_unique(array_filter($candidates)));
	}

	/**
	 * Тип переменной: `$this`, параметр текущего метода или `$x = new Type()`.
	 *
	 * @return array<int, string> кандидаты FQCN
	 */
	public function typeCandidatesOfVariable(string $variable, int $offset): array
	{
		$variable = ltrim($variable, '$');
		if ($variable === '') {
			return [];
		}
		if ($variable === 'this') {
			$class = $this->classAt($offset);
			return $class !== null ? [$class['fqcn']] : [];
		}
		$class = $this->classAt($offset);
		if ($class !== null) {
			$method = $this->methodAt($offset);
			if ($method !== null && isset($method['params'][$variable])) {
				$type = $method['params'][$variable];
				$candidates = $this->typeCandidates($type);
				if ($candidates !== []) {
					return $candidates;
				}
			}
		}

		$params = $this->functionParamsAt($offset);
		if (isset($params[$variable])) {
			$candidates = $this->typeCandidates($params[$variable]);
			if ($candidates !== []) {
				return $candidates;
			}
		}

		$pattern = '/\$' . preg_quote($variable, '/') . '\s*=\s*new\s+([\\\\A-Za-z_][\\\\A-Za-z0-9_]*)/';
		if (preg_match_all($pattern, $this->text, $matches, PREG_OFFSET_CAPTURE) > 0) {
			$found = null;
			foreach ($matches[0] as $index => $match) {
				if ($match[1] >= $offset) {
					break;
				}
				$found = $matches[1][$index][0];
			}
			if ($found !== null) {
				return $this->classCandidates($found);
			}
		}

		// `$APPLICATION`, `$USER`, `$DB` не объявляются в коде — это глобальные
		// переменные ядра, их типы известны.
		$global = self::globalClass($variable);
		return $global !== null ? [$global] : [];
	}

	/**
	 * Параметры функции по позиции курсора, включая глобальные функции
	 * (у методов параметры уже разобраны в `methodAt`).
	 *
	 * @return array<string, string> имя переменной => тип
	 */
	public function functionParamsAt(int $offset): array
	{
		if (preg_match_all('/function\s+&?\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/', $this->masked, $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		$best = [];
		foreach ($matches[0] as $match) {
			$openParen = $match[1] + strlen($match[0]) - 1;
			$closeParen = $this->matchingParen($openParen);
			if ($closeParen <= $openParen || $offset <= $closeParen) {
				continue; // курсор в объявлении или до него
			}
			$brace = strpos($this->masked, '{', $closeParen);
			if ($brace === false) {
				continue;
			}
			$bodyClose = $this->matchingBrace($brace);
			if ($offset <= $brace || $offset >= $bodyClose) {
				continue;
			}
			$params = $this->parseParams(substr($this->masked, $openParen + 1, $closeParen - $openParen - 1));
			if (count($params) > count($best)) {
				$best = $params;
			}
		}
		return $best;
	}

	/**
	 * Кандидаты FQCN по строке типа (`?Foo`, `Foo|null`, `\A\B`).
	 *
	 * @return array<int, string>
	 */
	public function typeCandidates(string $type): array
	{
		$type = trim($type, " \t\n\r\0\x0B?");
		$parts = preg_split('/[|&]/', $type) ?: [];
		$result = [];
		foreach ($parts as $part) {
			$part = trim($part, " \t\n\r\0\x0B?\\");
			if ($part === '' || self::isBuiltinType($part)) {
				continue;
			}
			foreach ($this->classCandidates($part) as $candidate) {
				$result[] = $candidate;
			}
		}
		return array_values(array_unique($result));
	}

	private static function isBuiltinType(string $type): bool
	{
		$builtins = [
			'int', 'integer', 'float', 'double', 'string', 'bool', 'boolean', 'array',
			'object', 'mixed', 'void', 'null', 'never', 'callable', 'iterable', 'self',
			'static', 'parent', 'false', 'true',
		];
		return in_array(strtolower($type), $builtins, true);
	}

	private function parseClasses(): void
	{
		$pattern = '/\b(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+'
			. '([A-Za-z_][A-Za-z0-9_]*)([^{;]*)\{/';
		if (preg_match_all($pattern, $this->masked, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE) === false) {
			return;
		}
		foreach ($matches as $match) {
			$name = $match[2][0];
			$header = $match[3][0] ?? '';
			$bodyOpen = $match[0][1] + strlen($match[0][0]) - 1;
			$bodyClose = $this->matchingBrace($bodyOpen);
			$extends = null;
			if (preg_match('/\bextends\s+([A-Za-z0-9_\\\\]+)/', $header, $extendsMatch) === 1) {
				$extends = ltrim($extendsMatch[1], '\\');
			}
			$fqcn = $this->namespace !== '' ? $this->namespace . '\\' . $name : $name;
			$methods = $this->parseMethods($bodyOpen, $bodyClose);
			$this->classes[] = [
				'name' => $name,
				'fqcn' => $fqcn,
				'namespace' => $this->namespace,
				'extends' => $extends,
				'start' => $match[0][1],
				'end' => $bodyClose,
				'methods' => $methods,
			];
		}
	}

	/**
	 * @return array<int, array{name: string, start: int, end: int, params: array<string, string>}>
	 */
	private function parseMethods(int $bodyOpen, int $bodyClose): array
	{
		$methods = [];
		$body = substr($this->masked, $bodyOpen, max(0, $bodyClose - $bodyOpen));
		if (preg_match_all('/function\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/', $body, $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		foreach ($matches[0] as $index => $match) {
			$name = $matches[1][$index][0];
			$openParen = $bodyOpen + $match[1] + strlen($match[0]) - 1;
			$closeParen = $this->matchingParen($openParen);
			$params = $this->parseParams(substr($this->masked, $openParen + 1, max(0, $closeParen - $openParen - 1)));
			$methods[] = [
				'name' => $name,
				'start' => $bodyOpen + $match[1],
				'end' => $closeParen,
				'params' => $params,
			];
		}
		return $methods;
	}

	/**
	 * @return array<string, string> имя переменной => тип
	 */
	private function parseParams(string $paramsText): array
	{
		$params = [];
		foreach (explode(',', $paramsText) as $raw) {
			if (preg_match('/(?:(?<type>[?\\\\A-Za-z0-9_|]+)\s+)?(?:&)?(?:\.\.\.)?\$(?<name>[A-Za-z_][A-Za-z0-9_]*)/', $raw, $match) !== 1) {
				continue;
			}
			$type = $match['type'] ?? '';
			if ($type === '') {
				continue;
			}
			$params[$match['name']] = $type;
		}
		return $params;
	}

	private function matchingBrace(int $open): int
	{
		$depth = 0;
		$length = strlen($this->masked);
		for ($i = $open; $i < $length; $i++) {
			$ch = $this->masked[$i];
			if ($ch === '{') {
				$depth++;
			} elseif ($ch === '}') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}

	private function matchingParen(int $open): int
	{
		$depth = 0;
		$length = strlen($this->masked);
		for ($i = $open; $i < $length; $i++) {
			$ch = $this->masked[$i];
			if ($ch === '(') {
				$depth++;
			} elseif ($ch === ')') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}
}
