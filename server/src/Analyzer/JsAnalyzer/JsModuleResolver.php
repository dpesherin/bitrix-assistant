<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/**
 * Разрешение JS-модулей для import/export-алиасов, относительных путей
 * и деклараций из `node_modules/@types`.
 */
final class JsModuleResolver
{
	/** @var array<string, array{mtime: int, baseUrl: string, paths: array<string, array<int, string>>}|null> */
	private array $tsconfigCache = [];

	/**
	 * @return array{local: string, imported: string, source: string, file: string, line: int, name: string, kind: string, declaration: string}|null
	 */
	public function resolve(TextDocument $document, string $token): ?array
	{
		$path = Paths::uriToPath($document->uri);
		if ($path === null) {
			return null;
		}
		foreach ($this->imports($document->text) as $import) {
			if ($import['local'] !== $token) {
				continue;
			}
			$target = $this->resolveFile($path, $import['source']);
			if ($target === null) {
				return null;
			}
			$content = @file_get_contents($target);
			if (!is_string($content)) {
				return null;
			}
			$declaration = $this->findDeclaration($content, $import['imported']);
			if ($declaration === null) {
				$reexport = $this->followReexport($target, $import['imported']);
				if ($reexport !== null) {
					return array_merge($import, $reexport);
				}
				return [
					'local' => $import['local'],
					'imported' => $import['imported'],
					'source' => $import['source'],
					'file' => $target,
					'line' => 1,
					'name' => $import['imported'] === 'default' ? basename($target) : $import['imported'],
					'kind' => 'module',
					'declaration' => basename($target),
				];
			}
			return array_merge($import, [
				'file' => $target,
				'line' => $declaration['line'],
				'name' => $declaration['name'],
				'kind' => $declaration['kind'],
				'declaration' => $declaration['declaration'],
			]);
		}
		return null;
	}

	/**
	 * @return array<int, array{local: string, imported: string, source: string}>
	 */
	public function imports(string $text): array
	{
		$imports = [];
		$patterns = [
			'/\bimport\s+([^;]+?)\s+from\s+[\'"]([^\'"]+)[\'"]/',
			'/\b(?:const|let|var)\s+([^=]+?)\s*=\s*require\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\)/',
		];
		foreach ($patterns as $pattern) {
			if (preg_match_all($pattern, $text, $matches, PREG_SET_ORDER) === false) {
				continue;
			}
			foreach ($matches as $match) {
				$clause = trim($match[1]);
				$source = $match[2];
				if (preg_match('/^\{([\s\S]*)\}$/', $clause, $named) === 1) {
					foreach (explode(',', $named[1]) as $item) {
						$parts = preg_split('/\s+as\s+/i', trim($item)) ?: [];
						$imported = trim($parts[0] ?? '');
						$local = trim($parts[1] ?? $imported);
						if ($imported !== '' && $local !== '') {
							$imports[] = ['local' => $local, 'imported' => $imported, 'source' => $source];
						}
					}
					continue;
				}
				if (preg_match('/^\*\s+as\s+([A-Za-z_$][\w$]*)$/i', $clause, $namespace) === 1) {
					$imports[] = ['local' => $namespace[1], 'imported' => '*', 'source' => $source];
					continue;
				}
				$default = trim(explode(',', $clause)[0]);
				if (preg_match('/^[A-Za-z_$][\w$]*$/', $default) === 1) {
					$imports[] = ['local' => $default, 'imported' => 'default', 'source' => $source];
				}
			}
		}
		return $imports;
	}

	/**
	 * Разрешает import через compilerOptions.paths/baseUrl из ближайшего
	 * tsconfig.json или jsconfig.json. Кэш привязан к mtime конфигурации.
	 */
	private function resolveTsconfigAlias(string $fromFile, string $specifier): ?string
	{
		$dir = dirname($fromFile);
		for ($depth = 0; $depth < 12; $depth++) {
			foreach (['tsconfig.json', 'jsconfig.json'] as $name) {
				$configPath = $dir . '/' . $name;
				if (!is_file($configPath)) {
					continue;
				}
				$config = $this->tsconfig($configPath);
				if ($config === null) {
					return null;
				}
				foreach ($config['paths'] as $pattern => $targets) {
					$star = strpos($pattern, '*');
					if ($star === false) {
						if ($pattern !== $specifier) {
							continue;
						}
						$replacement = '';
					} else {
						$prefix = substr($pattern, 0, $star);
						$suffix = substr($pattern, $star + 1);
						if (!str_starts_with($specifier, $prefix) || !str_ends_with($specifier, $suffix)) {
							continue;
						}
						$length = strlen($specifier) - strlen($prefix) - strlen($suffix);
						if ($length < 0) {
							continue;
						}
						$replacement = substr($specifier, strlen($prefix), $length);
					}
					foreach ($targets as $target) {
						$candidate = rtrim($config['baseUrl'], '/') . '/' . str_replace('*', $replacement, $target);
						$resolved = $this->firstFile(Paths::normalize($candidate));
						if ($resolved !== null) {
							return $resolved;
						}
					}
				}
				return null;
			}
			$parent = dirname($dir);
			if ($parent === $dir) {
				break;
			}
			$dir = $parent;
		}
		return null;
	}

