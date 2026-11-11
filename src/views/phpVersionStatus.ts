import * as vscode from 'vscode';
import { PhpSyntaxChecker } from '../features/phpSyntax';
import { ProjectPhpStore } from '../php/projectPhp';

/** Выбор версии PHP для syntax-check в статус-баре. */
export class PhpVersionStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly subscription: vscode.Disposable;

	constructor(
		private readonly syntax: PhpSyntaxChecker,
		private readonly projects: ProjectPhpStore,
	) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
		this.item.name = 'Bitrix Assistant: версия PHP';
		this.item.command = 'bitrix.php.selectVersion';
		this.subscription = vscode.Disposable.from(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('bitrix.php')) {
					this.update();
				}
			}),
			this.projects.onDidChange(() => this.update()),
			vscode.window.onDidChangeActiveTextEditor(() => this.update()),
		);
		this.update();
		this.item.show();
	}

	private uri(): vscode.Uri | undefined {
		return vscode.window.activeTextEditor?.document.uri;
	}

	update(): void {
		const version = this.projects.version(this.uri());
		this.item.text = `$(code) PHP ${version}`;
		const project = this.projects.projectName(this.uri());
		const tooltip = new vscode.MarkdownString(
			`**PHP для проверки синтаксиса: ${version}**\n\n` +
				`Проект: **${project}**. Версия хранится в состоянии расширения для проекта.\n\n` +
				'`auto` — `php` из PATH, иначе встроенный PHP 8.4. Другие версии нужно ' +
				'поставить на компьютер и указать путь.\n\n' +
				'[Выбрать версию](command:bitrix.php.selectVersion) · ' +
				'[Указать путь к PHP](command:bitrix.php.setPath) · ' +
				'[Скачать сборку](command:bitrix.php.downloadRuntime)\n\n' +
				'Хранилище: состояние расширения (workspaceState), не файлы проекта.',
		);
		tooltip.isTrusted = true;
		this.item.tooltip = tooltip;
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
