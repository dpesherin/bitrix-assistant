import * as vscode from 'vscode';
import { BitrixIndexer, ClassCompletionRow } from '../indexer/indexer';
import { errorMessage, log } from '../log';

const TOKEN_RE = /([\\A-Za-z0-9_]+)$/;

/** `CompletionItem.labelDetails` (LSP 3.17): в @types/vscode может отсутствовать. */
interface LabelDetails {
	detail?: string;
	description?: string;
}

function setLabelDetails(item: vscode.CompletionItem, details: LabelDetails): void {
	(item as vscode.CompletionItem & { labelDetails?: LabelDetails }).labelDetails = details;
}



interface ImportInfo {
	namespace: string;
	/** short name → FQCN */
	uses: Map<string, string>;
	insertLine: number | undefined;
}

/**
 * Автодополнение PHP-классов в VS Code (не через LSP): `\CF`, `CFile`,
 * `\Bitrix\Main\Lo…`. При выборе класса из namespace добавляет `use`.
 */
export class PhpClassCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly indexer: BitrixIndexer) {}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.CompletionItem[] | undefined> {
		try {
			return await this.provide(document, position);
		} catch (err) {
			log().warn(`Автодополнение классов: ${errorMessage(err)}`);
			return undefined;
		}
	}

	private async provide(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.CompletionItem[] | undefined> {
		if (document.languageId !== 'php') {
			return undefined;
		}
		const before = document.lineAt(position).text.slice(0, position.character);
		const match = TOKEN_RE.exec(before);
		if (!match) {
			return undefined;
		}
		const token = match[1];
		const leadingSlash = token.startsWith('\\');
		const bare = leadingSlash ? token.slice(1) : token;
		// После `\` хватает одного символа: `\C` уже даёт CFile/CForm/CCrm…
		if (bare.length < (leadingSlash ? 1 : 2)) {
			return undefined;
		}
		const tokenStart = position.character - token.length;
		const previous = tokenStart > 0 ? before[tokenStart - 1] : '';
		// Не предлагать классы в переменных, после `->` и внутри строк.
		if (previous === '$' || previous === '>' || previous === ':' || previous === "'" || previous === '"') {
			return undefined;
		}
		// Диапазон замены не включает ведущий `\`: VS Code фильтрует подсказки
		// по срезу строки от начала диапазона, и элемент `\CFile` не совпадал
		// с набранным `\CF` — все элементы отбрасывались.
		const startChar = leadingSlash ? tokenStart + 1 : tokenStart;

		const qualified = token.includes('\\');
		if (!qualified && !/^[A-Z]/.test(bare)) {
			return undefined;
		}
		// `globalOnly` — только для `\CF` (глобальный легаси-класс). Если после
		// слэша набрано пространство имён (`\Bitrix\Main\Lo`), фильтр по
		// `namespace = ''` отсекал бы всё.
		const globalOnly = leadingSlash && !bare.includes('\\');
		const rows = await this.indexer.completionClasses(bare, globalOnly, 50);
		if (rows.length === 0) {
			return undefined;
		}

		const info = this.readImports(document);
		const range = new vscode.Range(position.line, startChar, position.line, position.character);
		const items: vscode.CompletionItem[] = [];
		// Класс может встретиться дважды (ядро и local/modified_core_files):
		// показываем один элемент на FQCN, иначе список забит одинаковыми именами.
		const seen = new Set<string>();
		for (const row of rows) {
			const key = row.fqcn.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			items.push(this.createItem(row, range, { info, qualified, leadingSlash }));
		}
		return items;
	}

	private createItem(
		row: ClassCompletionRow,
		range: vscode.Range,
		context: { info: ImportInfo; qualified: boolean; leadingSlash: boolean },
	): vscode.CompletionItem {
		const { info, qualified, leadingSlash } = context;
		const namespaced = typeof row.namespace === 'string' && row.namespace !== '';
		const imported = info.uses.get(row.name) === row.fqcn;
		const sameNamespace = (row.namespace ?? '') === info.namespace;
		const item = new vscode.CompletionItem(row.name, vscode.CompletionItemKind.Class);
		item.range = range;
		// Правая колонка — полный FQCN (видно, из какого namespace класс),
		// серая подпись — модуль, чтобы не терять привязку к ядру/проекту.
		item.detail = namespaced ? row.fqcn : 'глобальный класс';
		setLabelDetails(item, { description: row.module ? row.module : '' });
		// Уже импортированный класс — первым; затем классы текущего namespace.
		item.sortText = `${imported ? '0' : sameNamespace ? '1' : '2'}_${row.name.toLowerCase()}_${row.fqcn}`;

		let insertText = row.name;
		let importEdit: vscode.TextEdit | undefined;
		if (qualified) {
			insertText = `\\${row.fqcn}`;
		} else if (!namespaced) {
			// Глобальный легаси-класс: в namespace нужен явный `\CFile`.
			insertText = info.namespace !== '' ? `\\${row.fqcn}` : row.name;
		} else if (row.namespace === info.namespace) {
			insertText = row.name;
		} else {
			const existing = info.uses.get(row.name);
			if (existing === row.fqcn) {
				insertText = row.name;
			} else if (existing !== undefined || info.insertLine === undefined) {
				// Конфликт короткого имени или некуда вставить `use` — пишем FQCN.
				insertText = `\\${row.fqcn}`;
			} else {
				insertText = row.name;
				importEdit = vscode.TextEdit.insert(
					new vscode.Position(info.insertLine, 0),
					`use ${row.fqcn};\n`,
				);
			}
		}
		if (leadingSlash) {
			insertText = insertText.replace(/^\\/, '');
		}
		item.insertText = insertText;
		// VS Code сверяет filterText со срезом строки от начала диапазона, а срез
		// никогда не содержит ведущий `\` (он остаётся в документе). Поэтому и
		// filterText не должен с него начинаться, иначе в файлах с namespace
		// (`\CFile`) элементы отбрасывались.
		item.filterText = insertText.replace(/^\\/, '');
		if (importEdit) {
			item.additionalTextEdits = [importEdit];
		}
		return item;
	}

	private readImports(document: vscode.TextDocument): ImportInfo {
		const text = document.getText();
		const namespace = /^\s*namespace\s+([A-Za-z0-9_\\]+)\s*[;{]/m.exec(text)?.[1] ?? '';
		const uses = new Map<string, string>();
		for (const match of text.matchAll(/^use\s+([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;/gm)) {
			const fqcn = match[1];
			const alias = match[2] ?? fqcn.split('\\').pop() ?? fqcn;
			uses.set(alias, fqcn);
		}

		let insertLine: number | undefined;
		const phpOpen = /<\?php/.exec(text);
		if (phpOpen) {
			insertLine = document.positionAt(phpOpen.index + phpOpen[0].length).line + 1;
		}
		const namespaceMatch = /^\s*namespace\s+[^;{]+[;{]/m.exec(text);
		if (namespaceMatch) {
			insertLine = document.positionAt(namespaceMatch.index + namespaceMatch[0].length).line + 1;
		}
		let lastUse: RegExpExecArray | null = null;
		const useRe = /^use\s+[A-Za-z0-9_\\]+(?:\s+as\s+[A-Za-z0-9_]+)?\s*;/gm;
		for (let match = useRe.exec(text); match; match = useRe.exec(text)) {
			lastUse = match;
		}
		if (lastUse) {
			insertLine = document.positionAt(lastUse.index + lastUse[0].length).line + 1;
		} else if (!namespaceMatch) {
			const declareMatch = /^\s*declare\s*\([^;]+;[ \t]*$/m.exec(text);
			if (declareMatch) {
				insertLine = document.positionAt(declareMatch.index + declareMatch[0].length).line + 1;
			}
		}
		if (insertLine !== undefined) {
			insertLine = Math.min(insertLine, document.lineCount);
		}
		return { namespace, uses, insertLine };
	}
}
