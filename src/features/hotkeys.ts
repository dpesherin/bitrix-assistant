import * as path from 'node:path';
import * as vscode from 'vscode';
import { updateKeybindings } from './hotkeysConfig';

interface HotkeyDefinition {
	setting: string;
	command: string;
	defaultKey: string;
	when?: string;
}

const DEFINITIONS: HotkeyDefinition[] = [
	{ setting: 'switchProfile', command: 'bitrix.ssh.switchProfile', defaultKey: 'ctrl+alt+p' },
	{ setting: 'upload', command: 'bitrix.ssh.upload', defaultKey: 'ctrl+alt+u', when: 'editorTextFocus' },
	{
		setting: 'saveAndUpload',
		command: 'bitrix.ssh.saveAndUpload',
		defaultKey: 'ctrl+alt+s',
		when: 'editorTextFocus',
	},
];

function platformDefault(definition: HotkeyDefinition): string {
	return process.platform === 'darwin'
		? definition.defaultKey.replace(/^ctrl\+/, 'cmd+')
		: definition.defaultKey;
}

function configuredKey(definition: HotkeyDefinition, platform: NodeJS.Platform): string {
	const raw = vscode.workspace
		.getConfiguration('bitrix.keybindings')
		.get<string>(definition.setting, '')
		.trim();
	if (raw === '') {
		return platform === 'darwin'
			? definition.defaultKey.replace(/^ctrl\+/, 'cmd+')
			: definition.defaultKey;
	}
	return raw.toLowerCase();
}

/** Путь к user keybindings.json: <userData>/User/keybindings.json. */
function keybindingsPath(context: vscode.ExtensionContext): string {
	return path.resolve(context.globalStorageUri.fsPath, '..', '..', 'keybindings.json');
}

async function readKeybindings(file: string): Promise<string> {
	try {
		const data = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
		return Buffer.from(data).toString('utf8');
	} catch {
		return '[]\n';
	}
}

/** Записывает выбранные в настройках клавиши в пользовательский keybindings.json. */
export async function applyHotkeys(context: vscode.ExtensionContext): Promise<void> {
	const entries = DEFINITIONS.map((definition) => ({
		key: configuredKey(definition, process.platform),
		command: definition.command,
		when: definition.when,
	}));
	for (const entry of entries) {
		if (!/^[a-z0-9+_-]+$/.test(entry.key)) {
			void vscode.window.showErrorMessage(`Bitrix Assistant: некорректная комбинация «${entry.key}»`);
			return;
		}
	}
	const file = keybindingsPath(context);
	const answer = await vscode.window.showWarningMessage(
		`Записать горячие клавиши Bitrix в ${file}?`,
		{ modal: true },
		'Применить',
	);
	if (answer !== 'Применить') {
		return;
	}
	try {
		const current = await readKeybindings(file);
		const updated = updateKeybindings(current, entries);
		await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(updated, 'utf8'));
		void vscode.window.showInformationMessage(
			'Bitrix Assistant: горячие клавиши обновлены. Если VS Code не применил их сразу — перезагрузите окно.',
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		void vscode.window.showErrorMessage(`Bitrix Assistant: не удалось обновить keybindings.json. ${message}`);
	}
}

export function hotkeyDefaults(): Array<{ setting: string; command: string; key: string }> {
	return DEFINITIONS.map((definition) => ({
		setting: definition.setting,
		command: definition.command,
		key: platformDefault(definition),
	}));
}
