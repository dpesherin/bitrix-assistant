/**
 * Генерация PHPDoc-аннотаций для ORM-таблиц (`*Table.php`).
 * Чистые функции: разбор `getMap()` и сборка doc-блока, без обращений к VS Code.
 */

export interface OrmField {
	name: string;
	type: string;
	nullable: boolean;
	primary: boolean;
}

export interface OrmAnnotationResult {
	fields: OrmField[];
	docblock: string;
	/** 0-based строка объявления класса. */
	classLine: number;
	/** 0-based диапазон существующего doc-блока класса, если он есть. */
	existingDoc?: { startLine: number; endLine: number };
}

const TYPE_MAP: Record<string, string> = {
	Integer: 'int',
	Int: 'int',
	Boolean: 'bool',
	Float: 'float',
	Double: 'float',
	Decimal: 'float',
	Date: '\\Bitrix\\Main\\Type\\Date',
	DateTime: '\\Bitrix\\Main\\Type\\DateTime',
	Datetime: '\\Bitrix\\Main\\Type\\DateTime',
	Enum: 'string',
	String: 'string',
	TextField: 'string',
	Text: 'string',
	Char: 'string',
	Json: 'array',
	Array: 'array',
};

function fieldType(className: string): string {
	const short = className.split('\\').pop() ?? className;
	for (const [key, value] of Object.entries(TYPE_MAP)) {
		if (short === `${key}Field`) {
			return value;
		}
	}
	return 'mixed';
}

function lineAt(text: string, offset: number): number {
	return text.slice(0, offset).split('\n').length - 1;
}

function matchingBrace(text: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		if (text[i] === '{') {
			depth++;
		} else if (text[i] === '}') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return text.length;
}

export function parseOrmFields(text: string): OrmField[] {
	const mapMatch = /function\s+getMap\s*\(\s*\)\s*(?::\s*[A-Za-z0-9_\\?|]+)?\s*\{/.exec(text);
	if (!mapMatch) {
		return [];
	}
	const open = mapMatch.index + mapMatch[0].length - 1;
	const body = text.slice(open, matchingBrace(text, open));
	const fields: OrmField[] = [];
	const re = /new\s+([\\A-Za-z0-9_]+)\s*\(\s*(['"])([A-Za-z0-9_]+)\2/g;
	const matches = [...body.matchAll(re)];
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		const start = match.index ?? 0;
		const end = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length;
		const chain = body.slice(start, end);
		if (/(Reference|OneToMany|OneToOne|ManyToMany)Field/.test(match[1])) {
			continue;
		}
		fields.push({
			name: match[3],
			type: fieldType(match[1]),
			nullable: /setRequired\s*\(\s*false\s*\)/.test(chain) || /setNullable\s*\(\s*true\s*\)/.test(chain),
			primary: /(?:configurePrimary|setPrimary|configureAutocomplete|setAutocomplete)\s*\(\s*(?:true\s*)?\)/.test(chain),
		});
	}
	return fields;
}

function findClass(text: string): { line: number; offset: number } | undefined {
	const match = /^[ \t]*(?:(?:final|abstract|readonly)\s+)*class\s+[A-Za-z_][A-Za-z0-9_]*/m.exec(text);
	if (!match) {
		return undefined;
	}
	return { line: lineAt(text, match.index), offset: match.index };
}

/** Ищет doc-блок, стоящий непосредственно перед `class`. */
function findClassDocblock(
	text: string,
	classOffset: number,
): { startLine: number; endLine: number; lines: string[] } | undefined {
	const before = text.slice(0, classOffset);
	const close = before.lastIndexOf('*/');
	if (close === -1) {
		return undefined;
	}
	if (before.slice(close + 2).trim() !== '') {
		return undefined;
	}
	const open = before.lastIndexOf('/**', close);
	if (open === -1) {
		return undefined;
	}
	const startLine = lineAt(text, open);
	const endLine = lineAt(text, close);
	const lines = text.slice(open, close + 2).split('\n');
	return { startLine, endLine, lines };
}

export function buildOrmDocblock(fields: OrmField[], existingLines?: string[]): string {
	const existing = (existingLines ?? [])
		.slice(1, -1)
		.map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
		.filter((line) => line !== '');
	const propertyLines: string[] = [];
	for (const field of fields) {
		const type = field.nullable ? `${field.type}|null` : field.type;
		propertyLines.push(`@property ${type} $${field.name}`);
	}
	const merged = [...existing];
	for (const line of propertyLines) {
		const name = /\$([A-Za-z0-9_]+)/.exec(line)?.[1];
		if (name && merged.some((item) => item.includes(`$${name}`))) {
			continue;
		}
		merged.push(line);
	}
	if (merged.length === 0) {
		return '/** */';
	}
	return ['/**', ...merged.map((line) => ` * ${line}`), ' */'].join('\n');
}

export function generateOrmAnnotation(text: string): OrmAnnotationResult | undefined {
	const cls = findClass(text);
	if (!cls) {
		return undefined;
	}
	const fields = parseOrmFields(text);
	if (fields.length === 0) {
		return undefined;
	}
	const doc = findClassDocblock(text, cls.offset);
	return {
		fields,
		docblock: buildOrmDocblock(fields, doc?.lines),
		classLine: cls.line,
		existingDoc: doc ? { startLine: doc.startLine, endLine: doc.endLine } : undefined,
	};
}
