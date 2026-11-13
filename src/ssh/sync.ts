import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activeFolder } from '../indexer/indexer';
import { errorMessage, log } from '../log';
import { readSettings } from '../settings';
import { isExcluded, toPosix } from '../util/glob';
import { mapPool } from '../util/pool';
import { ByteProgress, SshConnectionManager } from './connection';
import { RemoteEntry } from './types';

export type SyncMode = 'both' | 'upload' | 'download';

/** Итог одиночной загрузки файла. */
export type UploadOutcome = 'uploaded' | 'identical' | 'excluded' | 'cancelled';

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	skipped: number;
}

/** Ход переноса каталога: сколько файлов и байт уже позади. */
export interface TransferState {
	doneFiles: number;
	totalFiles: number;
	doneBytes: number;
	totalBytes: number;
}

export type TransferProgress = (state: TransferState) => void;

/** Счётчик прогресса: байты по чанкам + число готовых файлов, с троттлингом. */
class Meter {
	private doneFiles = 0;
	private doneBytes = 0;
	private lastEmit = 0;

	constructor(
		private readonly totalFiles: number,
		private readonly totalBytes: number,
		private readonly onState?: TransferProgress,
	) {}

	/** Колбэк для одного файла: ssh2 отдаёт накопленные байты этого файла. */
	fileProgress(): ByteProgress {
		let previous = 0;
		return (transferred: number) => {
			this.doneBytes += transferred - previous;
			previous = transferred;
			this.emit();
		};
	}

	fileDone(): void {
		this.doneFiles++;
		this.emit();
	}

	finish(): void {
		this.emit(true);
	}

	private emit(force = false): void {
		if (!this.onState) {
			return;
		}
		const now = Date.now();
		if (!force && now - this.lastEmit < 150) {
			return;
		}
		this.lastEmit = now;
		this.onState({
			doneFiles: this.doneFiles,
			totalFiles: this.totalFiles,
			// На повторной попытке (пересоздание каталога) счётчик может обогнать
			// план — проценты не должны уезжать за 100.
			doneBytes: Math.min(this.doneBytes, this.totalBytes),
			totalBytes: this.totalBytes,
		});
	}
}

/** Сколько файлов переносить одновременно (настройка bitrix.ssh.concurrency). */
function transferConcurrency(): number {
	const value = Number(readSettings().sshConcurrency);
	return Number.isFinite(value) ? Math.min(16, Math.max(1, Math.floor(value))) : 4;
}

/** Сопоставление локального и удалённого дерева + операции загрузки/скачивания. */
export class SyncService {
	/** Каталоги, которые уже точно есть на сервере: экономит stat при каждой загрузке. */
	private readonly knownDirs = new Set<string>();

	constructor(private readonly connections: SshConnectionManager) {}

