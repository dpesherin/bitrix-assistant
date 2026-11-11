/**
 * Извлечение глобальных объектов и экспортов из JS-файлов Битрикса.
 *
 * Правила детерминированные: присваивания `BX.X = ...`, `BX.namespace('BX.X')`,
 * `window.X = ...`, ключи объектных литералов, `prototype`-методы и ES-экспорты.
 * Минифицированные файлы (`.min.js`) не сканируются вызывающей стороной.
 */

export type JsGlobalType = 'namespace' | 'object' | 'function' | 'method' | 'property' | 'export' | 'class';

export interface JsParam {
	/** Имя параметра; вложенные свойства конфига приходят как `config.method`. */
	name: string;
	type?: string;
	optional: boolean;
	defaultValue?: string;
	description?: string;
	/** Ключи объекта-параметра, найденные по `options.key` в теле функции. */
	keys?: string[];
}

export interface JsGlobal {
	name: string;
	type: JsGlobalType;
	line: number;
	/** Сигнатура вида `runAction(action: string, config: Object)`. */
	signature?: string;
	params?: JsParam[];
	returnType?: string;
	/** Описание из JSDoc без тегов. */
	doc?: string;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

/** Заменяет комментарии пробелами, сохраняя длину и переводы строк. */
export function stripJsComments(src: string): string {
	const out = src.split('');
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n') {
				out[i] = ' ';
				i++;
			}
			continue;
		}
		if (ch === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			const stop = close === -1 ? src.length : close + 2;
			for (; i < stop; i++) {
				if (src[i] !== '\n') {
					out[i] = ' ';
				}
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			i++;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === '\\') {
					i++;
				}
				i++;
			}
			i++;
			continue;
		}
		i++;
	}
	return out.join('');
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

/** Ключи верхнего уровня объектного литерала, начинающегося с `{` в `braceIndex`. */
export function objectLiteralKeys(
	src: string,
	braceIndex: number,
): { name: string; type: 'method' | 'property'; start: number; valueStart: number }[] {
	const keys: { name: string; type: 'method' | 'property'; start: number; valueStart: number }[] = [];
	let depth = 0;
	let i = braceIndex;
	let expectKey = true;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			i++;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === '\\') {
					i++;
				}
				i++;
			}
			i++;
			continue;
		}
		if (ch === '{' || ch === '(' || ch === '[') {
			depth++;
			i++;
			continue;
		}
		if (ch === '}' || ch === ')' || ch === ']') {
			depth--;
			if (depth <= 0) {
				break;
			}
			i++;
			continue;
		}
		if (depth === 1 && expectKey) {
			const rest = src.slice(i);
			const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(rest);
			if (m) {
				const key = m[1];
				const afterColon = i + m[0].length;
				const ahead = src.slice(afterColon, afterColon + 80);
				const isMethod = /^\s*(?:async\s+)?(?:function\b|\()/.test(ahead) || /=>/.test(ahead.slice(0, 40));
				keys.push({
					name: key,
					type: isMethod ? 'method' : 'property',
					start: i + (m[0].length - m[0].trimStart().length),
					valueStart: afterColon,
				});
				i = afterColon;
				expectKey = false;
				continue;
			}
			expectKey = false;
		}
		if (depth === 1 && ch === ',') {
			expectKey = true;
			i++;
			continue;
		}
		i++;
	}
	return keys;
}

function rhsType(src: string, afterEquals: number): JsGlobalType {
	const rest = src.slice(afterEquals, afterEquals + 120).replace(/^\s+/, '');
	if (rest.startsWith('{')) {
		return 'object';
	}
	if (/^(?:async\s+)?function\b/.test(rest) || /^\([^)]*\)\s*=>/.test(rest) || /^[A-Za-z_$][\w$]*\s*=>/.test(rest)) {
		return 'function';
	}
	if (rest.startsWith('class ')) {
		return 'class';
	}
	return 'property';
}

function splitTopLevelParams(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let last = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
		} else if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
		} else if (ch === ',' && depth === 0) {
			parts.push(text.slice(last, i));
			last = i + 1;
		}
	}
	const tail = text.slice(last);
	if (tail.trim() !== '') {
		parts.push(tail);
	}
	return parts;
}

