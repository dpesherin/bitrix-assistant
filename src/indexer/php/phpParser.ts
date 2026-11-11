/**
 * Детерминированный разбор PHP-файлов ядра Битрикса: классы, наследование,
 * методы с сигнатурами, doc-блоки, `@deprecated`, ORM-таблицы.
 *
 * Это не полноценный парсер PHP, а устойчивый сканер на маскированной копии
 * исходника: комментарии/строки заменяются пробелами, поэтому ключевые слова
 * внутри строк и heredoc не дают ложных срабатываний.
 */

export interface PhpDocBlock {
	start: number;
	end: number;
	text: string;
}

export interface ParsedParam {
	name: string;
	type?: string;
	default?: string;
	variadic: boolean;
	byRef: boolean;
}

export type PhpClassKind = 'class' | 'interface' | 'trait' | 'enum';

export interface ParsedMethod {
	name: string;
	signature: string;
	returnType?: string;
	params: ParsedParam[];
	isStatic: boolean;
	visibility: 'public' | 'protected' | 'private';
	isAbstract: boolean;
	line: number;
	doc?: string;
	deprecated: boolean;
	deprecatedNote?: string;
}

export interface ParsedProperty {
	name: string;
	type?: string;
	visibility: 'public' | 'protected' | 'private';
	isStatic: boolean;
	defaultValue?: string;
	doc?: string;
	line: number;
}

export interface ParsedConstant {
	name: string;
	type?: string;
	value?: string;
	doc?: string;
	line: number;
}

export interface ParsedFunction {
	name: string;
	fqcn: string;
	signature: string;
	returnType?: string;
	params: ParsedParam[];
	doc?: string;
	deprecated: boolean;
	deprecatedNote?: string;
	line: number;
}

export interface ParsedGlobalConstant {
	name: string;
	value?: string;
	doc?: string;
	line: number;
}

export interface ParsedClass {
	fqcn: string;
	name: string;
	namespace: string;
	kind: PhpClassKind;
	extends?: string;
	implements: string[];
	isAbstract: boolean;
	isFinal: boolean;
	isOrm: boolean;
	deprecated: boolean;
	deprecatedNote?: string;
	doc?: string;
	line: number;
	methods: ParsedMethod[];
	properties: ParsedProperty[];
	constants: ParsedConstant[];
	traits: string[];
}

function lineStartsOf(src: string): number[] {
	const starts = [0];
	for (let i = 0; i < src.length; i++) {
		if (src[i] === '\n') {
			starts.push(i + 1);
		}
	}
	return starts;
}

function lineAt(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo + 1;
}

/**
 * Маскирует комментарии и строки. Doc-блоки дополнительно возвращаются списком,
 * чтобы потом связать их с объявлениями.
 */
/**
 * Оставляет только PHP-код (`<?php … ?>`), HTML/JS снаружи заменяет пробелами.
 * Иначе `define('item', …)` из JS-шаблона попадает в глобальные константы.
 */
