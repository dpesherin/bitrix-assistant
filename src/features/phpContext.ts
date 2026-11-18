/**
 * Где мы находимся в PHP-шаблоне: в коде (`<?php … ?>`, `<?= … ?>`) или в HTML.
 *
 * Нужно, чтобы в разметке не всплывали подсказки PHP: классы Битрикса на
 * `class="Test"`, функции и константы на обычные слова внутри тегов.
 */
export function isInsidePhpTag(text: string, offset: number): boolean {
	const limit = Math.max(0, Math.min(offset, text.length));
	const before = text.slice(0, limit);
	const open = before.lastIndexOf('<?');
	const close = before.lastIndexOf('?>');
	return open !== -1 && (close === -1 || open > close);
}

/**
 * Документ начинается с открывающего тега PHP — в том числе недописанного:
 * `<?`, `<?=`, `<ph`, `<php`. Нужно для untitled: раньше язык переключался
 * только после полного `<?php`, и подсказки на `<?` не появлялись.
 */
export function startsWithPhpTag(text: string): boolean {
	return /^<(?:\?(?:php(?![A-Za-z])|=|(?![A-Za-z]))|php?(?![A-Za-z]))/i.test(text.trimStart());
}
