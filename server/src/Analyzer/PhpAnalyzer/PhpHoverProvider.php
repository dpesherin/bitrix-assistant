<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\DocBlock;
use BitrixLsp\Support\HoverColor;
use BitrixLsp\Support\TextDocument;

/** Hover по PHP-классу и методу: сигнатура, возвращаемый тип, doc-блок, файл. */
final class PhpHoverProvider
{
	public function __construct(
		private readonly Repository $repository,
		private readonly PhpMethodResolver $resolver,
	) {
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function provide(TextDocument $document, int $offset): ?array
	{
		$variable = $this->componentVariableHover($document, $offset);
		if ($variable !== null) {
			return $variable;
		}
		$declaration = $this->declarationMemberHover($document, $offset);
		if ($declaration !== null) {
			return $declaration;
		}
		$local = $this->localVariableHover($document, $offset);
		if ($local !== null) {
			return $local;
		}

		$earlyToken = PhpUseMap::tokenAt($document->text, $offset);
		if (
			$earlyToken !== null &&
			$earlyToken['start'] > 0 &&
			$document->text[$earlyToken['start'] - 1] === '$'
		) {
			return null;
		}

		$keyword = PhpKeywordHover::provide($document, $offset);
		if ($keyword !== null) {
			return $keyword;
		}

		$declaration = $this->methodDeclarationHover($document, $offset);
		if ($declaration !== null) {
			return $declaration;
		}

		$reference = $this->resolver->resolve($document, $offset);
		if ($reference !== null) {
			return $this->methodHover($document, $reference);
		}

		$memberAccess = $this->resolver->resolveMemberTarget($document, $offset);
		$target = $memberAccess;
		if ($target !== null) {
			if ($target['operator'] === '->' || $target['operator'] === '::$') {
				$property = $this->repository->findPropertyInHierarchy($target['class'], $target['token']['name']);
				if ($property !== null) {
					return $this->propertyHover($document, $target['class'], $property, $target['token']);
				}
			}
			if ($target['operator'] === '::') {
				$constant = $this->repository->findConstantInHierarchy($target['class'], $target['token']['name']);
				if ($constant !== null) {
					return $this->constantHover($document, $target['class'], $constant, $target['token']);
				}
			}
		}

		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		// `$obj->in_array()` / `Class::foo()`: это обращение к члену, а не вызов
		// глобальной функции — иначе hover показывал чужую встроенную функцию.
		if ($memberAccess !== null) {
			return null;
		}
		$class = $this->findClass($document->text, $token['name']);
		if ($class === null) {
			$native = PhpNativeCatalog::find($token['name']);
			if ($native !== null) {
				return $this->nativeClassHover($document, $native, $token);
			}
			$function = $this->repository->findFunction($token['name']);
			if ($function !== null) {
				return $this->functionHover($document, $function, $token);
			}
			$constant = $this->repository->findGlobalConstant($token['name']);
			if ($constant !== null) {
				return $this->globalConstantHover($document, $constant, $token);
			}
			return null;
		}
		$docInfo = DocBlock::parse((string) ($class['doc'] ?? ''));
		$meta = '`' . (string) $class['kind'] . '`';
		if (!empty($class['module'])) {
			$meta .= ' · модуль `' . (string) $class['module'] . '`';
		}
		if (!empty($class['is_orm'])) {
			$meta .= ' · ORM-таблица';
		}
		$lines = [HoverColor::span((string) $class['fqcn'], 'class'), $meta];
		$declaration = (string) $class['kind'] . ' ' . (string) $class['name'];
		if (!empty($class['extends'])) {
			$declaration .= ' extends ' . (string) $class['extends'];
		}
		$lines[] = HoverColor::signature($declaration);
		$constructor = $this->constructorSignature((string) $class['fqcn']);
		if ($constructor !== null) {
			$lines[] = HoverColor::signature($constructor);
		}
		if (!empty($class['extends'])) {
			$lines[] = "**Наследует:** `{$class['extends']}`";
		}
		if (!empty($class['deprecated'])) {
			$lines[] = '**@deprecated**' . ($docInfo['deprecatedNote'] !== null ? ' — ' . $docInfo['deprecatedNote'] : '');
		}
		if ($docInfo['description'] !== '') {
			$lines[] = "**Описание**\n\n" . mb_substr($docInfo['description'], 0, 1200);
		}
		$lines[] = HoverColor::sourceLine((string) $class['file'], (int) $class['line'], false);
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($token['start'], $token['end']),
		];
	}