function phpOnlySource(source: string): string {
	const open = source.indexOf('<?');
	if (open === -1) {
		return source;
	}
	const out = source.split('');
	const length = source.length;
	let i = 0;
	let inPhp = false;
	let quote: string | null = null;
	let lineComment = false;
	let blockComment = false;
	const blank = (from: number, to: number): void => {
		for (; from < to; from++) {
			if (out[from] !== '\n') {
				out[from] = ' ';
			}
		}
	};
	while (i < length) {
		if (!inPhp) {
			const start = source.indexOf('<?', i);
			if (start === -1) {
				blank(i, length);
				break;
			}
			blank(i, start);
			inPhp = true;
			i = start + 2;
			continue;
		}
		const ch = source[i];
		const next = source[i + 1] ?? '';
		if (lineComment) {
			if (ch === '\n') {
				lineComment = false;
			}
			i++;
			continue;
		}
		if (blockComment) {
			if (ch === '*' && next === '/') {
				blockComment = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (quote !== null) {
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === quote) {
				quote = null;
			}
			i++;
			continue;
		}
		if (ch === '/' && next === '/') {
			lineComment = true;
			i += 2;
			continue;
		}
		if (ch === '/' && next === '*') {
			blockComment = true;
			i += 2;
			continue;
		}
		if (ch === '#' && next !== '[') {
			lineComment = true;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			quote = ch;
			i++;
			continue;
		}
		if (ch === '?' && next === '>') {
			inPhp = false;
			i += 2;
			continue;
		}
		i++;
	}
	return out.join('');
}

export function maskPhp(src: string): { masked: string; docblocks: PhpDocBlock[] } {
	src = phpOnlySource(src);
	const out = src.split('');
	const docblocks: PhpDocBlock[] = [];
	let i = 0;
	const blank = (from: number, to: number): void => {
		for (let k = from; k < to && k < src.length; k++) {
			if (src[k] !== '\n') {
				out[k] = ' ';
			}
		}
	};
	while (i < src.length) {
		const ch = src[i];
		if (ch === '/' && src[i + 1] === '/') {
			let j = i;
			while (j < src.length && src[j] !== '\n') {
				j++;
			}
			blank(i, j);
			i = j;
			continue;
		}
		if (ch === '#' && src[i + 1] === '[') {
			// PHP-атрибут `#[...]`: маскируем целиком, чтобы аргументы
			// с `$var` и вложенными массивами не попадали в объявления.
			let j = i + 2;
			let depth = 1;
			while (j < src.length && depth > 0) {
				const current = src[j];
				if (current === "'" || current === '"') {
					const quote = current;
					j++;
					while (j < src.length && src[j] !== quote) {
						if (src[j] === '\\') {
							j++;
						}
						j++;
					}
					j++;
					continue;
				}
				if (current === '[') {
					depth++;
				} else if (current === ']') {
					depth--;
				}
				j++;
			}
			blank(i, Math.min(j, src.length));
			i = j;
			continue;
		}
		if (ch === '#' && src[i + 1] !== '[') {
			let j = i;
			while (j < src.length && src[j] !== '\n') {
				j++;
			}
			blank(i, j);
			i = j;
			continue;
		}
		if (ch === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			const stop = close === -1 ? src.length : close + 2;
			if (src[i + 2] === '*' && src[i + 3] !== '/') {
				const text = src.slice(i + 3, close === -1 ? src.length : close);
				docblocks.push({ start: i, end: stop, text: cleanDocblock(text) });
			}
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const quote = ch;
			let j = i + 1;
			while (j < src.length && src[j] !== quote) {
				if (src[j] === '\\') {
					j++;
				}
				j++;
			}
			j++;
			blank(i, Math.min(j, src.length));
			i = j;
			continue;
		}
		if (ch === '<' && src.startsWith('<<<', i)) {
			const header = /^<<<[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n/.exec(src.slice(i));
			if (header) {
				const terminator = new RegExp(`^[ \\t]*${header[2]}\\b`, 'm');
				const rest = src.slice(i + header[0].length);
				const m = terminator.exec(rest);
				const stop = m ? i + header[0].length + m.index + m[0].length : src.length;
				blank(i, stop);
				i = stop;
				continue;
			}
		}
		i++;
	}
	return { masked: out.join(''), docblocks };
}

function cleanDocblock(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
		.join('\n')
		.trim();
}

function findDocblock(docblocks: PhpDocBlock[], declStart: number, masked: string): PhpDocBlock | undefined {
	for (let i = docblocks.length - 1; i >= 0; i--) {
		const doc = docblocks[i];
		if (doc.end <= declStart) {
			if (masked.slice(doc.end, declStart).trim() === '') {
				if (declStart - doc.end <= 400) {
					return doc;
				}
			}
			return undefined;
		}
	}
	return undefined;
}

function matchingBrace(src: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < src.length; i++) {
		const ch = src[i];
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return src.length;
}

function matchingParen(src: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < src.length; i++) {
		const ch = src[i];
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return src.length;
}

function depthAt(masked: string, bodyOpen: number, target: number): number {
	let depth = 0;
	for (let i = bodyOpen; i < target; i++) {
		if (masked[i] === '{') {
			depth++;
		} else if (masked[i] === '}') {
			depth--;
		}
	}
	return depth;
}

function parseClassMembers(
	content: string,
	masked: string,
	docblocks: PhpDocBlock[],
	starts: number[],
	bodyOpen: number,
	bodyClose: number,
): { properties: ParsedProperty[]; constants: ParsedConstant[]; traits: string[] } {
	const properties: ParsedProperty[] = [];
	const constants: ParsedConstant[] = [];
	const traits: string[] = [];
	const body = masked.slice(bodyOpen, bodyClose);

	const propertyRe =
		/((?:(?:public|protected|private|static|readonly)\s+)*)(?:([?\\A-Za-z0-9_|\[\]]+)\s+)?\$([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*([^;]+))?;/g;
	for (let match = propertyRe.exec(body); match; match = propertyRe.exec(body)) {
		const abs = bodyOpen + match.index;
		if (depthAt(masked, bodyOpen, abs) !== 1) {
			continue;
		}
		if (abs > 0 && (masked[abs - 1] === ':' || masked[abs - 1] === '$')) {
			continue;
		}
		// Параметр метода (`int $x = 1)`) не должен считаться свойством.
		if (/[){}]/.test(match[0])) {
			continue;
		}
		const modifiers = match[1] ?? '';
		const doc = findDocblock(docblocks, abs, masked);
		const docType = doc ? /@var\s+([^\s*]+)/.exec(doc.text)?.[1] : undefined;
		const equals = match[0].indexOf('=');
		const defaultValue =
			equals === -1
				? undefined
				: content.slice(abs + equals + 1, abs + match[0].length - 1).trim();
		properties.push({
			name: match[3],
			type: match[2]?.trim() || docType,
			visibility: /\bprivate\b/.test(modifiers)
				? 'private'
				: /\bprotected\b/.test(modifiers)
					? 'protected'
					: 'public',
			isStatic: /\bstatic\b/.test(modifiers),
			defaultValue: defaultValue || undefined,
			doc: doc?.text,
			line: lineAt(starts, abs),
		});
	}

	const constRe = /((?:(?:public|protected|private|final)\s+)*)const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/g;
	for (let match = constRe.exec(body); match; match = constRe.exec(body)) {
		const abs = bodyOpen + match.index;
		if (depthAt(masked, bodyOpen, abs) !== 1) {
			continue;
		}
		const doc = findDocblock(docblocks, abs, masked);
		const equals = match[0].indexOf('=');
		const value =
			equals === -1 ? undefined : content.slice(abs + equals + 1, abs + match[0].length - 1).trim();
		constants.push({
			name: match[2],
			value: value || undefined,
			doc: doc?.text,
			line: lineAt(starts, abs),
		});
	}

	const traitRe = /^[ \t]*use\s+([A-Za-z0-9_\\,\s]+);/gm;
	for (let match = traitRe.exec(body); match; match = traitRe.exec(body)) {
		const abs = bodyOpen + match.index;
		if (depthAt(masked, bodyOpen, abs) !== 1) {
			continue;
		}
		for (const name of match[1].split(',')) {
			const clean = name.trim();
			if (clean && !/^(function|const)$/i.test(clean)) {
				traits.push(clean);
			}
		}
	}

	return { properties, constants, traits };
}

function splitParams(original: string, masked: string, from: number, to: number): string[] {
	const parts: string[] = [];
	let depth = 0;
	let last = from;
	for (let i = from; i < to; i++) {
		const ch = masked[i];
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
		} else if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
		} else if (ch === ',' && depth === 0) {
			parts.push(original.slice(last, i));
			last = i + 1;
		}
	}
	const tail = original.slice(last, to);
	if (tail.trim() !== '') {
		parts.push(tail);
	}
	return parts;
}

