import * as vscode from 'vscode';
import { PhpSyntaxChecker } from '../features/phpSyntax';

/** Выбор версии PHP для syntax-check в статус-баре. */
export class PhpVersionStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly subscription: vscode.Disposable;

	constructor(private readonly syntax: PhpSyntaxChecker) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
		this.item.name = 'Bitrix Assistant: версия PHP';
		this.item.command = 'bitrix.php.selectVersion';
		this.subscription = vscode.Disposable.from(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('bitrix.php.version')) {
					this.update();
				}
			}),
			vscode.window.onDidChangeActiveTextEditor(() => this.update()),
		);
		this.update();
		this.item.show();
	}

	private uri(): vscode.Uri | undefined {
		return vscode.window.activeTextEditor?.document.uri;
	}

	update(): void {
		const version = vscode.workspace
			.getConfiguration('bitrix.php', this.uri())
			.get<string>('version', 'auto');
		this.item.text = `$(code) PHP ${version}`;
		this.item.tooltip = new vscode.MarkdownString(
			`**PHP для проверки синтаксиса: ${version}**\n\n` +
				'Клик — выбрать версию. `auto` — системный `php`, иначе встроенный.\n\n' +
				'Настройка: `bitrix.php.version`',
		);
		const current = version;
		void this.syntax.effectiveVersion(this.uri()).then((effective) => {
			if (effective && current === 'auto' && effective !== current) {
				this.item.text = `$(code) PHP ${effective}`;
			}
		});
	}

	dispose(): void {
		this.subscription.dispose();
		this.item.dispose();
	}
}
