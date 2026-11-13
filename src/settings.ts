import * as vscode from 'vscode';

export interface BitrixSettings {
	uploadOnSave: boolean;
	downloadOnOpen: boolean;
	sshExclude: string[];
	sshAutoConnect: boolean;
	sshConcurrency: number;
	indexEnabled: boolean;
	indexPhpStubs: boolean;
	indexVendor: boolean;
	bitrixPath: string;
	indexExclude: string[];
	jsMaxFileSizeKb: number;
	jsLibraryCheck: boolean;
	lspEnabled: boolean;
	lspPhpBinary: string;
	phpSemantic: boolean;
}

function config(scope?: vscode.Uri): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('bitrix', scope);
}

/** Настройки проекта; scope — папка workspace (мульти-рут: активная папка). */
export function readSettings(scope?: vscode.Uri): BitrixSettings {
	const cfg = config(scope);
	const ssh = cfg.get<Record<string, unknown>>('ssh') ?? {};
	const index = cfg.get<Record<string, unknown>>('index') ?? {};
	const js = cfg.get<Record<string, unknown>>('js') ?? {};
	const lsp = cfg.get<Record<string, unknown>>('lsp') ?? {};
	const php = cfg.get<Record<string, unknown>>('php') ?? {};
	return {
		uploadOnSave: Boolean(ssh.uploadOnSave ?? false),
		downloadOnOpen: Boolean(ssh.downloadOnOpen ?? false),
		sshExclude: Array.isArray(ssh.exclude) ? (ssh.exclude as string[]) : [],
		sshAutoConnect: Boolean(ssh.autoConnect ?? false),
		sshConcurrency: Number(ssh.concurrency ?? 4),
		indexEnabled: Boolean(index.enabled ?? true),
		indexPhpStubs: Boolean(index.phpStubs ?? true),
		indexVendor: Boolean(index.vendor ?? true),
		bitrixPath: String(index.bitrixPath ?? 'bitrix'),
		indexExclude: Array.isArray(index.exclude) ? (index.exclude as string[]) : [],
		jsMaxFileSizeKb: Number(index.jsMaxFileSizeKb ?? 512),
		jsLibraryCheck: Boolean(js.enableLibraryCheck ?? false),
		lspEnabled: Boolean(lsp.enabled ?? true),
		lspPhpBinary: String(lsp.phpBinary ?? ''),
		phpSemantic: Boolean(php['semantic'] ?? false),
	};
}
