import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log, errorMessage } from '../log';
import { readSettings } from '../settings';
import { isExcluded, toPosix } from '../util/glob';
import { mapPool } from '../util/pool';
import { Database } from './db';
import { PARSER_VERSION } from './schema';
import { IndexWriter } from './indexWriter';
import { ParsePool, WORKER_MIN_FILES, resolveThreads, settlePool } from './parsePool';
import type { JsParseResult, ParseResult, ParsedFile, PhpParseResult } from './parseWorker';

/**
 * Сколько каталогов читать одновременно при обходе. Больше — быстрее на больших
 * проектах, но и больше параллельных запросов к диску; 8 — компромисс.
 */
const WALK_CONCURRENCY = 8;

/** Отдать управление event loop: длинная синхронная работа не должна морозить интерфейс. */
function yieldToLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

export interface ClassCompletionRow {
	fqcn: string;
	name: string;
	namespace: string | null;
	module?: string | null;
	file: string;
	line: number;
	doc?: string | null;
}

export interface IndexStats {
	classes: number;
	methods: number;
	functions: number;
	phpConstants: number;
	components: number;
	jsExtensions: number;
	jsGlobals: number;
	dbFile: string;
}

export interface BitrixLayout {
	siteRoot: string;
	bitrixDir: string;
	localDir: string;
}

export type Report = (message: string) => void;

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'vendor']);

/** Входит ли файл в те же корни, что и полный обход индексатора. */
export function isIndexableSource(file: string, layout: BitrixLayout): boolean {
	const relative = path.relative(layout.siteRoot, path.normalize(file)).split(path.sep).join('/');
	if (relative.startsWith('../')) {
		return false;
	}
	if (/\.(?:php)$/i.test(relative)) {
		return (
			// Composer-зависимости: без них нет подсказок и переходов по vendor-классам.
			/^(?:vendor|local\/vendor)\//.test(relative) ||
			/^(?:bitrix|local)\/(?:components|php_interface)\//.test(relative) ||
			/^(?:bitrix|local)\/modules\/[^/]+\/(?:lib|classes|install\/components|install\/classes)\//.test(relative) ||
			/^bitrix\/modules\/[^/]+\/(?:tools|include|prolog|start)\.php$/.test(relative)
		);
	}
	if (/\.(?:js|d\.ts)$/i.test(relative)) {
		return (
			/^(?:bitrix|local)\/js\//.test(relative) ||
			/^bitrix\/modules\/[^/]+\/install\/js\//.test(relative)
		);
	}
	return false;
}

/**
 * Активная папка workspace: папка активного редактора, иначе первая видимая,
 * иначе первая папка. В мульти-руте все операции идут по активной папке.
 */
export function activeFolder(): vscode.WorkspaceFolder | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return undefined;
	}
	const active = vscode.window.activeTextEditor?.document.uri;
	const fromActive = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
	if (fromActive) {
		return fromActive;
	}
	for (const editor of vscode.window.visibleTextEditors) {
		const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (folder) {
			return folder;
		}
	}
	return folders[0];
}

export function resolveLayout(folder?: vscode.WorkspaceFolder): BitrixLayout | undefined {
	const target = folder ?? activeFolder();
	if (!target) {
		return undefined;
	}
	const configured = readSettings(target.uri).bitrixPath;
	const bitrixDir = path.isAbsolute(configured) ? configured : path.join(target.uri.fsPath, configured);
	if (!fs.existsSync(bitrixDir)) {
		return undefined;
	}
	const siteRoot = path.dirname(bitrixDir);
	return { siteRoot, bitrixDir, localDir: path.join(siteRoot, 'local') };
}