export interface JsParamShape {
	name: string;
	type?: string;
	optional: boolean;
}

function parseParamPart(part: string): JsParamShape | undefined {
	const match = /^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*(?::\s*([^=]+?))?\s*(?:=.*)?$/.exec(part);
	if (!match) {
		return undefined;
	}
	const type = match[3]?.trim();
	return { name: match[1], type: type && type !== '' ? type : undefined, optional: Boolean(match[2]) };
}

function jsParamDetails(raw: string): JsParamShape[] {
	return splitTopLevelParams(raw)
		.map(parseParamPart)
		.filter((param): param is JsParamShape => Boolean(param));
}

function parseFunctionParams(rhs: string): JsParamShape[] | undefined {
	const rest = rhs.replace(/^\s+/, '');
	const match =
		/^(?:async\s+)?function\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/.exec(rest) ??
		/^(?:async\s+)?\(([^)]*)\)\s*=>/.exec(rest);
	if (match) {
		return jsParamDetails(match[1]);
	}
	const single = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(rest);
	return single ? [{ name: single[1], optional: false }] : undefined;
}

interface ParsedJsDoc {
	description: string;
	params: Map<string, { type?: string; optional: boolean; defaultValue?: string; description?: string }>;
	returnType?: string;
}

/** Ищет JSDoc-блок непосредственно перед присваиванием. */
function findJsDocBefore(content: string, offset: number): string | undefined {
	const close = content.lastIndexOf('*/', offset);
	if (close === -1) {
		return undefined;
	}
	if (content.slice(close + 2, offset).trim() !== '') {
		return undefined;
	}
	const open = content.lastIndexOf('/**', close);
	if (open === -1) {
		return undefined;
	}
	return content.slice(open + 3, close);
}

function parseJsDoc(raw: string): ParsedJsDoc {
	const descriptionLines: string[] = [];
	const params = new Map<string, { type?: string; optional: boolean; defaultValue?: string; description?: string }>();
	let returnType: string | undefined;
	let inTags = false;
	for (const rawLine of raw.split('\n')) {
		const line = rawLine.replace(/^\s*\*\s?/, '').trimEnd();
		if (/^@/.test(line.trim())) {
			inTags = true;
		}
		const param = /^@param\s+\{([^}]+)\}\s+(\[[^\]]*\]|[A-Za-z0-9_.$]+)(?:\s*[-–]\s*(.*))?$/.exec(line.trim());
		if (param) {
			let name = param[2];
			let optional = false;
			let defaultValue: string | undefined;
			if (name.startsWith('[') && name.endsWith(']')) {
				optional = true;
				name = name.slice(1, -1).trim();
				const equals = name.indexOf('=');
				if (equals !== -1) {
					defaultValue = name.slice(equals + 1).trim().replace(/^['"]|['"]$/g, '');
					name = name.slice(0, equals).trim();
				}
			}
			params.set(name, {
				type: param[1].trim(),
				optional,
				defaultValue,
				description: param[3]?.trim() || undefined,
			});
			continue;
		}
		const returns = /^@returns?\s+\{([^}]+)\}/.exec(line.trim());
		if (returns) {
			returnType = returns[1].trim();
			continue;
		}
		if (!inTags && line.trim() !== '') {
			descriptionLines.push(line.trim());
		}
	}
	return { description: descriptionLines.join('\n').trim(), params, returnType };
}

