import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { DROP_SQL, SCHEMA_SQL, SCHEMA_VERSION } from './schema';

export type SqlValue = null | number | bigint | string | Uint8Array;

type SqliteModule = typeof import('node:sqlite');

/**
 * Тонкая обёртка над встроенным `node:sqlite` (Node >= 22.5, VS Code 1.10x+).
 * Нативных зависимостей нет — важно для кроссплатформенной упаковки.
 */
export class Database {
	private readonly statements = new Map<string, StatementSync>();

	private constructor(
		readonly file: string,
		private readonly db: DatabaseSync,
	) {}

	static async open(file: string): Promise<Database> {
		let sqlite: SqliteModule;
		try {
			// require, а не import: при старом Node ошибка должна быть перехватываемой.
			sqlite = require('node:sqlite') as SqliteModule;
		} catch {
			throw new Error(
				'Встроенный модуль node:sqlite недоступен в этом Extension Host. ' +
					'Нужен VS Code с Node >= 22.5 (проверено на 1.144). Обновите VS Code.',
			);
		}
		const instance = new sqlite.DatabaseSync(file);
		const db = new Database(file, instance);
		db.exec('PRAGMA journal_mode = WAL;');
		db.exec('PRAGMA synchronous = NORMAL;');
		db.exec('PRAGMA busy_timeout = 5000;');
		const versionRow = instance.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
		const version = Number(versionRow?.user_version ?? 0);
		const hasTables =
			Number(
				(
					instance
						.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'classes'")
						.get() as { n?: number } | undefined
				)?.n ?? 0,
			) > 0;
		if (version < SCHEMA_VERSION && (version > 0 || hasTables)) {
			db.exec(DROP_SQL);
		}
		db.exec(SCHEMA_SQL);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
		return db;
	}

	private statement(sql: string): StatementSync {
		let stmt = this.statements.get(sql);
		if (!stmt) {
			stmt = this.db.prepare(sql);
			this.statements.set(sql, stmt);
		}
		return stmt;
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	run(sql: string, ...params: SqlValue[]): void {
		this.statement(sql).run(...params);
	}

	all<T>(sql: string, ...params: SqlValue[]): T[] {
		return this.statement(sql).all(...params) as T[];
	}

	get<T>(sql: string, ...params: SqlValue[]): T | undefined {
		return this.statement(sql).get(...params) as T | undefined;
	}

	transaction<T>(fn: () => T): T {
		this.exec('BEGIN IMMEDIATE;');
		try {
			const result = fn();
			this.exec('COMMIT;');
			return result;
		} catch (err) {
			this.exec('ROLLBACK;');
			throw err;
		}
	}

	close(): void {
		this.statements.clear();
		this.db.close();
	}
}