	/**
	 * @return array{baseUrl: string, paths: array<string, array<int, string>>}|null
	 */
	private function tsconfig(string $configPath): ?array
	{
		$mtime = @filemtime($configPath) ?: 0;
		if (array_key_exists($configPath, $this->tsconfigCache)) {
			$cached = $this->tsconfigCache[$configPath];
			if ($cached !== null && $cached['mtime'] === $mtime) {
				return $cached;
			}
			if ($cached === null && $mtime === 0) {
				return null;
			}
		}
		$raw = @file_get_contents($configPath);
		if (!is_string($raw)) {
			$this->tsconfigCache[$configPath] = null;
			return null;
		}
		$raw = preg_replace('#/\*[\s\S]*?\*/#', '', $raw) ?? $raw;
		$raw = preg_replace('#(^|[^:])//[^\n\r]*#', '$1', $raw) ?? $raw;
		$raw = preg_replace('#,\s*([}\]])#', '$1', $raw) ?? $raw;
		$data = json_decode($raw, true);
		if (!is_array($data)) {
			$this->tsconfigCache[$configPath] = null;
			return null;
		}
		$options = is_array($data['compilerOptions'] ?? null) ? $data['compilerOptions'] : [];
		$baseUrl = dirname($configPath);
		if (is_string($options['baseUrl'] ?? null) && $options['baseUrl'] !== '') {
			$baseUrl = Paths::normalize(dirname($configPath) . '/' . $options['baseUrl']);
		}
		$paths = [];
		if (is_array($options['paths'] ?? null)) {
			foreach ($options['paths'] as $pattern => $targets) {
				if (!is_string($pattern) || !is_array($targets)) {
					continue;
				}
				$list = array_values(array_filter($targets, 'is_string'));
				if ($list !== []) {
					$paths[$pattern] = $list;
				}
			}
		}
		$config = ['baseUrl' => $baseUrl, 'paths' => $paths];
		$this->tsconfigCache[$configPath] = ['mtime' => $mtime] + $config;
		return $config;
	}

	private function resolveFile(string $fromFile, string $specifier): ?string
	{
		$base = dirname($fromFile);
		if (str_starts_with($specifier, '.')) {
			$target = Paths::normalize($base . '/' . $specifier);
			return $this->firstFile($target);
		}
		if (str_starts_with($specifier, '/')) {
			return $this->firstFile(Paths::normalize($specifier));
		}
		$aliased = $this->resolveTsconfigAlias($fromFile, $specifier);
		if ($aliased !== null) {
			return $aliased;
		}
		$package = $specifier;
		$rest = '';
		if (str_starts_with($specifier, '@')) {
			$parts = explode('/', $specifier, 3);
			$package = implode('/', array_slice($parts, 0, 2));
			$rest = $parts[2] ?? '';
		} else {
			$parts = explode('/', $specifier, 2);
			$package = $parts[0];
			$rest = $parts[1] ?? '';
		}
		$dir = $base;
		while ($dir !== '' && $dir !== '/' && $dir !== '.') {
			$nodeModules = $dir . '/node_modules';
			$root = $nodeModules . '/' . $package;
			if (is_dir($root)) {
				$fromPackage = $this->packageEntry($root . '/package.json');
				if ($fromPackage !== null && $rest === '') {
					return $this->firstFile($fromPackage);
				}
				$target = $root . '/' . $rest;
				$resolved = $this->firstFile($target);
				if ($resolved !== null) {
					return $resolved;
				}
				return $fromPackage;
			}
			$types = $nodeModules . '/@types/' . str_replace('/', '__', $package);
			if (is_dir($types)) {
				$target = $types . '/' . $rest;
				$resolved = $this->firstFile($target);
				if ($resolved !== null) {
					return $resolved;
				}
				$fromPackage = $this->packageEntry($types . '/package.json');
				if ($fromPackage !== null) {
					return $this->firstFile($fromPackage);
				}
			}
			$dir = dirname($dir);
		}
		return null;
	}

