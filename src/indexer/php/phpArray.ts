/**
 * Разбор подмножества PHP-литералов, достаточного для `config.php` расширений,
 * `.parameters.php` компонентов и `jscore.php`.
 *
 * Поддерживается: `array(...)`, `[...]`, строки, числа, true/false/null,
 * вложенные массивы, ключи `=>`, конкатенация (сохраняется как `expr`).
 * Никакого исполнения PHP-кода — только детерминированный разбор текста.
 */

export type PhpValue =
	| { kind: 'array'; entries: PhpEntry[] }
	| { kind: 'string'; value: string }
	| { kind: 'number'; value: number }
	| { kind: 'bool'; value: boolean }
	| { kind: 'null' }
	| { kind: 'expr'; text: string };

export interface PhpEntry {
	key?: string | number;
	value: PhpValue;
}

interface Token {
	type: 'string' | 'number' | 'ident' | 'punct' | 'eof';
	text: string;
	start: number;
	end: number;
}

const IDENT_START = /[A-Za-z_\\]/;
const IDENT_PART = /[A-Za-z0-9_\\]/;

function tokenize(src: string, from: number): Token[] {
	const tokens: Token[] = [];
	let i = from;
	while (i < src.length) {
		const ch = src[i];
		if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
			i++;
			continue;
		}
		if (ch === '/' && src[i + 1] === '/') {
			const nl = src.indexOf('\n', i);
			i = nl === -1 ? src.length : nl + 1;
			continue;
		}
		if (ch === '#') {
			const nl = src.indexOf('\n', i);
			i = nl === -1 ? src.length : nl + 1;
			continue;
		}
		if (ch === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			i = close === -1 ? src.length : close + 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const { value, end } = readString(src, i);
			tokens.push({ type: 'string', text: value, start: i, end });
			i = end;
			continue;
		}
		if (/[0-9]/.test(ch)) {
			let j = i;
			while (j < src.length && /[0-9_.]/.test(src[j])) {
				j++;
			}
			tokens.push({ type: 'number', text: src.slice(i, j), start: i, end: j });
			i = j;
			continue;
		}
		if (IDENT_START.test(ch)) {
			let j = i;
			while (j < src.length && IDENT_PART.test(src[j])) {
				j++;
			}
			tokens.push({ type: 'ident', text: src.slice(i, j), start: i, end: j });
			i = j;
			continue;
		}
		if (ch === '=' && src[i + 1] === '>') {
			tokens.push({ type: 'punct', text: '=>', start: i, end: i + 2 });
			i += 2;
			continue;
		}
		if (ch === '-' && src[i + 1] === '>') {
			tokens.push({ type: 'punct', text: '->', start: i, end: i + 2 });
			i += 2;
			continue;
		}
		if (ch === ':' && src[i + 1] === ':') {
			tokens.push({ type: 'punct', text: '::', start: i, end: i + 2 });
			i += 2;
			continue;
		}
		tokens.push({ type: 'punct', text: ch, start: i, end: i + 1 });
		i++;
	}
	tokens.push({ type: 'eof', text: '', start: src.length, end: src.length });
	return tokens;
}

function readString(src: string, start: number): { value: string; end: number } {
	const quote = src[start];
	let out = '';
	let i = start + 1;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '\\') {
			const next = src[i + 1];
			if (next === undefined) {
				break;
			}
			const map: Record<string, string> = {
				n: '\n',
				r: '\r',
				t: '\t',
				'\\': '\\',
				"'": "'",
				'"': '"',
				$: '$',
			};
			out += map[next] ?? next;
			i += 2;
			continue;
		}
		if (ch === quote) {
			return { value: out, end: i + 1 };
		}
		out += ch;
		i++;
	}
	return { value: out, end: src.length };
}

class Parser {
	private index = 0;

	constructor(
		private readonly src: string,
		private readonly tokens: Token[],
	) {}

	get position(): number {
		return this.tokens[this.index]?.start ?? this.src.length;
	}

	private peek(offset = 0): Token {
		return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
	}

	private take(): Token {
		const token = this.peek();
		this.index++;
		return token;
	}

