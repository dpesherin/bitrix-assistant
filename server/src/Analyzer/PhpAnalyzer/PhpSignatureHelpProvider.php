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
}
