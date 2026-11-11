/* Минимальный mock API VS Code для unit-тестов SSH/Sync (node --test). */
import * as path from 'node:path';

export interface MockFolder {
	uri: { fsPath: string; scheme: string; toString(): string };
	name: string;
	index: number;
}

export const mockState = {
	folders: [] as MockFolder[],
	settings: {} as Record<string, unknown>,
	prompts: [] as string[],
	promptResult: undefined as string | undefined,
};

class MockEventEmitter<T> {
	private listeners: Array<(value: T) => void> = [];
	readonly event = (listener: (value: T) => void): { dispose(): void } => {
		this.listeners.push(listener);
		return { dispose: () => undefined };
	};
	fire(value: T): void {
		for (const listener of this.listeners) {
			listener(value);
		}
	}
	dispose(): void {
		this.listeners = [];
	}
}

function deepGet(source: unknown, key: string): unknown {
	let current: unknown = source;
	for (const part of key.split('.')) {
		if (current === null || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

export function mockFolder(fsPath: string): MockFolder {
	return {
		uri: { fsPath, scheme: 'file', toString: () => `file://${fsPath}` },
		name: path.basename(fsPath),
		index: mockState.folders.length,
	};
}

const mock = {
	workspace: {
		get workspaceFolders(): MockFolder[] | undefined {
			return mockState.folders.length > 0 ? mockState.folders : undefined;
		},
		getWorkspaceFolder(uri: { fsPath: string }): MockFolder | undefined {
			return mockState.folders.find(
				(folder) => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}${path.sep}`),
			);
		},
		getConfiguration(): { get<T>(key: string, fallback?: T): T | undefined } {
			return {
				get<T>(key: string, fallback?: T): T | undefined {
					const value = deepGet(mockState.settings, key);
					return (value === undefined ? fallback : value) as T | undefined;
				},
			};
		},
		onDidChangeConfiguration: () => ({ dispose: () => undefined }),
	},
	window: {
		async showWarningMessage(message: string): Promise<string | undefined> {
			mockState.prompts.push(message);
			return mockState.promptResult;
		},
		createOutputChannel() {
			return {
				name: 'test',
				append: () => undefined,
				appendLine: () => undefined,
				replace: () => undefined,
				clear: () => undefined,
				show: () => undefined,
				hide: () => undefined,
				dispose: () => undefined,
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				debug: () => undefined,
				trace: () => undefined,
			};
		},
	},
	Uri: {
		file(fsPath: string) {
			return { fsPath, scheme: 'file', toString: () => `file://${fsPath}` };
		},
	},
	EventEmitter: MockEventEmitter,
	CancellationError: class MockCancellationError extends Error {},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};

type LoadFn = (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
// require('module') — реальный объект Module; import * as даёт копию без сеттеров.
const nodeModule = require('module') as { _load: LoadFn };
const originalLoad = nodeModule._load;
nodeModule._load = function patchedLoad(request, parent, isMain): unknown {
	if (request === 'vscode') {
		return mock;
	}
	return originalLoad.call(this, request, parent, isMain);
};
