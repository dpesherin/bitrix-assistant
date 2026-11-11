<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/** Переход к определению: JS-файл, где объявлен глобал, либо config.php расширения. */
final class JsDefinitionProvider
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
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, int $offset): array
	{
		$token = JsScanner::tokenAt($document->text, $offset);
		if ($token === null) {
			return [];
		}
		if (str_starts_with($token['name'], 'BX')) {
			$target = $this->resolve($token['name']);
			return $target !== null ? [$this->location($target['file'], $target['line'])] : [];
		}
		$module = $this->modules->resolve($document, $token['name']);
		if ($module !== null) {
			return [$this->location((string) $module['file'], (int) $module['line'])];
		}
		$member = $this->memberResolver->resolve($document, $offset, $token['name']);
		if ($member === null) {
			return [];
		}
		if ($member['kind'] === 'module') {
			return [$this->location((string) $member['data']['file'], (int) $member['data']['line'])];
		}
		if ($member['kind'] !== 'index') {
			return [];
		}
		$file = $member['row']['source_file'] ?? null;
		if (!is_string($file) || $file === '') {
			return [];
		}
		return [$this->location($file, (int) ($member['row']['line'] ?? 1))];
	}

	/**
	 * @return array<string, mixed>
	 */
	private function location(string $file, int $line): array
	{
		$zeroBased = max(0, $line - 1);
		return [
			'uri' => Paths::pathToUri($file),
			'range' => [
				'start' => ['line' => $zeroBased, 'character' => 0],
				'end' => ['line' => $zeroBased, 'character' => 0],
			],
		];
	}

	/**
	 * @return array{file: string, line: int}|null
	 */
	private function resolve(string $name): ?array
	{
		$parts = explode('.', $name);
		for ($count = count($parts); $count >= 2; $count--) {
			$candidate = implode('.', array_slice($parts, 0, $count));
			$row = $this->repository->globalByName($candidate);
			if ($row === null) {
				continue;
			}
			$file = $row['source_file'] ?? null;
			if (is_string($file) && $file !== '') {
				return ['file' => $file, 'line' => (int) ($row['line'] ?? 1)];
			}
			break;
		}

		$extensionName = $this->resolver->resolveUsage($name);
		if ($extensionName === null) {
			return null;
		}
		$extension = $this->repository->extensionByName($extensionName);
		if ($extension === null) {
			return null;
		}
		$config = $extension['config_path'] ?? null;
		if (is_string($config) && $config !== '') {
			return ['file' => $config, 'line' => 1];
		}
		$files = json_decode((string) ($extension['js_files_json'] ?? '[]'), true);
		if (is_array($files) && isset($files[0]) && is_string($files[0])) {
			return ['file' => $files[0], 'line' => 1];
		}
		return null;
	}
}
