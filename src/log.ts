import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
	channel ??= vscode.window.createOutputChannel('Bitrix Assistant', { log: true });
	return channel;
}

export function log(): vscode.LogOutputChannel {
	return initLog();
}

export function showLog(): void {
	initLog().show(true);
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
