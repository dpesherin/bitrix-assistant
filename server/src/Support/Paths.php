<?php

declare(strict_types=1);

namespace BitrixLsp\Support;

/** Работа с file:// URI и путями (кроссплатформенно). */
final class Paths
{
	public static function uriToPath(string $uri): ?string
	{
		if (strncmp($uri, 'file://', 7) !== 0) {
			return null;
		}
		$path = rawurldecode(substr($uri, 7));
		if (preg_match('#^/[A-Za-z]:#', $path) === 1) {
			$path = substr($path, 1);
		}
		return self::normalize($path);
	}

	public static function pathToUri(string $path): string
	{
		$normalized = str_replace('\\', '/', $path);
		if (preg_match('#^[A-Za-z]:#', $normalized) === 1) {
			$normalized = '/' . $normalized;
		}
		return 'file://' . implode('/', array_map('rawurlencode', explode('/', $normalized)));
	}

	public static function normalize(string $path): string
	{
		$path = str_replace('\\', '/', $path);
		$path = preg_replace('#/+#', '/', $path) ?? $path;
		if (strlen($path) > 1) {
			$path = rtrim($path, '/');
		}
		return $path;
	}

	/** Путь `$path` относительно `$base` (в нотации `/`), либо исходный путь. */
	public static function relative(string $base, string $path): string
	{
		$base = rtrim(self::normalize($base), '/');
		$path = self::normalize($path);
		if ($base !== '' && strncmp($path, $base . '/', strlen($base) + 1) === 0) {
			return substr($path, strlen($base) + 1);
		}
		return $path;
	}
}
