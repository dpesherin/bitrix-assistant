import * as vscode from 'vscode';
import { BitrixIndexer } from '../indexer/indexer';
import { buildUseEdit } from './phpUseEdit';

function currentNamespace(source: string): string {
	const match = /^[ \t]*namespace\s+([A-Za-z0-9_\\]+)\s*[;{]/m.exec(source);
	return match ? match[1] : '';
}

function isImportContext(source: string, offset: number): boolean {
	const before = source.slice(Math.max(0, offset - 60), offset);
	if (/\buse\s+[^;]*$/i.test(before)) {
		return false;
	}
	if (/[\\$>:]\s*$/.test(before)) {
		return false;
	}
	return true;
}

/** Quick Fix: импорт класса по короткому имени из локального индекса. */
export class PhpAutoImportProvider implements vscode.CodeActionProvider {
	constructor(private readonly indexer: BitrixIndexer) {}

	async provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context?: vscode.CodeActionContext,
	): Promise<vscode.CodeAction[]> {
		const source = document.getText();
		const diagnostic = context?.diagnostics.find(
			(item) => item.code === 'bitrix.php.unresolved-class',
		);
		const wordRange = diagnostic
			? diagnostic.range
			: document.getWordRangeAtPosition(range.start, /\\?[A-Za-z_][A-Za-z0-9_\\]*/);
		if (!wordRange) {
			return [];
		}
		const word = document.getText(wordRange);
		if (word.startsWith('\\') || !isImportContext(source, document.offsetAt(wordRange.start))) {
			return [];
		}
		const short = word.split('\\').pop() ?? word;
		if (short === '' || !/^[A-Z]/.test(short)) {
			return [];
		}
		const rows = await this.indexer.classesByShortName(short, 10);
		if (rows.length === 0) {
			return [];
		}
		const namespace = currentNamespace(source);
		const actions: vscode.CodeAction[] = [];
		for (const row of rows) {
			if ((row.namespace ?? '') === namespace) {
				continue;
			}
			const edit = buildUseEdit(source, row.fqcn);
			if (!edit) {
				continue;
			}
			const action = new vscode.CodeAction(
				`Импортировать ${row.fqcn}`,
				vscode.CodeActionKind.QuickFix,
			);
			if (diagnostic) {
				action.diagnostics = [diagnostic];
			}
			action.edit = new vscode.WorkspaceEdit();
			action.edit.insert(document.uri, document.positionAt(edit.offset), edit.text);
			actions.push(action);
		}
		return actions;
	}
}
