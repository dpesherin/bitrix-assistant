import * as path from 'node:path';
import {
	arrayEntries,
	arrayGet,
	asBool,
	asRawList,
	asStringList,
	extractConfigArray,
	resolveConfigPath,
} from '../php/phpArray';

export interface JsExtensionConfig {
	/** Полное имя расширения, например `main.core` или `ui.buttons`. */
	name: string;
	vendor: string;
	configPath: string;
	/** Абсолютные пути к js-файлам (резолв `./`, `/`, `__DIR__`). */
	js: string[];
	css: string[];
	lang: string[];
	rel: string[];
	skipCore: boolean;
}

const CONFIG_KEYS = ['js', 'css', 'lang', 'rel', 'skip_core'] as const;
const CONFIG_KEY_SET = new Set<string>(CONFIG_KEYS);

function toPosix(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Имя расширения из пути конфига: `.../js/<vendor>/<ext>/config.php` → `vendor.ext`.
 * Если vendor-каталога нет — просто имя каталога.
 */
export function extensionNameFromPath(configPath: string): { name: string; vendor: string } {
	const parts = toPosix(configPath).split('/');
	const file = parts.pop() ?? '';
	if (file !== 'config.php') {
		return { name: '', vendor: '' };
	}
	const ext = parts.pop() ?? '';
	const vendor = parts.pop() ?? '';
	if (vendor === 'js' || vendor === '') {
		return { name: ext, vendor: '' };
	}
	return { name: `${vendor}.${ext}`, vendor };
}

/**
 * Резолв значения `js`/`css`/`lang` конфига в абсолютный путь.
 * `'/bitrix/js/main/core/core.js'` трактуется относительно корня проекта,
 * который восстанавливается по сегменту `/bitrix/` или `/local/` в пути к конфигу.
 */
export function resolveAssetPath(raw: string, configDir: string): string | undefined {
	const value = raw.trim();
	if (value === '') {
		return undefined;
	}
	const dir = toPosix(configDir);
	if (value.startsWith('/')) {
		const marker = /\/(bitrix|local)\//.exec(`${dir}/`);
		if (!marker) {
			return undefined;
		}
		const siteRoot = dir.slice(0, marker.index);
		return path.posix.normalize(`${siteRoot}${value}`);
	}
	if (value.startsWith('./') || value.startsWith('../')) {
		return path.posix.normalize(`${dir}/${value}`);
	}
	const fromExpr = resolveConfigPath(value, dir);
	if (fromExpr) {
		return path.posix.normalize(fromExpr);
	}
	return path.posix.normalize(`${dir}/${value}`);
}

function resolveList(rawValues: string[], configDir: string): string[] {
	const out: string[] = [];
	for (const raw of rawValues) {
		const resolved = resolveAssetPath(raw, configDir);
		if (resolved && !out.includes(resolved)) {
			out.push(resolved);
		}
	}
	return out;
}

function makeConfig(
	name: string,
	configPath: string,
	value: Parameters<typeof arrayGet>[0],
): JsExtensionConfig {
	const configDir = path.posix.dirname(toPosix(configPath));
	const fromPath = extensionNameFromPath(configPath);
	const vendor = name.includes('.') ? name.split('.')[0] : fromPath.vendor;
	return {
		name,
		vendor,
		configPath,
		js: resolveList(asRawList(arrayGet(value, 'js')), configDir),
		css: resolveList(asRawList(arrayGet(value, 'css')), configDir),
		lang: resolveList(asRawList(arrayGet(value, 'lang')), configDir),
		rel: asStringList(arrayGet(value, 'rel')),
		skipCore: asBool(arrayGet(value, 'skip_core')) ?? false,
	};
}

/**
 * Разбирает `config.php` расширения (или `jscore.php`).
 * Поддерживаются обе формы:
 *   `$arJsConfig = ['main.core' => ['js' => [...], 'rel' => [...]]]`
 *   `return ['js' => [...], 'rel' => [...]]`
 */
export function parseJsConfig(content: string, configPath: string): JsExtensionConfig[] {
	const root = extractConfigArray(content);
	if (!root || root.kind !== 'array') {
		return [];
	}
	const result: JsExtensionConfig[] = [];
	const rootKeys = new Set(arrayEntries(root).map((entry) => String(entry.key ?? '')));
	const isSingleConfig = [...rootKeys].some((key) => CONFIG_KEY_SET.has(key));
	if (isSingleConfig) {
		const { name } = extensionNameFromPath(toPosix(configPath));
		if (name) {
			result.push(makeConfig(name, configPath, root));
		}
		return result;
	}
	for (const entry of arrayEntries(root)) {
		if (typeof entry.key !== 'string' || entry.value.kind !== 'array') {
			continue;
		}
		const keys = arrayEntries(entry.value).map((item) => String(item.key ?? ''));
		if (!keys.some((key) => CONFIG_KEY_SET.has(key))) {
			continue;
		}
		result.push(makeConfig(entry.key, configPath, entry.value));
	}
	return result;
}
