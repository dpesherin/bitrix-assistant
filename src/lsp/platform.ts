import * as fs from 'node:fs';
import * as path from 'node:path';

export type PlatformKey = 'win32-x64' | 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64';

export interface LspLaunch {
	command: string;
	args: string[];
	source: 'setting' | 'static' | 'system';
	/** Сообщение пользователю, если используется нештатный вариант. */
	warning?: string;
}

export function platformKey(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): PlatformKey | undefined {
	if (platform === 'win32' && arch === 'x64') {
		return 'win32-x64';
	}
	if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
		return `darwin-${arch}`;
	}
	if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
		return `linux-${arch}`;
	}
	return undefined;
}

/** Имя статического бинарника в `server/bin/`. */
export function staticBinaryName(key: PlatformKey): string {
	return key.startsWith('win32') ? `php-${key}.exe` : `php-${key}`;
}

export interface LaunchOptions {
	extensionPath: string;
	/** `bitrix.lsp.phpBinary` из настроек. */
	configuredBinary?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	exists?: (p: string) => boolean;
}

/**
 * Выбор PHP-рантайма для LSP:
 * 1) явный путь из настроек (для отладки с системным PHP);
 * 2) встроенный static-php-cli бинарник под платформу;
 * 3) `php` из PATH как аварийный вариант.
 *
 * Скрипт — phar из `server/bin/bitrix-lsp.phar`, иначе исходники `server/src/main.php`.
 */
export function resolveLspLaunch(options: LaunchOptions): LspLaunch {
	const exists = options.exists ?? ((p: string) => fs.existsSync(p));
	const serverDir = path.join(options.extensionPath, 'server');
	const phar = path.join(serverDir, 'bin', 'bitrix-lsp.phar');
	const entry = exists(phar) ? phar : path.join(serverDir, 'src', 'main.php');

	if (options.configuredBinary) {
		return { command: options.configuredBinary, args: [entry], source: 'setting' };
	}
	const key = platformKey(options.platform, options.arch);
	if (key) {
		const binary = path.join(serverDir, 'bin', staticBinaryName(key));
		if (exists(binary)) {
			return { command: binary, args: [entry], source: 'static' };
		}
	}
	return {
		command: 'php',
		args: [entry],
		source: 'system',
		warning:
			'Встроенный PHP-бинарник не найден (server/bin/php-<platform>-<arch>), используется php из PATH. ' +
			'Соберите бинарники: npm run build:php.',
	};
}
