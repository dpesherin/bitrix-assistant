import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import {
	DiagnosticsScopeStore,
	diagnosticsScopeKey,
	diagnosticsScopeLabel,
	normalizeDiagnosticsScope,
} from '../src/lsp/diagnosticsScope';

/** Мок workspaceState: достаточно get/update, чтобы проверить сохранение режима. */
class MemoryState {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined;
	get<T>(key: string, fallback: T): T;
	get<T>(key: string, fallback?: T): T | undefined {
		return this.values.has(key) ? (this.values.get(key) as T) : fallback;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

function state(): vscode.Memento {
	return new MemoryState() as unknown as vscode.Memento;
}

function folder(fsPath: string): vscode.WorkspaceFolder {
	return { uri: { fsPath } } as vscode.WorkspaceFolder;
}

test('Режим проверки: неизвестное значение — индекс проекта', () => {
	assert.equal(normalizeDiagnosticsScope('local'), 'local');
	assert.equal(normalizeDiagnosticsScope('index'), 'index');
	assert.equal(normalizeDiagnosticsScope(undefined), 'index');
	assert.equal(normalizeDiagnosticsScope('all'), 'index');
	assert.equal(diagnosticsScopeLabel('local'), 'весь local');
	assert.equal(diagnosticsScopeLabel('index'), 'индекс проекта');
});

test('Режим проверки: по умолчанию индекс, выбранный local переживает перезапуск', async () => {
	const memory = state();
	const store = new DiagnosticsScopeStore(memory);
	const project = folder('/sites/shop');

	assert.equal(store.scope(project), 'index', 'без записи работает режим по умолчанию');

	await store.setScope(project, 'local');
	assert.equal(store.scope(project), 'local');
	assert.equal(
		new DiagnosticsScopeStore(memory).scope(project),
		'local',
		'новый store читает то же состояние — режим сохраняется между сессиями',
	);
});

test('Режим проверки: у каждого проекта своя запись', async () => {
	const memory = state();
	const store = new DiagnosticsScopeStore(memory);
	const first = folder('/sites/one');
	const second = folder('/sites/two');

	await store.setScope(first, 'local');
	await store.setScope(second, 'index');

	assert.equal(store.scope(first), 'local');
	assert.equal(store.scope(second), 'index');
	assert.notEqual(diagnosticsScopeKey(first.uri.fsPath), diagnosticsScopeKey(second.uri.fsPath));
});

test('Режим проверки: испорченная запись не ломает чтение', async () => {
	const memory = state();
	await memory.update('bitrix.diagnostics.scope', { '/sites/shop': 'everything', '/sites/ok': 'local' });
	const store = new DiagnosticsScopeStore(memory);

	assert.equal(store.scope(folder('/sites/shop')), 'index');
	assert.equal(store.scope(folder('/sites/ok')), 'local');
});