	private function packageEntry(string $packageJson): ?string
	{
		if (!is_file($packageJson)) {
			return null;
		}
		$content = @file_get_contents($packageJson);
		if (!is_string($content)) {
			return null;
		}
		$data = json_decode($content, true);
		if (!is_array($data)) {
			return null;
		}
		$entry = $data['types'] ?? $data['typings'] ?? $data['main'] ?? null;
		if (!is_string($entry) || $entry === '') {
			return null;
		}
		return Paths::normalize(dirname($packageJson) . '/' . $entry);
	}

	private function firstFile(string $target): ?string
	{
		$candidates = [
			$target,
			$target . '.js',
			$target . '.mjs',
			$target . '.cjs',
			$target . '.ts',
			$target . '.tsx',
			$target . '.d.ts',
			$target . '/index.js',
			$target . '/index.ts',
			$target . '/index.d.ts',
		];
		foreach ($candidates as $candidate) {
			if (is_file($candidate)) {
				$real = realpath($candidate);
				return Paths::normalize($real !== false ? $real : $candidate);
			}
		}
		return null;
	}

	/**
	 * @return array{name: string, kind: string, line: int, declaration: string}|null
	 */
	private function findDeclaration(string $content, string $imported): ?array
	{
		if ($imported === 'default') {
			if (preg_match('/\bexport\s+default\s+(?:abstract\s+)?(?:class|function)\s+([A-Za-z_$][\w$]*)/', $content, $match, PREG_OFFSET_CAPTURE) === 1) {
				return $this->declaration($match[1][0], 'class', $content, $match[1][1]);
			}
			if (preg_match('/\bexport\s+default\s+([A-Za-z_$][\w$]*)/', $content, $match, PREG_OFFSET_CAPTURE) === 1) {
				return $this->declaration($match[1][0], 'default', $content, $match[1][1]);
			}
		}
		$quoted = preg_quote($imported, '/');
		$pattern = '/\b(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(class|function|const|let|var|interface|type|enum)\s+'
			. $quoted . '\b/';
		if (preg_match($pattern, $content, $match, PREG_OFFSET_CAPTURE) === 1) {
			$kind = $match[1][0];
			return $this->declaration($imported, $kind, $content, (int) $match[0][1]);
		}
		return null;
	}

	/**
	 * @return array{name: string, kind: string, line: int, declaration: string}
	 */
	private function declaration(string $name, string $kind, string $content, int $offset): array
	{
		$before = substr($content, 0, $offset);
		$line = substr_count($before, "\n") + 1;
		$end = strpos($content, "\n", $offset);
		$declaration = trim($end === false ? substr($content, $offset) : substr($content, $offset, $end - $offset));
		return ['name' => $name, 'kind' => $kind, 'line' => $line, 'declaration' => mb_substr($declaration, 0, 240)];
	}

	/**
	 * Члены класса/интерфейса из импортированного модуля.
	 *
	 * @return array<int, array{name: string, kind: string, signature: string}>
	 */
	public function members(TextDocument $document, string $local): array
	{
		$resolved = $this->resolve($document, $local);
		if ($resolved === null) {
			return [];
		}
		$content = @file_get_contents($resolved['file']);
		if (!is_string($content)) {
			return [];
		}
		$import = $this->importFor($document, $local);
		if ($import !== null && $import['imported'] === '*') {
			return array_map(
				static fn (array $item): array => [
					'name' => $item['name'],
					'kind' => $item['kind'],
					'signature' => $item['signature'],
				],
				$this->exportMembers($resolved['file']),
			);
		}
		$name = (string) $resolved['name'];
		$pattern = '/\b(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface)\s+'
			. preg_quote($name, '/') . '\b[^{]*\{/';
		if (preg_match($pattern, $content, $match, PREG_OFFSET_CAPTURE) !== 1) {
			return [];
		}
		$open = (int) $match[0][1] + strlen($match[0][0]) - 1;
		$close = $this->matchingBrace($content, $open);
		$body = substr($content, $open + 1, max(0, $close - $open - 1));
		$members = [];
		if (preg_match_all(
			'/(?:^|[;{}])\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*(?::\s*([^;{\n]+))?/',
			$body,
			$methods,
			PREG_SET_ORDER,
		) > 0) {
			foreach ($methods as $method) {
				$methodName = $method[1];
				if (in_array($methodName, ['if', 'for', 'while', 'switch', 'catch', 'return', 'function'], true)) {
					continue;
				}
				$signature = $methodName . '(' . trim(preg_replace('/\s+/', ' ', $method[2])) . ')';
				if (!empty($method[3])) {
					$signature .= ': ' . trim($method[3]);
				}
				$members[$methodName] = ['name' => $methodName, 'kind' => 'method', 'signature' => $signature];
			}
		}
		if (preg_match_all('/(?:^|[;{}])\s*(?:static\s+)?([A-Za-z_$][\w$]*)\s*(?==|;)/', $body, $fields) > 0) {
			foreach ($fields[1] as $field) {
				if (!isset($members[$field])) {
					$members[$field] = ['name' => $field, 'kind' => 'property', 'signature' => $field];
				}
			}
		}
		return array_values($members);
	}

