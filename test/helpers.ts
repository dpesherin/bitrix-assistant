import { parseArrayAt } from '../src/indexer/php/phpArray';

/** Разбор массива из строки без `$var =`. */
export function parsePhpArrayLiteralForTest(src: string) {
	const start = src.search(/array\s*\(|\[/);
	const parsed = parseArrayAt(src, start);
	if (!parsed) {
		throw new Error('array expected');
	}
	return parsed.value;
}
