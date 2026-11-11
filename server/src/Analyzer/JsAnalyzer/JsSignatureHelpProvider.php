<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\HoverColor;
use BitrixLsp\Support\TextDocument;

/** Signature help для JS-вызовов `BX.*`, `this.*` и частых DOM-методов. */
final class JsSignatureHelpProvider
{
	private readonly JsMemberResolver $memberResolver;

	public function __construct(private readonly Repository $repository)
	{
		$this->memberResolver = new JsMemberResolver($repository);
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
		$before = rtrim(substr($masked, 0, $open));
		if (preg_match('/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/', $before, $match) !== 1) {
			return null;
		}
		$callee = $match[1];
		$active = $this->activeParameter($masked, $open, $offset);

		if (str_starts_with($callee, 'BX.')) {
			$row = $this->repository->globalByName($callee);
			return $row !== null ? $this->fromRow($row, $callee, $active) : null;
		}

		$member = $this->memberResolver->resolve($document, $open, $callee);
		if ($member === null) {
			return null;
		}
		if ($member['kind'] === 'native') {
			return $this->fromNative($member['data'], $callee, $active);
		}
		return $this->fromRow($member['row'], $callee, $active);
	}

	/**
	 * @param array<string, mixed> $row
	 * @return array<string, mixed>
	 */
	private function fromRow(array $row, string $callee, int $active): array
	{
		$params = json_decode((string) ($row['params_json'] ?? '[]'), true);
		if (!is_array($params)) {
			$params = [];
		}
		$labels = [];
		foreach ($params as $param) {
			$name = (string) ($param['name'] ?? '');
			if ($name === '' || str_contains($name, '.')) {
				continue;
			}
			$label = $name;
			$label .= !empty($param['optional']) ? '?' : '';
			$type = trim((string) ($param['type'] ?? ''));
			if ($type !== '') {
				$label .= ': ' . $type;
			}
			$default = trim((string) ($param['defaultValue'] ?? ''));
			if ($default !== '') {
				$label .= ' = ' . $default;
			}
			$labels[] = ['label' => $label];
		}

		$signature = trim((string) ($row['signature'] ?? ''));
		$base = substr($callee, (int) strrpos($callee, '.') + 1);
		if ($signature === '') {
			$signature = $base . '(' . implode(', ', array_map(
				static fn (array $label): string => (string) $label['label'],
				$labels,
			)) . ')';
		}
		$active = $labels === [] ? 0 : min($active, count($labels) - 1);

		$prefix = substr($callee, 0, (int) strrpos($callee, '.') + 1);
		$fullSignature = str_starts_with($signature, $base . '(') ? $prefix . $signature : $signature;
		$returnType = trim((string) ($row['return_type'] ?? ''));
		if ($returnType !== '') {
			$fullSignature .= ': ' . $returnType;
		}
		$documentation = "```ts\n{$fullSignature}\n```";
		$rowDoc = trim((string) ($row['doc'] ?? ''));
		if ($rowDoc !== '') {
			$documentation .= "\n\n" . $rowDoc;
		}
		if ($returnType !== '') {
			$documentation .= "\n\n**Возвращает:** `{$returnType}`";
		}
		if (!empty($row['source_file'])) {
			$documentation .= "\n\n" . HoverColor::sourceLine((string) $row['source_file'], (int) $row['line']);
		}
		return $this->result($signature, $labels, $documentation, $active);
	}

	/**
	 * @param array<string, mixed> $data
	 * @return array<string, mixed>
	 */
	private function fromNative(array $data, string $callee, int $active): array
	{
		$params = is_array($data['params'] ?? null) ? $data['params'] : [];
		$labels = [];
		foreach ($params as $param) {
			$labels[] = ['label' => (string) ($param['label'] ?? $param['name'] ?? '')];
		}
		$active = $labels === [] ? 0 : min($active, count($labels) - 1);
		$owner = (string) ($data['owner'] ?? 'element');
		$signature = (string) ($data['signature'] ?? $callee);
		$fullSignature = "{$owner}.{$signature}";
		$returnType = (string) ($data['return_type'] ?? '');
		if ($returnType !== '') {
			$fullSignature .= ': ' . $returnType;
		}
		$documentation = "```ts\n{$fullSignature}\n```";
		$doc = trim((string) ($data['doc'] ?? ''));
		if ($doc !== '') {
			$documentation .= "\n\n" . $doc;
		}
		if ($returnType !== '') {
			$documentation .= "\n\n**Возвращает:** `{$returnType}`";
		}
		return $this->result($signature, $labels, $documentation, $active);
	}

	/**
	 * @param array<int, array{label: string}> $params
	 * @return array<string, mixed>
	 */
	private function result(string $signature, array $params, string $documentation, int $active): array
	{
		return [
			'signatures' => [[
				'label' => $signature,
				'documentation' => ['kind' => 'markdown', 'value' => trim($documentation)],
				'parameters' => $params,
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