function describeJsAssignment(
	content: string,
	stripped: string,
	assignmentStart: number,
	afterEquals: number,
	name: string,
): Pick<JsGlobal, 'signature' | 'params' | 'doc' | 'returnType'> {
	const rhs = stripped.slice(afterEquals, afterEquals + 4000).replace(/^\s+/, '');
	const docRaw = findJsDocBefore(content, assignmentStart);
	const parsed = docRaw ? parseJsDoc(docRaw) : undefined;
	const topParams = parseFunctionParams(rhs);
	const params: JsParam[] = [];
	if (topParams) {
		for (const param of topParams) {
			const info = parsed?.params.get(param.name);
			params.push({
				name: param.name,
				type: info?.type ?? param.type,
				optional: info?.optional ?? param.optional,
				defaultValue: info?.defaultValue,
				description: info?.description,
			});
		}
	}
	if (parsed) {
		for (const [paramName, info] of parsed.params) {
			if (params.some((param) => param.name === paramName)) {
				continue;
			}
			params.push({
				name: paramName,
				type: info.type,
				optional: info.optional,
				defaultValue: info.defaultValue,
				description: info.description,
			});
		}
	}
	const baseName = name.split('.').pop() ?? name;
	let signature: string | undefined;
	if (topParams) {
		const rendered = topParams.map((param) => {
			const info = parsed?.params.get(param.name);
			const type = info?.type ?? param.type;
			const optional = info?.optional ?? param.optional;
			return `${param.name}${optional ? '?' : ''}${type ? `: ${type}` : ''}`;
		});
		signature = `${baseName}(${rendered.join(', ')})`;
	}
	return {
		signature,
		params: params.slice(0, 80),
		doc: parsed?.description || undefined,
		returnType: parsed?.returnType,
	};
}

function matchingBrace(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') {
			depth++;
		} else if (src[i] === '}') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return src.length;
}

function braceDepthAt(src: string, bodyOpen: number, offset: number): number {
	let depth = 0;
	const end = Math.min(offset, src.length);
	for (let i = bodyOpen; i < end; i++) {
		const ch = src[i];
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
		}
	}
	return depth;
}


