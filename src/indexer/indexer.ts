import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log, errorMessage } from '../log';
import { readSettings } from '../settings';
import { isExcluded, toPosix } from '../util/glob';
import { Database } from './db';
import { IndexWriter } from './indexWriter';

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
			if (fs.existsSync(stubsFile)) {
				const count = writer.writePhpStubs(stubsFile);
				log().debug(`php-stubs: импортировано ${count} встроенных функций PHP`);
			}
		}

		const phpFiles: string[] = [];
		await this.collectPhpFiles(layout, excludes, token, phpFiles, settings.indexVendor);
		const jsFiles: string[] = [];
		const configFiles: string[] = [];
		await this.collectJsFiles(layout, excludes, settings.jsMaxFileSizeKb, token, jsFiles, configFiles);

		report(`PHP: ${phpFiles.length}, JS: ${jsFiles.length}, config.php: ${configFiles.length}`);

		// 1. Конфиги расширений (нужны раньше JS-файлов — для привязки глобалов).
		for (const file of configFiles) {
			this.throwIfCancelled(token);
			seen.add(file);
			if (!force && (await this.isUnchanged(hashRows, file))) {
				continue;
			}
			writer.writeConfigFile(file);
			this.touchHash(db, file);
		}
		const jscore = path.join(layout.bitrixDir, 'modules', 'main', 'jscore.php');
		if (fs.existsSync(jscore)) {
			writer.writeJscore(jscore);
		}

		const extensionByFile = writer.loadExtensionFileMap();
		report(`Конфиги: ${configFiles.length}, расширений: ${extensionByFile.size ? new Set(extensionByFile.values()).size : 0}`);

		// 2. JS-файлы.
		let processed = 0;
		for (const file of jsFiles) {
			this.throwIfCancelled(token);
			seen.add(file);
			processed++;
			if (processed % 500 === 0) {
				report(`JS: ${processed}/${jsFiles.length}`);
			}
			if (!force && (await this.isUnchanged(hashRows, file))) {
				continue;
			}
			writer.writeJsFile(file, extensionByFile.get(IndexWriter.jsFileKey(file)));
			this.touchHash(db, file);
		}

		// 3. PHP-файлы (классы, методы, компоненты).
		processed = 0;
		for (const file of phpFiles) {
			this.throwIfCancelled(token);
			seen.add(file);
			processed++;
			if (processed % 500 === 0) {
				report(`PHP: ${processed}/${phpFiles.length}`);
			}
			if (!force && (await this.isUnchanged(hashRows, file))) {
				continue;
			}
			writer.writePhpFile(file);
			this.touchHash(db, file);
		}

		// 4. Удалённые файлы.
		if (!token?.isCancellationRequested) {
			for (const existing of hashRows.keys()) {
				if (!seen.has(existing)) {
					writer.deleteFile(existing);
				}
			}
			writer.refreshDeprecated();
			db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'indexed_at', String(Date.now()));
		}
		report('Индекс готов.');
	}

	private throwIfCancelled(token?: vscode.CancellationToken): void {
		if (token?.isCancellationRequested) {
			throw new vscode.CancellationError();
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
	): Promise<void> {
		const roots: string[] = [];
		for (const dir of listDirectories(path.join(layout.bitrixDir, 'modules'))) {
			roots.push(path.join(dir, 'lib'));
			// Глобальные функции/константы легаси-ядра (GetMessage, IncludeTemplate).
			roots.push(path.join(dir, 'tools.php'), path.join(dir, 'include.php'), path.join(dir, 'prolog.php'), path.join(dir, 'start.php'));
			// Легаси-ядро: CFile, CMain, CUser и другие классы из classes/general,
			// classes/mysql, classes/pgsql.
			roots.push(path.join(dir, 'classes'));
			roots.push(path.join(dir, 'install', 'components'));
			roots.push(path.join(dir, 'install', 'classes'));
			// Админские страницы: там объявлены глобальные хелперы вида
			// __AdmSettingsDrawList(), без них они считались неизвестными.
			roots.push(path.join(dir, 'admin'));
		}
		for (const dir of listDirectories(path.join(layout.localDir, 'modules'))) {
			roots.push(path.join(dir, 'lib'));
			roots.push(path.join(dir, 'classes'));
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
		for (const root of roots) {
			if (isDirectory(root)) {
				await this.walk(
					root,
					layout,
					excludes,
					token,
					out,
					(file) => file.endsWith('.php'),
					undefined,
					includeVendor,
				);
			} else if (root.endsWith('.php') && isFile(root)) {
				out.push(root);
			}
		}
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
	): Promise<void> {
		const roots: string[] = [path.join(layout.bitrixDir, 'js'), path.join(layout.localDir, 'js')];
		for (const dir of listDirectories(path.join(layout.bitrixDir, 'modules'))) {
			roots.push(path.join(dir, 'install', 'js'));
		}
		const maxBytes = Math.max(1, maxSizeKb) * 1024;
		for (const root of roots) {
			if (!isDirectory(root)) {
				continue;
			}
			await this.walk(
				root,
				layout,
				excludes,
				token,
				jsOut,
				(file) => (file.endsWith('.js') || file.endsWith('.d.ts')) && !file.endsWith('.min.js') && this.sizeOf(file) <= maxBytes,
				configOut,
			);
		}
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

	private async walk(
		root: string,
		layout: BitrixLayout,
		excludes: string[],
		token: vscode.CancellationToken | undefined,
		out: string[],
		accept: (file: string) => boolean,
		configOut?: string[],
		allowVendor = false,
	): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(root, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			this.throwIfCancelled(token);
			const full = path.join(root, entry.name);
			const rel = toPosix(path.relative(layout.siteRoot, full));
			if (isExcluded(rel, excludes)) {
				continue;
			}
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) && !(allowVendor && entry.name === 'vendor')) {
					continue;
				}
				await this.walk(full, layout, excludes, token, out, accept, configOut);
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
