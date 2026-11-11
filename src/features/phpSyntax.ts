import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from '../log';
import { downloadRuntime, listCachedRuntimes, removeCachedRuntime, runtimeCachePath } from './phpRuntimeDownloader';
import { resolveLspLaunch } from '../lsp/platform';
import { parseLintOutput } from './phpLint';
import { isExcluded } from '../util/glob';

/** Проверка синтаксиса PHP выбранным бинарником (`php -l`). */
export class PhpSyntaxChecker implements vscode.Disposable {
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('bitrix-php-syntax');
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly versions = new Map<string, number>();
	private readonly warned = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly binaryPromises = new Map<string, Promise<{ command: string; version: string } | undefined>>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(
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
		const selected = String(this.config(uri).get<string>('version', 'auto'));
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

	async downloadSelected(): Promise<void> {
		const uri = vscode.window.activeTextEditor?.document.uri;
		const version = String(this.config(uri).get<string>('version', 'auto'));
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
		const config = this.config(document.uri);
		const selected = String(config.get<string>('version', 'auto'));
		const binary = await this.resolveBinary(selected, document.uri);
		if (!binary) {
			if (selected !== 'auto') {
				this.warnMissing(selected);
			}
			return;
		}
		if (selected !== 'auto' && binary.version !== '' && selected !== binary.version) {
			this.warnMissing(selected);
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
							const folderConfig = this.config(uri);
							const selected = String(folderConfig.get<string>('version', 'auto'));
							const binary = await this.resolveBinary(selected, uri);
							if (!binary) {
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
	): Promise<{ command: string; version: string } | undefined> {
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
	): Promise<{ command: string; version: string } | undefined> {
		const config = this.config(uri);
		const explicit = String(config.get<string>('lintBinary', '')).trim();
		if (explicit !== '' && fs.existsSync(explicit)) {
			const version = await this.versionOf(explicit);
			return { command: explicit, version: version ?? '' };
		}

		if (selected !== 'auto') {
			const cached = runtimeCachePath(
				this.context,
				selected,
				process.platform as 'darwin' | 'linux' | 'win32',
				process.arch === 'arm64' ? 'arm64' : 'x64',
			);
			if (fs.existsSync(cached)) {
				return { command: cached, version: selected };
			}
		}

		const lspConfigured = String(
			vscode.workspace.getConfiguration('bitrix.lsp').get<string>('phpBinary', ''),
		).trim();
		const launch = resolveLspLaunch({
			extensionPath: this.context.extensionPath,
			configuredBinary: lspConfigured || undefined,
			exists: (candidate) => fs.existsSync(candidate),
		});
		const candidates = [
			'php',
			lspConfigured,
			launch.command,
			`php${selected === 'auto' ? '' : selected}`,
			selected === 'auto' ? '' : `/opt/homebrew/opt/php@${selected}/bin/php`,
			selected === 'auto' ? '' : `/usr/local/opt/php@${selected}/bin/php`,
		].filter((candidate): candidate is string => Boolean(candidate));

		const seen = new Set<string>();
		for (const candidate of candidates) {
			if (seen.has(candidate)) {
				continue;
			}
			seen.add(candidate);
			const version = await this.versionOf(candidate);
			if (!version) {
				continue;
			}
			if (selected === 'auto' || version === selected) {
				return { command: candidate, version };
			}
		}
		return undefined;
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

	private warnMissing(version: string): void {
		const key = `php-version-${version}`;
		if (this.warned.has(key)) {
			return;
		}
		this.warned.add(key);
		void vscode.window
			.showWarningMessage(
				`Bitrix Assistant: PHP ${version} не найден. Скачать статическую сборку или указать путь?`,
				'Скачать',
				'Указать путь',
			)
			.then((action) => {
				if (action === 'Скачать') {
					void this.downloadSelected();
				} else if (action === 'Указать путь') {
					void vscode.commands.executeCommand('workbench.action.openSettings', 'bitrix.php.lintBinary');
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
