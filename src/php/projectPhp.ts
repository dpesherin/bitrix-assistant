import * as vscode from 'vscode';
import { normalizePhpEntry, projectStorageKey, type PhpEntry } from './interpreter';

/**
 * Версия PHP и пути к интерпретаторам по проектам — в состоянии расширения
 * (`workspaceState`), а не в файлах проекта.
 *
 * Ключ — папка workspace (в мульти-руте у каждого проекта своя запись).
 * Значения из `bitrix.php.version` / `bitrix.php.paths` читаются как fallback,
 * пока в состоянии ничего нет: так настройки, сделанные до перехода на store,
 * продолжают работать.
 */

const STORE_KEY = 'bitrix.php.projects';

export type ProjectPhpEntry = PhpEntry;

type ProjectPhpState = Record<string, PhpEntry>;

/** Нормализованный ключ проекта: путь папки workspace. */
export function projectKey(folder: vscode.WorkspaceFolder | undefined): string {
	return projectStorageKey(folder?.uri.fsPath);
}

/** Значения из настроек, если в состоянии проекта записи ещё нет. */
export function fallbackEntry(version: unknown, paths: unknown): PhpEntry {
	return normalizePhpEntry(version, paths);
}

export class ProjectPhpStore implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();

	/** Срабатывает после изменения версии или пути для проекта. */
	readonly onDidChange = this.changed.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	dispose(): void {
		this.changed.dispose();
	}

	/** Папка проекта для uri (или первая папка workspace). */
	folderFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
		if (uri) {
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			if (folder) {
				return folder;
			}
		}
		return vscode.workspace.workspaceFolders?.[0];
	}

	/** Имя проекта для сообщений. */
	projectName(uri?: vscode.Uri): string {
		return this.folderFor(uri)?.name ?? 'настройки пользователя';
	}

	version(uri?: vscode.Uri): string {
		const entry = this.stored(this.keyFor(uri));
		if (entry) {
			return entry.version;
		}
		return this.fallback(uri).version;
	}

	paths(uri?: vscode.Uri): Record<string, string> {
		const entry = this.stored(this.keyFor(uri));
		if (entry) {
			return { ...entry.paths };
		}
		return this.fallback(uri).paths;
	}

	async setVersion(uri: vscode.Uri | undefined, version: string): Promise<void> {
		await this.update(uri, (entry) => {
			entry.version = version;
		});
	}

	/** Путь к PHP для версии; `undefined` — удалить путь для этой версии. */
	async setPath(
		uri: vscode.Uri | undefined,
		version: string,
		command: string | undefined,
	): Promise<void> {
		await this.update(uri, (entry) => {
			if (command === undefined || command.trim() === '') {
				delete entry.paths[version];
			} else {
				entry.paths[version] = command.trim();
			}
		});
	}

	private async update(
		uri: vscode.Uri | undefined,
		mutate: (entry: ProjectPhpEntry) => void,
	): Promise<void> {
		const key = this.keyFor(uri);
		const state = this.state();
		const entry = state[key] ?? this.fallback(uri);
		mutate(entry);
		state[key] = entry;
		await this.context.workspaceState.update(STORE_KEY, state);
		this.changed.fire(uri);
	}

	private keyFor(uri?: vscode.Uri): string {
		return projectKey(this.folderFor(uri));
	}

	private state(): ProjectPhpState {
		const raw = this.context.workspaceState.get<Record<string, unknown>>(STORE_KEY) ?? {};
		const result: ProjectPhpState = {};
		for (const [key, value] of Object.entries(raw)) {
			if (!value || typeof value !== 'object') {
				continue;
			}
			const candidate = value as { version?: unknown; paths?: unknown };
			if (typeof candidate.version !== 'string') {
				continue;
			}
			result[key] = fallbackEntry(candidate.version, candidate.paths);
		}
		return result;
	}

	private stored(key: string): ProjectPhpEntry | undefined {
		return this.state()[key];
	}

	private fallback(uri?: vscode.Uri): ProjectPhpEntry {
		const folder = this.folderFor(uri);
		const cfg = vscode.workspace.getConfiguration('bitrix.php', folder?.uri);
		return fallbackEntry(cfg.get('version', 'auto'), cfg.get('paths', {}));
	}
}