	/**
	 * `$arResult` / `$arParams` в шаблоне компонента.
	 *
	 * @return array<string, mixed>|null
	 */
	private function componentVariableHover(TextDocument $document, int $offset): ?array
	{
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null || ($token['name'] !== 'arResult' && $token['name'] !== 'arParams')) {
			return null;
		}
		$before = substr($document->text, max(0, $token['start'] - 8), min(8, $token['start']));
		$direct = $token['start'] > 0 && $document->text[$token['start'] - 1] === '$';
		$thisMember = str_ends_with($before, '$this->');
		if (!$direct && !$thisMember) {
			return null;
		}
		$path = \BitrixLsp\Support\Paths::uriToPath($document->uri);
		$component = $path !== null ? $this->repository->componentForFile($path) : null;
		if ($component === null) {
			return null;
		}
		$name = (string) ($component['name'] ?? '');
		$lines = $token['name'] === 'arResult'
			? [
				HoverColor::span('$arResult', 'variable'),
				'`результат компонента` · `' . $name . '`',
				'Результат, подготовленный компонентом в `executeComponent()` и переданный в шаблон.',
			]
			: [
				HoverColor::span('$arParams', 'variable'),
				'`параметры компонента` · `' . $name . '`',
				'Входные параметры компонента из `.parameters.php` и вызова `$APPLICATION->IncludeComponent()`.',
			];
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($direct ? $token['start'] - 1 : $token['start'], $token['end']),
		];
	}

	/**
	 * Hover на объявлении свойства/константы класса.
	 *
	 * @return array<string, mixed>|null
	 */
	private function declarationMemberHover(TextDocument $document, int $offset): ?array
	{
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		$context = PhpDocumentContext::create($document);
		$class = $context->classAt($offset);
		if ($class === null) {
			return null;
		}
		$before = substr($document->text, 0, $token['start']);
		if (preg_match('/\bconst\s+$/', $before) === 1) {
			$constant = $this->repository->findConstantInHierarchy($class['fqcn'], $token['name']);
			return $constant !== null ? $this->constantHover($document, $class['fqcn'], $constant, $token) : null;
		}
		if ($token['start'] > 0 && $document->text[$token['start'] - 1] === '$') {
			$lineStart = strrpos(substr($document->text, 0, $token['start']), "\n");
			$lineStart = $lineStart === false ? 0 : $lineStart + 1;
			$line = substr($document->text, $lineStart, $token['start'] - $lineStart);
			if (preg_match('/^\s*(?:(?:public|protected|private|static|readonly|var)\s+)+(?:[?\\\\A-Za-z0-9_|]+\s+)?\$\s*$/', $line) === 1) {
				$property = $this->repository->findPropertyInHierarchy($class['fqcn'], $token['name']);
				return $property !== null ? $this->propertyHover($document, $class['fqcn'], $property, $token) : null;
			}
		}
		return null;
	}

	/**
	 * Локальная переменная или параметр: тип, @var, объявление.
	 *
	 * @return array<string, mixed>|null
	 */
	/**
	 * Склеивает блоки карточки горизонтальными разделителями; заголовок и строка
	 * «метод · public · класс» остаются рядом.
	 *
	 * @param array<int, string> $lines
	 */
	private static function renderSections(array $lines): string
	{
		$lines = array_values(array_filter($lines, static fn ($line): bool => is_string($line) && trim($line) !== ''));
		if (count($lines) > 1 && str_starts_with($lines[1], '`')) {
			$lines = array_merge([$lines[0] . "\n\n" . $lines[1]], array_slice($lines, 2));
		}
		return implode("\n\n---\n\n", $lines);
	}

	private function localVariableHover(TextDocument $document, int $offset): ?array
	{
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if (
			$token === null ||
			$token['start'] === 0 ||
			$document->text[$token['start'] - 1] !== '$' ||
			$token['name'] === 'this'
		) {
			return null;
		}
		$name = $token['name'];
		$before = substr($document->text, 0, $offset);
		$parameter = $this->parameterType($document->text, $offset, $name);
		$var = $this->varAnnotation($before, $name);
		$global = PhpDocumentContext::globalClass($name);
		$type = $parameter ?? $var ?? $this->assignmentType($document->text, $offset, $name, 0) ?? $global ?? 'mixed';
		$kind = $parameter !== null
			? 'параметр'
			: ($global !== null && $var === null ? 'глобальная переменная' : 'локальная переменная');
		$lines = [
			HoverColor::span('$' . $name, 'variable'),
			"`({" . $kind . "})` " . HoverColor::span($type, 'class') . ' ' . HoverColor::span('$' . $name, 'variable'),
			HoverColor::signature($type . ' $' . $name),
		];
		if ($var !== null) {
			$lines[] = "`@var` " . HoverColor::span($var, 'class') . ' ' . HoverColor::span('$' . $name, 'variable');
		}
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($token['start'] - 1, $token['end']),
		];
	}

	private function parameterType(string $text, int $offset, string $name): ?string
	{
		if (preg_match_all('/\bfunction\s+&?\s*[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/s', $text, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		$best = null;
		foreach ($matches[0] as $index => $match) {
			if ($match[1] <= $offset) {
				$best = $matches[1][$index][0];
			}
		}
		if ($best === null) {
			return null;
		}
		if (preg_match('/(?:^|,)\s*([?\\\\A-Za-z0-9_|]+)\s+&?\s*(?:\.\.\.)?\s*\$' . preg_quote($name, '/') . '\b/', $best, $match) === 1) {
			return trim($match[1]);
		}
		return null;
	}

	private function varAnnotation(string $before, string $name): ?string
	{
		$start = strrpos($before, '/**');
		if ($start === false) {
			return null;
		}
		$doc = substr($before, $start);
		if (preg_match('/@var\s+([^\s*]+)\s+\$' . preg_quote($name, '/') . '\b/', $doc, $match) === 1) {
			return trim($match[1]);
		}
		return null;
	}

	private function assignmentType(string $text, int $offset, string $name, int $depth): ?string
	{
		if ($depth > 3) {
			return null;
		}
		$pattern = '/\$' . preg_quote($name, '/') . '\s*=\s*([^;]+);/s';
		if (preg_match_all($pattern, $text, $matches, PREG_OFFSET_CAPTURE) === false) {
			return null;
		}
		$rhs = null;
		foreach ($matches[0] as $index => $match) {
			if ($match[1] <= $offset) {
				$rhs = $matches[1][$index][0] ?? null;
			}
		}
		if (!is_string($rhs)) {
			return null;
		}
		if (preg_match('/\bnew\s+([\\\\A-Za-z_][\\\\A-Za-z0-9_]*)/', $rhs, $match) === 1) {
			return trim($match[1]);
		}
		if (preg_match('/^\s*\[/', $rhs) === 1 || preg_match('/^\s*array\s*\(/', $rhs) === 1) {
			return 'array';
		}
		if (preg_match('/^\s*[\'"].*[\'"]\s*$/s', $rhs) === 1) {
			return 'string';
		}
		if (preg_match('/^\s*-?\d+\s*$/', $rhs) === 1) {
			return 'int';
		}
		if (preg_match('/^\s*(true|false)\s*$/i', $rhs) === 1) {
			return 'bool';
		}
		if (preg_match('/\$([A-Za-z_][A-Za-z0-9_]*)/', $rhs, $match) === 1) {
			$other = $match[1];
			if ($other !== $name) {
				return $this->parameterType($text, $offset, $other)
					?? $this->assignmentType($text, $offset, $other, $depth + 1);
			}
		}
		return null;
	}

	/**
	 * Hover по имени в объявлении `function foo(...)`: показывает сигнатуру
	 * и, если у своего метода нет doc-блока, описание из родителя/интерфейса.
	 *
	 * @return array<string, mixed>|null
	 */
	private function methodDeclarationHover(TextDocument $document, int $offset): ?array
	{
		$context = PhpDocumentContext::create($document);
		$current = $context->classAt($offset);
		$methodAt = $context->methodAt($offset);
		if ($current === null || $methodAt === null) {
			return null;
		}
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null || $token['name'] !== $methodAt['name']) {
			return null;
		}
		if ($token['start'] < $methodAt['start'] || $token['end'] > $methodAt['end']) {
			return null;
		}

		$row = $this->repository->classByName($current['fqcn']);
		if ($row === null) {
			return null;
		}
		$method = $this->repository->findMethodInHierarchy($current['fqcn'], $methodAt['name']);
		if ($method === null) {
			return null;
		}
		$inherited = null;
		$parent = $this->repository->parentClassName($row);
		if ($parent !== null) {
			$inherited = $this->repository->findMethodInHierarchy($parent, $methodAt['name']);
		}
		return $this->methodHover(
			$document,
			['token' => $token, 'class' => $current['fqcn'], 'method' => $method],
			$inherited,
			$parent,
		);
	}

	/**
	 * @param array{token: array{name: string, start: int, end: int}, class: string, method: array<string, mixed>} $reference
	 * @param array<string, mixed>|null $inherited
	 * @return array<string, mixed>
	 */
	private function methodHover(TextDocument $document, array $reference, ?array $inherited = null, ?string $parent = null): array
	{
		$method = $reference['method'];
		$class = $reference['class'];
		$modifiers = trim(
			(string) ($method['visibility'] ?? 'public')
			. (($method['is_static'] ?? 0) ? ' static' : '')
			. (($method['is_abstract'] ?? 0) ? ' abstract' : ''),
		);
		$docInfo = DocBlock::parse((string) ($method['doc'] ?? ''));
		$inheritedDoc = $inherited !== null ? DocBlock::parse((string) ($inherited['doc'] ?? '')) : null;
		if ($docInfo['description'] === '' && $inheritedDoc !== null && $inheritedDoc['description'] !== '') {
			$docInfo = $inheritedDoc;
		}
		$signature = (string) ($method['signature'] ?? ($method['name'] . '()'));
		$lines = [
			HoverColor::span((string) $method['name'] . '()', 'method'),
			"`метод · {$modifiers}` · `{$class}`",
		];
		$fullyQualified = '\\' . ltrim((string) $class, '\\') . '::' . $signature;
		$lines[] = HoverColor::signature($fullyQualified);

		if ($inherited !== null && $parent !== null) {
			$lines[] = "**Переопределяет:** `{$parent}::{$method['name']}()`";
		}
		$description = $docInfo['description'];
		if ($description !== '') {
			$lines[] = "**Описание**\n\n" . mb_substr($description, 0, 1200);
		}

		$params = json_decode((string) ($method['params_json'] ?? '[]'), true);
		if (is_array($params) && $params !== []) {
			$paramsBlock = DocBlock::renderParams($params, $docInfo['params'], $docInfo['paramTypes'] ?? []);
			if ($paramsBlock !== '') {
				$lines[] = $paramsBlock;
			}
		}

		$returnType = trim((string) ($method['return_type'] ?? ''));
		if ($returnType === '' && $docInfo['return'] !== null) {
			$returnType = $docInfo['return'];
		}
		if ($returnType !== '') {
			$lines[] = '**Возвращает:** ' . HoverColor::span($returnType, 'class');
		}
		if (!empty($method['deprecated']) || $docInfo['deprecated']) {
			$lines[] = '**@deprecated**' . ($docInfo['deprecatedNote'] !== null ? ' — ' . $docInfo['deprecatedNote'] : '');
		}
		$lines[] = HoverColor::sourceLine((string) $method['file'], (int) $method['line'], false);
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($reference['token']['start'], $reference['token']['end']),
		];
	}

	/**
	 * @param array<string, mixed> $property
	 * @param array{name: string, start: int, end: int} $token
	 * @return array<string, mixed>
	 */
	private function propertyHover(TextDocument $document, string $class, array $property, array $token): array
	{
		$type = trim((string) ($property['type'] ?? ''));
		$modifiers = (string) ($property['visibility'] ?? 'public')
			. ((int) ($property['is_static'] ?? 0) === 1 ? ' static' : '');
		$declaration = trim($modifiers . ' ' . ($type !== '' ? $type . ' ' : '') . '$' . (string) $property['name']);
		$lines = [
			HoverColor::span((string) $property['name'], 'variable'),
			"`свойство · {$modifiers}` · `{$class}`",
			HoverColor::signature($declaration),
		];
		$docInfo = DocBlock::parse((string) ($property['doc'] ?? ''));
		if ($docInfo['description'] !== '') {
			$lines[] = "**Описание**\n\n" . mb_substr($docInfo['description'], 0, 1000);
		}
		if (!empty($property['default_value'])) {
			$lines[] = '**По умолчанию:** ' . HoverColor::span((string) $property['default_value'], 'value');
		}
		$lines[] = HoverColor::sourceLine((string) $property['file'], (int) $property['line'], false);
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($token['start'], $token['end']),
		];
	}

	/**
	 * @param array<string, mixed> $constant
	 * @param array{name: string, start: int, end: int} $token
	 * @return array<string, mixed>
	 */
	private function constantHover(TextDocument $document, string $class, array $constant, array $token): array
	{
		$value = trim((string) ($constant['value'] ?? ''));
		$declaration = 'const ' . (string) $constant['name'] . ($value !== '' ? ' = ' . $value : '');
		$lines = [
			HoverColor::span((string) $constant['name'], 'constant'),
			"`константа` · `{$class}`",
			HoverColor::signature($declaration),
		];
		$docInfo = DocBlock::parse((string) ($constant['doc'] ?? ''));
		if ($docInfo['description'] !== '') {
			$lines[] = "**Описание**\n\n" . mb_substr($docInfo['description'], 0, 1000);
		}
		$lines[] = HoverColor::sourceLine((string) $constant['file'], (int) $constant['line'], false);
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($token['start'], $token['end']),
		];
	}

	/**
	 * @param array<string, mixed> $function
	 * @param array{name: string, start: int, end: int} $token
	 * @return array<string, mixed>
	 */
	private function functionHover(TextDocument $document, array $function, array $token): array
	{
		$docInfo = DocBlock::parse((string) ($function['doc'] ?? ''));
		$lines = [
			HoverColor::span((string) $function['name'] . '()', 'function'),
			"`глобальная функция` · `{$function['fqcn']}`",
			HoverColor::signature((string) ($function['signature'] ?? ($function['name'] . '()'))),
		];
		if ($docInfo['description'] !== '') {
			$lines[] = "**Описание**\n\n" . mb_substr($docInfo['description'], 0, 1200);
		}
		$params = json_decode((string) ($function['params_json'] ?? '[]'), true);
		if (is_array($params) && $params !== []) {
			$paramsBlock = DocBlock::renderParams($params, $docInfo['params'], $docInfo['paramTypes'] ?? []);
			if ($paramsBlock !== '') {
				$lines[] = $paramsBlock;
			}
		}
		$returnType = trim((string) ($function['return_type'] ?? ''));
		if ($returnType === '' && $docInfo['return'] !== null) {
			$returnType = $docInfo['return'];
		}
		if ($returnType !== '') {
			$lines[] = '**Возвращает:** ' . HoverColor::span($returnType, 'class');
		}
		if (!empty($function['deprecated']) || $docInfo['deprecated']) {
			$lines[] = '**@deprecated**' . ($docInfo['deprecatedNote'] !== null ? ' — ' . $docInfo['deprecatedNote'] : '');
		}
		$lines[] = HoverColor::sourceLine((string) $function['file'], (int) $function['line'], false);
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($token['start'], $token['end']),
		];
	}

	/**
	 * @param array<string, mixed> $constant
	 * @param array{name: string, start: int, end: int} $token
	 * @return array<string, mixed>
	 */
	private function globalConstantHover(TextDocument $document, array $constant, array $token): array
	{
		$value = trim((string) ($constant['value'] ?? ''));
		$lines = [
			HoverColor::span((string) $constant['name'], 'constant'),
			'`глобальная константа`',
			HoverColor::signature("define('" . $constant['name'] . "'" . ($value !== '' ? ', ' . $value : '') . ");"),
		];
		$docInfo = DocBlock::parse((string) ($constant['doc'] ?? ''));
		if ($docInfo['description'] !== '') {
			$lines[] = "**Описание**\n\n" . mb_substr($docInfo['description'], 0, 1000);
		}
		$lines[] = HoverColor::sourceLine((string) $constant['file'], (int) $constant['line'], false);
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($token['start'], $token['end']),
		];
	}

	/**
	 * @return array<string, mixed>|null
	 */
	private function findClass(string $text, string $token): ?array
	{
		$uses = PhpUseMap::parse($text);
		$candidates = array_unique([
			PhpUseMap::resolve($token, $uses),
			ltrim($token, '\\'),
		]);
		foreach ($candidates as $candidate) {
			$class = $this->repository->classByName($candidate);
			if ($class !== null) {
				return $class;
			}
		}
		return null;
	}

	/**
	 * Hover для встроенного класса PHP (его нет в индексе: исходников в проекте нет).
	 *
	 * @param array{kind: string, doc: string, ctor: array{signature: string, params: array<int, array<string, mixed>>, doc: string}|null} $native
	 * @param array{name: string, start: int, end: int} $token
	 * @return array<string, mixed>
	 */
	private function nativeClassHover(TextDocument $document, array $native, array $token): array
	{
		$lines = [
			HoverColor::span('\\' . ltrim($token['name'], '\\'), 'class'),
			'`' . $native['kind'] . '` · встроенный класс PHP',
		];
		if ($native['ctor'] !== null) {
			$lines[] = HoverColor::signature($native['ctor']['signature']);
		}
		$lines[] = $native['doc'];
		return [
			'contents' => ['kind' => 'markdown', 'value' => self::renderSections($lines)],
			'range' => $document->range($token['start'], $token['end']),
		];
	}

	/**
	 * Сигнатура конструктора класса: из индекса (включая предков), а если
	 * цепочка упирается во встроенный класс PHP — оттуда.
	 */
	private function constructorSignature(string $fqcn): ?string
	{
		$method = $this->repository->findMethodInHierarchy($fqcn, '__construct');
		if ($method !== null) {
			return (string) ($method['signature'] ?? '__construct()');
		}
		$current = $fqcn;
		$seen = [];
		for ($guard = 0; $guard < 50; $guard++) {
			if (isset($seen[$current])) {
				break;
			}
			$seen[$current] = true;
			$class = $this->repository->classByName($current);
			if ($class === null) {
				break;
			}
			$parent = $this->repository->parentClassName($class);
			if ($parent === null) {
				break;
			}
			$native = PhpNativeCatalog::constructorOf($parent);
			if ($native !== null) {
				return (string) $native['signature'];
			}
			$current = $parent;
		}
		$native = PhpNativeCatalog::constructorOf($fqcn);
		return $native === null ? null : (string) $native['signature'];
	}
}
