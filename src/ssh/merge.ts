import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage, log } from '../log';
import { readSettings } from '../settings';
import { BaseSnapshots } from './baseSnapshot';
import { SshConnectionManager } from './connection';

/**
 * Слияние локальной и серверной версий файла во встроенном редакторе слияния VS Code.
 *
 * Редактор вызывается внутренней командой `_open.mergeEditor` (её же использует
 * встроенное git-расширение): публичного API для merge-редактора в VS Code нет.
 * Поэтому любая ошибка здесь — не повод падать: возвращаем false, и вызывающий
 * код показывает обычное сравнение в diff.
 */
export class MergeService {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly connections: SshConnectionManager,
		private readonly bases?: BaseSnapshots,
	) {}

	/** Можно ли пробовать редактор слияния (настройка + подключение). */
	available(): boolean {
		return readSettings().sshMergeEditor && this.connections.isConnected;
	}

	/**
	 * Открывает редактор слияния: слева локальная версия, справа серверная,
	 * снизу результат. Результат сохраняется поверх локального файла — при
	 * «Complete Merge» VS Code пишет его в output, дальше файл уходит на сервер
	 * обычной загрузкой.
	 */
	async open(localPath: string, remotePath: string): Promise<boolean> {
		if (!this.connections.isConnected) {
			void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
			return false;
		}
		if (!readSettings().sshMergeEditor) {
			return false;
		}
		// Открытый с несохранёнными правками документ нельзя перезаписывать
		// результатом слияния: сначала сохраняем его.
		const opened = vscode.workspace.textDocuments.find(
			(candidate) =>
				candidate.uri.scheme === 'file' &&
				path.normalize(candidate.uri.fsPath) === path.normalize(localPath),
		);
		if (opened?.isDirty) {
			await opened.save();
		}
		try {
			const directory = await this.prepare(remotePath, localPath);
			const name = path.posix.basename(remotePath);
			await vscode.commands.executeCommand('_open.mergeEditor', {
				base: vscode.Uri.file(path.join(directory, `base-${name}`)),
				input1: { uri: vscode.Uri.file(path.join(directory, `mine-${name}`)), title: 'Моё (локально)' },
				input2: { uri: vscode.Uri.file(path.join(directory, name)), title: 'На сервере' },
				output: vscode.Uri.file(localPath),
			});
			log().info(`SSH: слияние открыто: ${remotePath}`);
			return true;
		} catch (err) {
			log().warn(`SSH: редактор слияния недоступен: ${errorMessage(err)}`);
			return false;
		}
	}

	/**
	 * Готовит файлы для редактора во временном каталоге расширения: серверная
	 * копия, копия локальной версии и база — последняя общая версия из снимков.
	 * Копия локальной версии нужна потому, что входные файлы слияния не должны
	 * совпадать с output (иначе редактор пишет результат поверх документа, который
	 * сам же и читает). Базы нет — файл ещё не синхронизировали этим расширением:
	 * тогда база пустая и каждое расхождение разрешается вручную.
	 */
	private async prepare(remotePath: string, localPath: string): Promise<string> {
		const hash = crypto.createHash('sha1').update(remotePath).digest('hex').slice(0, 16);
		const directory = path.join(this.context.globalStorageUri.fsPath, 'merge', hash);
		await fs.promises.mkdir(directory, { recursive: true });
		const name = path.posix.basename(remotePath);
		await this.connections.fastGet(remotePath, path.join(directory, name));
		await fs.promises.copyFile(localPath, path.join(directory, `mine-${name}`));
		const base = await this.bases?.read(this.connections.activeProfile, remotePath);
		if (base) {
			await fs.promises.writeFile(path.join(directory, `base-${name}`), base);
			log().debug(`SSH: база слияния из снимка: ${remotePath}`);
		} else {
			await fs.promises.writeFile(path.join(directory, `base-${name}`), '');
			log().debug(`SSH: снимка нет, база слияния пустая: ${remotePath}`);
		}
		return directory;
	}
}
