<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;

/**
 * Сопоставление `BX.SomeLib.Foo` с расширением из индекса:
 * сначала по точному глобальному имени (самый длинный известный префикс),
 * затем по эвристикам имени расширения (camelCase → dotted).
 */
final class LibraryResolver
{
	public function __construct(private readonly Repository $repository)
	{
	}

	public function resolveUsage(string $usage): ?string
	{
		$usage = trim($usage);
		if (strncmp($usage, 'BX.', 3) !== 0) {
			return null;
		}
		$tail = substr($usage, 3);
		if ($tail === '') {
			return null;
		}
		$parts = explode('.', $tail);

		// 1. Имя расширения, выведенное из имени глобала (`BX.UI.Buttons` → `ui.buttons`).
		//    Это приоритетнее записи в js_globals: один и тот же BX.* может
		//    встретиться в файлах разных расширений.
		foreach ($this->candidates($parts) as $candidate) {
			if ($this->repository->extensionByName($candidate) !== null) {
				return $candidate;
			}
		}

		// 2. Точное глобальное имя (самый длинный известный префикс).
		for ($count = count($parts); $count >= 1; $count--) {
			$global = 'BX.' . implode('.', array_slice($parts, 0, $count));
			$row = $this->repository->globalByName($global);
			if ($row === null) {
				continue;
			}
			$extension = $row['extension_name'] ?? null;
			if (is_string($extension) && $extension !== '') {
				return $extension;
			}
			// 3. Глобал есть, но файл не привязан к расширению — определяем
			//    расширение по каталогу файла.
			$source = $row['source_file'] ?? null;
			if (is_string($source) && $source !== '') {
				$byPath = $this->repository->extensionForFilePath($source);
				$byPathName = $byPath['name'] ?? null;
				if (is_string($byPathName) && $byPathName !== '') {
					return $byPathName;
				}
			}
		}

		return null;
	}

	/**
	 * @param array<int, string> $parts
	 * @return array<int, string>
	 */
	private function candidates(array $parts): array
	{
		$candidates = [];
		for ($count = count($parts); $count >= 1; $count--) {
			$slice = array_slice($parts, 0, $count);
			if ($count === 1 && strlen($slice[0]) < 3) {
				continue;
			}
			$joined = implode('.', $slice);
			$candidates[] = strtolower($joined);
			$candidates[] = self::camelToDot($slice);
			$candidates[] = self::camelToSnake($slice);
		}
		return array_values(array_unique(array_filter($candidates, static fn (string $item): bool => $item !== '')));
	}

	/**
	 * `Main.Core` → `main.core`, `UI.Buttons` → `ui.buttons`, `SomeLib` → `some.lib`.
	 *
	 * @param array<int, string> $parts
	 */
	private static function camelToDot(array $parts): string
	{
		$converted = array_map(static function (string $part): string {
			$part = preg_replace('/(?<=[a-z0-9])([A-Z])/', '.$1', $part) ?? $part;
			return strtolower($part);
		}, $parts);
		return implode('.', $converted);
	}

	/**
	 * `SomeLib` → `some_lib`.
	 *
	 * @param array<int, string> $parts
	 */
	private static function camelToSnake(array $parts): string
	{
		$converted = array_map(static function (string $part): string {
			$part = preg_replace('/(?<=[a-z0-9])([A-Z])/', '_$1', $part) ?? $part;
			return strtolower($part);
		}, $parts);
		return implode('.', $converted);
	}
}
