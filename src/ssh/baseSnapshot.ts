import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage, log } from '../log';
import { SshProfile } from './types';

/**
 * Снимок последней синхронизированной версии файла — общий предок (merge base)
 * для слияния локальной и серверной версий.
 *
 * Снимается в момент, когда обе стороны точно совпадают: сразу после успешной
 * загрузки на сервер или скачивания с сервера. Это и есть семантика git —
 * «последняя общая версия», поэтому для 3-way merge непересекающиеся правки
 * склеиваются автоматически, а конфликтом помечается только пересечение.
 *
 * Каталог — глобальный (`globalStorage/base`), ключ — хост/порт/пользователь и
 * путь на сервере, чтобы снимки не путались между профилями и проектами.
 * Размер ограничен: обе стороны ограничения (на файл и общий) проверяются при
 * записи и при суточной уборке.
 */
export class BaseSnapshots {
	/** Файлы больше этого размера не снимаем: слияние таких файлов всё равно бессмысленно. */
	static readonly MAX_BYTES = 256 * 1024;
	/** Общий бюджет каталога снимков. */
	static readonly MAX_TOTAL_BYTES = 50 * 1024 * 1024;
	/** Снимок, к которому не обращались столько времени, удаляется при уборке. */
	static readonly MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
	private static readonly PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
	private static readonly MARKER = '.prune';

	/** limits — переопределение лимитов (нужно тестам, в бою берутся константы класса). */
	constructor(
		private readonly directory: string | undefined,
		private readonly limits: { maxTotalBytes?: number; maxAgeMs?: number } = {},
	) {}

	/** Путь снимка для файла: каталог по хэшу идентичности, имя — настоящее. */
	private fileFor(profile: SshProfile, remotePath: string): string | undefined {
		if (!this.directory) {
			return undefined;
		}
		const identity = `${profile.host}:${profile.port}/${profile.username}${remotePath}`;
		const hash = crypto.createHash('sha1').update(identity).digest('hex').slice(0, 20);
		return path.join(this.directory, hash, path.posix.basename(remotePath));
	}

	/** Содержимое последней общей версии; undefined — снимка нет (слияние с пустой базой). */
	async read(profile: SshProfile | undefined, remotePath: string): Promise<Buffer | undefined> {
		if (!profile) {
			return undefined;
		}
		const file = this.fileFor(profile, remotePath);
		if (!file) {
			return undefined;
		}
		try {
			return await fs.promises.readFile(file);
		} catch {
			return undefined;
		}
	}

	/** Запоминает локальный файл как последнюю общую версию (стороны совпадают). */
	async remember(profile: SshProfile | undefined, remotePath: string, localPath: string): Promise<void> {
		if (!profile) {
			return;
		}
		const file = this.fileFor(profile, remotePath);
		if (!file) {
			return;
		}
		try {
			const stat = await fs.promises.stat(localPath);
			if (!stat.isFile() || stat.size > BaseSnapshots.MAX_BYTES) {
				return;
			}
			const content = await fs.promises.readFile(localPath);
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			await fs.promises.writeFile(file, content);
		} catch (err) {
			log().debug(`Снимок для слияния ${remotePath}: ${errorMessage(err)}`);
		}
	}

	/**
	 * Уборка: старые снимки (30 дней) и превышение общего бюджета (самые старые
	 * удаляются первыми). Запускается в фоне при активации, не чаще раза в сутки.
	 */
	async pruneIfDue(): Promise<void> {
		if (!this.directory) {
			return;
		}
		const marker = path.join(this.directory, BaseSnapshots.MARKER);
		const markerStat = await fs.promises.stat(marker).catch(() => undefined);
		if (markerStat && Date.now() - markerStat.mtimeMs < BaseSnapshots.PRUNE_INTERVAL_MS) {
			return;
		}
		const files = await this.listSnapshots();
		if (files === undefined) {
			return;
		}
		const maxTotalBytes = this.limits.maxTotalBytes ?? BaseSnapshots.MAX_TOTAL_BYTES;
		const threshold = Date.now() - (this.limits.maxAgeMs ?? BaseSnapshots.MAX_AGE_MS);
		let removed = 0;
		let total = 0;
		const alive: Array<{ file: string; mtime: number; size: number }> = [];
		for (const entry of files) {
			if (entry.mtime < threshold) {
				await fs.promises.rm(entry.file, { force: true }).catch(() => undefined);
				removed++;
				continue;
			}
			alive.push(entry);
			total += entry.size;
		}
		if (total > maxTotalBytes) {
			alive.sort((left, right) => left.mtime - right.mtime);
			for (const entry of alive) {
				if (total <= maxTotalBytes) {
					break;
				}
				await fs.promises.rm(entry.file, { force: true }).catch(() => undefined);
				total -= entry.size;
				removed++;
			}
		}
		if (removed > 0) {
			log().info(`Снимки для слияния: удалено ${removed} (осталось ${Math.round(total / 1024)} КБ)`);
			await this.removeEmptyDirs();
		}
		await fs.promises.mkdir(this.directory, { recursive: true }).catch(() => undefined);
		await fs.promises.writeFile(marker, String(Date.now())).catch(() => undefined);
	}

	/** Все снимки с их mtime и размером; undefined — каталога ещё нет. */
	private async listSnapshots(): Promise<Array<{ file: string; mtime: number; size: number }> | undefined> {
		if (!this.directory) {
			return undefined;
		}
		let buckets: string[];
		try {
			buckets = await fs.promises.readdir(this.directory);
		} catch {
			return undefined;
		}
		const out: Array<{ file: string; mtime: number; size: number }> = [];
		for (const bucket of buckets) {
			const directory = path.join(this.directory, bucket);
			const names = await fs.promises.readdir(directory).catch(() => undefined);
			if (!names) {
				continue;
			}
			for (const name of names) {
				const file = path.join(directory, name);
				const stat = await fs.promises.stat(file).catch(() => undefined);
				if (stat?.isFile()) {
					out.push({ file, mtime: stat.mtimeMs, size: stat.size });
				}
			}
		}
		return out;
	}

	private async removeEmptyDirs(): Promise<void> {
		if (!this.directory) {
			return;
		}
		const buckets = await fs.promises.readdir(this.directory).catch(() => []);
		for (const bucket of buckets) {
			await fs.promises.rmdir(path.join(this.directory, bucket)).catch(() => undefined);
		}
	}
}
