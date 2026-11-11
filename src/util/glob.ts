/**
 * Минимальная поддержка glob-паттернов для exclude-списков.
 * Поддерживаются: `**`, `*`, `?`, литералы. Разделитель — только `/`.
 */

const cache = new Map<string, RegExp>();

export function toPosix(p: string): string {
	return p.replace(/\\/g, '/');
}

export function normalizeRelative(p: string): string {
	let s = toPosix(p).replace(/^\.\//, '');
	if (s.endsWith('/')) {
		s = s.slice(0, -1);
	}
	return s;
}

export function globToRegExp(pattern: string): RegExp {
	const cached = cache.get(pattern);
	if (cached) {
		return cached;
	}
	const src = normalizeRelative(pattern);
	let out = '';
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === '*') {
			if (src[i + 1] === '*') {
				i += 1;
				if (src[i + 1] === '/') {
					i += 1;
					out += '(?:.*/)?';
				} else {
					out += '.*';
				}
			} else {
				out += '[^/]*';
			}
		} else if (ch === '?') {
			out += '[^/]';
		} else if ('\\^$.|+()[]{}'.includes(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	const re = new RegExp(`^${out}$`);
	cache.set(pattern, re);
	return re;
}

/** Путь исключён, если совпал сам паттерн или его родительский каталог. */
export function isExcluded(relPath: string, patterns: readonly string[]): boolean {
	const p = normalizeRelative(relPath);
	for (const pattern of patterns) {
		const clean = normalizeRelative(pattern);
		if (globToRegExp(clean).test(p)) {
			return true;
		}
		// `bitrix/cache` без `/**` должен исключать и содержимое каталога.
		if (p.startsWith(`${clean}/`) && globToRegExp(clean).test(clean)) {
			return true;
		}
		// `dir/**` должен исключать и сам каталог (для раннего пропуска обхода).
		if (clean.endsWith('/**')) {
			const dir = clean.slice(0, -3);
			if (p === dir || p.startsWith(`${dir}/`)) {
				return true;
			}
		}
		if (clean.startsWith('**/') && globToRegExp(clean.slice(3)).test(p)) {
			return true;
		}
	}
	return false;
}