	parseValue(): PhpValue {
		const token = this.peek();
		if (token.type === 'string') {
			this.take();
			return this.maybeExpression({ kind: 'string', value: token.text }, token.start);
		}
		if (token.type === 'number') {
			this.take();
			const numeric = Number(token.text.replace(/_/g, ''));
			return this.maybeExpression({ kind: 'number', value: Number.isFinite(numeric) ? numeric : 0 }, token.start);
		}
		if (token.type === 'punct' && (token.text === '[' || token.text === '(')) {
			return this.parseArray(token);
		}
		if (token.type === 'ident') {
			const lowered = token.text.toLowerCase();
			if (lowered === 'array') {
				const next = this.peek(1);
				if (next.type === 'punct' && next.text === '(') {
					this.take();
					return this.parseArray(this.peek());
				}
			}
			if (lowered === 'true' || lowered === 'false') {
				this.take();
				return { kind: 'bool', value: lowered === 'true' };
			}
			if (lowered === 'null') {
				this.take();
				return { kind: 'null' };
			}
		}
		return this.parseExpression();
	}

	private parseArray(open: Token): PhpValue {
		this.take();
		const close = open.text === '[' ? ']' : ')';
		const entries: PhpEntry[] = [];
		while (this.peek().type !== 'eof' && entries.length < 10_000) {
			const token = this.peek();
			if (token.type === 'punct' && token.text === close) {
				this.take();
				break;
			}
			if (token.type === 'punct' && token.text === ',') {
				this.take();
				continue;
			}
			// Гарантия прогресса: на неожиданной пунктуации (`;`, `=`, ...)
			// разбор не должен зацикливаться и копить записи до OOM.
			const before = this.index;
			const first = this.parseValue();
			if (this.index === before) {
				this.take();
				continue;
			}
			if (this.peek().type === 'punct' && this.peek().text === '=>') {
				this.take();
				const value = this.parseValue();
				entries.push({ key: scalarKey(first), value });
			} else {
				entries.push({ value: first });
			}
			if (this.peek().type === 'punct' && this.peek().text === ',') {
				this.take();
			}
		}
		return { kind: 'array', entries };
	}

	private maybeExpression(value: PhpValue, start: number): PhpValue {
		if (!(this.peek().type === 'punct' && this.peek().text === '.')) {
			return value;
		}
		return this.parseExpression(start);
	}

	/** Всё, что не литерал (константы, `__DIR__ . '/x'`, вызовы), хранится как исходный текст. */
	private parseExpression(startOverride?: number): PhpValue {
		const start = startOverride ?? this.peek().start;
		let depth = 0;
		let end = start;
		while (this.peek().type !== 'eof') {
			const token = this.peek();
			if (token.type === 'punct') {
				if (token.text === '(' || token.text === '[') {
					depth++;
				} else if (token.text === ')' || token.text === ']') {
					if (depth === 0) {
						break;
					}
					depth--;
				} else if (depth === 0 && (token.text === ',' || token.text === ';' || token.text === '=>')) {
					break;
				}
			}
			end = token.end;
			this.take();
		}
		const text = this.src.slice(start, end).trim().replace(/\s+/g, ' ');
		return { kind: 'expr', text };
	}
}

function scalarKey(value: PhpValue): string | number | undefined {
	if (value.kind === 'string') {
		return value.value;
	}
	if (value.kind === 'number') {
		return value.value;
	}
	return undefined;
}

/** Разбирает массив, начинающийся в позиции `start` (пробелы/комментарии допустимы). */
export function parseArrayAt(src: string, start: number): { value: PhpValue; end: number } | undefined {
	const tokens = tokenize(src, start);
	const parser = new Parser(src, tokens);
	const first = tokens[0];
	if (!first) {
		return undefined;
	}
	const isArray =
		(first.type === 'punct' && (first.text === '[' || first.text === '(')) ||
		(first.type === 'ident' && first.text.toLowerCase() === 'array');
	if (!isArray) {
		return undefined;
	}
	const value = parser.parseValue();
	if (value.kind !== 'array') {
		return undefined;
	}
	return { value, end: parser.position };
}

