import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from '../log';
import { downloadRuntime, listCachedRuntimes, removeCachedRuntime, runtimeCachePath } from './phpRuntimeDownloader';
import { platformKey, staticBinaryName } from '../lsp/platform';
import {
	BUNDLED_PHP_VERSION,
	candidateCommands,
	describeSource,
	expandConfigPath,
	versionMatches,
	SELECTABLE_PHP_VERSIONS,
	type PhpSource,
} from '../php/interpreter';
import { parseLintOutput } from './phpLint';
import { isExcluded } from '../util/glob';
import { ProjectPhpStore } from '../php/projectPhp';

/** Проверка синтаксиса PHP выбранным бинарником (`php -l`). */
export class PhpSyntaxChecker implements vscode.Disposable {
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('bitrix-php-syntax');
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly versions = new Map<string, number>();
	private readonly warned = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly binaryPromises = new Map<
		string,
		Promise<{ command: string; version: string; source: PhpSource } | undefined>
	>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly projects: ProjectPhpStore,
	) {
		this.disposables.push(
			this.projects.onDidChange(() => {
				this.binaryPromises.clear();
				this.versions.clear();
				for (const document of vscode.workspace.textDocuments) {
					this.schedule(document);
				}
			}),
			vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document)),
			vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document)),
			vscode.workspace.onDidSaveTextDocument((document) => this.schedule(document)),
			vscode.workspace.onDidCloseTextDocument((document) => {
				this.diagnostics.delete(document.uri);
				this.versions.delete(document.uri.toString());
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('bitrix.php')) {
					this.binaryPromises.clear();
					this.warned.clear();
					this.versions.clear();
					if (!this.config().get<boolean>('lint', true)) {
						this.diagnostics.clear();
						return;
					}
					for (const document of vscode.workspace.textDocuments) {
						this.schedule(document);
					}
				}
			}),
		);
		for (const document of vscode.workspace.textDocuments) {
			this.schedule(document);
		}
	}

	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.diagnostics.dispose();
	}

	private readonly switching = new Set<string>();

	private schedule(document: vscode.TextDocument): void {
		if (document.uri.scheme === 'untitled' && document.languageId !== 'php') {
			const text = document.getText();
			if (text.trimStart().startsWith('<?php')) {
				const key = document.uri.toString();
				if (!this.switching.has(key)) {
					this.switching.add(key);
					void vscode.languages.setTextDocumentLanguage(document, 'php').then(
						() => this.switching.delete(key),
						() => this.switching.delete(key),
					);
				}
			} else if (text.trim() === '') {
				return;
			}
		}
		const untitledPhp =
			document.uri.scheme === 'untitled' &&
			(document.languageId === 'php' || document.getText().trimStart().startsWith('<?php'));
		if (
			(!untitledPhp && document.uri.scheme !== 'file') ||
			(!untitledPhp && document.languageId !== 'php') ||
			!this.config(document.uri).get<boolean>('lint', true)
		) {
			return;
		}
		const key = document.uri.toString();
		const previous = this.timers.get(key);
		if (previous) {
			clearTimeout(previous);
		}
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				void this.check(document);
			}, 400),
		);
	}

	async effectiveVersion(uri?: vscode.Uri): Promise<string | undefined> {
		const selected = this.projects.version(uri);
		const binary = await this.resolveBinary(selected, uri);
		return binary?.version || (selected === 'auto' ? undefined : selected);
	}

	async manageRuntimes(): Promise<void> {
		const runtimes = await listCachedRuntimes(this.context);
		if (runtimes.length === 0) {
			const action = await vscode.window.showInformationMessage(
				'Bitrix Assistant: скачанных PHP-рантаймов нет.',
				'Скачать текущую версию',
			);
			if (action) {
				await this.downloadSelected();
			}
			return;
		}
		const picked = await vscode.window.showQuickPick(
			runtimes.map((runtime) => ({
				label: `PHP ${runtime.version}`,
				description: `${runtime.platform}-${runtime.arch} · ${(runtime.size / 1024 / 1024).toFixed(1)} МБ`,
				detail: runtime.command,
				runtime,
			})),
			{ title: 'Скачанные PHP для проверки синтаксиса', placeHolder: 'Выберите, чтобы удалить' },
		);
		if (!picked) {
			return;
		}
		const confirmed = await vscode.window.showWarningMessage(
			`Удалить PHP ${picked.runtime.version} (${picked.runtime.platform}-${picked.runtime.arch})?`,
			{ modal: true },
			'Удалить',
		);
		if (confirmed !== 'Удалить') {
			return;
		}
		await removeCachedRuntime(this.context, picked.runtime);
		this.binaryPromises.clear();
		this.versions.clear();
		for (const document of vscode.workspace.textDocuments) {
			this.schedule(document);
		}
	}

	async downloadSelected(versionArg?: string): Promise<void> {
		const uri = vscode.window.activeTextEditor?.document.uri;
		const version = versionArg ?? this.projects.version(uri);
		if (version === 'auto') {
			void vscode.window.showWarningMessage('Bitrix Assistant: выберите конкретную версию PHP, чтобы скачать её.');
			return;
		}
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Bitrix Assistant: скачивание PHP ${version}`,
				cancellable: true,
			},
			async (progress, token) => {
				const controller = new AbortController();
				const cancellation = token.onCancellationRequested(() => controller.abort());
				try {
					const runtime = await downloadRuntime(this.context, version, {
						signal: controller.signal,
						onProgress: (received, total, delta) => {
							const mb = (received / 1024 / 1024).toFixed(1);
							progress.report({
								message: total > 0
									? `${mb} / ${(total / 1024 / 1024).toFixed(1)} МБ`
									: `${mb} МБ`,
								increment: total > 0 ? (delta / total) * 100 : undefined,
							});
						},
					});
					this.binaryPromises.clear();
					this.versions.clear();
					void vscode.window.showInformationMessage(
						`Bitrix Assistant: PHP ${runtime.version} скачан (${runtime.command}).`,
					);
					for (const document of vscode.workspace.textDocuments) {
						this.schedule(document);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (controller.signal.aborted) {
						void vscode.window.showInformationMessage(`Bitrix Assistant: скачивание PHP ${version} отменено.`);
					} else {
						void vscode.window.showErrorMessage(`Bitrix Assistant: не удалось скачать PHP ${version}. ${message}`);
					}
				} finally {
					cancellation.dispose();
				}
			},
		);
	}

	private async check(document: vscode.TextDocument): Promise<void> {
		if (!this.config(document.uri).get<boolean>('lint', true)) {
			this.diagnostics.delete(document.uri);
			return;
		}
		const version = document.version;
		if (this.versions.get(document.uri.toString()) === version) {
			return;
		}
		this.versions.set(document.uri.toString(), version);
		const selected = this.projects.version(document.uri);
		const binary = await this.resolveBinary(selected, document.uri);
		if (!binary) {
			if (selected !== 'auto') {
				this.warnMissing(selected, undefined, document.uri);
			}
			return;
		}
		if (!versionMatches(selected, binary.version)) {
			this.warnMissing(selected, binary.version, document.uri);
			this.diagnostics.set(document.uri, []);
			return;
		}

		const diagnostic = await this.lintText(document.uri, document.getText(), binary).catch(() => {
			this.warnOnce('php-lint-missing', 'PHP для проверки синтаксиса не найден.');
			return undefined;
		});
		if (document.isClosed || document.version !== version) {
			return;
		}
		if (diagnostic) {
			this.diagnostics.set(document.uri, [diagnostic]);
		} else {
			this.diagnostics.delete(document.uri);
		}
	}

	async lintWorkspace(): Promise<void> {
		const config = this.config();
		if (!config.get<boolean>('lint', true)) {
			void vscode.window.showInformationMessage('Bitrix Assistant: проверка синтаксиса PHP выключена.');
			return;
		}
		const excludes = vscode.workspace
			.getConfiguration('bitrix')
			.get<string[]>('index.exclude', []);
		const files = await vscode.workspace.findFiles('**/*.php', '**/{node_modules,vendor}/**');
		const selectedFiles = files.filter((uri) => {
			const relative = vscode.workspace.asRelativePath(uri, false).split(path.sep).join('/');
			return !isExcluded(relative, excludes);
		});
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Bitrix Assistant: проверка синтаксиса PHP',
				cancellable: true,
			},
			async (progress, token) => {
				this.diagnostics.clear();
				let index = 0;
				const total = selectedFiles.length;
				const worker = async (): Promise<void> => {
					for (;;) {
						if (token.isCancellationRequested) {
							return;
						}
						const current = index++;
						if (current >= total) {
							return;
						}
						const uri = selectedFiles[current];
						progress.report({ message: `${current + 1} / ${total}`, increment: total > 0 ? 100 / total : 0 });
						try {
							const text = await fs.promises.readFile(uri.fsPath, 'utf8');
							const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
							const version = document?.version;
							const selected = this.projects.version(uri);
							const binary = await this.resolveBinary(selected, uri);
							if (!binary || !versionMatches(selected, binary.version)) {
								continue;
							}
							const diagnostic = await this.lintText(uri, text, binary);
							if (document && version !== undefined && document.version !== version) {
								continue;
							}
							if (diagnostic) {
								this.diagnostics.set(uri, [diagnostic]);
							} else {
								this.diagnostics.delete(uri);
							}
						} catch (err) {
							log().debug(`lint ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
				};
				await Promise.all([worker(), worker()]);
			},
		);
	}

	private async lintText(
		uri: vscode.Uri,
		text: string,
		binary: { command: string; version: string },
	): Promise<vscode.Diagnostic | undefined> {
		const temp = path.join(
			os.tmpdir(),
			`bitrix-lint-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.php`,
		);
		try {
			await fs.promises.writeFile(temp, text, 'utf8');
			const output = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
				execFile(
					binary.command,
					['-d', 'display_errors=1', '-d', 'error_reporting=E_ALL', '-l', temp],
					{ timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
					(error, stdout, stderr) => {
						if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
							reject(error);
							return;
						}
						resolve({ stdout, stderr });
					},
				);
			});
			const problem = parseLintOutput(`${output.stderr}
${output.stdout}`);
			if (!problem) {
				return undefined;
			}
			const lines = text.split(/\r?\n/);
			const line = Math.min(problem.line - 1, Math.max(0, lines.length - 1));
			const range = new vscode.Range(line, 0, line, (lines[line] ?? '').length);
			const diagnostic = new vscode.Diagnostic(range, problem.message, vscode.DiagnosticSeverity.Error);
			log().info(`PHP syntax (${binary.version || 'unknown'}): ${uri.fsPath}:${problem.line}`);
			diagnostic.source = 'bitrix-php';
			diagnostic.code = 'syntax';
			return diagnostic;
		} finally {
			await fs.promises.unlink(temp).catch(() => undefined);
		}

	}

	private config(uri?: vscode.Uri): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('bitrix.php', uri);
	}

	private async resolveBinary(
		selected: string,
		uri?: vscode.Uri,
	): Promise<{ command: string; version: string; source: PhpSource } | undefined> {
		const key = `${uri?.toString() ?? ''}|${selected}`;
		const existing = this.binaryPromises.get(key);
		if (existing) {
			return existing;
		}
		const pending = this.resolveBinaryNow(selected, uri);
		this.binaryPromises.set(key, pending);
		return pending;
	}

	private async resolveBinaryNow(
		selected: string,
		uri?: vscode.Uri,
	): Promise<{ command: string; version: string; source: PhpSource } | undefined> {
		const config = this.config(uri);
		const explicit = String(config.get<string>('lintBinary', '')).trim();
		const paths = this.expandedPhpPaths(uri);
		const key = platformKey();
		const downloaded =
			selected === 'auto'
				? undefined
				: runtimeCachePath(
						this.context,
						selected,
						process.platform as 'darwin' | 'linux' | 'win32',
						process.arch === 'arm64' ? 'arm64' : 'x64',
					);
		const bundled = key
			? path.join(this.context.extensionPath, 'server', 'bin', staticBinaryName(key))
			: undefined;
		const candidates = candidateCommands({
			selected,
			paths,
			lintBinary: explicit !== '' && fs.existsSync(explicit) ? explicit : undefined,
			downloaded: downloaded && fs.existsSync(downloaded) ? downloaded : undefined,
			bundled: bundled && fs.existsSync(bundled) ? bundled : undefined,
		});
		for (const candidate of candidates) {
			const version = await this.versionOf(candidate.command);
			if (!version) {
				continue;
			}
			// Явный путь уважаем как есть: версию пользователь выбрал сам.
			const explicitSource = candidate.source === 'paths' || candidate.source === 'lintBinary';
			if (explicitSource || versionMatches(selected, version)) {
				log().debug(
					`PHP ${version} для версии ${selected}: ${candidate.command} (${describeSource(candidate.source)})`,
				);
				return { command: candidate.command, version, source: candidate.source };
			}
		}
		return undefined;
	}

	/** Пути к PHP по версиям из состояния проекта. */
	private phpPaths(uri?: vscode.Uri): Record<string, string> {
		return this.projects.paths(uri);
	}

	/** Те же пути с раскрытыми `~` и `${env:VAR}` — для запуска процесса. */
	private expandedPhpPaths(uri?: vscode.Uri): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [version, value] of Object.entries(this.phpPaths(uri))) {
			result[version] = expandConfigPath(value);
		}
		return result;
	}

	/** Имя проекта, к которому привязана версия PHP. */
	projectName(uri?: vscode.Uri): string {
		return this.projects.projectName(uri);
	}

	/** Проверка при старте: выбранная для проекта версия PHP реально доступна? */
	async verifySelectedRuntime(): Promise<void> {
		const uri =
			vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
		const config = this.config(uri);
		if (!config.get<boolean>('lint', true)) {
			return;
		}
		const selected = this.projects.version(uri);
		if (selected === 'auto') {
			return;
		}
		const binary = await this.resolveBinary(selected, uri);
		if (binary && versionMatches(selected, binary.version)) {
			return;
		}
		this.warnMissing(selected, binary?.version, uri);
	}

	/**
	 * Команда «указать путь к PHP»: путь вводится текстом и сохраняется
	 * в состоянии проекта (`workspaceState`), без правки файлов проекта.
	 */
	async setPath(versionArg?: string): Promise<void> {
		const uri = vscode.window.activeTextEditor?.document.uri;
		let version = versionArg ?? this.projects.version(uri);
		if (version === 'auto') {
			version =
				(
					await vscode.window.showQuickPick(
						SELECTABLE_PHP_VERSIONS.map((item) => ({ label: `PHP ${item}`, version: item })),
						{ title: 'Для какой версии PHP указать путь', placeHolder: 'Например, PHP 8.3' },
					)
				)?.version ?? '';
		}
		if (!version) {
			return;
		}
		const project = this.projectName(uri);
		const current = this.phpPaths(uri)[version] ?? '';
		const example = process.platform === 'win32' ? String.raw`C:\php83\php.exe` : '/opt/homebrew/opt/php@8.3/bin/php';
		const value = await vscode.window.showInputBox({
			title: `Путь к PHP ${version} — проект «${project}»`,
			prompt:
				'Полный путь к исполняемому файлу: можно писать ~ и ${env:HOME}. ' +
				'Сохраняется в состоянии расширения для проекта. Пустое поле — удалить путь.',
			value: current,
			placeHolder: example,
			validateInput: (input) =>
				input.trim() !== '' && !/^[~/\\]|^[A-Za-z]:[\\/]/.test(input.trim())
					? 'Нужен полный путь (например, /usr/bin/php8.3 или C:\\php83\\php.exe)'
					: undefined,
		});
		if (value === undefined) {
			return;
		}
		const trimmed = value.trim();
		await this.projects.setPath(uri, version, trimmed === '' ? undefined : trimmed);

		if (trimmed === '') {
			void vscode.window.showInformationMessage(
				`Bitrix Assistant: путь к PHP ${version} удалён (проект «${project}»).`,
			);
		} else {
			const expanded = expandConfigPath(trimmed);
			if (!fs.existsSync(expanded)) {
				void vscode.window.showWarningMessage(
					`Bitrix Assistant: сохранил путь ${trimmed} для PHP ${version}, но файла нет: ${expanded}. ` +
						'Проверьте путь после установки PHP.',
				);
			}
			const actual = fs.existsSync(expanded) ? await this.versionOf(expanded) : undefined;
			if (actual && !versionMatches(version, actual)) {
				void vscode.window.showWarningMessage(
					`Bitrix Assistant: по пути ${expanded} работает PHP ${actual}, а указан PHP ${version}. ` +
						'Выберите файл нужной версии или измените bitrix.php.version.',
				);
			} else if (actual) {
				void vscode.window.showInformationMessage(
					`Bitrix Assistant: PHP ${version} для проекта «${project}» — ${expanded}.`,
				);
			}
		}
		this.binaryPromises.clear();
		this.versions.clear();
		for (const document of vscode.workspace.textDocuments) {
			this.schedule(document);
		}
	}

	private versionOf(command: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			execFile(command, ['-r', 'echo PHP_VERSION;'], { timeout: 3000 }, (error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				const match = /^(\d+)\.(\d+)/.exec(stdout.trim());
				resolve(match ? `${match[1]}.${match[2]}` : undefined);
			});
		});
	}

	private warnMissing(version: string, actual?: string, uri?: vscode.Uri): void {
		const project = this.projectName(uri);
		const key = `php-version-${version}-${project}`;
		if (this.warned.has(key)) {
			return;
		}
		this.warned.add(key);
		const detail = actual
			? `По указанному пути работает PHP ${actual}.`
			: `Встроен только PHP ${BUNDLED_PHP_VERSION}.`;
		void vscode.window
			.showWarningMessage(
				`Bitrix Assistant: PHP ${version} для проекта «${project}» не найден. ${detail} ` +
					'Скачать сборку, указать путь или установить PHP на компьютер.',
				'Скачать',
				'Указать путь',
			)
			.then((action) => {
				if (action === 'Скачать') {
					void this.downloadSelected(version);
				} else if (action === 'Указать путь') {
					void this.setPath(version);
				}
			});
	}

	private warnOnce(key: string, message: string): void {
		if (this.warned.has(key)) {
			return;
		}
		this.warned.add(key);
		void vscode.window.showWarningMessage(`Bitrix Assistant: ${message}`);
	}
}
