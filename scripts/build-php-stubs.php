<?php

declare(strict_types=1);

/**
 * Генерирует server/data/php-stubs.json — сигнатуры встроенных функций и классов PHP
 * из текущего рантайма (reflection). Запускается встроенным PHP 8.4 при сборке:
 *
 *   server/bin/php-darwin-arm64 scripts/build-php-stubs.php
 *
 * Файл импортируется индексатором расширения как псевдо-исходники `<phpstub>`:
 * подсказки, hover и сигнатуры по stdlib работают без php.net и без встроенных
 * подсказок VS Code (которые мы отключаем).
 */

$out = $argv[1] ?? __DIR__ . '/../server/data/php-stubs.json';

/** Строковое представление типа. */
function stubType(?ReflectionType $type): ?string
{
	if ($type === null) {
		return null;
	}
	if ($type instanceof ReflectionNamedType) {
		$name = $type->getName();
		if ($type->allowsNull() && $name !== 'mixed' && $name !== 'null') {
			return '?' . $name;
		}
		return $name;
	}
	if ($type instanceof ReflectionUnionType) {
		return implode('|', array_map(static fn (ReflectionType $t): string => (string) stubType($t), $type->getTypes()));
	}
	if ($type instanceof ReflectionIntersectionType) {
		return implode('&', array_map(static fn (ReflectionType $t): string => (string) stubType($t), $type->getTypes()));
	}
	return null;
}

/** Короткое значение по умолчанию. */
function stubDefault(ReflectionParameter $param): ?string
{
	if (!$param->isDefaultValueAvailable()) {
		// Необязательный параметр без доступного значения (часто у встроенных
		// функций): помечаем как `null`, иначе он считается обязательным и
		// вызовы вида `array_keys($a)` дают «ожидается аргументов 2–3».
		return $param->isOptional() ? 'null' : null;
	}
	try {
		$value = $param->getDefaultValue();
	} catch (Throwable) {
		return null;
	}
	if ($value === null) {
		return 'null';
	}
	if (is_bool($value)) {
		return $value ? 'true' : 'false';
	}
	if (is_int($value) || is_float($value)) {
		return (string) $value;
	}
	if (is_string($value)) {
		$short = strlen($value) > 40 ? substr($value, 0, 40) . '…' : $value;
		return "'" . str_replace("'", "\\'", $short) . "'";
	}
	if (is_array($value)) {
		return '[]';
	}
	if (is_object($value)) {
		return get_class($value) . '::class';
	}
	return null;
}

/** @return array<int, array<string, mixed>> */
function stubParams(ReflectionFunctionAbstract $fn): array
{
	$params = [];
	foreach ($fn->getParameters() as $param) {
		$entry = [
			'name' => $param->getName(),
			'variadic' => $param->isVariadic(),
			'byRef' => $param->isPassedByReference(),
		];
		$type = stubType($param->getType());
		if ($type !== null) {
			$entry['type'] = $type;
		}
		$default = stubDefault($param);
		if ($default !== null) {
			$entry['default'] = $default;
		}
		$params[] = $entry;
	}
	return $params;
}

/** Сигнатура вида `name(type $a, ?int $b = null): string`. */
function stubSignature(string $name, ReflectionFunctionAbstract $fn): string
{
	$parts = [];
	foreach ($fn->getParameters() as $param) {
		$label = '';
		$type = stubType($param->getType());
		if ($type !== null) {
			$label .= $type . ' ';
		}
		if ($param->isPassedByReference()) {
			$label .= '&';
		}
		if ($param->isVariadic()) {
			$label .= '...';
		}
		$label .= '$' . $param->getName();
		$default = stubDefault($param);
		if ($default !== null) {
			$label .= ' = ' . $default;
		}
		$parts[] = $label;
	}
	$return = stubType($fn->getReturnType());
	return $name . '(' . implode(', ', $parts) . ')' . ($return !== null ? ': ' . $return : '');
}

$functions = [];
foreach (get_defined_functions()['internal'] as $name) {
	try {
		$fn = new ReflectionFunction($name);
	} catch (Throwable) {
		continue;
	}
	if ($fn->isDeprecated()) {
		// устаревшие тоже полезны (диагностика), но помечаем флагом
	}
	$functions[] = [
		'name' => $name,
		'signature' => stubSignature($name, $fn),
		'returnType' => stubType($fn->getReturnType()),
		'params' => stubParams($fn),
		'deprecated' => $fn->isDeprecated() ? 1 : 0,
	];
}

$classes = [];
$symbols = array_merge(get_declared_classes(), get_declared_interfaces(), function_exists('get_declared_enums') ? [] : []);
foreach ($symbols as $class) {
	try {
		$ref = new ReflectionClass($class);
	} catch (Throwable) {
		continue;
	}
	if ($ref->isAnonymous()) {
		continue;
	}
	$parent = $ref->getParentClass();
	$methods = [];
	foreach ($ref->getMethods() as $method) {
		$methods[] = [
			'name' => $method->getName(),
			'signature' => stubSignature($method->getName(), $method),
			'returnType' => stubType($method->getReturnType()),
			'params' => stubParams($method),
			'static' => $method->isStatic() ? 1 : 0,
			'visibility' => $method->isPrivate() ? 'private' : ($method->isProtected() ? 'protected' : 'public'),
			'abstract' => $method->isAbstract() ? 1 : 0,
			'deprecated' => $method->isDeprecated() ? 1 : 0,
		];
	}
	$constants = [];
	foreach ($ref->getReflectionConstants() as $const) {
		$constants[] = [
			'name' => $const->getName(),
			'value' => is_scalar($const->getValue()) ? var_export($const->getValue(), true) : '',
			'visibility' => $const->isPrivate() ? 'private' : ($const->isProtected() ? 'protected' : 'public'),
		];
	}
	$properties = [];
	foreach ($ref->getProperties() as $property) {
		$properties[] = [
			'name' => $property->getName(),
			'type' => stubType($property->getType()),
			'static' => $property->isStatic() ? 1 : 0,
			'visibility' => $property->isPrivate() ? 'private' : ($property->isProtected() ? 'protected' : 'public'),
		];
	}
	$classes[] = [
		'fqcn' => $ref->getName(),
		'kind' => $ref->isInterface() ? 'interface' : ($ref->isTrait() ? 'trait' : ($ref->isEnum() ? 'enum' : 'class')),
		'final' => $ref->isFinal() ? 1 : 0,
		'abstract' => $ref->isAbstract() ? 1 : 0,
		'extends' => $parent !== false ? $parent->getName() : null,
		'methods' => $methods,
		'constants' => $constants,
		'properties' => $properties,
	];
}

usort($functions, static fn (array $a, array $b): int => strcmp($a['name'], $b['name']));
usort($classes, static fn (array $a, array $b): int => strcmp($a['fqcn'], $b['fqcn']));

$payload = [
	'php' => PHP_VERSION,
	'generatedAt' => gmdate('c'),
	'functions' => $functions,
	'classes' => $classes,
];
$json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
if ($json === false) {
	fwrite(STDERR, "json_encode: " . json_last_error_msg() . PHP_EOL);
	exit(1);
}
if (file_put_contents($out, $json) === false) {
	fwrite(STDERR, "не удалось записать {$out}" . PHP_EOL);
	exit(1);
}
echo sprintf(
	"php-stubs: %s — %d функций, %d классов, %d КБ (PHP %s)\n",
	$out,
	count($functions),
	count($classes),
	(int) round(strlen($json) / 1024),
	PHP_VERSION,
);