/** `$var = array(...)` / `$var = [...]`. */
export function findAssignedArray(src: string, variable: string): PhpValue | undefined {
	const escaped = variable.replace(/[.$]/g, '\\$&');
	const re = new RegExp(`${escaped}\\s*=\\s*`, 'g');
	const match = re.exec(src);
	if (!match) {
		return undefined;
	}
	const parsed = parseArrayAt(src, match.index + match[0].length);
	return parsed?.value;
}

/** Первый массив после `return` (jscore.php и подобные файлы). */
export function findReturnedArray(src: string): PhpValue | undefined {
	const re = /\breturn\s+(?=array\s*\(|\[)/g;
	const match = re.exec(src);
	if (!match) {
		return undefined;
	}
	return parseArrayAt(src, match.index + match[0].length)?.value;
}

/**
 * Достаёт массив из файла: сначала `$variable`, затем `return ...`, затем
 * первый `array(` (для конфигов без обёртки).
 */
export function extractConfigArray(src: string, variable = '$arJsConfig'): PhpValue | undefined {
	const assigned = findAssignedArray(src, variable);
	if (assigned) {
		return assigned;
	}
	const returned = findReturnedArray(src);
	if (returned) {
		return returned;
	}
	const re = /array\s*\(/g;
	const match = re.exec(src);
	if (match) {
		return parseArrayAt(src, match.index)?.value;
	}
	return undefined;
}

export function arrayEntries(value: PhpValue | undefined): PhpEntry[] {
	return value && value.kind === 'array' ? value.entries : [];
}

export function arrayGet(value: PhpValue | undefined, key: string | number): PhpValue | undefined {
	if (!value || value.kind !== 'array') {
		return undefined;
	}
	for (const entry of value.entries) {
		if (entry.key === key) {
			return entry.value;
		}
	}
	return undefined;
}

export function asString(value: PhpValue | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	if (value.kind === 'string') {
		return value.value;
	}
	if (value.kind === 'number') {
		return String(value.value);
	}
	return undefined;
}

/** Как `asStringList`, но сохраняет неразобранные выражения (`__DIR__ . '/x'`). */
export function asRawList(value: PhpValue | undefined): string[] {
	if (!value) {
		return [];
	}
	if (value.kind === 'string') {
		return [value.value];
	}
	if (value.kind === 'expr') {
		return [value.text];
	}
	if (value.kind !== 'array') {
		return [];
	}
	const out: string[] = [];
	for (const entry of value.entries) {
		const item = entry.value;
		if (item.kind === 'string') {
			out.push(item.value);
		} else if (item.kind === 'expr') {
			out.push(item.text);
		}
	}
	return out;
}

export function asStringList(value: PhpValue | undefined): string[] {
	if (!value) {
		return [];
	}
	if (value.kind === 'string') {
		return [value.value];
	}
	if (value.kind !== 'array') {
		return [];
	}
	const out: string[] = [];
	for (const entry of value.entries) {
		const str = asString(entry.value);
		if (str !== undefined && str !== '') {
			out.push(str);
		}
	}
	return out;
}

export function asBool(value: PhpValue | undefined): boolean | undefined {
	if (!value) {
		return undefined;
	}
	if (value.kind === 'bool') {
		return value.value;
	}
	if (value.kind === 'number') {
		return value.value !== 0;
	}
	if (value.kind === 'string') {
		return value.value !== '' && value.value !== '0';
	}
	return undefined;
}

/** Разворачивает `__DIR__ . '/x'` / `__DIR__ . "/x"` в путь относительно каталога конфига. */
export function resolveConfigPath(raw: string, configDir: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed === '') {
		return undefined;
	}
	if (/^['"]/.test(trimmed)) {
		const m = /^(['"])(.*?)\1/.exec(trimmed);
		if (m) {
			return m[2].startsWith('/') ? m[2] : undefined;
		}
	}
	const dirMatch = /^__DIR__((?:\s*\.\s*(['"])(.*?)\2)+)$/.exec(trimmed);
	if (dirMatch) {
		const parts = [...trimmed.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
		const joined = parts.join('');
		return joined.startsWith('/') ? `${configDir}${joined}` : `${configDir}/${joined}`;
	}
	return undefined;
}