async function removeSqliteFiles(file: string): Promise<void> {
	for (const suffix of ['', '-wal', '-shm']) {
		await fs.promises.rm(`${file}${suffix}`, { force: true }).catch(() => undefined);
	}
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Удаляет только `-wal`/`-shm` файла, не трогая саму базу. */
async function removeSidecars(file: string): Promise<void> {
	for (const suffix of ['-wal', '-shm']) {
		await fs.promises.rm(`${file}${suffix}`, { force: true }).catch(() => undefined);
	}
}

/** Похоже ли на повреждение файла индекса. */
function isCorruption(err: unknown): boolean {
	const message = errorMessage(err).toLowerCase();
	return (
		message.includes('malformed') ||
		message.includes('database disk image') ||
		message.includes('not a database') ||
		message.includes('sqlite_corrupt')
	);
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function listFiles(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

function listDirectories(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

export class BitrixIndexer implements vscode.Disposable {
	private db?: Database;
	private openKey?: string;
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;
	private openFailureReported = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	get dbFile(): string {
		// Индекс привязан к проекту: в мульти-руте у каждой папки своя база,
		// чтобы классы разных сайтов не смешивались.
		const root = this.context.storageUri?.fsPath
			?? path.join(this.context.globalStorageUri.fsPath, 'no-workspace');
		const layout = resolveLayout();
		const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
		if (!multiRoot || !layout) {
			return path.join(root, 'bitrix-index.db');
		}
		const hash = crypto.createHash('sha1').update(layout.siteRoot).digest('hex').slice(0, 12);
		return path.join(root, `bitrix-index-${hash}.db`);
	}

	async ensureOpen(): Promise<Database | undefined> {
		const key = this.dbFile;
		if (this.db && this.openKey !== key) {
			this.db.close();
			this.db = undefined;
		}
		if (this.db) {
			return this.db;
		}
		await fs.promises.mkdir(path.dirname(key), { recursive: true });
		await this.recoverIndex(key);
		try {
			this.db = await Database.open(key);
			this.openKey = key;
			this.openFailureReported = false;
			return this.db;
		} catch (err) {
			if (isCorruption(err)) {
				log().warn(`Файл индекса повреждён (${errorMessage(err)}) — пересоздаю`);
				const recovered = await this.resetIndex(key);
				if (recovered) {
					void vscode.window.showWarningMessage(
						'Bitrix Assistant: файл индекса был повреждён и пересоздан — индекс строится заново.',
					);
					return recovered;
				}
			}
			if (!this.openFailureReported) {
				this.openFailureReported = true;
				void vscode.window.showErrorMessage(
					`Bitrix Assistant: не удалось открыть индекс. ${errorMessage(err)}`,
				);
			}
			return undefined;
		}
	}

	/** Удаляет повреждённую базу (при наличии — подставляет `.bak`) и открывает заново. */
	private async resetIndex(key: string): Promise<Database | undefined> {
		try {
			const current = this.db;
			this.db = undefined;
			this.openKey = undefined;
			current?.close();
			await removeSqliteFiles(key);
			await removeSqliteFiles(`${key}.rebuild`);
			if (fs.existsSync(`${key}.bak`)) {
				await removeSidecars(`${key}.bak`);
				await fs.promises.rename(`${key}.bak`, key);
				log().info('Индекс восстановлен из резервной копии');
			}
			const db = await Database.open(key);
			this.db = db;
			this.openKey = key;
			this.openFailureReported = true;
			return db;
		} catch (err) {
			log().warn(`Пересоздание индекса не удалось: ${errorMessage(err)}`);
			return undefined;
		}
	}

	/** Восстанавливает индекс после прерванной атомарной замены. */
	private async recoverIndex(key: string): Promise<void> {
		if (!fs.existsSync(key) && fs.existsSync(`${key}.bak`)) {
			await fs.promises.rename(`${key}.bak`, key).catch(() => undefined);
			log().warn('Индекс восстановлен из резервной копии');
		} else if (fs.existsSync(key)) {
			await removeSqliteFiles(`${key}.bak`);
		}
		await removeSqliteFiles(`${key}.rebuild`);
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Кандидаты классов для completion в VS Code (без LSP). */
	async completionClasses(
		prefix: string,
		globalOnly: boolean,
		limit = 50,
	): Promise<ClassCompletionRow[]> {
		const db = await this.ensureOpen();
		if (!db) {
			return [];
		}
		const escaped = prefix.replace(/[\\%_]/g, '\\$&');
		const like = `${escaped}%`;
		const sql = globalOnly
			? 'SELECT fqcn, name, namespace, module, file, line, doc FROM classes '
				+ "WHERE name LIKE ? ESCAPE '\\' AND (namespace IS NULL OR namespace = '') "
				+ 'ORDER BY LENGTH(fqcn) ASC, fqcn ASC LIMIT ?'
			: 'SELECT fqcn, name, namespace, module, file, line, doc FROM classes '
				+ "WHERE (fqcn LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') "
				+ "ORDER BY (fqcn LIKE 'Bitrix%') DESC, LENGTH(fqcn) ASC, fqcn ASC LIMIT ?";
		const params = globalOnly ? [like, limit] : [like, like, limit];
		return db.all<ClassCompletionRow>(sql, ...params);
	}

	/** Классы с точным коротким именем — для Quick Fix авто-импорта. */
	async classesByShortName(name: string, limit = 10): Promise<ClassCompletionRow[]> {
		const db = await this.ensureOpen();
		if (!db) {
			return [];
		}
		return db.all<ClassCompletionRow>(
			'SELECT fqcn, name, namespace, file, line, doc FROM classes WHERE name = ? '
				+ "ORDER BY (fqcn LIKE 'Bitrix%') DESC, LENGTH(fqcn) ASC, fqcn ASC LIMIT ?",
			name,
			limit,
		);
	}

	/** Уплотняет SQLite-файл после больших перестроек. */
	async compact(): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.ensureOpen();
			if (!db) {
				return;
			}
			db.exec('VACUUM;');
		});
	}

	async stats(): Promise<IndexStats | undefined> {
		const db = await this.ensureOpen();
		if (!db) {
			return undefined;
		}
		const count = (table: string): number =>
			db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
		return {
			classes: count('classes'),
			methods: count('methods'),
			functions: count('php_functions'),
			phpConstants: count('php_constants'),
			components: count('components'),
			jsExtensions: count('js_extensions'),
			jsGlobals: count('js_globals'),
			dbFile: this.dbFile,
		};
	}

	/**
	 * Полная перестройка индекса в отдельной базе с атомарной заменой файла.
	 * Старый индекс остаётся рабочим до успешного завершения; при сбое
	 * восстанавливается резервная копия (см. recoverIndex).
	 */
	async rebuild(report: Report = () => undefined, token?: vscode.CancellationToken): Promise<void> {
		await this.enqueue(async () => {
			const target = this.dbFile;
			const temp = `${target}.rebuild`;
			const backup = `${target}.bak`;
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await removeSqliteFiles(temp);
			report('Построение нового индекса…');
			const fresh = await Database.open(temp);
			try {
				await this.runSync(fresh, report, token, true);
				fresh.exec('PRAGMA wal_checkpoint(TRUNCATE);');
			} finally {
				fresh.close();
			}
			const current = this.db;
			this.db = undefined;
			this.openKey = undefined;
			current?.close();
			try {
				await removeSqliteFiles(backup);
				if (fs.existsSync(target)) {
					await fs.promises.rename(target, backup);
				}
				// `-wal`/`-shm` остались от прежней базы: новый файл должен открыться чисто.
				await removeSidecars(target);
				await fs.promises.rename(temp, target);
				await removeSqliteFiles(backup);
			} catch (err) {
				// Откат: возвращаем прежний индекс на место.
				if (!fs.existsSync(target) && fs.existsSync(backup)) {
					await fs.promises.rename(backup, target).catch(() => undefined);
				}
				throw err;
			}
			await this.ensureOpen();
		});
	}

	/** Инкрементальная синхронизация: изменённые файлы переразбираются, удалённые вычищаются. */
	async sync(report: Report = () => undefined, token?: vscode.CancellationToken): Promise<void> {
		await this.enqueue(async () => {
			const db = await this.ensureOpen();
			if (!db) {
				return;
			}
			try {
				await this.runSync(db, report, token, false);
			} catch (err) {
				if (!isCorruption(err)) {
					throw err;
				}
				log().warn(`Индекс повреждён при обновлении (${errorMessage(err)}) — пересоздаю`);
				const fresh = await this.resetIndex(this.dbFile);
				if (!fresh) {
					throw err;
				}
				await this.runSync(fresh, report, token, false);
			}
		});
	}

	/** Удаляет файл из индекса (событие удаления с диска). */
	async removeFile(filePath: string): Promise<boolean> {
		return this.enqueue(async () => {
			const db = await this.ensureOpen();
			if (!db) {
				return false;
			}
			const layout = resolveLayout();
			if (!layout) {
				return false;
			}
			const file = path.normalize(filePath);
			if (!file.startsWith(layout.siteRoot)) {
				return false;
			}
			if (isExcluded(path.relative(layout.siteRoot, file), readSettings().indexExclude)) {
				return false;
			}
			try {
				const writer = new IndexWriter(db, (message) => log().debug(message));
				writer.deleteFile(file);
				writer.refreshDeprecated();
				db.run('DELETE FROM file_hashes WHERE path = ?', file);
				return true;
			} catch (err) {
				log().debug(`remove ${file}: ${errorMessage(err)}`);
				return false;
			}
		});
	}

	async reindexFile(uri: vscode.Uri): Promise<boolean> {
		return this.enqueue(async () => {
			const db = await this.ensureOpen();
			if (!db) {
				return false;
			}
			const layout = resolveLayout();
			if (!layout || uri.scheme !== 'file') {
				return false;
			}
			const file = path.normalize(uri.fsPath);
			if (!file.startsWith(layout.siteRoot)) {
				return false;
			}
			if (isExcluded(path.relative(layout.siteRoot, file), readSettings().indexExclude)) {
				return false;
			}
			try {
				const stat = await fs.promises.stat(file);
				if (!stat.isFile()) {
					return false;
				}
				const writer = new IndexWriter(db, (message) => log().debug(message));
				if (file.endsWith('config.php')) {
					writer.writeConfigFile(file);
				} else if (file.endsWith('.js') || file.endsWith('.d.ts')) {
					if (file.endsWith('.min.js')) {
						return false;
					}
					writer.writeJsFile(file, writer.loadExtensionFileMap().get(IndexWriter.jsFileKey(file)));
				} else if (file.endsWith('.php')) {
					writer.writePhpFile(file);
				} else {
					return false;
				}
				db.run(
					'INSERT OR REPLACE INTO file_hashes (path, hash, size, mtime) VALUES (?, ?, ?, ?)',
					file,
					'',
					Number(stat.size),
					Math.round(stat.mtimeMs),
				);
				return true;
			} catch (err) {
				log().debug(`reindex ${file}: ${errorMessage(err)}`);
				return false;
			}
		});
	}

	private async runSync(
		db: Database,
		report: Report,
		token: vscode.CancellationToken | undefined,
		force: boolean,
	): Promise<void> {
		const settings = readSettings();
		const layout = resolveLayout();
		if (!layout) {
			report('Каталог bitrix не найден — индексация пропущена.');
			return;
		}
		// Обновилось расширение и изменился разбор — старые строки в индексе
		// устарели: пересобираем целиком, иначе исправления не применятся.
		if (!force) {
			const stored = Number(
				db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'parser_version' LIMIT 1")[0]?.value ?? 0,
			);
			if (stored !== PARSER_VERSION) {
				log().info(`Версия индексатора изменилась (${stored} → ${PARSER_VERSION}) — полная переиндексация`);
				report('Версия индексатора изменилась — пересобираю индекс полностью.');
				force = true;
			}
		}
		const excludes = settings.indexExclude;
		const writer = new IndexWriter(db, (message) => log().debug(message));
		const seen = new Set<string>();
		const hashRows = force
			? new Map<string, { size: number; mtime: number }>()
			: new Map(
					db
						.all<{ path: string; size: number; mtime: number }>('SELECT path, size, mtime FROM file_hashes')
						.map((row) => [row.path, { size: row.size, mtime: row.mtime }]),
				);

		writer.indexModules(layout.bitrixDir, layout.localDir);
		if (settings.indexPhpStubs) {
			const stubsFile = path.join(this.context.extensionPath, 'server', 'data', 'php-stubs.json');
			// Стабы — это ~1,6 МБ JSON и тысяча INSERT-ов на каждый sync. Перебирать
			// их заново нужно только когда файл (или версия разбора) изменился.
			const signature = this.stubsSignature(stubsFile);
			const storedSignature = db.all<{ value: string }>(
				"SELECT value FROM meta WHERE key = 'php_stubs_signature' LIMIT 1",
			)[0]?.value;
			if (signature && (force || signature !== storedSignature)) {
				const count = writer.writePhpStubs(stubsFile);
				db.run(
					'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
					'php_stubs_signature',
					signature,
				);
				log().debug(`php-stubs: импортировано ${count} встроенных функций PHP`);
			}
		}

		// Корни обхода накладываются друг на друга (local/components ⊂ local и т.п.),
		// поэтому каждый каталог читаем ровно один раз — отдельно для PHP и JS.
		const phpVisited = new Set<string>();
		const phpFiles: string[] = [];
		await this.collectPhpFiles(layout, excludes, token, phpFiles, settings.indexVendor, phpVisited);
		const jsFiles: string[] = [];
		const configFiles: string[] = [];
		const jsVisited = new Set<string>();
		await this.collectJsFiles(layout, excludes, settings.jsMaxFileSizeKb, token, jsFiles, configFiles, jsVisited);

		report(`PHP: ${phpFiles.length}, JS: ${jsFiles.length}, config.php: ${configFiles.length}`);

		// Проверка «файл не менялся» — это stat на файл. Последовательно она стоила
		// больше, чем сам разбор (на больших каталогах — сотни миллисекунд), поэтому
		// проверяем пулом и дальше идём только по изменившимся.
		const changed = await this.changedFiles(hashRows, [...configFiles, ...jsFiles, ...phpFiles], force, token);

		// 1. Конфиги расширений (нужны раньше JS-файлов — для привязки глобалов).
		// Пишем пачками: на проекте это сотни файлов, и транзакция на каждый — дорого.
		let configBatch: string[] = [];
		const flushConfigs = (): void => {
			if (configBatch.length === 0) {
				return;
			}
			const batch = configBatch;
			configBatch = [];
			db.transaction(() => {
				for (const file of batch) {
					writer.writeConfigFile(file);
					this.touchHash(db, file);
				}
			});
		};
		let configsInBatch = 0;
		for (const file of configFiles) {
			this.throwIfCancelled(token);
			seen.add(file);
			if (!changed.has(file)) {
				continue;
			}
			configBatch.push(file);
			configsInBatch++;
			if (configsInBatch % 256 === 0) {
				flushConfigs();
				await yieldToLoop();
			}
		}
		flushConfigs();
		const jscore = path.join(layout.bitrixDir, 'modules', 'main', 'jscore.php');
		if (fs.existsSync(jscore)) {
			writer.writeJscore(jscore);
		}

		const extensionByFile = writer.loadExtensionFileMap();
		report(`Конфиги: ${configFiles.length}, расширений: ${extensionByFile.size ? new Set(extensionByFile.values()).size : 0}`);

		// 2. JS-файлы (глобалы, расширения, типы).
		const changedJs: string[] = [];
		for (const file of jsFiles) {
			this.throwIfCancelled(token);
			seen.add(file);
			if (changed.has(file)) {
				changedJs.push(file);
			}
		}
		await this.indexParsedFiles(
			'js',
			db,
			changedJs,
			report,
			'JS',
			(batch) => {
				for (const entry of batch) {
					const result = entry as JsParseResult;
					if (!result.globals || !result.shapes) {
						log().debug(`js ${result.file}: ${result.error ?? 'пустое сканирование'}`);
						continue;
					}
					writer.writeScannedJs({
						file: result.file,
						globals: result.globals,
						shapes: result.shapes,
						extensionName: extensionByFile.get(IndexWriter.jsFileKey(result.file)),
					});
					this.recordResultHash(db, result);
				}
			},
			(file) => {
				writer.writeJsFile(file, extensionByFile.get(IndexWriter.jsFileKey(file)));
				this.touchHash(db, file);
			},
			token,
		);

		// 3. PHP-файлы (классы, методы, компоненты).
		const changedPhp: string[] = [];
		for (const file of phpFiles) {
			this.throwIfCancelled(token);
			seen.add(file);
			if (changed.has(file)) {
				changedPhp.push(file);
			}
		}
		await this.indexParsedFiles(
			'php',
			db,
			changedPhp,
			report,
			'PHP',
			(batch) => {
				for (const entry of batch) {
					const result = entry as PhpParseResult;
					if (!result.content || !result.parsed) {
						log().debug(`php ${result.file}: ${result.error ?? 'пустой разбор'}`);
						continue;
					}
					writer.writeParsedPhpFile({
						file: result.file,
						content: result.content,
						parsed: result.parsed,
					});
					this.recordResultHash(db, result);
				}
			},
			(file) => {
				writer.writePhpFile(file);
				this.touchHash(db, file);
			},
			token,
		);

		// 4. Удалённые файлы.
		if (!token?.isCancellationRequested) {
			for (const existing of hashRows.keys()) {
				if (!seen.has(existing)) {
					writer.deleteFile(existing);
				}
			}
			writer.refreshDeprecated();
			db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'indexed_at', String(Date.now()));
			db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'parser_version', String(PARSER_VERSION));
		}
		report('Индекс готов.');
	}

	/**
	 * Разбор и запись файлов индекса. На большом проекте разбор уходит в пул
	 * воркеров (самая дорогая часть), запись в SQLite остаётся здесь — база нужна
	 * LSP-процессу и открытым запросам, второй писатель ей не нужен. Если воркеры
	 * недоступны или отключены настройкой, те же файлы доделываются в основном
	 * потоке: результат одинаковый.
	 */
	private async indexParsedFiles(
		kind: 'php' | 'js',
		db: Database,
		files: readonly string[],
		report: Report,
		label: string,
		writeBatch: (results: ParseResult[]) => void,
		writeSingle: (file: string) => void,
		token?: vscode.CancellationToken,
	): Promise<void> {
		const total = files.length;
		const threads = resolveThreads(readSettings().indexThreads);
		let processed = 0;
		const note = (): void => {
			processed++;
			if (processed % 500 === 0) {
				report(`${label}: ${processed}/${total}`);
			}
		};
		if (threads <= 1 || total < WORKER_MIN_FILES) {
			for (const file of files) {
				this.throwIfCancelled(token);
				writeSingle(file);
				note();
				if (processed % 100 === 0) {
					await yieldToLoop();
				}
			}
			return;
		}
		const pool = new ParsePool(threads);
		const written = new Set<string>();
		// Пачка файлов пишется одной транзакцией: транзакция на файл — это лишние
		// BEGIN/COMMIT и блокировка, на тысячах файлов такая мелочь стоит секунды.
		const pending: ParseResult[] = [];
		const flush = (): void => {
			if (pending.length === 0) {
				return;
			}
			const batch = pending.splice(0);
			db.transaction(() => writeBatch(batch));
		};
		try {
			const onBatch = (batch: ParseResult[]): void => {
				if (token?.isCancellationRequested) {
					return;
				}
				for (const result of batch) {
					written.add(result.file);
					pending.push(result);
					note();
				}
				flush();
			};
			if (kind === 'php') {
				await pool.parsePhpStream(files, onBatch, token);
			} else {
				await pool.parseJsStream(files, onBatch, token);
			}
			flush();
			return;
		} catch (err) {
			if (token?.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			log().warn(`${label}: разбор в воркерах не удался, доделываю в основном потоке: ${errorMessage(err)}`);
		} finally {
			await settlePool(pool);
		}
		for (const file of files) {
			if (written.has(file)) {
				continue;
			}
			this.throwIfCancelled(token);
			writeSingle(file);
			note();
			if (processed % 100 === 0) {
				await yieldToLoop();
			}
		}
	}

	/** Пишет хэш разобранного файла: посчитанный в воркере или заново здесь. */
	private recordResultHash(db: Database, parsed: ParsedFile): void {
		if (parsed.hash !== undefined && parsed.size !== undefined && parsed.mtime !== undefined) {
			this.recordHash(db, parsed.file, parsed.hash, parsed.size, parsed.mtime);
			return;
		}
		this.touchHash(db, parsed.file);
	}

	private throwIfCancelled(token?: vscode.CancellationToken): void {
		if (token?.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
	}

	/** Изменившиеся файлы из списка: stat-проверка пулом, без блокировки event loop. */
	private async changedFiles(
		rows: Map<string, { size: number; mtime: number }>,
		files: readonly string[],
		force: boolean,
		token?: vscode.CancellationToken,
	): Promise<Set<string>> {
		if (force) {
			return new Set(files);
		}
		const changed = new Set<string>();
		await mapPool(files, 16, async (file) => {
			if (token?.isCancellationRequested) {
				return;
			}
			if (!(await this.isUnchanged(rows, file))) {
				changed.add(file);
			}
		});
		return changed;
	}

	/** Подпись файла стабов: меняешь стабы или разбор — меняется подпись. */
	private stubsSignature(stubsFile: string): string | undefined {
		try {
			const stat = fs.statSync(stubsFile);
			return `${PARSER_VERSION}:${stat.size}:${Math.round(stat.mtimeMs)}`;
		} catch {
			return undefined;
		}
	}

	private async isUnchanged(
		rows: Map<string, { size: number; mtime: number }>,
		file: string,
	): Promise<boolean> {
		const known = rows.get(file);
		if (!known) {
			return false;
		}
		try {
			const stat = await fs.promises.stat(file);
			return known.size === stat.size && known.mtime === Math.round(stat.mtimeMs);
		} catch {
			return false;
		}
	}

	private recordHash(db: Database, file: string, hash: string, size: number, mtime: number): void {
		try {
			db.run(
				'INSERT OR REPLACE INTO file_hashes (path, hash, size, mtime) VALUES (?, ?, ?, ?)',
				file,
				hash,
				size,
				mtime,
			);
		} catch (err) {
			log().debug(`hash ${file}: ${errorMessage(err)}`);
		}
	}

	private touchHash(db: Database, file: string): void {
		try {
			const stat = fs.statSync(file);
			const content = fs.readFileSync(file);
			const hash = crypto.createHash('sha1').update(content).digest('hex');
			db.run(
				'INSERT OR REPLACE INTO file_hashes (path, hash, size, mtime) VALUES (?, ?, ?, ?)',
				file,
				hash,
				Number(stat.size),
				Math.round(stat.mtimeMs),
			);
		} catch (err) {
			log().debug(`hash ${file}: ${errorMessage(err)}`);
		}
	}

	private async collectPhpFiles(
		layout: BitrixLayout,
		excludes: string[],
		token: vscode.CancellationToken | undefined,
		out: string[],
		includeVendor = false,
		visited?: Set<string>,
	): Promise<void> {
		const roots: string[] = [];
		for (const dir of listDirectories(path.join(layout.bitrixDir, 'modules'))) {
			roots.push(path.join(dir, 'lib'));
			// Глобальные функции/константы легаси-ядра (GetMessage, IncludeTemplate).
			roots.push(path.join(dir, 'tools.php'), path.join(dir, 'include.php'), path.join(dir, 'prolog.php'), path.join(dir, 'start.php'));
			// Легаси-ядро: CFile, CMain, CUser и другие классы из classes/general,
			// classes/mysql, classes/pgsql.
			roots.push(path.join(dir, 'classes'));
			// ORM-аннотации ядра: `EO_*_Query`, `EO_*_Collection` и прочие классы
			// сущностей объявлены здесь, а не в lib. Без них `Table::query()`
			// не продолжается дальше первого шага: тип возврата не находится.
			roots.push(path.join(dir, 'meta'));
			roots.push(path.join(dir, 'install', 'components'));
			roots.push(path.join(dir, 'install', 'classes'));
			// Админские страницы: там объявлены глобальные хелперы вида
			// __AdmSettingsDrawList(), без них они считались неизвестными.
			roots.push(path.join(dir, 'admin'));
		}
		for (const dir of listDirectories(path.join(layout.localDir, 'modules'))) {
			roots.push(path.join(dir, 'lib'));
			roots.push(path.join(dir, 'classes'));
			roots.push(path.join(dir, 'meta'));
			roots.push(path.join(dir, 'tools.php'), path.join(dir, 'include.php'));
		}
		// PHP-файлы прямо в каталоге модуля: functions.php, options.php, default_option.php
		// и подобные — там объявлены глобальные функции (например CrmCheckPath).
		for (const moduleRoot of [
			...listDirectories(path.join(layout.bitrixDir, 'modules')),
			...listDirectories(path.join(layout.localDir, 'modules')),
		]) {
			for (const file of listFiles(moduleRoot)) {
				if (!file.endsWith('.php') || isExcluded(path.relative(layout.siteRoot, file), excludes)) {
					continue;
				}
				out.push(file);
			}
		}
		if (includeVendor) {
			roots.push(path.join(layout.siteRoot, 'vendor'), path.join(layout.localDir, 'vendor'));
			// vendor бывает вложенным: local/modules/<module>/vendor,
			// local/php/src/<lib>/vendor и т.п. Без них хелперы пакетов
			// (например `d()` из Laravel) считаются неизвестными функциями.
			for (const moduleRoot of [
				...listDirectories(path.join(layout.bitrixDir, 'modules')),
				...listDirectories(path.join(layout.localDir, 'modules')),
			]) {
				for (const candidate of [path.join(moduleRoot, 'vendor'), path.join(moduleRoot, 'lib', 'vendor')]) {
					if (isDirectory(candidate)) {
						roots.push(candidate);
					}
				}
			}
		}
		roots.push(
			// Ядро бизнес-процессов: классы активностей (CBPCrmCreateDynamicActivity
			// и подобные) объявлены здесь, а не в modules.
			path.join(layout.bitrixDir, 'activities'),
			path.join(layout.bitrixDir, 'components'),
			path.join(layout.localDir, 'components'),
			path.join(layout.bitrixDir, 'php_interface'),
			path.join(layout.localDir, 'php_interface'),
			// Весь local: в проектах встречаются свои каталоги (local/testing,
			// local/lib, local/api и т.п.) — их классы тоже должны попадать в индекс.
			layout.localDir,
		);
		await this.walkRoots(
			roots,
			layout,
			excludes,
			token,
			out,
			(file) => file.endsWith('.php'),
			undefined,
			includeVendor,
			visited,
		);
		out.sort();
		// Дедупликация: layout.localDir пересекается с уже добавленными каталогами.
		const unique: string[] = [];
		for (const file of out) {
			if (unique[unique.length - 1] !== file) {
				unique.push(file);
			}
		}
		out.length = 0;
		out.push(...unique);
	}

	private async collectJsFiles(
		layout: BitrixLayout,
		excludes: string[],
		maxSizeKb: number,
		token: vscode.CancellationToken | undefined,
		jsOut: string[],
		configOut: string[],
		visited?: Set<string>,
	): Promise<void> {
		const roots: string[] = [path.join(layout.bitrixDir, 'js'), path.join(layout.localDir, 'js')];
		for (const dir of listDirectories(path.join(layout.bitrixDir, 'modules'))) {
			roots.push(path.join(dir, 'install', 'js'));
		}
		const maxBytes = Math.max(1, maxSizeKb) * 1024;
		await this.walkRoots(
			roots,
			layout,
			excludes,
			token,
			jsOut,
			(file) => (file.endsWith('.js') || file.endsWith('.d.ts')) && !file.endsWith('.min.js') && this.sizeOf(file) <= maxBytes,
			configOut,
			false,
			visited,
		);
		jsOut.sort();
		configOut.sort();
	}

	private sizeOf(file: string): number {
		try {
			return fs.statSync(file).size;
		} catch {
			return Number.MAX_SAFE_INTEGER;
		}
	}

	/**
	 * Обход дерева в ширину: каталоги одного уровня читаются параллельно
	 * (WALK_CONCURRENCY). Последовательный `await readdir` на каждый каталог
	 * упирался в round-trip к пулу потоков — на 3 800 каталогах это ~100 мс
	 * простоя главного потока при каждом старте.
	 */
	private async walkRoots(
		roots: readonly string[],
		layout: BitrixLayout,
		excludes: string[],
		token: vscode.CancellationToken | undefined,
		out: string[],
		accept: (file: string) => boolean,
		configOut?: string[],
		allowVendor = false,
		visited?: Set<string>,
	): Promise<void> {
		let level: string[] = [];
		for (const root of roots) {
			if (isDirectory(root)) {
				if (visited) {
					if (visited.has(root)) {
						continue;
					}
					visited.add(root);
				}
				level.push(root);
				continue;
			}
			// Корень может быть отдельным файлом (tools.php, include.php модуля).
			if (isFile(root) && accept(root)) {
				out.push(root);
			}
		}
		while (level.length > 0) {
			const nextLevel: string[] = [];
			await mapPool(level, WALK_CONCURRENCY, async (dir) => {
				let entries: fs.Dirent[];
				try {
					entries = await fs.promises.readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					this.throwIfCancelled(token);
					const full = path.join(dir, entry.name);
					const rel = toPosix(path.relative(layout.siteRoot, full));
					if (isExcluded(rel, excludes)) {
						continue;
					}
					if (entry.isDirectory()) {
						if (SKIP_DIRS.has(entry.name) && !(allowVendor && entry.name === 'vendor')) {
							continue;
						}
						if (visited) {
							if (visited.has(full)) {
								continue;
							}
							visited.add(full);
						}
						nextLevel.push(full);
						continue;
					}
					if (!entry.isFile()) {
						continue;
					}
					if (configOut && entry.name === 'config.php') {
						configOut.push(full);
						continue;
					}
					if (accept(full)) {
						out.push(full);
					}
				}
			});
			level = nextLevel;
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.db?.close();
		this.db = undefined;
	}
}
