<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\DocBlock;
use BitrixLsp\Support\TextDocument;

/** Signature help для вызовов PHP-методов: параметры из индекса. */
final class PhpSignatureHelpProvider
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
		$masked = JsScanner::maskCode($document->text, true);
		$open = $this->findOpenParen($masked, $offset);
		if ($open === null) {
			return null;
		}
		$context = null;
		$calleeOffset = $open - 1;
		while ($calleeOffset > 0 && preg_match('/\s/', $masked[$calleeOffset]) === 1) {
			$calleeOffset--;
		}
		// `new Foo(...)`: конструктор ищется у класса, а не у `->`/`::`.
		$context ??= PhpDocumentContext::create($document);
		$newClass = $this->newExpressionClass($masked, $calleeOffset, $context);
		if ($newClass !== null) {
			$reference = $this->constructorReference($newClass);
			if ($reference === null) {
				return null;
			}
			return $this->signatureForReference($reference, $document, $masked, $open, $offset);
		}

		$reference = $this->resolver->resolve($document, $calleeOffset, $context);
		if ($reference === null) {
			$context = PhpDocumentContext::create($document);
			$token = PhpUseMap::tokenAt($document->text, $calleeOffset);
			if ($token === null) {
				return null;
			}
			$function = $this->repository->findFunction($token['name']);
			if ($function !== null) {
				return $this->functionSignature($function, $document, $masked, $open, $offset);
			}
			$class = $context->classAt($calleeOffset);
			if ($class === null) {
				return null;
			}
			$method = $this->repository->findMethodInHierarchy($class['fqcn'], $token['name']);
			if ($method === null) {
				return null;
			}
			$reference = ['method' => $method, 'class' => $class['fqcn']];
		}

		return $this->signatureForReference($reference, $document, $masked, $open, $offset);
	}

	/**
	 * @param array{method: array<string, mixed>, class: string} $reference
	 * @return array<string, mixed>|null
	 */
	private function signatureForReference(
		array $reference,
		TextDocument $document,
		string $masked,
		int $open,
		int $offset,
	): ?array {
		$method = $reference['method'];
		$params = json_decode((string) ($method['params_json'] ?? '[]'), true);
		if (!is_array($params)) {
			$params = [];
		}
		$docInfo = DocBlock::parse((string) ($method['doc'] ?? ''));
		$parameterLabels = [];
		foreach ($params as $param) {
			$name = (string) ($param['name'] ?? '');
			$label = trim((string) ($param['type'] ?? '') . ' $' . $name);
			if (!empty($param['variadic'])) {
				$label = '...' . $label;
			}
			if (isset($param['default'])) {
				$label .= ' = ' . (string) $param['default'];
			}
			$entry = ['label' => $label];
			$paramDoc = $docInfo['params'][$name] ?? '';
			if ($paramDoc !== '') {
				$entry['documentation'] = ['kind' => 'markdown', 'value' => $paramDoc];
			}
			$parameterLabels[] = $entry;
		}

		$active = $this->activeParameter($masked, $open, $offset);
		if ($parameterLabels !== []) {
			$active = min($active, count($parameterLabels) - 1);
		}

		return [
			'signatures' => [[
				'label' => (string) ($method['signature'] ?? $method['name'] . '()'),
				'documentation' => [
					'kind' => 'markdown',
					'value' => trim(
						"```php\n\\" . ltrim((string) $reference['class'], '\\')
						. '::' . (string) ($method['signature'] ?? ($method['name'] . '()'))
						. "\n```"
						. ($docInfo['description'] !== '' ? "\n\n" . mb_substr($docInfo['description'], 0, 800) : '')
						. ($docInfo['return'] !== null ? "\n\n**@return** `{$docInfo['return']}`" : ''),
					),
				],
				'parameters' => $parameterLabels,
			]],
			'activeSignature' => 0,
			'activeParameter' => $active,
		];
	}

	/**
	 * @param array<string, mixed> $function
	 * @return array<string, mixed>
	 */
	private function functionSignature(array $function, TextDocument $document, string $masked, int $open, int $offset): array
	{
		$params = json_decode((string) ($function['params_json'] ?? '[]'), true);
		if (!is_array($params)) {
			$params = [];
		}
		$docInfo = DocBlock::parse((string) ($function['doc'] ?? ''));
		$parameterLabels = [];
		foreach ($params as $param) {
			$name = (string) ($param['name'] ?? '');
			$label = trim((string) ($param['type'] ?? '') . ' $' . $name);
			if (!empty($param['variadic'])) {
				$label = '...' . $label;
			}
			if (isset($param['default'])) {
				$label .= ' = ' . (string) $param['default'];
			}
			$entry = ['label' => $label];
			$paramDoc = $docInfo['params'][$name] ?? '';
			if ($paramDoc !== '') {
				$entry['documentation'] = ['kind' => 'markdown', 'value' => $paramDoc];
			}
			$parameterLabels[] = $entry;
		}
		$active = $this->activeParameter($masked, $open, $offset);
		if ($parameterLabels !== []) {
			$active = min($active, count($parameterLabels) - 1);
		}
		$signature = (string) ($function['signature'] ?? ($function['name'] . '()'));
		return [
			'signatures' => [[
				'label' => $signature,
				'documentation' => [
					'kind' => 'markdown',
					'value' => trim(
						"```php\n{$signature}\n```"
						. ($docInfo['description'] !== '' ? "\n\n" . mb_substr($docInfo['description'], 0, 800) : '')
						. ($docInfo['return'] !== null ? "\n\n**@return** `{$docInfo['return']}`" : ''),
					),
				],
				'parameters' => $parameterLabels,
			]],
			'activeSignature' => 0,
			'activeParameter' => $active,
		];
	}

	private function findOpenParen(string $masked, int $offset): ?int
	{
		$depth = 0;
		$limit = min($offset, strlen($masked));
		for ($i = $limit - 1; $i >= 0; $i--) {
			$ch = $masked[$i];
			if ($ch === ')') {
				$depth++;
			} elseif ($ch === '(') {
				if ($depth === 0) {
					return $i;
				}
				$depth--;
			}
		}
		return null;
	}

	private function activeParameter(string $masked, int $open, int $offset): int
	{
		$depth = 0;
		$commas = 0;
		$limit = min($offset, strlen($masked));
		for ($i = $open + 1; $i < $limit; $i++) {
			$ch = $masked[$i];
			if ($ch === '(' || $ch === '[' || $ch === '{') {
				$depth++;
			} elseif ($ch === ')' || $ch === ']' || $ch === '}') {
				$depth--;
			} elseif ($ch === ',' && $depth === 0) {
				$commas++;
			}
		}
		return $commas;
	}

	/**
	 * Класс из выражения `new <Name>` непосредственно перед открывающей скобкой.
	 */
	private function newExpressionClass(string $masked, int $calleeOffset, PhpDocumentContext $context): ?string
	{
		$token = PhpUseMap::tokenAt($masked, $calleeOffset);
		if ($token === null) {
			return null;
		}
		$before = rtrim(substr($masked, 0, $token['start']));
		if (preg_match('/(?:^|[^A-Za-z0-9_$>])new$/', $before) !== 1) {
			return null;
		}
		$candidates = $context->classCandidates($token['name']);
		foreach ($candidates as $candidate) {
			if ($this->repository->classByName($candidate) !== null || PhpNativeCatalog::find($candidate) !== null) {
				return $candidate;
			}
		}
		return $candidates[0] ?? null;
	}

	/**
	 * Ссылка на конструктор класса: из индекса, а для встроенных классов PHP
	 * (и классов, наследующих их) — из каталога: их исходников в проекте нет.
	 *
	 * @return array{method: array<string, mixed>, class: string}|null
	 */
	private function constructorReference(string $fqcn): ?array
	{
		$method = $this->repository->findMethodInHierarchy($fqcn, '__construct');
		if ($method !== null) {
			return ['method' => $method, 'class' => $fqcn];
		}
		$native = PhpNativeCatalog::constructorOf($fqcn);
		if ($native !== null) {
			return ['method' => $native, 'class' => PhpNativeCatalog::nameOf($fqcn) ?? $fqcn];
		}
		// Наследник встроенного класса: конструктор берётся у предка (`Exception`).
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
				return ['method' => $native, 'class' => PhpNativeCatalog::nameOf($parent) ?? $parent];
			}
			$current = $parent;
		}
		if ($this->repository->classByName($fqcn) !== null || PhpNativeCatalog::find($fqcn) !== null) {
			return [
				'method' => [
					'name' => '__construct',
					'signature' => '__construct()',
					'params_json' => '[]',
					'doc' => '',
					'file' => '',
					'line' => 0,
				],
				'class' => $fqcn,
			];
		}
		return null;
	}
}
