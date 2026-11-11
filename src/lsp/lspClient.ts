import * as vscode from 'vscode';
import {
	CloseAction,
	ErrorAction,
	ErrorHandler,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	State,
	TransportKind,
} from 'vscode-languageclient/node';
import { log, errorMessage } from '../log';
import { BitrixIndexer, resolveLayout } from '../indexer/indexer';
import { readSettings } from '../settings';
import type { ProjectPhpStore } from '../php/projectPhp';
import { resolveLspLaunch } from './platform';

/**
 * Канал LSP с фильтром ожидаемого шума: LanguageClient всегда пишет
 * `[Error] Server process exited with code 0.` при штатном перезапуске.
 */
const EXPECTED_EXIT = /^\[Error\s+-[^\]]*\]\s+Server process exited with code 0\.$/;

function quietOutput(inner: vscode.OutputChannel): vscode.OutputChannel {
	const keep = (value: string): boolean => !EXPECTED_EXIT.test(value.trim());
	return new Proxy(inner, {
		get(target, property) {
			if (property === 'append') {
				return (value: string): void => {
					if (keep(value)) {
						target.append(value);
					}
				};
			}
			if (property === 'appendLine') {
				return (value: string): void => {
					if (keep(value)) {
						target.appendLine(value);
					}
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as vscode.OutputChannel;
}



/**
 * Клиент LSP-сервера на PHP. Сервер выбирается по платформе и запускается
 * как дочерний процесс (stdio), база индекса передаётся через окружение.
 */
export class BitrixLanguageClient implements vscode.Disposable {
	private client?: LanguageClient;
	private output?: vscode.OutputChannel;
	private disposed = false;
	private restartTimer?: NodeJS.Timeout;
	private restartAttempts = 0;
	private stopping = false;
	private siteRoot?: string;
	private scopeTimer?: NodeJS.Timeout;
	/** Очередь жизненного цикла: start/stop/restart не выполняются параллельно. */
	private lifecycle: Promise<void> = Promise.resolve();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly indexer: BitrixIndexer,
		private readonly projects: ProjectPhpStore,
	) {}

	get isRunning(): boolean {
		return Boolean(this.client);
	}

	async start(): Promise<void> {
		return this.enqueueLifecycle(() => this.doStart());
	}

	private enqueueLifecycle(task: () => Promise<void>): Promise<void> {
		const next = this.lifecycle.then(task, task);
		this.lifecycle = next.catch(() => undefined);
		return next;
	}

	private async doStart(): Promise<void> {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		this.stopping = false;
		if (this.client) {
			return;
		}
		const layout = resolveLayout();
		if (!layout) {
			log().info('LSP не запущен: каталог bitrix не найден в workspace');
			return;
		}
		// Версия PHP и пути берутся из состояния проекта (workspaceState),
		// настройки — только fallback.
		const scope = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(layout.siteRoot))?.uri;
		const settings = readSettings(scope);
		const phpVersion = this.projects.version(scope);
		const phpPaths = this.projects.paths(scope);
		if (!settings.lspEnabled) {
			log().info('LSP выключен настройкой bitrix.lsp.enabled');
			return;
		}
		this.siteRoot = layout.siteRoot;
		if (!this.output) {
			this.output = vscode.window.createOutputChannel('Bitrix LSP');
		}
		const launch = resolveLspLaunch({
			extensionPath: this.context.extensionPath,
			configuredBinary: settings.lspPhpBinary || undefined,
			phpPaths,
		});
		if (launch.warning) {
			log().warn(launch.warning);
		}
		log().info(`LSP: ${launch.command} ${launch.args.join(' ')} (${launch.source})`);

		const serverOptions: ServerOptions = {
			command: launch.command,
			args: launch.args,
			transport: TransportKind.stdio,
			options: {
				cwd: layout.siteRoot,
				env: {
					...process.env,
					BITRIX_DB: this.indexer.dbFile,
					BITRIX_ROOT: layout.siteRoot,
					BITRIX_BITRIX_PATH: layout.bitrixDir,
					BITRIX_JS_LIB_CHECK: settings.jsLibraryCheck ? '1' : '0',
					BITRIX_PHP_SEMANTIC: settings.phpSemantic ? '1' : '0',
					BITRIX_PHP_VERSION: phpVersion,
					BITRIX_LSP_LOG: '1',
				},
			},
		};
		// Автоперезапуск LanguageClient отключён: единственный supervisor — этот класс.
		// Иначе встроенный restart и наш scheduleRestart стартуют два сервера сразу.
		const errorHandler: ErrorHandler = {
			error: () => ({ action: ErrorAction.Shutdown, handled: true }),
			closed: () => ({ action: CloseAction.DoNotRestart, handled: true }),
		};
		const clientOptions: LanguageClientOptions = {
			// VS Code может запросить подсказки на trigger-символе раньше, чем
			// отправит textDocument/didChange: сервер тогда видит старый текст
			// (`$a = s` вместо `$a = str_`) и отдаёт чужие элементы. Небольшая
			// задержка гарантирует, что изменение уже ушло в LSP.
			middleware: {
				provideCompletionItem: async (document, position, context, token, next) => {
					await new Promise((resolve) => setTimeout(resolve, 25));
					return next(document, position, context, token);
				},
			},
			documentSelector: [
				{ scheme: 'file', language: 'php' },
				{ scheme: 'untitled', language: 'php' },
				{ scheme: 'file', language: 'javascript' },
				{ scheme: 'untitled', language: 'javascript' },
				{ scheme: 'file', language: 'javascriptreact' },
				{ scheme: 'untitled', language: 'javascriptreact' },
			],
			synchronize: { configurationSection: 'bitrix' },
			errorHandler,
			initializationOptions: {
				bitrixRoot: layout.siteRoot,
				bitrixPath: layout.bitrixDir,
				dbPath: this.indexer.dbFile,
				jsLibraryCheck: settings.jsLibraryCheck,
				phpSemantic: settings.phpSemantic,
				phpVersion,
			},
			outputChannel: quietOutput(this.output),
			// Hover-разметка приходит от нашего же LSP; разрешаем HTML только
			// для цветных <span style="color:#..."> и включаем trusted-режим.
			markdown: { isTrusted: true, supportHtml: true },
		};
		const client = new LanguageClient('bitrixLsp', 'Bitrix LSP', serverOptions, clientOptions);
		try {
			await client.start();
			this.client = client;
			this.restartAttempts = 0;
			client.onDidChangeState((event) => {
				if (event.newState === State.Stopped && this.client === client) {
					this.client = undefined;
					this.scheduleRestart('процесс LSP остановился');
				}
			});
			log().info('LSP-сервер запущен');
		} catch (err) {
			log().warn(`LSP не запустился: ${errorMessage(err)}`);
			await client.stop().catch(() => undefined);
			this.scheduleRestart('ошибка запуска LSP');
		}
	}

	/** Попросить сервер перевалидировать открытые документы (после обновления индекса). */
	refreshDiagnostics(): void {
		const client = this.client;
		if (!client || client.state !== State.Running) {
			return;
		}
		void client
			.sendNotification('workspace/didChangeConfiguration', { settings: {} })
			.catch((err) => log().debug(`refreshDiagnostics: ${errorMessage(err)}`));
	}

	stop(): Promise<void> {
		return this.enqueueLifecycle(() => this.doStop());
	}

	private async doStop(): Promise<void> {
		this.stopping = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		const client = this.client;
		this.client = undefined;
		if (!client) {
			return;
		}
		// Сервер уже мог завершиться сам: stop() в этом состоянии пишет в мёртвый
		// поток и даёт «Stopping server failed». Достаточно освободить клиент.
		if (client.state === State.Stopped) {
			client.dispose();
			return;
		}
		await client.stop().catch((err) => log().warn(`LSP stop: ${errorMessage(err)}`));
	}

	async restart(): Promise<void> {
		return this.enqueueLifecycle(async () => {
			await this.doStop();
			await this.doStart();
		});
	}

	/** Мульти-рут: при смене активной папки перезапускает сервер с её корнем и базой. */
	syncScope(): void {
		if (this.disposed) {
			return;
		}
		if (this.scopeTimer) {
			clearTimeout(this.scopeTimer);
		}
		this.scopeTimer = setTimeout(() => {
			this.scopeTimer = undefined;
			const next = resolveLayout()?.siteRoot;
			if (next === this.siteRoot) {
				return;
			}
			this.siteRoot = next;
			if (!next) {
				log().info('LSP: в активной папке нет bitrix — сервер остановлен');
				void this.stop();
				return;
			}
			log().info(`LSP: активная папка изменилась (${next}) — перезапуск`);
			void this.restart().catch((err) => log().warn(`LSP scope restart: ${errorMessage(err)}`));
		}, 300);
	}

	private scheduleRestart(reason: string): void {
		if (this.disposed || this.stopping || this.restartTimer || !readSettings().lspEnabled) {
			return;
		}
		this.restartAttempts++;
		const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.restartAttempts - 1));
		log().warn(`${reason}; перезапуск LSP через ${delay} мс (попытка ${this.restartAttempts})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			void this.start().catch((err) => log().warn(`LSP restart: ${errorMessage(err)}`));
		}, delay);
	}

	dispose(): void {
		if (this.scopeTimer) {
			clearTimeout(this.scopeTimer);
			this.scopeTimer = undefined;
		}
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		void this.stop();
		this.output?.dispose();
	}
}
