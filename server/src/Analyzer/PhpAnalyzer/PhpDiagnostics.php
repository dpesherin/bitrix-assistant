<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Config;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/**
 * PHP-диагностики: устаревшие классы (`@deprecated` в индексе) и параметры
 * `$arParams`, не объявленные в `.parameters.php` компонента.
 */
final class PhpDiagnostics
{
	private const MAX_DIAGNOSTICS = 40;

	public function __construct(
		private readonly Repository $repository,
		private readonly Config $config,
		private readonly PhpSemanticDiagnostics $semantic,
	)
	{
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function check(TextDocument $document): array
	{
		$diagnostics = [];
		$uses = PhpUseMap::parse($document->text);
		$reported = [];
		foreach (PhpUseMap::classReferences($document->text) as $reference) {
			$fqcn = PhpUseMap::resolve($reference['name'], $uses);
			if (isset($reported[$fqcn])) {
				continue;
			}
			$class = $this->repository->classByName($fqcn);
			if ($class === null || (int) ($class['deprecated'] ?? 0) !== 1) {
				continue;
			}
			$reported[$fqcn] = true;
			$deprecated = $this->repository->deprecatedSubject((string) $class['fqcn']);
			$replaced = $deprecated['replaced_by'] ?? null;
			$message = sprintf('Класс %s помечен @deprecated.', $class['fqcn']);
			if (is_string($replaced) && $replaced !== '') {
				$message .= ' Замена: ' . $replaced . '.';
			}
			$diagnostics[] = [
				'range' => $document->range($reference['start'], $reference['end']),
				'severity' => 3,
				'source' => 'bitrix',
				'code' => 'bitrix.php.deprecated-class',
				'message' => $message,
				'data' => ['kind' => 'deprecated-class', 'class' => $class['fqcn'], 'replacedBy' => $replaced],
			];
			if (count($diagnostics) >= self::MAX_DIAGNOSTICS) {
				return $diagnostics;
			}
		}

		$diagnostics = array_merge($diagnostics, $this->unresolvedClassDiagnostics($document, $uses));
		// Неизвестные функции/методы показываем всегда; остальные семантические
		// проверки (аргументы, типы, неопределённые переменные) — по настройке.
		$diagnostics = array_merge(
			$diagnostics,
			$this->config->phpSemantic
				? $this->semantic->check($document)
				: $this->semantic->checkSymbols($document),
		);
		// `undeclared-param` не проверяем: у компонентов параметры часто приходят
		// из шаблона или родительского компонента, проверка давала поток ложных.
		return $diagnostics;
	}

	/**
	 * Класс без `use`, но с уникальным коротким именем в индексе:
	 * подсказываем Quick Fix «Импортировать …».
	 *
	 * @param array<string, string> $uses
	 * @return array<int, array<string, mixed>>
	 */
	private function unresolvedClassDiagnostics(TextDocument $document, array $uses): array
	{
		$context = PhpDocumentContext::create($document);
		$namespace = $context->namespaceName();
		$local = [];
		if (preg_match_all('/\b(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/', PhpDocumentContext::create($document)->text(), $matches) > 0) {
			foreach ($matches[1] as $name) {
				$local[$name] = true;
			}
		}
		$builtins = array_fill_keys([
			'array', 'bool', 'callable', 'false', 'float', 'int', 'iterable', 'mixed', 'null',
			'object', 'parent', 'self', 'static', 'string', 'true', 'void', 'DateTime',
			'DateTimeImmutable', 'Exception', 'Error', 'Throwable', 'PDO', 'Closure', 'Generator',
			'Traversable', 'Countable', 'ArrayAccess', 'Iterator', 'IteratorAggregate',
			'JsonSerializable', 'stdClass', 'Stringable',
		], true);
		$diagnostics = [];
		$reported = [];
		foreach (PhpUseMap::classReferences($document->text) as $reference) {
			$name = $reference['name'];
			if ($name === '' || isset($builtins[$name]) || isset($local[$name])) {
				continue;
			}
			if (str_starts_with($name, '\\') || str_contains($name, '\\')) {
				continue;
			}
			$first = explode('\\', $name)[0];
			if (isset($uses[$first])) {
				continue;
			}
			if (isset($reported[$name])) {
				continue;
			}
			$candidates = $namespace !== '' ? [$namespace . '\\' . $name, $name] : [$name];
			$known = false;
			foreach ($candidates as $candidate) {
				if ($this->repository->classByName($candidate) !== null) {
					$known = true;
					break;
				}
			}
			if ($known) {
				continue;
			}
			$suggestion = $this->repository->findClassByShortName($name);
			if ($suggestion === null) {
				continue;
			}
			$reported[$name] = true;
			$diagnostics[] = [
				'range' => $document->range($reference['start'], $reference['end']),
				'severity' => 2,
				'source' => 'bitrix',
				'code' => 'bitrix.php.unresolved-class',
				'message' => sprintf('Класс %s не импортирован. Импортировать %s?', $name, $suggestion['fqcn']),
				'data' => ['kind' => 'unresolved-class', 'name' => $name],
			];
			if (count($diagnostics) >= self::MAX_DIAGNOSTICS) {
				break;
			}
		}
		return $diagnostics;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function parameterDiagnostics(TextDocument $document): array
	{
		$path = Paths::uriToPath($document->uri);
		if ($path === null) {
			return [];
		}
		$component = $this->repository->componentForFile($path);
		if ($component === null) {
			return [];
		}
		// Компоненты ядра принимают runtime-параметры, которых нет в .parameters.php
		// (их передают шаблоны и родительские компоненты) — не проверяем их.
		$componentPath = (string) ($component['path'] ?? '');
		if (str_contains($componentPath, '/bitrix/components/') || str_contains($componentPath, '/install/components/')) {
			return [];
		}
		// Нет .parameters.php — сравнивать не с чем: параметры приходят от шаблона
		// или родительского компонента, это не ошибка.
		if (trim((string) ($component['parameters_file'] ?? '')) === '') {
			return [];
		}
		$params = $this->repository->paramsForComponent((string) $component['name']);
		if ($params === []) {
			return [];
		}
		$declared = [];
		foreach ($params as $param) {
			$declared[(string) $param['name']] = true;
		}
		$diagnostics = [];
		$reported = [];
		if (preg_match_all('/\$arParams\s*\[\s*[\'"]([A-Za-z0-9_]+)[\'"]\s*\]/', PhpSource::phpOnly($document->text), $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		foreach ($matches[1] as $match) {
			$name = $match[0];
			if (isset($declared[$name]) || isset($reported[$name])) {
				continue;
			}
			$reported[$name] = true;
			$start = $match[1];
			$end = $start + strlen($name) + 2;
			$diagnostics[] = [
				'range' => $document->range($start, min(strlen($document->text), $end)),
				'severity' => 2,
				'source' => 'bitrix',
				'code' => 'bitrix.php.undeclared-param',
				'message' => sprintf(
					'Параметр «%s» не объявлен в .parameters.php компонента «%s».',
					$name,
					$component['name'],
				),
				'data' => ['kind' => 'undeclared-param', 'param' => $name, 'component' => $component['name']],
			];
			if (count($diagnostics) >= self::MAX_DIAGNOSTICS) {
				break;
			}
		}
		return $diagnostics;
	}
}
