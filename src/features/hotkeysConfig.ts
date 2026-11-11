import { applyEdits, modify, parse } from 'jsonc-parser';

/** Чистое обновление keybindings.json с сохранением комментариев/формата. */
export function updateKeybindings(text: string, entries: Array<{ key: string; command: string; when?: string }>): string {
	let current = text.trim() === '' ? '[]' : text;
	for (const entry of entries) {
		const parsed = parse(current);
		if (!Array.isArray(parsed)) {
			throw new Error('keybindings.json должен содержать массив');
		}
		const index = parsed.findIndex(
			(item) => item && typeof item === 'object' && (item as { command?: string }).command === entry.command,
		);
		const formattingOptions = { insertSpaces: true, tabSize: 2 };
		if (index >= 0) {
			current = applyEdits(current, modify(current, [index, 'key'], entry.key, { formattingOptions }));
		} else {
			current = applyEdits(current, modify(current, [parsed.length], entry, { formattingOptions }));
		}
	}
	return current;
}