	private localRootFor(localPath?: string): string | undefined {
		const profile = this.connections.activeProfile;
		if (profile?.localRoot) {
			return profile.localRoot;
		}
		if (localPath) {
			const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path.resolve(localPath)));
			if (owner) {
				return owner.uri.fsPath;
			}
		}
		return activeFolder()?.uri.fsPath;
	}

	toRemotePath(localPath: string): string | undefined {
		const profile = this.connections.activeProfile;
		const root = this.localRootFor(localPath);
		if (!profile || !root) {
			return undefined;
		}
		const relative = path.relative(root, path.resolve(localPath));
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			return undefined;
		}
		const posix = toPosix(relative);
		return posix === '' ? profile.remoteRoot : `${profile.remoteRoot}/${posix}`;
	}

	toLocalPath(remotePath: string): string | undefined {
		const profile = this.connections.activeProfile;
		const root = this.localRootFor();
		if (!profile || !root) {
			return undefined;
		}
		const remoteRoot = profile.remoteRoot.replace(/\/+$/, '');
		const normalized = remotePath.replace(/\/+$/, '');
		if (normalized !== remoteRoot && !normalized.startsWith(`${remoteRoot}/`)) {
			return undefined;
		}
		const relative = normalized.slice(remoteRoot.length).replace(/^\/+/, '');
		return relative === '' ? root : path.join(root, ...relative.split('/'));
	}

	isExcludedPath(localPathOrRelative: string): boolean {
		const root = this.localRootFor(localPathOrRelative);
		const relative = root ? path.relative(root, path.resolve(root, localPathOrRelative)) : localPathOrRelative;
		return isExcluded(relative, readSettings().sshExclude);
	}

	async upload(localPath: string, progress?: ByteProgress): Promise<UploadOutcome> {
		if (!this.connections.isConnected) {
			throw new Error('Нет активного SSH-подключения');
		}
		const remotePath = this.toRemotePath(localPath);
		if (!remotePath) {
			throw new Error('Файл вне локального корня проекта');
		}
		if (this.isExcludedPath(localPath)) {
			return 'excluded';
		}
		// Загрузка одиночного файла: каталог сюда попадать не должен (иначе fastPut
		// падает с EISDIR) — для каталогов есть uploadEntry.
		if ((await this.statOrUndefined(localPath))?.isDirectory()) {
			throw new Error('Это каталог, а не файл: загрузите каталог целиком (uploadEntry)');
		}
		const decision = await this.confirmOverwrite(localPath, remotePath);
		if (decision !== 'upload') {
			return decision;
		}
		const remoteDir = path.posix.dirname(remotePath);
		// Каталог уже создавали в этой сессии — не тратим на него stat-раундтрипы.
		if (this.knownDirs.has(remoteDir)) {
			try {
				await this.uploadAtomic(localPath, remotePath, progress);
				return 'uploaded';
			} catch (err) {
				// Каталог могли удалить на сервере: пересоздаём и повторяем один раз.
				this.knownDirs.delete(remoteDir);
				log().debug(`SSH: каталог ${remoteDir} пропал, пересоздаю (${errorMessage(err)})`);
			}
		}
		await this.ensureRemoteDir(remoteDir, this.knownDirs);
		await this.uploadAtomic(localPath, remotePath, progress);
		return 'uploaded';
	}

	/**
	 * Сравнение локального файла с серверным по содержимому (без mtime).
	 * `missing` — на сервере нет файла.
	 */
	async compare(localPath: string, remotePath?: string): Promise<'identical' | 'different' | 'missing'> {
		const remote = remotePath ?? this.toRemotePath(localPath);
		if (!remote) {
			throw new Error('Файл вне локального корня проекта');
		}
		const info = await this.connections.stat(remote);
		if (!info || info.type !== 'file') {
			return 'missing';
		}
		if (!(await this.statOrUndefined(localPath))) {
			return 'missing';
		}
		return (await this.sameContent(localPath, remote, info.size)) ? 'identical' : 'different';
	}

	/** Совпадает ли содержимое файлов: сначала размер, затем sha256. */
	private async sameContent(localPath: string, remotePath: string, remoteSize?: number): Promise<boolean> {
		try {
			const local = await fs.promises.readFile(localPath);
			if (remoteSize !== undefined && remoteSize !== local.length) {
				return false;
			}
			const remote = await this.connections.readFile(remotePath);
			if (local.length !== remote.length) {
				return false;
			}
			const digest = (data: Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
			return digest(local) === digest(remote);
		} catch (err) {
			// Сравнить не удалось — ведём себя как раньше, по mtime.
			log().debug(`SSH: сравнение с ${remotePath} не удалось: ${errorMessage(err)}`);
			return false;
		}
	}

	/**
	 * Разрешение конфликта. Серверный файл новее, но содержимое совпадает —
	 * перезаписывать нечего, спрашивать не о чем (mtime локального файла
	 * стареет, даже если содержимое не менялось).
	 */
	private async confirmOverwrite(
		localPath: string,
		remotePath: string,
	): Promise<'upload' | 'identical' | 'cancelled'> {
		const remote = await this.connections.stat(remotePath);
		const local = await this.statOrUndefined(localPath);
		if (!remote || remote.mtime === undefined || !local) {
			return 'upload';
		}
		const localSeconds = local.mtimeMs / 1000;
		if (localSeconds + 2 >= remote.mtime) {
			return 'upload';
		}
		if (await this.sameContent(localPath, remotePath, remote.size)) {
			log().info(`SSH: содержимое совпадает, загрузка не нужна: ${remotePath}`);
			return 'identical';
		}
		const choice = await vscode.window.showWarningMessage(
			`На сервере файл новее локального: ${remotePath}. Перезаписать?`,
			{ modal: true },
			'Перезаписать',
		);
		return choice === 'Перезаписать' ? 'upload' : 'cancelled';
	}

	private async uploadAtomic(localPath: string, remotePath: string, progress?: ByteProgress): Promise<void> {
		const temp = `${remotePath}.bitrix-assistant-${process.pid}.tmp`;
		try {
			await this.connections.fastPut(localPath, temp, progress);
			// Резервную копию `<файл>.bak` не делаем: замена идёт через temp,
			// поэтому недописанный файл на сервер не попадает.
			await this.connections.replace(temp, remotePath);
		} catch (err) {
			await this.connections.unlink(temp);
			throw err;
		}
	}

	/** Создаёт каталог на сервере один раз за операцию, без повторных stat. */
	private async ensureRemoteDir(remoteDir: string, cache: Set<string>): Promise<void> {
		const parts = remoteDir.replace(/\/+$/, '').split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current += `/${part}`;
			if (cache.has(current)) {
				continue;
			}
			if (!(await this.connections.stat(current))) {
				await this.connections.mkdir(current);
			}
			cache.add(current);
		}
	}

	/** Файлы, у которых серверная версия новее локальной (по mtime, допуск 2 с). */
	private async newerOnServer(files: readonly string[]): Promise<Set<string>> {
		const newer = new Set<string>();
		// Проверка конфликтов — это по одному stat на файл: последовательно на
		// каталоге в сотни файлов она занимала больше времени, чем сама загрузка.
		await mapPool(files, Math.min(8, Math.max(4, transferConcurrency())), async (file) => {
			const remotePath = this.toRemotePath(file);
			if (!remotePath || this.isExcludedPath(file)) {
				return;
			}
			const remote = await this.connections.stat(remotePath);
			const local = await this.statOrUndefined(file);
			if (!remote || remote.mtime === undefined || !local) {
				return;
			}
			if (local.mtimeMs / 1000 + 2 < remote.mtime) {
				if (await this.sameContent(file, remotePath, remote.size)) {
					return;
				}
				newer.add(file);
			}
		});
		return newer;
	}

	/** Один общий вопрос на пакет; true — перезаписать все конфликтные файлы. */
	private async confirmBulkOverwrite(count: number): Promise<boolean> {
		const choice = await vscode.window.showWarningMessage(
			`На сервере новее ${count} файл(ов). Перезаписать их?`,
			{ modal: true },
			'Перезаписать все',
			'Пропустить новые',
		);
		return choice === 'Перезаписать все';
	}

	async download(remotePath: string, localPath?: string, progress?: ByteProgress): Promise<string | undefined> {
		const target = localPath ?? this.toLocalPath(remotePath);
		if (!target) {
			throw new Error('Удалённый путь вне remoteRoot');
		}
		if (this.isExcludedPath(target)) {
			return undefined;
		}
		await this.connections.fastGet(remotePath, target, progress);
		return target;
	}

	/** Явное скачивание файла или каталога с сервера (перезапись локальных копий). */
	async downloadEntry(
		remotePath: string,
		report: (message: string) => void = () => undefined,
		token?: vscode.CancellationToken,
		onProgress?: TransferProgress,
	): Promise<SyncResult> {
		if (!this.connections.isConnected) {
			throw new Error('Нет активного SSH-подключения');
		}
		const info = await this.connections.stat(remotePath);
		if (!info) {
			throw new Error(`На сервере не найдено: ${remotePath}`);
		}
		if (info.type !== 'directory') {
			const target = this.toLocalPath(remotePath);
			if (!target) {
				throw new Error('Удалённый путь вне remoteRoot');
			}
			if (this.isExcludedPath(target)) {
				throw new Error('Путь исключён настройкой bitrix.ssh.exclude');
			}
			const meter = new Meter(1, info.size, onProgress);
			await this.connections.fastGet(remotePath, target, meter.fileProgress());
			meter.fileDone();
			meter.finish();
			return { uploaded: 0, downloaded: 1, skipped: 0 };
		}
		const files: RemoteEntry[] = [];
		report('Обход каталога на сервере…');
		await this.walkRemote(remotePath, files, token);
		report(`Файлов к скачиванию: ${files.length}`);
		const totalBytes = files.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
		const meter = new Meter(files.length, totalBytes, onProgress);
		let downloaded = 0;
		let skipped = 0;
		await mapPool(files, transferConcurrency(), async (entry) => {
			if (token?.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const target = this.toLocalPath(entry.path);
			if (!target || this.isExcludedPath(target)) {
				skipped++;
				meter.fileDone();
				return;
			}
			await this.connections.fastGet(entry.path, target, meter.fileProgress());
			downloaded++;
			meter.fileDone();
		});
		meter.finish();
		return { uploaded: 0, downloaded, skipped };
	}

	/** Явная загрузка локального файла или каталога на сервер. */
	async uploadEntry(
		localPath: string,
		report: (message: string) => void = () => undefined,
		token?: vscode.CancellationToken,
		onProgress?: TransferProgress,
	): Promise<SyncResult> {
		if (!this.connections.isConnected) {
			throw new Error('Нет активного SSH-подключения');
		}
		const stat = await this.statOrUndefined(localPath);
		if (!stat) {
			throw new Error(`Локальный путь не найден: ${localPath}`);
		}
		if (stat.isFile()) {
			const meter = new Meter(1, stat.size, onProgress);
			const outcome = await this.upload(localPath, meter.fileProgress());
			if (outcome === 'identical') {
				report('Содержимое совпадает с серверным — загрузка не нужна');
			}
			meter.fileDone();
			meter.finish();
			const uploaded = outcome === 'uploaded';
			return { uploaded: uploaded ? 1 : 0, downloaded: 0, skipped: uploaded ? 0 : 1 };
		}
		if (!stat.isDirectory()) {
			throw new Error('Поддерживаются только файлы и каталоги');
		}
		const files: string[] = [];
		report('Обход локального каталога…');
		await this.walkLocal(localPath, files, token);
		report(`Файлов к загрузке: ${files.length}`);
		const sizes = new Map<string, number>();
		let totalBytes = 0;
		for (const file of files) {
			const info = await this.statOrUndefined(file);
			const size = info?.size ?? 0;
			sizes.set(file, size);
			totalBytes += size;
		}
		const conflicts = await this.newerOnServer(files);
		const skipConflicts = conflicts.size > 0 && !(await this.confirmBulkOverwrite(conflicts.size));
		const meter = new Meter(files.length, totalBytes, onProgress);
		const dirs = new Set<string>();
		let uploaded = 0;
		let skipped = 0;
		await mapPool(files, transferConcurrency(), async (file) => {
			if (token?.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const remotePath = this.toRemotePath(file);
			if (!remotePath || this.isExcludedPath(file) || (skipConflicts && conflicts.has(file))) {
				skipped++;
				meter.fileDone();
				return;
			}
			await this.ensureRemoteDir(path.posix.dirname(remotePath), dirs);
			await this.uploadAtomic(file, remotePath, meter.fileProgress());
			uploaded++;
			meter.fileDone();
		});
		meter.finish();
		return { uploaded, downloaded: 0, skipped };
	}

	async syncAll(
		mode: SyncMode = 'both',
		report: (message: string) => void = () => undefined,
		token?: vscode.CancellationToken,
	): Promise<SyncResult> {
		const result: SyncResult = { uploaded: 0, downloaded: 0, skipped: 0 };
		const profile = this.connections.activeProfile;
		const root = this.localRootFor();
		if (!profile || !root) {
			throw new Error('Нет активного SSH-подключения');
		}
		const remoteFiles: RemoteEntry[] = [];
		report(`Обход ${profile.remoteRoot}…`);
		await this.walkRemote(profile.remoteRoot, remoteFiles, token);
		report(`На сервере ${remoteFiles.length} файлов`);

		let overwrites = 0;
		// Файлы, у которых отличается mtime, но содержимое одинаковое: трогать их
		// не нужно, и в счётчик перезаписи они не попадают.
		const identical = new Set<string>();
		for (const entry of remoteFiles) {
			const localPath = this.toLocalPath(entry.path);
			if (!localPath || this.isExcludedPath(localPath)) {
				continue;
			}
			const localStat = await this.statOrUndefined(localPath);
			if (!localStat) {
				continue;
			}
			const remoteSeconds = entry.mtime;
			const localSeconds = Math.round(localStat.mtimeMs / 1000);
			if (remoteSeconds === localSeconds) {
				continue;
			}
			if (await this.sameContent(localPath, entry.path, entry.size)) {
				identical.add(entry.path);
				continue;
			}
			if (
				mode === 'download' ||
				(mode === 'both' && remoteSeconds > localSeconds) ||
				mode === 'upload' ||
				(mode === 'both' && localSeconds > remoteSeconds)
			) {
				overwrites++;
			}
		}
		if (overwrites > 0) {
			const choice = await vscode.window.showWarningMessage(
				`Синхронизация перезапишет ${overwrites} файл(ов). Продолжить?`,
				{ modal: true },
				'Синхронизировать',
			);
			if (choice !== 'Синхронизировать') {
				return { uploaded: 0, downloaded: 0, skipped: remoteFiles.length };
			}
		}

		const dirs = new Set<string>();
		for (const entry of remoteFiles) {
			if (token?.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const localPath = this.toLocalPath(entry.path);
			if (!localPath || this.isExcludedPath(localPath)) {
				continue;
			}
			const localStat = await this.statOrUndefined(localPath);
			if (!localStat) {
				if (mode !== 'upload') {
					await this.connections.fastGet(entry.path, localPath);
					result.downloaded++;
				}
				continue;
			}
			const remoteSeconds = entry.mtime;
			const localSeconds = Math.round(localStat.mtimeMs / 1000);
			if (remoteSeconds === localSeconds || identical.has(entry.path)) {
				result.skipped++;
				continue;
			}
			if (mode === 'download' || (mode === 'both' && remoteSeconds > localSeconds)) {
				if (remoteSeconds > localSeconds) {
					await this.connections.fastGet(entry.path, localPath);
					result.downloaded++;
					continue;
				}
			}
			if (mode === 'upload' || mode === 'both') {
				if (localSeconds > remoteSeconds) {
					await this.ensureRemoteDir(path.posix.dirname(entry.path), dirs);
					await this.uploadAtomic(localPath, entry.path);
					result.uploaded++;
					continue;
				}
			}
			result.skipped++;
		}

		if (mode === 'upload' || mode === 'both') {
			report('Поиск локальных файлов, отсутствующих на сервере…');
			const localFiles: string[] = [];
			await this.walkLocal(root, localFiles, token);
			const remoteSet = new Set(remoteFiles.map((entry) => entry.path));
			for (const localFile of localFiles) {
				if (token?.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				const remotePath = this.toRemotePath(localFile);
				if (!remotePath || remoteSet.has(remotePath) || this.isExcludedPath(localFile)) {
					continue;
				}
				await this.ensureRemoteDir(path.posix.dirname(remotePath), dirs);
				await this.uploadAtomic(localFile, remotePath);
				result.uploaded++;
			}
		}
		return result;
	}

	private async statOrUndefined(file: string): Promise<fs.Stats | undefined> {
		try {
			return await fs.promises.stat(file);
		} catch {
			return undefined;
		}
	}

	private async walkRemote(
		dir: string,
		out: RemoteEntry[],
		token?: vscode.CancellationToken,
	): Promise<void> {
		if (token?.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		let entries: RemoteEntry[];
		try {
			entries = await this.connections.readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const localPath = this.toLocalPath(entry.path);
			if (localPath && this.isExcludedPath(localPath)) {
				continue;
			}
			if (entry.type === 'directory') {
				await this.walkRemote(entry.path, out, token);
			} else if (entry.type === 'file') {
				out.push(entry);
			}
		}
	}

	private async walkLocal(
		dir: string,
		out: string[],
		token?: vscode.CancellationToken,
	): Promise<void> {
		if (token?.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (this.isExcludedPath(full)) {
				continue;
			}
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === '.git') {
					continue;
				}
				await this.walkLocal(full, out, token);
			} else if (entry.isFile()) {
				out.push(full);
			}
		}
	}
}