function parseParam(raw: string): ParsedParam | undefined {
	const text = raw.trim();
	if (text === '') {
		return undefined;
	}
	const nameMatch = /\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
	if (!nameMatch) {
		return undefined;
	}
	const beforeName = text.slice(0, nameMatch.index);
	const variadic = beforeName.includes('...');
	const byRef = /&\s*$/.test(beforeName);
	const typeText = beforeName
		.replace(/\.\.\./g, ' ')
		.replace(/&/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const eqIndex = text.indexOf('=', nameMatch.index + nameMatch[0].length);
	const defaultValue = eqIndex === -1 ? undefined : text.slice(eqIndex + 1).trim();
	return {
		name: nameMatch[1],
		type: typeText === '' ? undefined : typeText,
		default: defaultValue,
		variadic,
		byRef,
	};
}

/**
 * Резолвит имя класса/трейта/интерфейса через `use`-импорты файла.
 * `\Foo\Bar` остаётся как есть; `Bar` и `Main\Bar` с импортом `Main` → FQCN.
 * Если импорта нет, имя возвращается как написано (дальше его пробует сервер).
 */
function resolveImportedName(raw: string, uses: Map<string, string>): string {
	const name = raw.trim();
	if (name === '' || name.startsWith('\\')) {
		return name.replace(/^\\/, '');
	}
	const slash = name.indexOf('\\');
	const head = slash === -1 ? name : name.slice(0, slash);
	const imported = uses.get(head);
	if (!imported) {
		return name;
	}
	return slash === -1 ? imported : `${imported}${name.slice(slash)}`;
}

function findUseStatements(masked: string): Map<string, string> {
	const map = new Map<string, string>();
	const re = /\buse\s+([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;/g;
	for (let m = re.exec(masked); m; m = re.exec(masked)) {
		const fqcn = m[1].replace(/^\\/, '');
		const alias = m[2] ?? fqcn.split('\\').pop();
		if (alias && !map.has(alias)) {
			map.set(alias, fqcn);
		}
	}
	return map;
}

export interface ParsedPhpFile {
	namespace: string;
	uses: Map<string, string>;
	classes: ParsedClass[];
	functions: ParsedFunction[];
	constants: ParsedGlobalConstant[];
}

/** Лежит ли смещение внутри одного из диапазонов [start, end]. */
function insideRanges(offset: number, ranges: Array<[number, number]>): boolean {
	for (const [start, end] of ranges) {
		if (offset >= start && offset <= end) {
			return true;
		}
	}
	return false;
}

function parseTopLevelFunctions(
	content: string,
	masked: string,
	docblocks: PhpDocBlock[],
	starts: number[],
	namespace: string,
	classRanges: Array<[number, number]>,
): { functions: ParsedFunction[]; ranges: Array<[number, number]> } {
	const functions: ParsedFunction[] = [];
	const ranges: Array<[number, number]> = [];
	const re = /\bfunction\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
	for (let m = re.exec(masked); m; m = re.exec(masked)) {
		if (insideRanges(m.index, classRanges)) {
			continue;
		}
		const name = m[1];
		const openParen = re.lastIndex - 1;
		const closeParen = matchingParen(masked, openParen);
		if (closeParen <= openParen) {
			continue;
		}
		const paramsText = content.slice(openParen + 1, closeParen);
		const params = splitParams(content, masked, openParen + 1, closeParen)
			.map(parseParam)
			.filter((param): param is ParsedParam => Boolean(param));
		const returnMatch = /^\s*:\s*([A-Za-z0-9_\\?|]+)/.exec(masked.slice(closeParen + 1, closeParen + 120));
		const doc = findDocblock(docblocks, m.index, masked);
		const docReturn = doc ? /@return\s+([^\s*]+)/.exec(doc.text)?.[1] : undefined;
		const returnType = returnMatch ? returnMatch[1] : docReturn;
		const deprecatedLine = doc?.text.split('\n').find((line) => /^@deprecated\b/.test(line));
		const signatureBody = paramsText.replace(/\s+/g, ' ').trim();
		functions.push({
			name,
			fqcn: namespace ? `${namespace}\\${name}` : name,
			signature: `${name}(${signatureBody})${returnType ? `: ${returnType}` : ''}`,
			returnType,
			params,
			doc: doc?.text,
			deprecated: Boolean(deprecatedLine),
			deprecatedNote: deprecatedLine?.replace(/^@deprecated\s*/, '').trim() || undefined,
			line: lineAt(starts, m.index),
		});
		const brace = masked.indexOf('{', closeParen + 1);
		const semicolon = masked.indexOf(';', closeParen + 1);
		if (brace !== -1 && (semicolon === -1 || brace < semicolon)) {
			ranges.push([brace, matchingBrace(masked, brace)]);
		}
	}
	return { functions, ranges };
}

function parseGlobalConstants(
	content: string,
	masked: string,
	docblocks: PhpDocBlock[],
	starts: number[],
	skipRanges: Array<[number, number]>,
): ParsedGlobalConstant[] {
	const constants: ParsedGlobalConstant[] = [];
	const seen = new Set<string>();
	const push = (name: string, value: string | undefined, offset: number): void => {
		if (name === '' || seen.has(name)) {
			return;
		}
		seen.add(name);
		const doc = findDocblock(docblocks, offset, masked);
		constants.push({
			name,
			value: value?.trim() ? value.trim().slice(0, 300) : undefined,
			doc: doc?.text,
			line: lineAt(starts, offset),
		});
	};

	const constRe = /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/g;
	for (let m = constRe.exec(masked); m; m = constRe.exec(masked)) {
		if (insideRanges(m.index, skipRanges)) {
			continue;
		}
		push(m[1], content.slice(m.index + m[0].indexOf('=') + 1, m.index + m[0].length - 1), m.index);
	}

	// `define('NAME', ...)`: имя — строка, а `maskPhp` её вырезает, поэтому
	// ищем по исходнику, но проверяем, что это не комментарий (в masked — код).
	const defineRe = /\bdefine\s*\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*,/g;
	for (let m = defineRe.exec(content); m; m = defineRe.exec(content)) {
		if (insideRanges(m.index, skipRanges) || masked.slice(m.index, m.index + 6) !== 'define') {
			continue;
		}
		const openParen = masked.indexOf('(', m.index);
		const closeParen = matchingParen(masked, openParen);
		const comma = masked.indexOf(',', m.index);
		const value = closeParen > comma ? content.slice(comma + 1, closeParen).trim() : undefined;
		push(m[2], value, m.index);
	}

	constants.sort((left, right) => left.line - right.line);
	return constants;
}

export function parsePhpFile(content: string): ParsedPhpFile {
	const { masked, docblocks } = maskPhp(content);
	const starts = lineStartsOf(content);
	const namespaceMatch = /\bnamespace\s+([A-Za-z0-9_\\]+)\s*[;{]/.exec(masked);
	const namespace = namespaceMatch ? namespaceMatch[1].replace(/^\\/, '') : '';
	const uses = findUseStatements(masked);
	const classes: ParsedClass[] = [];
	const classRanges: Array<[number, number]> = [];

	const classRe =
		/\b((?:(?:abstract|final|readonly)\s+)*)(class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)([\s\S]*?)\{/g;
	for (let m = classRe.exec(masked); m; m = classRe.exec(masked)) {
		const modifiers = m[1] ?? '';
		const kind = m[2] as PhpClassKind;
		const name = m[3];
		const header = m[4] ?? '';
		const bodyOpen = m.index + m[0].length - 1;
		const bodyClose = matchingBrace(masked, bodyOpen);
		classRanges.push([bodyOpen, bodyClose]);
		const extendsMatch = /\bextends\s+([A-Za-z0-9_\\]+)/.exec(header);
		const implementsMatch = /\bimplements\s+([A-Za-z0-9_\\,\s]+)/.exec(header);
		const implementsList = implementsMatch
			? implementsMatch[1]
					.split(',')
					.map((item) => resolveImportedName(item, uses))
					.filter(Boolean)
			: [];
		const extendsName = extendsMatch ? resolveImportedName(extendsMatch[1], uses) : undefined;
		const doc = findDocblock(docblocks, m.index, masked);
		const deprecatedLine = doc?.text.split('\n').find((line) => /^@deprecated\b/.test(line));
		const methods: ParsedMethod[] = [];

		const fnRe =
			/((?:(?:public|protected|private|static|abstract|final|readonly)\s+)*)function\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
		fnRe.lastIndex = bodyOpen;
		for (let fn = fnRe.exec(masked); fn && fn.index < bodyClose; fn = fnRe.exec(masked)) {
			const mods = fn[1] ?? '';
			const openParen = fnRe.lastIndex - 1;
			const closeParen = matchingParen(masked, openParen);
			const paramsText = content.slice(openParen + 1, closeParen);
			const params = splitParams(content, masked, openParen + 1, closeParen)
				.map(parseParam)
				.filter((param): param is ParsedParam => Boolean(param));
			const returnMatch = /^\s*:\s*([A-Za-z0-9_\\?|]+)/.exec(masked.slice(closeParen + 1, closeParen + 120));
			const fnDoc = findDocblock(docblocks, fn.index, masked);
			const docReturn = fnDoc ? /@return\s+([^\s*]+)/.exec(fnDoc.text)?.[1] : undefined;
			const returnType = returnMatch ? returnMatch[1] : docReturn;
			const deprecatedLine = fnDoc?.text.split('\n').find((line) => /^@deprecated\b/.test(line));
			const visibility = /\bprivate\b/.test(mods)
				? 'private'
				: /\bprotected\b/.test(mods)
					? 'protected'
					: 'public';
			const signatureBody = paramsText.replace(/\s+/g, ' ').trim();
			methods.push({
				name: fn[2],
				signature: `${fn[2]}(${signatureBody})${returnType ? `: ${returnType}` : ''}`,
				returnType,
				params,
				isStatic: /\bstatic\b/.test(mods),
				visibility,
				isAbstract: /\babstract\b/.test(mods) || kind === 'interface',
				line: lineAt(starts, fn.index),
				doc: fnDoc?.text,
				deprecated: Boolean(deprecatedLine),
				deprecatedNote: deprecatedLine?.replace(/^@deprecated\s*/, '').trim() || undefined,
			});
		}

		const members = parseClassMembers(content, masked, docblocks, starts, bodyOpen, bodyClose);
		const extendsShort = extendsName?.split('\\').pop();
		classes.push({
			fqcn: namespace ? `${namespace}\\${name}` : name,
			name,
			namespace,
			kind,
			extends: extendsName,
			implements: implementsList,
			isAbstract: /\babstract\b/.test(modifiers),
			isFinal: /\bfinal\b/.test(modifiers),
			isOrm: extendsShort === 'DataManager',
			deprecated: Boolean(deprecatedLine),
			deprecatedNote: deprecatedLine?.replace(/^@deprecated\s*/, '').trim() || undefined,
			doc: doc?.text,
			line: lineAt(starts, m.index),
			methods,
			properties: members.properties,
			constants: members.constants,
			traits: members.traits.map((name) => resolveImportedName(name, uses)),
		});
	}

	const parsedFunctions = parseTopLevelFunctions(content, masked, docblocks, starts, namespace, classRanges);
	const phpConstants = parseGlobalConstants(
		content,
		masked,
		docblocks,
		starts,
		[...classRanges, ...parsedFunctions.ranges],
	);

	return { namespace, uses, classes, functions: parsedFunctions.functions, constants: phpConstants };
}
