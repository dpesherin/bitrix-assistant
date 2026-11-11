<?php

declare(strict_types=1);

namespace BitrixLsp;

/**
 * Конфигурация сервера: пути передаются расширением через переменные окружения,
 * настройки — через `workspace/didChangeConfiguration`.
 */
final class Config
{
	public function __construct(
		public readonly ?string $dbPath,
		public readonly ?string $bitrixRoot,
		public readonly ?string $bitrixPath,
		public bool $jsLibraryCheck,
		public bool $phpSemantic = true,
		public string $phpVersion = 'auto',
	) {
	}

	public static function fromEnvironment(): self
	{
		$env = static fn (string $name): ?string => self::nonEmpty(getenv($name));
		return new self(
			$env('BITRIX_DB'),
			$env('BITRIX_ROOT'),
			$env('BITRIX_BITRIX_PATH'),
			self::nonEmpty(getenv('BITRIX_JS_LIB_CHECK')) === '1',
			self::nonEmpty(getenv('BITRIX_PHP_SEMANTIC')) !== '0',
			self::nonEmpty(getenv('BITRIX_PHP_VERSION')) ?? 'auto',
		);
	}

	/**
	 * Клиент синхронизирует секцию `bitrix`, поэтому структура может быть
	 * как `{js: {...}}`, так и `{bitrix: {js: {...}}}`.
	 *
	 * @param array<string, mixed> $settings
	 */
	public function applySettings(array $settings): void
	{
		$bitrix = isset($settings['bitrix']) && is_array($settings['bitrix']) ? $settings['bitrix'] : $settings;
		if (isset($bitrix['js']['enableLibraryCheck'])) {
			$this->jsLibraryCheck = (bool) $bitrix['js']['enableLibraryCheck'];
		}
		if (isset($bitrix['php']['semantic'])) {
			$this->phpSemantic = (bool) $bitrix['php']['semantic'];
		}
		if (isset($bitrix['php']['version']) && is_string($bitrix['php']['version'])) {
			$this->phpVersion = $bitrix['php']['version'];
		}
	}

	private static function nonEmpty(mixed $value): ?string
	{
		if (!is_string($value)) {
			return null;
		}
		$value = trim($value);
		return $value === '' ? null : $value;
	}
}
