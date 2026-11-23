/**
 * Псевдоклассы ядра: `Loader::registerClassAliases([...])`.
 *
 * В ядре Битрикса старые имена классов (`Bitrix\Main\Entity\DataManager`,
 * `Bitrix\Main\Entity\Field` и т.п.) не объявлены отдельными файлами — это
 * алиасы на актуальные классы. Без них проектный код `class X extends
 * Entity\DataManager` не находит родителя: методы `getList`, `add`, `update`
 * выглядят неизвестными.
 *
 * Разбираем вызовы `registerClassAliases([...])` из `compatibility.php` и
 * отдаём пары alias → target. Индекс превращает их в псевдоклассы с
 * `extends = target`, чтобы работал обычный обход иерархии.
 */

export interface ClassAlias {
	alias: string;
	target: string;
}

const PAIR = /(['"])([A-Za-z0-9_\\]+)\1\s*=>\s*(['"])([A-Za-z0-9_\\]+)\3/g;

/** Пары `'Alias' => 'Target'` из всех вызовов `registerClassAliases([...])`. */
export function parseClassAliases(source: string): ClassAlias[] {
	const aliases = new Map<string, string>();
	const callRe = /registerClassAliases\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
	for (const call of source.matchAll(callRe)) {
		for (const pair of call[1].matchAll(PAIR)) {
			const alias = pair[2].replace(/^\\/, '');
			const target = pair[4].replace(/^\\/, '');
			if (alias !== '' && target !== '' && alias !== target) {
				aliases.set(alias, target);
			}
		}
	}
	return [...aliases].map(([alias, target]) => ({ alias, target }));
}
