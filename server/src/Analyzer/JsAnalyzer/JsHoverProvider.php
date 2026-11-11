<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\HoverColor;
use BitrixLsp\Support\TextDocument;

/** Hover по `BX.*`: сигнатура, параметры, описание, расширение и файл. */
final class JsHoverProvider
{
	private readonly JsMemberResolver $memberResolver;

	public function __construct(
		private readonly Repository $repository,
		private readonly LibraryResolver $resolver,
		private readonly JsModuleResolver $modules = new JsModuleResolver(),
	) {
		$this->memberResolver = new JsMemberResolver($repository);
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public function provide(TextDocument $document, int $offset): ?array
	{
		$token = JsScanner::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		$value = null;
		if (str_starts_with($token['name'], 'BX')) {
			$value = $this->describe($token['name']);
		}
		if ($value === null) {
			$module = $this->modules->resolve($document, $token['name']);
			if ($module !== null) {
				$value = $this->renderModule($module);
			}
		}
		if ($value === null) {
			$member = $this->memberResolver->resolve($document, $offset, $token['name']);
			if ($member === null) {
				return null;
			}
			$value = match ($member['kind']) {
				'index' => $this->renderGlobal($member['row'], $this->extensionForRow($member['row'])),
				'module' => $this->renderModuleMember($member['data']),
				default => $this->renderNative($member['data']),
			};
		}
		return [
			'contents' => ['kind' => 'markdown', 'value' => $value],
			'range' => $document->range($token['start'], $token['end']),
		];
	}

	/**
	 * @param array<string, mixed> $module
	 */
	private function renderModule(array $module): string
	{
		$kind = (string) ($module['kind'] ?? 'module');
		$lines = [
			HoverColor::span((string) $module['local'], 'class'),
			"`import` · `{$kind}` · из `{$module['source']}`",
		];
		$declaration = (string) ($module['declaration'] ?? '');
		if ($declaration !== '') {
			$lines[] = "```ts\n{$declaration}\n```";
		}
		if ($module['imported'] !== 'default' && $module['imported'] !== $module['local']) {
			$lines[] = "**Импортирует:** `{$module['imported']}` как `{$module['local']}`";
		}
		$lines[] = HoverColor::sourceLine((string) $module['file'], (int) $module['line']);
		return implode("\n\n", $lines);
	}

	/**
	 * @param array<string, mixed> $member
	 */
	private function renderModuleMember(array $member): string
	{
		$lines = [
			HoverColor::span((string) $member['name'], (string) $member['kind'] === 'class' ? 'class' : 'method'),
			"`{$member['kind']}` · из `{$member['source']}`",
			"```ts\n{$member['signature']}\n```",
			HoverColor::sourceLine((string) $member['file'], (int) $member['line']),
		];
		return implode("\n\n", $lines);
	}

	/**
	 * @param array<string, mixed> $row
	 */
	private function extensionForRow(array $row): ?array
	{
		$name = $row['extension_name'] ?? null;
		return is_string($name) && $name !== '' ? $this->repository->extensionByName($name) : null;
	}

	/**
	 * @param array<string, mixed> $data
	 */
	private function renderNative(array $data): string
	{
		$name = (string) $data['name'];
		$owner = (string) $data['owner'];
		$signature = (string) $data['signature'];
		$returnType = (string) ($data['return_type'] ?? '');
		$code = "{$owner}.{$signature}";
		if ($returnType !== '') {
			$code .= ': ' . $returnType;
		}
		$lines = [HoverColor::span((string) $name, 'method'), "`DOM API` · `{$owner}`", "```ts\n{$code}\n```"];
		$params = $data['params'] ?? [];
		if (is_array($params) && $params !== []) {
			$rows = ['| Параметр | Тип | Обяз. |', '| --- | --- | --- |'];
			foreach ($params as $param) {
				$rows[] = sprintf(
					'| `%s` | %s | %s |',
					(string) ($param['name'] ?? ''),
					!empty($param['type']) ? '`' . str_replace('|', '\\|', (string) $param['type']) . '`' : '—',
					!empty($param['optional']) ? 'нет' : 'да',
				);
			}
			$lines[] = "**Параметры**\n\n" . implode("\n", $rows);
		}
		if ($returnType !== '') {
			$lines[] = "**Возвращает:** `{$returnType}`";
		}
		$doc = trim((string) ($data['doc'] ?? ''));
		if ($doc !== '') {
			$lines[] = "**Описание**\n\n" . $doc;
		}
		return implode("\n\n", $lines);
	}

	private function describe(string $name): ?string
	{
		$parts = explode('.', $name);
		for ($count = count($parts); $count >= 2; $count--) {
			$candidate = implode('.', array_slice($parts, 0, $count));
			$row = $this->repository->globalByName($candidate);
			if ($row === null) {
				continue;
			}
			$extension = null;
			$extensionName = $row['extension_name'] ?? null;
			if (is_string($extensionName) && $extensionName !== '') {
				$extension = $this->repository->extensionByName($extensionName);
			}
			return $this->renderGlobal($row, $extension);
		}

		$extensionName = $this->resolver->resolveUsage($name);
		if ($extensionName === null) {
			return null;
		}
		$extension = $this->repository->extensionByName($extensionName);
		return $extension !== null ? $this->renderExtension($extension) : null;
	}

	/**
	 * @param array<string, mixed> $row
	 * @param array<string, mixed>|null $extension
	 */
	private function renderGlobal(array $row, ?array $extension): string
	{
		$name = (string) $row['name'];
		$type = (string) ($row['type'] ?? 'property');
		$signature = (string) ($row['signature'] ?? '');
		$returnType = trim((string) ($row['return_type'] ?? ''));
		$prefix = substr($name, 0, (int) strrpos($name, '.') + 1);
		$code = $signature !== '' ? $prefix . $signature : $name;
		if ($returnType !== '') {
			$code .= ': ' . $returnType;
		}

		$lines = [HoverColor::span((string) $name, $type === 'class' ? 'class' : ($type === 'property' ? 'variable' : 'method')), "`{$type}`"];
		if ($extension !== null) {
			$lines[1] .= ' · `' . (string) $extension['name'] . '`';
		}
		$lines[] = "```ts\n{$code}\n```";

		$doc = trim((string) ($row['doc'] ?? ''));
		if ($doc !== '') {
			$lines[] = "**Описание**\n\n" . mb_substr($doc, 0, 1200);
		}

		$params = json_decode((string) ($row['params_json'] ?? '[]'), true);
		if (is_array($params) && $params !== []) {
			$lines[] = "**Параметры**\n\n" . $this->renderParams($params);
		}

		if ($returnType !== '') {
			$lines[] = "**Возвращает:** `{$returnType}`";
		}
		if ($extension !== null) {
			$rel = json_decode((string) ($extension['rel_json'] ?? '[]'), true);
			if (is_array($rel) && $rel !== []) {
				$lines[] = '**Зависимости:** ' . implode(', ', array_map(
					static fn (string $item): string => "`{$item}`",
					array_slice($rel, 0, 20),
				));
			}
			if (!empty($extension['config_path'])) {
				$lines[] = "**Конфигурация:** `{$extension['config_path']}`";
			}
		}
		if (!empty($row['source_file'])) {
			$lines[] = HoverColor::sourceLine((string) $row['source_file'], (int) $row['line']);
		}
		return implode("\n\n", $lines);
	}

	/**
	 * @param array<int, array<string, mixed>> $params
	 */
	private function renderParams(array $params): string
	{
		$top = [];
		$nested = [];
		foreach ($params as $param) {
			$name = (string) ($param['name'] ?? '');
			if ($name === '') {
				continue;
			}
			if (str_contains($name, '.')) {
				$nested[] = $param;
			} else {
				$top[] = $param;
			}
		}
		$parts = [];
		if ($top !== []) {
			$parts[] = $this->renderParamTable($top);
		}
		if ($nested !== []) {
			$parts[] = "**Свойства конфигурации**\n\n" . $this->renderParamTable(array_slice($nested, 0, 40));
		}
		return implode("\n\n", $parts);
	}

	/**
	 * @param array<int, array<string, mixed>> $params
	 */
	private function renderParamTable(array $params): string
	{
		$rows = ['| Параметр | Тип | Обяз. | По умолчанию |', '| --- | --- | --- | --- |'];
		foreach ($params as $param) {
			$name = (string) ($param['name'] ?? '');
			$type = trim((string) ($param['type'] ?? ''));
			$default = trim((string) ($param['defaultValue'] ?? ($param['default'] ?? '')));
			$escape = static fn (string $value): string => str_replace('|', '\\|', $value);
			$rows[] = sprintf(
				'| `%s` | %s | %s | %s |',
				$escape($name),
				$type !== '' ? '`' . $escape($type) . '`' : '—',
				!empty($param['optional']) ? 'нет' : 'да',
				$default !== '' ? '`' . $escape($default) . '`' : '—',
			);
		}
		return implode("\n", $rows);
	}

	/**
	 * @param array<string, mixed> $extension
	 */
	private function renderExtension(array $extension): string
	{
		$name = (string) $extension['name'];
		$lines = [HoverColor::span((string) $name, 'class'), '`JS-расширение`'];
		$rel = json_decode((string) ($extension['rel_json'] ?? '[]'), true);
		if (is_array($rel) && $rel !== []) {
			$lines[] = '**Зависимости (rel):** ' . implode(', ', array_map(
				static fn (string $item): string => "`{$item}`",
				$rel,
			));
		}
		if (!empty($extension['config_path'])) {
			$lines[] = "**Конфигурация:** `{$extension['config_path']}`";
		}
		$files = json_decode((string) ($extension['js_files_json'] ?? '[]'), true);
		if (is_array($files) && $files !== []) {
			$listed = array_slice($files, 0, 5);
			$lines[] = "**Файлы:**\n" . implode("\n", array_map(
				static fn (string $file): string => "- `{$file}`",
				$listed,
			));
		}
		return implode("\n\n", $lines);
	}
}
