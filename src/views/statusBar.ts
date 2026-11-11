import * as vscode from 'vscode';
import { SshConnectionManager } from '../ssh/connection';

/** Статус SSH-подключения в статус-баре + быстрый доступ к меню расширения. */
export class BitrixStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly subscription: vscode.Disposable;
	private indexing = false;

	constructor(private readonly connections: SshConnectionManager) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
		this.item.name = 'Bitrix Assistant';
		this.item.command = 'bitrix.ssh.switchProfile';
		this.subscription = this.connections.onDidChangeConnection(() => this.update());
		this.update();
		this.item.show();
	}

	setIndexing(value: boolean): void {
		this.indexing = value;
		this.update();
	}

	update(): void {
		const profile = this.connections.activeProfile;
		if (this.indexing) {
			this.item.text = '$(sync~spin) Bitrix Assistant: индексация…';
			this.item.tooltip = 'Bitrix Assistant: обновление индекса';
			this.item.backgroundColor = undefined;
			this.item.color = undefined;
			return;
		}
		if (profile) {
			this.item.text = `$(server) ${profile.name}`;
			this.item.tooltip = new vscode.MarkdownString(
				`**Сервер: ${profile.name}**\n\n` +
					`\`${profile.username}@${profile.host}:${profile.port}\`\n\n` +
					`${profile.remoteRoot}\n\n` +
					'Клик — сменить сервер\n\n' +
					'[Удалить SSH-профиль](command:bitrix.ssh.removeProfile)',
			);
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
			this.item.color = new vscode.ThemeColor('statusBarItem.remoteForeground');
			return;
		}
		this.item.text = '$(server) Bitrix Assistant: сервер не выбран';
		this.item.tooltip = 'Bitrix Assistant: выбрать сервер';
		this.item.backgroundColor = undefined;
		this.item.color = undefined;
	}

	dispose(): void {
		this.subscription.dispose();
		this.item.dispose();
	}
}
