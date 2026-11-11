import * as os from 'node:os';

/**
 * Версии PHP и порядок поиска исполняемого файла.
 *
 * В .vsix едет ровно один рантайм — `BUNDLED_PHP_VERSION`. Остальные версии
 * пользователь ставит на ПК сам (или скачивает статическую сборку командой
 * `bitrix.php.downloadRuntime`) и указывает путь в `bitrix.php.paths`.
 */

/** Версия встроенного PHP: совпадает с `php-version` в craft.yml. */
export const BUNDLED_PHP_VERSION = '8.4';

/** Версии, доступные в `bitrix.php.version`. */
export const SELECTABLE_PHP_VERSIONS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'] as const;

export type PhpSource = 'paths' | 'lintBinary' | 'downloaded' | 'bundled' | 'path' | 'versioned';

export interface PhpCommand {
	command: string;
	source: PhpSource;
}

export interface CandidateOptions {
	/** `auto` или конкретная версия из SELECTABLE_PHP_VERSIONS. */
	selected: string;
	/** `bitrix.php.paths`: версия → путь к исполняемому файлу. */
	paths?: Record<string, string>;
	/** Устаревший общий путь `bitrix.php.lintBinary`. */
	lintBinary?: string;
	/** Скачанный рантайм нужной версии (globalStorage/php-runtimes). */
	downloaded?: string;
	/** Встроенный бинарник `server/bin/php-<platform>-<arch>`. */
	bundled?: string;
	platform?: NodeJS.Platform;
}

/**
 * Раскрывает `~` и `${env:VAR}` в пути из настроек: путь хранится в settings.json
 * как текст, без привязки к конкретному пользователю и без выбора файла.
 */
export function expandConfigPath(
	value: string,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): string {
	let result = value.trim();
	if (result === '') {
		return result;
	}
	result = result.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
		typeof env[name] === 'string' ? (env[name] as string) : whole,
	);
	if (result === '~') {
		return home;
	}
	if (result.startsWith('~/') || result.startsWith('~\\')) {
		return `${home}${result.slice(1)}`;
	}
	return result;
}

/** Запись «версия + пути» для одного проекта. */
export interface PhpEntry {
	version: string;
	paths: Record<string, string>;
}

/** Приводит значение из настроек/состояния к валидной записи. */
export function normalizePhpEntry(version: unknown, paths: unknown): PhpEntry {
	const entry: PhpEntry = {
		version: typeof version === 'string' && version.trim() !== '' ? version.trim() : 'auto',
		paths: {},
	};
	if (paths && typeof paths === 'object') {
		for (const [key, value] of Object.entries(paths as Record<string, unknown>)) {
			if (typeof value === 'string' && value.trim() !== '') {
				entry.paths[key] = value.trim();
			}
		}
	}
	return entry;
}

/** Ключ проекта в состоянии расширения: путь папки workspace, нормализованный. */
export function projectStorageKey(
	fsPath: string | undefined,
	platform: NodeJS.Platform = process.platform,
): string {
	if (!fsPath) {
		return 'workspace';
	}
	const normalized = fsPath.replace(/[\\/]+$/, '');
	return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Совпадает ли выбранная версия с фактической (сравниваем major.minor). */
export function versionMatches(selected: string, actual: string): boolean {
	if (selected === 'auto') {
		return true;
	}
	const [selectedMajor, selectedMinor] = selected.split('.');
	const [actualMajor, actualMinor] = actual.split('.');
	return selectedMajor === actualMajor && selectedMinor === actualMinor;
}

/**
 * Порядок, в котором ищем PHP под выбранную версию. Явные пути идут раньше
 * встроенного рантайма: если пользователь указал путь, он важнее.
 */
export function candidateCommands(options: CandidateOptions): PhpCommand[] {
	const platform = options.platform ?? process.platform;
	const paths = options.paths ?? {};
	const result: PhpCommand[] = [];
	const push = (command: string | undefined, source: PhpSource): void => {
		const value = (command ?? '').trim();
		if (value === '' || result.some((item) => item.command === value)) {
			return;
		}
		result.push({ command: value, source });
	};

	if (options.selected === 'auto') {
		// `auto` — «что установлено на ПК»: сначала php из PATH, потом встроенный.
		push('php', 'path');
		push(paths[BUNDLED_PHP_VERSION], 'paths');
		push(options.lintBinary, 'lintBinary');
		push(options.bundled, 'bundled');
		return result;
	}

	push(paths[options.selected], 'paths');
	push(options.lintBinary, 'lintBinary');
	push(options.downloaded, 'downloaded');
	if (options.selected === BUNDLED_PHP_VERSION) {
		push(options.bundled, 'bundled');
	}
	push(`php${options.selected}`, 'versioned');
	if (platform === 'darwin') {
		// Homebrew: /opt/homebrew на Apple Silicon, /usr/local на Intel.
		push(`/opt/homebrew/opt/php@${options.selected}/bin/php`, 'versioned');
		push(`/usr/local/opt/php@${options.selected}/bin/php`, 'versioned');
	}
	return result;
}

/** Человеческое описание источника — для лога и сообщений. */
export function describeSource(source: PhpSource): string {
	switch (source) {
		case 'paths':
			return 'bitrix.php.paths';
		case 'lintBinary':
			return 'bitrix.php.lintBinary';
		case 'downloaded':
			return 'скачанный рантайм';
		case 'bundled':
			return 'встроенный рантайм';
		case 'path':
			return 'php из PATH';
		case 'versioned':
			return 'PATH/Homebrew';
	}
}