/** ES-классы (включая `declare class` из .d.ts) и их методы. */
function scanJsClasses(
	content: string,
	src: string,
	found: JsGlobal[],
	push: (name: string, type: JsGlobalType, offset: number, details?: Pick<JsGlobal, 'signature' | 'params' | 'doc' | 'returnType'>) => void,
	starts: number[],
	namespace = '',
): void {
	const classRe =
		/(?:^|[;{}\n])\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([^{]*)\{/g;
	for (let m = classRe.exec(src); m; m = classRe.exec(src)) {
		const name = m[1];
		const bodyOpen = m.index + m[0].length - 1;
		const bodyClose = matchingBrace(src, bodyOpen);
		if (bodyClose <= bodyOpen) {
			continue;
		}
		const isExported = /\bexport\b/.test(m[0]);
		const classKeyword = m.index + m[0].indexOf('class');
		const classOffset = classKeyword + 'class'.length;
		// JSDoc ищем от начала объявления: между `*/` и `class` может стоять
		// `export`/`abstract`, а findJsDocBefore требует только пробелы.
		const lineStart = content.lastIndexOf('\n', classKeyword) + 1;
		const indentMatch = /^\s*/.exec(content.slice(lineStart, classKeyword));
		const declarationStart = lineStart + (indentMatch ? indentMatch[0].length : 0);
		const docBefore = findJsDocBefore(content, declarationStart);
		const memberOf = docBefore
			? /@memberof\s+\{?\s*(BX(?:\.[A-Za-z0-9_$]+)+)/i.exec(docBefore)?.[1]
			: undefined;
		const localNamespace = memberOf
			?? (docBefore ? /@namespace\s*\{?\s*(BX(?:\.[A-Za-z0-9_$]+)+)/i.exec(docBefore)?.[1] : undefined)
			?? namespace;
		const qualified =
			localNamespace !== '' && (isExported || memberOf !== undefined)
				? `${localNamespace}.${name}`
				: name;
		let classDetails: Pick<JsGlobal, 'signature' | 'params' | 'doc'> = {};
		const ctorRe = /\bconstructor\s*\(/g;
		ctorRe.lastIndex = bodyOpen;
		for (let ctor = ctorRe.exec(src); ctor && ctor.index < bodyClose; ctor = ctorRe.exec(src)) {
			if (braceDepthAt(src, bodyOpen, ctor.index + 1) !== 1) {
				continue;
			}
			const ctorOpen = ctor.index + ctor[0].length - 1;
			let ctorDepth = 0;
			let ctorClose = -1;
			for (let i = ctorOpen; i < bodyClose; i++) {
				if (src[i] === '(') {
					ctorDepth++;
				} else if (src[i] === ')') {
					ctorDepth--;
					if (ctorDepth === 0) {
						ctorClose = i;
						break;
					}
				}
			}
			if (ctorClose <= ctorOpen) {
				continue;
			}
			const parsed = jsParamDetails(src.slice(ctorOpen + 1, ctorClose));
			const ctorDocRaw = findJsDocBefore(content, ctor.index);
			const ctorDoc = ctorDocRaw ? parseJsDoc(ctorDocRaw) : undefined;
			const params: JsParam[] = parsed.map((param) => {
				const info = ctorDoc?.params.get(param.name);
				return {
					name: param.name,
					type: info?.type ?? param.type,
					optional: info?.optional ?? param.optional,
					defaultValue: info?.defaultValue,
					description: info?.description,
				};
			});
			const rendered = parsed.map((param) => {
				const info = ctorDoc?.params.get(param.name);
				const type = info?.type ?? param.type;
				const optional = info?.optional ?? param.optional;
				return `${param.name}${optional ? '?' : ''}${type ? `: ${type}` : ''}`;
			});
			classDetails = {
				signature: `${name}(${rendered.join(', ')})`,
				params: params.slice(0, 80),
				doc: ctorDoc?.description || undefined,
			};
			break;
		}
		push(name, 'class', classOffset, classDetails);
		if (qualified !== name) {
			push(qualified, 'class', classOffset, classDetails);
		}
		const methodRe =
			/(?:^|[;{}])\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
		methodRe.lastIndex = bodyOpen;
		for (let method = methodRe.exec(src); method && method.index < bodyClose; method = methodRe.exec(src)) {
			const methodName = method[1];
			if (/^(?:if|for|while|switch|catch|function|return|new|typeof|await|delete|void|throw|else|do|try)$/.test(methodName)) {
				continue;
			}
			if (braceDepthAt(src, bodyOpen, method.index + 1) !== 1) {
				continue;
			}
			const nameOffset = method.index + method[0].indexOf(methodName);
			const openParen = method.index + method[0].length - 1;
			let depth = 0;
			let closeParen = -1;
			for (let i = openParen; i < bodyClose; i++) {
				if (src[i] === '(') {
					depth++;
				} else if (src[i] === ')') {
					depth--;
					if (depth === 0) {
						closeParen = i;
						break;
					}
				}
			}
			if (closeParen === -1) {
				continue;
			}
			let rest = src.slice(closeParen + 1, closeParen + 400);
			const returnMatch = /^\s*:\s*([^;{\n]+)/.exec(rest);
			rest = rest.replace(/^\s*:\s*[^;{\n]+/, '').trimStart();
			if (!rest.startsWith('{') && !rest.startsWith(';')) {
				continue;
			}
			const paramsRaw = src.slice(openParen + 1, closeParen);
			const parsedParams = jsParamDetails(paramsRaw);
			const docRaw = findJsDocBefore(content, nameOffset);
			const doc = docRaw ? parseJsDoc(docRaw) : undefined;
			const params: JsParam[] = parsedParams.map((param) => {
				const info = doc?.params.get(param.name);
				return {
					name: param.name,
					type: info?.type ?? param.type,
					optional: info?.optional ?? param.optional,
					defaultValue: info?.defaultValue,
					description: info?.description,
				};
			});
			const rendered = parsedParams.map((param) => {
				const info = doc?.params.get(param.name);
				const type = info?.type ?? param.type;
				const optional = info?.optional ?? param.optional;
				return `${param.name}${optional ? '?' : ''}${type ? `: ${type}` : ''}`;
			});
				const methodDetails = {
					signature: `${methodName}(${rendered.join(', ')})`,
					params: params.slice(0, 80),
					doc: doc?.description || undefined,
					returnType: returnMatch?.[1]?.trim() ?? doc?.returnType,
				};
				push(`${name}.${methodName}`, 'method', nameOffset, methodDetails);
				if (qualified !== name) {
					push(`${qualified}.${methodName}`, 'method', nameOffset, methodDetails);
				}
		}
		const fieldRe = /(?:^|[;{}])\s*(?:static\s+)?(?:#)?([A-Za-z_$][\w$]*)\s*(?==|;)/g;
		fieldRe.lastIndex = bodyOpen;
		for (let field = fieldRe.exec(src); field && field.index < bodyClose; field = fieldRe.exec(src)) {
			const fieldName = field[1];
			if (/^(?:if|for|while|switch|catch|function|return|new|typeof|await|delete|void|throw|else|do|try|class)$/.test(fieldName)) {
				continue;
			}
			if (braceDepthAt(src, bodyOpen, field.index + 1) !== 1) {
				continue;
			}
			push(`${name}.${fieldName}`, 'property', field.index + field[0].indexOf(fieldName));
			if (qualified !== name) {
				push(`${qualified}.${fieldName}`, 'property', field.index + field[0].indexOf(fieldName));
			}
		}
		classRe.lastIndex = bodyClose + 1;
	}
}

function normalizeName(name: string): string {
	return name.replace(/\.prototype\./g, '.').replace(/\.prototype$/, '');
}

/**
 * Возвращает список глобальных имён файла. `offset` — байтовое смещение
 * (для JS-файлов это же смещение в символах, если файл в UTF-8 без BOM).
 */
export interface JsTypeShape {
	name: string;
	keys: string[];
	extends: string[];
	line: number;
}

function depthAtText(text: string, index: number): number {
	let depth = 0;
	for (let i = 0; i < index && i < text.length; i++) {
		const ch = text[i];
		if (ch === '{' || ch === '(' || ch === '[') {
			depth++;
		} else if (ch === '}' || ch === ')' || ch === ']') {
			depth--;
		}
	}
	return depth;
}

function splitTopLevelBy(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let last = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '{' || ch === '(' || ch === '[') {
			depth++;
		} else if (ch === '}' || ch === ')' || ch === ']') {
			depth--;
		} else if (ch === separator && depth === 0) {
			parts.push(text.slice(last, i));
			last = i + 1;
		}
	}
	parts.push(text.slice(last));
	return parts;
}

function topLevelKeys(body: string): string[] {
	const keys: string[] = [];
	const re = /([A-Za-z_$][\w$]*)\s*(\?)?\s*:/g;
	for (let match = re.exec(body); match; match = re.exec(body)) {
		if (depthAtText(body, match.index) !== 0) {
			continue;
		}
		keys.push(match[1]);
	}
	return [...new Set(keys)];
}

function statementEnd(src: string, from: number): number {
	let depth = 0;
	for (let i = from; i < src.length; i++) {
		const ch = src[i];
		if (ch === '{' || ch === '(' || ch === '[') {
			depth++;
		} else if (ch === '}' || ch === ')' || ch === ']') {
			depth--;
		} else if (ch === ';' && depth === 0) {
			return i;
		} else if (ch === '\n' && depth === 0) {
			return i;
		}
	}
	return src.length;
}

/**
 * Разбирает TS-формы `type X = { … }` и `interface X extends Y { … }`
 * из JS/TS-файлов. Нужны для подсказок ключей объекта (`ButtonOptions`).
 */
export function scanJsTypeShapes(content: string, maxBytes = DEFAULT_MAX_BYTES): JsTypeShape[] {
	if (content.length > maxBytes) {
		return [];
	}
	const src = stripJsComments(content);
	const starts = lineStartsOf(src);
	const shapes: JsTypeShape[] = [];
	const typeRe = /\b(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g;
	for (let match = typeRe.exec(src); match; match = typeRe.exec(src)) {
		const valueStart = match.index + match[0].length;
		const rhs = src.slice(valueStart, statementEnd(src, valueStart));
		const keys = new Set<string>();
		const parents: string[] = [];
		for (const part of splitTopLevelBy(rhs, '&')) {
			const trimmed = part.trim();
			if (trimmed.startsWith('{')) {
				const close = matchingBrace(trimmed, 0);
				if (close > 0) {
					for (const key of topLevelKeys(trimmed.slice(1, close))) {
						keys.add(key);
					}
				}
				continue;
			}
			if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
				parents.push(trimmed);
			}
		}
		if (keys.size > 0) {
			shapes.push({ name: match[1], keys: [...keys], extends: parents, line: lineAt(starts, match.index) });
		}
	}
	// JSDoc-комментарии удалены из `src`, поэтому typedef ищем в исходнике.
	const docRe = /\/\*\*([\s\S]*?)\*\//g;
	for (let match = docRe.exec(content); match; match = docRe.exec(content)) {
		const body = match[1];
		const definition = /@typedef\s+\{([^}]+)\}\s+([A-Za-z_$][\w$]*)/.exec(body);
		if (!definition) {
			continue;
		}
		const keys: string[] = [];
		const propertyRe = /@property\s+(?:\([^)]*\)\s*)?(?:\{[^}]*\}\s*)?\[?([A-Za-z_$][\w$]*)/g;
		for (let property = propertyRe.exec(body); property; property = propertyRe.exec(body)) {
			keys.push(property[1]);
		}
		if (keys.length === 0) {
			continue;
		}
		const parents = definition[1]
			.split('&')
			.map((name) => name.trim())
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
		shapes.push({ name: definition[2], keys: [...new Set(keys)], extends: parents, line: lineAt(starts, match.index) });
	}
	const interfaceRe = /\b(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([^{]+))?\s*\{/g;
	for (let match = interfaceRe.exec(src); match; match = interfaceRe.exec(src)) {
		const open = match.index + match[0].length - 1;
		const close = matchingBrace(src, open);
		if (close <= open) {
			continue;
		}
		const keys = topLevelKeys(src.slice(open + 1, close));
		const parents = (match[2] ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
		if (keys.length > 0) {
			shapes.push({ name: match[1], keys, extends: parents, line: lineAt(starts, match.index) });
		}
	}
	return shapes;
}

export function scanJsGlobals(content: string, maxBytes = DEFAULT_MAX_BYTES): JsGlobal[] {
	if (content.length > maxBytes) {
		return [];
	}
	const src = stripJsComments(content);
	const starts = lineStartsOf(src);
	const found: JsGlobal[] = [];
	const push = (
		name: string,
		type: JsGlobalType,
		offset: number,
		details: Pick<JsGlobal, 'signature' | 'params' | 'doc' | 'returnType'> = {},
	): void => {
		const clean = normalizeName(name);
		if (!clean) {
			return;
		}
		const existing = found.find((item) => item.name === clean && item.type === type);
		if (existing) {
			existing.signature ??= details.signature;
			existing.params ??= details.params;
			existing.doc ??= details.doc;
			existing.returnType ??= details.returnType;
			return;
		}
		found.push({ name: clean, type, line: lineAt(starts, offset), ...details });
	};

	const namespaceRe = /\bBX\.namespace\s*\(\s*(['"])([A-Za-z0-9_.$]+)\1/g;
	for (let m = namespaceRe.exec(src); m; m = namespaceRe.exec(src)) {
		push(m[2], 'namespace', m.index);
	}

	const assignRe = /(?:^|[;{}\n])\s*(?:var\s+|let\s+|const\s+)?(?:window\.)?BX((?:\.[A-Za-z_$][\w$]*)+)\s*=(?!=)/g;
	for (let m = assignRe.exec(src); m; m = assignRe.exec(src)) {
		const name = `BX${m[1]}`;
		const type: JsGlobalType = m[1].includes('.prototype.') ? 'method' : rhsType(src, assignRe.lastIndex);
		// `m.index` может указывать на пробелы/переводы строк в начале совпадения,
		// поэтому JSDoc и строку считаем от самого имени `BX...`.
		const targetIndex = m.index + m[0].indexOf('BX');
		const details = describeJsAssignment(content, src, targetIndex, assignRe.lastIndex, normalizeName(name));
		push(name, type, targetIndex, details);
		if (type === 'object') {
			const brace = src.indexOf('{', assignRe.lastIndex);
			if (brace !== -1) {
				for (const key of objectLiteralKeys(src, brace)) {
					const full = `${normalizeName(name)}.${key.name}`;
					const details = key.type === 'method'
						? describeJsAssignment(content, src, key.start, key.valueStart, full)
						: {};
					push(full, key.type, key.start, details);
				}
			}
		}
	}

	const windowRe = /(?:^|[;{}\n])\s*window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g;
	for (let m = windowRe.exec(src); m; m = windowRe.exec(src)) {
		push(`window.${m[1]}`, rhsType(src, windowRe.lastIndex), m.index);
	}

	const exportDeclRe =
		/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
	for (let m = exportDeclRe.exec(src); m; m = exportDeclRe.exec(src)) {
		push(m[1], 'export', m.index);
	}

	// Bitrix-бандлы часто объявляют неймспейсы не присваиванием, а строкой
	// в конфигурации событий или JSDoc-тегом `@namespace {BX.Main.Popup}`.
	const namespacePropRe = /\bnamespace\s*:\s*(['"])(BX(?:\.[A-Za-z0-9_$]+)+)\1/g;
	for (let m = namespacePropRe.exec(src); m; m = namespacePropRe.exec(src)) {
		push(m[2], 'namespace', m.index);
	}
	const jsdocNamespaceRe = /@(?:namespace|memberOf)\s*\{?\s*(BX(?:\.[A-Za-z0-9_$]+)+)/g;
	for (let m = jsdocNamespaceRe.exec(content); m; m = jsdocNamespaceRe.exec(content)) {
		push(m[1], 'namespace', m.index);
	}
	// `@memberOf BX.Main.Popup` + следующая декларация → конструктор/класс
	// внутри namespace (например, `BX.Main.Popup.Button`).
	const memberOfRe = /@memberof\s+(BX(?:\.[A-Za-z0-9_$]+)+)/gi;
	for (let m = memberOfRe.exec(content); m; m = memberOfRe.exec(content)) {
		const tail = content.slice(m.index + m[0].length, m.index + m[0].length + 500);
		const declaration = /\b(class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(tail);
		if (declaration) {
			push(
				`${m[1]}.${declaration[2]}`,
				declaration[1] === 'class' ? 'class' : 'function',
				m.index + m[0].length,
			);
		}
	}

	const jsdocNamespace = /@namespace\s*\{?\s*(BX(?:\.[A-Za-z0-9_$]+)+)/i.exec(content);
	scanJsClasses(content, src, found, push, starts, jsdocNamespace?.[1] ?? '');

	const exportListRe = /\bexport\s*\{([^}]*)\}/g;
	for (let m = exportListRe.exec(src); m; m = exportListRe.exec(src)) {
		const items = m[1].split(',');
		for (const item of items) {
			const parts = item.trim().split(/\s+as\s+/);
			const name = (parts[1] ?? parts[0] ?? '').trim();
			if (name) {
				push(name, 'export', m.index);
			}
		}
	}

	found.sort((a, b) => a.line - b.line);
	for (const global of found) {
		attachOptionKeys(src, starts, global);
	}
	return found;
}

/**
 * Извлекает ключи объекта-параметра из обращений `options.key` в теле
 * объявления. Даёт подсказки вида `BX.UI.Button({ … })` без парсера типов.
 */
function attachOptionKeys(src: string, starts: number[], global: JsGlobal): void {
	const params = global.params;
	if (!params || params.length === 0) {
		return;
	}
	const offset = starts[Math.max(0, global.line - 1)] ?? 0;
	const window = src.slice(offset, offset + 20_000);
	const declaration = /(?:\bfunction\s*(?:[A-Za-z_$][\w$]*)?|\bconstructor|^\s*[A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(window);
	if (!declaration) {
		return;
	}
	const names = jsParamDetails(declaration[1]).map((param) => param.name);
	const candidates = names.filter((name) =>
		params.some((param) => param.name === name && (param.type === undefined || param.type === 'object' || param.type === '?object')),
	);
	if (candidates.length === 0) {
		return;
	}
	const open = window.indexOf('{', declaration.index + declaration[0].length);
	if (open === -1) {
		return;
	}
	const close = matchingBrace(window, open);
	if (close <= open) {
		return;
	}
	const body = window.slice(open, close);
	const keys = new Set<string>();
	for (const name of candidates) {
		const re = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g');
		for (let match = re.exec(body); match; match = re.exec(body)) {
			keys.add(match[1]);
			if (keys.size >= 80) {
				break;
			}
		}
	}
	if (keys.size === 0) {
		return;
	}
	for (const param of params) {
		if (candidates.includes(param.name)) {
			param.keys = [...keys].slice(0, 80);
		}
	}
}
