import type * as vscode from 'vscode';
import { projectStorageKey } from '../php/interpreter';

/**
 * Где искать проблемы при проверке всего проекта.
 *
 * `index` — файлы из индекса (сначала код проекта, затем ядро), действует лимит
 * `bitrix.diagnostics.projectLimit`. `local` — обход папки `local` на диске:
 * проверяются все PHP и JS-файлы, включая те, что индексатор намеренно пропускает
 * (шаблоны, скрипты вне `isIndexableSource`), без лимита.
 *
 * Режим хранится в `workspaceState` по папке проекта — как версия PHP: выбранный
 * один раз «весь local» остаётся включённым при следующем открытии этого проекта.
 */

export const DIAGNOSTICS_SCOPES = ['index', 'local'] as const;

export type DiagnosticsScope = (typeof DIAGNOSTICS_SCOPES)[number];

export const DEFAULT_DIAGNOSTICS_SCOPE: DiagnosticsScope = 'index';

const STORE_KEY = 'bitrix.diagnostics.scope';

export interface DiagnosticsScopeChoice {
	scope: DiagnosticsScope;
	label: string;
	detail: string;
}

/** Пункты выбора режима: один список и для QuickPick, и для подписи в сообщениях. */
export const DIAGNOSTICS_SCOPE_CHOICES: readonly DiagnosticsScopeChoice[] = [
	{
		scope: 'index',
		label: '$(database) Индекс проекта',
		detail: 'Файлы из индекса: сначала код проекта, затем ядро. Действует лимит файлов.',
	},
	{
		scope: 'local',
		label: '$(folder) Весь local',
		detail: 'Все PHP и JS-файлы в папке local, включая не попавшие в индекс. Без лимита.',
	},
];

/** Неизвестное значение (старая запись, правка вручную) трактуем как режим по умолчанию. */
export function normalizeDiagnosticsScope(value: unknown): DiagnosticsScope {
	return value === 'local' ? 'local' : DEFAULT_DIAGNOSTICS_SCOPE;
}

/** Короткая подпись режима для сообщений и лога. */
export function diagnosticsScopeLabel(scope: DiagnosticsScope): string {
	return scope === 'local' ? 'весь local' : 'индекс проекта';
}

/** Ключ записи: папка workspace (в мульти-руте у каждого проекта свой режим). */
export function diagnosticsScopeKey(fsPath: string | undefined): string {
	return projectStorageKey(fsPath);
}

/** Минимум `Memento`, которого достаточно store: так его можно проверить тестом. */
type ScopeState = Pick<vscode.Memento, 'get' | 'update'>;

export class DiagnosticsScopeStore {
	constructor(private readonly state: ScopeState) {}

	/** Режим для проекта; без записи — значение по умолчанию. */
	scope(folder?: vscode.WorkspaceFolder): DiagnosticsScope {
		return normalizeDiagnosticsScope(this.map()[diagnosticsScopeKey(folder?.uri.fsPath)]);
	}

	async setScope(
		folder: vscode.WorkspaceFolder | undefined,
		scope: DiagnosticsScope,
	): Promise<void> {
		const map = this.map();
		map[diagnosticsScopeKey(folder?.uri.fsPath)] = normalizeDiagnosticsScope(scope);
		await this.state.update(STORE_KEY, map);
	}

	/** Состояние читаем на каждом обращении: `workspaceState` может меняться извне. */
	private map(): Record<string, DiagnosticsScope> {
		const raw = this.state.get<Record<string, unknown>>(STORE_KEY) ?? {};
		const result: Record<string, DiagnosticsScope> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (value === 'index' || value === 'local') {
				result[key] = value;
			}
		}
		return result;
	}
}