	/**
	 * @return array{local: string, imported: string, source: string}|null
	 */
	private function importFor(TextDocument $document, string $local): ?array
	{
		foreach ($this->imports($document->text) as $import) {
			if ($import['local'] === $local) {
				return $import;
			}
		}
		return null;
	}

	/**
	 * @return array<int, array{name: string, kind: string, signature: string, line: int, file: string}>
	 */
	public function member(TextDocument $document, string $local, string $name): ?array
	{
		$resolved = $this->resolve($document, $local);
		if ($resolved === null) {
			return null;
		}
		foreach ($this->exportMembers((string) $resolved['file']) as $member) {
			if ($member['name'] === $name) {
				return $member + ['source' => (string) $resolved['source']];
			}
		}
		return null;
	}

	public function exportMembers(string $file): array
	{
		$content = @file_get_contents($file);
		if (!is_string($content)) {
			return [];
		}
		$members = [];
		$re = '/\bexport\s+(?:default\s+)?(?:async\s+)?(?:declare\s+)?(?:abstract\s+)?'
			. '(class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/';
		if (preg_match_all($re, $content, $matches, PREG_OFFSET_CAPTURE | PREG_SET_ORDER) > 0) {
			foreach ($matches as $match) {
				$offset = (int) $match[0][1];
				$line = substr_count(substr($content, 0, $offset), "\n") + 1;
				$end = strpos($content, "\n", $offset);
				$members[$match[2][0]] = [
					'name' => $match[2][0],
					'kind' => $match[1][0],
					'signature' => trim($end === false ? substr($content, $offset) : substr($content, $offset, $end - $offset)),
					'line' => $line,
					'file' => $file,
				];
			}
		}
		if (preg_match_all('/\bexport\s*\{([^}]*)\}/', $content, $lists, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($lists[1] as $item) {
				foreach (explode(',', $item[0]) as $part) {
					$bits = preg_split('/\s+as\s+/i', trim($part)) ?: [];
					$name = trim($bits[1] ?? $bits[0] ?? '');
					if ($name === '') {
						continue;
					}
					$fileOffset = (int) $item[1];
					$line = substr_count(substr($content, 0, $fileOffset), "\n") + 1;
					$members[$name] = [
						'name' => $name,
						'kind' => 'export',
						'signature' => $name,
						'line' => $line,
						'file' => $file,
					];
				}
			}
		}
		return array_values($members);
	}

	/**
	 * @return array{file: string, line: int, name: string, kind: string, declaration: string}|null
	 */
	private function followReexport(string $file, string $imported): ?array
	{
		$content = @file_get_contents($file);
		if (!is_string($content)) {
			return null;
		}
		$re = '/\bexport\s*\{([^}]*)\}\s*from\s*[\'"]([^\'"]+)[\'"]/';
		if (preg_match_all($re, $content, $matches, PREG_SET_ORDER) === false) {
			return null;
		}
		foreach ($matches as $match) {
			foreach (explode(',', $match[1]) as $part) {
				$bits = preg_split('/\s+as\s+/i', trim($part)) ?: [];
				$sourceName = trim($bits[0] ?? '');
				$exportedName = trim($bits[1] ?? $sourceName);
				if ($exportedName !== $imported) {
					continue;
				}
				$target = $this->resolveFile($file, $match[2]);
				if ($target === null) {
					return null;
				}
				$targetContent = @file_get_contents($target);
				if (!is_string($targetContent)) {
					return null;
				}
				$declaration = $this->findDeclaration($targetContent, $sourceName);
				if ($declaration === null) {
					return null;
				}
				return [
					'file' => $target,
					'line' => $declaration['line'],
					'name' => $declaration['name'],
					'kind' => $declaration['kind'],
					'declaration' => $declaration['declaration'],
				];
			}
		}
		return null;
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

}
