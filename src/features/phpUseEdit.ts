/** Чистые операции вставки `use` для PHP Quick Fix (без зависимости от VS Code). */

export interface UseEdit {
	offset: number;
	text: string;
}

/**
 * Куда вставить `use FQCN;`: после последнего top-level `use`, после
 * `namespace` или сразу после `<?php`. Внутрь класса (trait `use`) не лезем.
 */
export function buildUseEdit(source: string, fqcn: string): UseEdit | undefined {
	const clean = fqcn.replace(/^\\/, '');
	if (clean === '') {
		return undefined;
	}
	const importRe = new RegExp(`^\\s*use\\s+${escapeRegExp(clean)}\\s*(?:as\\s+\\w+\\s*)?;`, 'm');
	if (importRe.test(source)) {
		return undefined;
	}

	const bodyStart = firstTypeDeclaration(source);
	const head = source.slice(0, bodyStart);
	const namespaceRe = /^[ \t]*namespace\s+[^;{]+[;{][^\n]*$/m;
	const namespaceMatch = namespaceRe.exec(head);
	const useRe = /^[ \t]*use\s+(?!function\b|const\b)[^;]+;/gm;
	let lastUse: RegExpExecArray | undefined;
	for (let match = useRe.exec(head); match; match = useRe.exec(head)) {
		lastUse = match;
	}

	const newline = source.includes('\r\n') ? '\r\n' : '\n';
	if (lastUse) {
		const offset = lastUse.index + lastUse[0].length;
		const indent = /^[ \t]*/.exec(lastUse[0])?.[0] ?? '';
		return { offset, text: `${newline}${indent}use ${clean};` };
	}
	if (namespaceMatch) {
		const offset = namespaceMatch.index + namespaceMatch[0].length;
		const indent = /^[ \t]*/.exec(namespaceMatch[0])?.[0] ?? '';
		return { offset, text: `${newline}${indent}use ${clean};` };
	}
	const php = /<\?php[^\n]*\n/.exec(source);
	if (php) {
		const declare = /^[ \t]*declare\s*\([^;]+;[ \t]*$/m.exec(head);
		const offset = declare ? declare.index + declare[0].length : php.index + php[0].length;
		return { offset, text: `use ${clean};${newline}` };
	}
	return { offset: 0, text: `<?php${newline}use ${clean};${newline}` };
}

function firstTypeDeclaration(source: string): number {
	const match = /^[ \t]*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+/m.exec(source);
	return match ? match.index : source.length;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

