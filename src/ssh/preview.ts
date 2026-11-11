import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log, errorMessage } from '../log';
import { SshConnectionManager } from './connection';

/** Расширения, которые безопасно открывать в текстовом редакторе. */
const TEXT_EXTENSIONS = new Set([
	'.php',
	'.phtml',
	'.inc',
	'.js',
	'.mjs',
	'.cjs',
	'.ts',
	'.css',
	'.scss',
	'.less',
	'.html',
	'.htm',
	'.xml',
	'.json',
	'.md',
	'.txt',
	'.sql',
	'.yml',
	'.yaml',
	'.ini',
	'.conf',
	'.log',
	'.sh',
	'.twig',
	'.vue',
	'.svelte',
	'.gitignore',
	'.env',
	'.htaccess',
]);

const TEXT_NAMES = new Set([
	'.htaccess',
	'.env',
	'.gitignore',
	'.editorconfig',
	'.prettierrc',
	'.eslintrc',
	'.babelrc',
	'composer.json',
	'package.json',
]);

/**
 * Просмотр файла с сервера: скачивает копию во временный каталог расширения,
 * открывает её в режиме «только чтение» сессии. Оригинал на сервере не меняется,
 * а временный файл находится вне workspace и не участвует в uploadOnSave.
 */
export class RemotePreview {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly connections: SshConnectionManager,
	) {}

	/** Скачивает копию во временный каталог (для diff/сравнения). */
	async fetch(remotePath: string): Promise<string | undefined> {
		if (!this.connections.isConnected) {
			return undefined;
		}
		try {
			const hash = crypto.createHash('sha1').update(remotePath).digest('hex').slice(0, 16);
			// Каталог по хэшу, а имя файла — настоящее: в diff-вкладке видно имя.
			const directory = path.join(this.context.globalStorageUri.fsPath, 'compare', hash);
			await fs.promises.mkdir(directory, { recursive: true });
			const localFile = path.join(directory, path.posix.basename(remotePath));
			await this.connections.fastGet(remotePath, localFile);
			return localFile;
		} catch (error) {
			void vscode.window.showErrorMessage(`Bitrix Assistant: не удалось скачать для сравнения. ${errorMessage(error)}`);
			return undefined;
		}
	}

	/** Очищает временные копии просмотра/сравнения. */
	async clearCache(): Promise<void> {
		for (const name of ['preview', 'compare']) {
			const directory = path.join(this.context.globalStorageUri.fsPath, name);
			await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async open(remotePath: string): Promise<void> {
		if (!this.connections.isConnected) {
			void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
			return;
		}
		try {
			const info = await this.connections.stat(remotePath);
			if (!info) {
				void vscode.window.showErrorMessage(`Bitrix Assistant: на сервере не найдено ${remotePath}`);
				return;
			}
			if (info.type === 'directory') {
				void vscode.window.showWarningMessage('Bitrix Assistant: это каталог — используйте «Скачать с сервера»');
				return;
			}
			const baseName = path.posix.basename(remotePath);
			const extension = path.posix.extname(remotePath).toLowerCase();
			if (!TEXT_EXTENSIONS.has(extension) && !TEXT_NAMES.has(baseName)) {
				const action = await vscode.window.showWarningMessage(
					`Bitrix Assistant: ${baseName} не похож на текстовый файл. Просмотр может быть некорректным.`,
					'Скачать локально',
				);
				if (action === 'Скачать локально') {
					void vscode.commands.executeCommand('bitrix.ssh.downloadRemote', remotePath);
				}
				return;
			}

			const previewDir = path.join(this.context.globalStorageUri.fsPath, 'preview');
			await fs.promises.mkdir(previewDir, { recursive: true });
			const hash = crypto.createHash('sha1').update(remotePath).digest('hex').slice(0, 16);
			const localFile = path.join(previewDir, `${hash}${extension}`);
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `Просмотр ${baseName}` },
				async () => {
					// Предыдущая копия могла быть помечена только для чтения.
					await fs.promises.chmod(localFile, 0o644).catch(() => undefined);
					await this.connections.fastGet(remotePath, localFile);
					// Дополнительная страховка от сохранения: файл доступен только на чтение.
					await fs.promises.chmod(localFile, 0o444).catch(() => undefined);
				},
			);

			const uri = vscode.Uri.file(localFile);
			const document = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
			if (!document.isDirty) {
				await vscode.commands.executeCommand('workbench.action.files.revert').then(undefined, () => undefined);
			}
			try {
				await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
			} catch (error) {
				log().warn(`Не удалось включить режим только чтения: ${errorMessage(error)}`);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Bitrix Assistant: не удалось открыть файл. ${errorMessage(error)}`);
		}
	}
}
