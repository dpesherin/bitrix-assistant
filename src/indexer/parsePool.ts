/**
 * Пул воркеров для разбора файлов индекса (PHP и JS).
 *
 * Каждый поток получает свою часть списка и присылает результаты пачками, а
 * основной поток сразу пишет их в SQLite. Так разбор (секунды на большом
 * проекте) не блокирует event loop расширения и не держит весь результат в памяти.
 *
 * Сколько потоков брать, решает настройка `bitrix.index.threads`:
 * 0 — автоматически (до 4, но на единицу меньше числа ядер),
 * 1 — без воркеров, разбор в основном потоке (минимум нагрузки на систему).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { errorMessage, log } from '../log';
import type { JsParseResult, ParseKind, ParseMessage, ParseResult, PhpParseResult } from './parseWorker';

/** Сколько файлов воркер отдаёт за одно сообщение. */
const BATCH = 32;
/** Меньше этого числа файлов выгоднее разобрать в основном потоке: запуск воркера дороже. */
export const WORKER_MIN_FILES = 150;
/** Верхняя граница потоков, даже если ядер больше: индекс не должен съедать машину. */
const MAX_THREADS = 4;

/** Сколько потоков выделить разбору с учётом настройки (0 — авто, 1 — без воркеров). */
export function resolveThreads(configured: number): number {
	if (!Number.isFinite(configured) || configured <= 0) {
		const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
		return Math.max(1, Math.min(MAX_THREADS, available - 1));
	}
	return Math.max(1, Math.min(MAX_THREADS, Math.floor(configured)));
}

export class ParsePool {
	constructor(private readonly threads: number) {}

	/** Разбор PHP-файлов пачками; результаты приходят по мере готовности. */
	async parsePhpStream(
		files: readonly string[],
		onBatch: (batch: PhpParseResult[]) => void,
		token?: { isCancellationRequested: boolean },
	): Promise<void> {
		await this.stream('php', files, (batch) => onBatch(batch as PhpParseResult[]), token);
	}

	/** Сканирование JS-файлов пачками. */
	async parseJsStream(
		files: readonly string[],
		onBatch: (batch: JsParseResult[]) => void,
		token?: { isCancellationRequested: boolean },
	): Promise<void> {
		await this.stream('js', files, (batch) => onBatch(batch as JsParseResult[]), token);
	}

	async dispose(): Promise<void> {
		for (const worker of this.workers) {
			await worker.terminate().catch(() => undefined);
		}
		this.workers.clear();
	}

	private readonly workers = new Set<Worker>();

	private async stream(
		kind: ParseKind,
		files: readonly string[],
		onBatch: (batch: ParseResult[]) => void,
		token?: { isCancellationRequested: boolean },
	): Promise<void> {
		const parts = Math.min(this.threads, Math.max(1, files.length));
		const slices = sliceFiles(files, parts);
		await Promise.all(slices.map((slice) => this.parseSlice(kind, slice, onBatch, token)));
	}

	private parseSlice(
		kind: ParseKind,
		files: string[],
		onBatch: (batch: ParseResult[]) => void,
		token?: { isCancellationRequested: boolean },
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let worker: Worker;
			try {
				worker = new Worker(path.join(__dirname, 'parseWorker.js'));
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			this.workers.add(worker);
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				this.workers.delete(worker);
				worker.removeAllListeners();
				void worker.terminate().catch(() => undefined);
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			worker.on('message', (message: ParseMessage) => {
				if (token?.isCancellationRequested) {
					finish(new Error('разбор отменён'));
					return;
				}
				if (message.batch) {
					try {
						onBatch(message.batch);
					} catch (err) {
						// Ошибка записи в базу — не повод падать: вызывающий перейдёт
						// на разбор и запись в основном потоке.
						finish(err instanceof Error ? err : new Error(String(err)));
						return;
					}
					// Пачка записана — разрешаем воркеру прислать следующую.
					worker.postMessage({ ack: true } satisfies ParseMessage);
				}
				if (message.done) {
					finish();
				}
			});
			worker.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
			worker.on('exit', (code) => {
				if (!settled && code !== 0) {
					finish(new Error(`воркер разбора завершился с кодом ${code}`));
				}
			});
			worker.postMessage({ kind, files, batch: BATCH });
		});
	}
}

/** Делит файлы на примерно равные части (по кругу — крупные и мелкие распределяются равномерно). */
function sliceFiles(files: readonly string[], parts: number): string[][] {
	const slices: string[][] = Array.from({ length: parts }, () => []);
	for (const [index, file] of files.entries()) {
		slices[index % parts].push(file);
	}
	return slices.filter((slice) => slice.length > 0);
}

/** Останавливает пул, если он создавался; ошибки остановки не должны ломать индексацию. */
export async function settlePool(pool: ParsePool | undefined): Promise<void> {
	if (!pool) {
		return;
	}
	await pool.dispose().catch((err) => log().debug(`Остановка пула разбора: ${errorMessage(err)}`));
}
