import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import {
	DiagnosticsScopeStore,
	diagnosticsFoldersLabel,
	diagnosticsScopeKey,
	diagnosticsScopeLabel,
	normalizeDiagnosticsScope,
	normalizeLocalFolder,
	normalizeLocalFolders,
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

test('Папки local: нормализация путей и отсечение выхода из local', () => {
	assert.equal(normalizeLocalFolder('templates'), 'templates');
	assert.equal(normalizeLocalFolder(' .\\modules\\vendor.module\\ '), 'modules/vendor.module');
	assert.equal(normalizeLocalFolder('./components/'), 'components');
	assert.equal(normalizeLocalFolder('../bitrix'), undefined);
	assert.equal(normalizeLocalFolder('modules/../bitrix'), undefined);
	assert.equal(normalizeLocalFolder('/components'), undefined);
	assert.equal(normalizeLocalFolder('/etc'), undefined);
	assert.equal(normalizeLocalFolder('C:\\Windows'), undefined);
	assert.equal(normalizeLocalFolder(''), undefined);
	assert.equal(normalizeLocalFolder(42), undefined);

	assert.deepEqual(normalizeLocalFolders(['templates', 'js', 'templates', '../x']), ['js', 'templates']);
	assert.deepEqual(normalizeLocalFolders('templates'), []);
	assert.equal(diagnosticsFoldersLabel([]), 'весь local');
	assert.equal(diagnosticsFoldersLabel(['js', 'templates']), 'js, templates');
});

test('Папки local: сохраняются за проектом и переживают перезапуск', async () => {
	const memory = state();
	const store = new DiagnosticsScopeStore(memory);
	const project = folder('/sites/shop');
	const other = folder('/sites/blog');

	assert.deepEqual(store.localFolders(project), [], 'без записи проверяется весь local');

	await store.setLocalFolders(project, ['templates', 'components']);
	await store.setLocalFolders(other, ['js']);

	assert.deepEqual(store.localFolders(project), ['components', 'templates']);
	assert.deepEqual(store.localFolders(other), ['js']);
	assert.deepEqual(
		new DiagnosticsScopeStore(memory).localFolders(project),
		['components', 'templates'],
		'новый store читает то же состояние — выбор сохраняется между сессиями',
	);
});

test('Папки local: испорченная запись не ломает чтение', async () => {
	const memory = state();
	await memory.update('bitrix.diagnostics.localFolders', {
		'/sites/shop': 'templates',
		'/sites/ok': ['components', 7],
	});
	const store = new DiagnosticsScopeStore(memory);

	assert.deepEqual(store.localFolders(folder('/sites/shop')), []);
	assert.deepEqual(store.localFolders(folder('/sites/ok')), ['components']);
});
