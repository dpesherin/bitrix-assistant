import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { generateOrmAnnotation } from './features/ormAnnotations';
import { PhpClassCompletionProvider } from './features/phpClassCompletion';
import { PhpAutoImportProvider } from './features/phpAutoImport';
import { PhpSyntaxChecker } from './features/phpSyntax';
import { BUNDLED_PHP_VERSION, SELECTABLE_PHP_VERSIONS } from './php/interpreter';
import { ProjectPhpStore } from './php/projectPhp';
import { flashFailed, flashIdentical, flashUploaded, spinUpload } from './features/uploadFeedback';
import { applyHotkeys } from './features/hotkeys';
import { BitrixIndexer, isIndexableSource, resolveLayout } from './indexer/indexer';
import { errorMessage, initLog, log, showLog } from './log';
import { BitrixLanguageClient } from './lsp/lspClient';
import { readSettings } from './settings';
import { SshConnectionManager } from './ssh/connection';
import { RemotePreview } from './ssh/preview';
import { ProfileStore } from './ssh/profiles';
import { SshTerminal } from './ssh/terminal';
import { RemoteNode, RemoteTreeProvider } from './ssh/remoteTree';
import { SyncMode, SyncService } from './ssh/sync';
import { SshProfile } from './ssh/types';
import { isExcluded } from './util/glob';
import { IndexViewProvider } from './views/indexView';
import { BitrixStatusBar } from './views/statusBar';
import { PhpVersionStatusBar } from './views/phpVersionStatus';

/** Недавно сохранённые файлы, чтобы watcher не индексировал их повторно. */
const recentIndexed = new Map<string, number>();

interface ActiveExtension {
	store: ProfileStore;
	connections: SshConnectionManager;
	sync: SyncService;
	indexer: BitrixIndexer;
	lsp: BitrixLanguageClient;
	tree: RemoteTreeProvider;
	indexView: IndexViewProvider;
	preview: RemotePreview;
	statusBar: BitrixStatusBar;
	phpSyntax: PhpSyntaxChecker;
	phpProjects: ProjectPhpStore;
}

export async function activate(context: vscode.ExtensionContext): Promise<ActiveExtension> {
	initLog();
	log().info('Bitrix Assistant активируется');
	const manifest = context.extension.packageJSON as {
		contributes?: { keybindings?: unknown[] };
	};
	log().info(`contributes.keybindings: ${manifest.contributes?.keybindings?.length ?? 0}`);

	const store = new ProfileStore(context);
	const connections = new SshConnectionManager(store);
	const sync = new SyncService(connections);
	const indexer = new BitrixIndexer(context);
	const phpProjects = new ProjectPhpStore(context);
	const lsp = new BitrixLanguageClient(context, indexer, phpProjects);
	const tree = new RemoteTreeProvider(connections);
	const indexView = new IndexViewProvider(indexer);
	const preview = new RemotePreview(context, connections);
	const statusBar = new BitrixStatusBar(connections);
	const phpSyntax = new PhpSyntaxChecker(context, phpProjects);
	const phpStatus = new PhpVersionStatusBar(phpSyntax, phpProjects);
	const sshView = vscode.window.createTreeView('bitrixSshExplorer', {
		treeDataProvider: tree,
		showCollapseAll: true,
	});
	const indexTreeView = vscode.window.createTreeView('bitrixIndex', {
		treeDataProvider: indexView,
		showCollapseAll: true,
	});
	const ext: ActiveExtension = {
		store,
		connections,
		sync,
		indexer,
		lsp,
		tree,
		indexView,
		preview,
		statusBar,
		phpSyntax,
		phpProjects,
	};

	context.subscriptions.push(
		connections,
		indexer,
		lsp,
		phpProjects,
		statusBar,
		phpStatus,
		sshView,
		indexTreeView,
		vscode.languages.registerCompletionItemProvider(
			[{ scheme: 'file', language: 'php' }, { scheme: 'untitled', language: 'php' }],
			new PhpClassCompletionProvider(indexer),
			'\\',
		),
		vscode.languages.registerCodeActionsProvider(
			[{ scheme: 'file', language: 'php' }, { scheme: 'untitled', language: 'php' }],
			new PhpAutoImportProvider(indexer),
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
		),
		phpSyntax,
	);
	await vscode.commands.executeCommand('setContext', 'bitrix.sshConnected', false);

	// Встроен только PHP 8.4: если для проекта выбрана другая версия и её нет
	// ни в PATH, ни в сохранённом пути, предлагаем скачать или указать путь.
	setTimeout(() => void phpSyntax.verifySelectedRuntime(), 3000);

	// Версия PHP проекта хранится в workspaceState: после смены перезапускаем LSP,
	// чтобы анализатор взял новую целевую версию.
	context.subscriptions.push(
		phpProjects.onDidChange(() => {
			void ext.lsp
				.restart()
				.catch((err) => log().warn(`LSP restart (PHP проекта): ${errorMessage(err)}`));
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('bitrix.ssh.connect', () => connect(ext)),
		vscode.commands.registerCommand('bitrix.ssh.terminal', () => openServerTerminal(ext)),
		vscode.commands.registerCommand('bitrix.ssh.switchProfile', () => switchProfile(ext)),
		vscode.commands.registerCommand('bitrix.ssh.setDefaultProfile', () => setDefaultProfile(ext)),
		vscode.commands.registerCommand('bitrix.ssh.saveAndUpload', () => saveAndUpload(ext)),
		vscode.commands.registerCommand('bitrix.ssh.disconnect', () => disconnect(ext)),
		vscode.commands.registerCommand('bitrix.ssh.addProfile', () => addProfile(ext)),
		vscode.commands.registerCommand('bitrix.ssh.removeProfile', () => removeProfile(ext)),
		vscode.commands.registerCommand('bitrix.ssh.manageHostKeys', () => manageHostKeys(ext)),
		vscode.commands.registerCommand('bitrix.ssh.upload', (arg?: vscode.Uri) => upload(ext, arg)),
		vscode.commands.registerCommand('bitrix.ssh.download', (arg?: vscode.Uri) => download(ext, arg)),
		vscode.commands.registerCommand('bitrix.ssh.syncAll', () => syncAll(ext)),
		vscode.commands.registerCommand('bitrix.ssh.preview', (arg?: RemoteNode | string) => previewRemote(ext, arg)),
		vscode.commands.registerCommand('bitrix.ssh.downloadRemote', (arg?: RemoteNode | string) =>
			downloadRemote(ext, arg),
		),
		vscode.commands.registerCommand('bitrix.ssh.uploadLocal', (arg?: RemoteNode | string) =>
			uploadLocal(ext, arg),
		),
		vscode.commands.registerCommand('bitrix.ssh.copyRemotePath', (arg?: RemoteNode | string) =>
			copyRemotePath(ext, arg),
		),
		vscode.commands.registerCommand('bitrix.ssh.compareRemote', (arg?: RemoteNode | string) =>
			compareRemote(ext, arg),
		),
		vscode.commands.registerCommand('bitrix.ssh.openLocal', (arg?: RemoteNode | string) =>
			openLocal(ext, arg),
		),
		vscode.commands.registerCommand('bitrix.index.compact', () => compactIndex(ext)),
		vscode.commands.registerCommand('bitrix.index.cleanupLegacy', () => cleanupLegacyIndex(ext, context)),
		vscode.commands.registerCommand('bitrix.hotkeys.apply', () => applyHotkeys(context)),
		vscode.commands.registerCommand('bitrix.hotkeys.open', () =>
			vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'bitrix'),
		),
		vscode.commands.registerCommand('bitrix.php.selectVersion', () => selectPhpVersion(ext)),
		vscode.commands.registerCommand('bitrix.php.setPath', (version?: string) =>
			ext.phpSyntax.setPath(version),
		),
		vscode.commands.registerCommand('bitrix.php.checkRuntime', () =>
			ext.phpSyntax.verifySelectedRuntime(),
		),
		vscode.commands.registerCommand('bitrix.php.downloadRuntime', () => ext.phpSyntax.downloadSelected()),
		vscode.commands.registerCommand('bitrix.php.manageRuntimes', () => ext.phpSyntax.manageRuntimes()),
		vscode.commands.registerCommand('bitrix.php.lintWorkspace', () => ext.phpSyntax.lintWorkspace()),
		vscode.commands.registerCommand('bitrix.showMenu', () => showMenu(ext)),
		vscode.commands.registerCommand('bitrix.showLog', () => showLog()),
		vscode.commands.registerCommand('bitrix.index.rebuild', () => runIndexCommand(ext, true)),
		vscode.commands.registerCommand('bitrix.index.reindexFile', () => reindexActiveFile(ext)),
		vscode.commands.registerCommand('bitrix.index.stats', () => showStats(ext)),
		vscode.commands.registerCommand('bitrix.orm.generateAnnotations', () => generateAnnotations()),
		vscode.commands.registerCommand('bitrix.lsp.restart', async () => {
			await ext.lsp.restart();
			void vscode.window.showInformationMessage('Bitrix LSP перезапущен');
		}),
		vscode.commands.registerCommand('bitrix.php.diagnoseAll', async () => {
			const limit = vscode.workspace
				.getConfiguration('bitrix')
				.get<number>('diagnostics.projectLimit', 500);
			try {
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Bitrix Assistant: проверка проекта',
					},
					() => ext.lsp.diagnoseAll(limit),
				);
				const suffix = result.truncated
					? ` Проверены первые ${result.files} файлов, лимит можно увеличить в настройках.`
					: '';
				void vscode.window.showInformationMessage(
					`Проверено файлов: ${result.files}, диагностик: ${result.diagnostics}.${suffix}`,
				);
			} catch (err) {
				void vscode.window.showErrorMessage(`Bitrix Assistant: ${errorMessage(err)}`);
			}
		}),
	);

	registerWatchers(context, ext);
	setupIndexWatchers(context, ext);
	void preview.clearCache();

	const settings = readSettings();
	if (settings.indexEnabled) {
		statusBar.setIndexing(true);
		void indexer
			.sync((message) => log().info(message))
			.then(async () => {
				statusBar.setIndexing(false);
				indexView.refresh();
				lsp.refreshDiagnostics();
				// Problems по всему проекту: LSP иначе присылает диагностику
				// только для открытых файлов, и после перезагрузки окна она пуста.
				void runProjectScan(ext);
			})
			.catch((err) => {
				statusBar.setIndexing(false);
				log().warn(`Начальная индексация: ${errorMessage(err)}`);
			});
	} else {
		log().info('Индексация выключена настройкой bitrix.index.enabled');
	}
	if (settings.sshAutoConnect && store.getDefaultId()) {
		void connect(ext);
	}
	void lsp.start();
	// Мульти-рут: активная папка определяет проект для индекса, SSH и LSP.
	let activeScope = resolveLayout()?.siteRoot;
	const onScopeChange = (): void => {
		lsp.syncScope();
		const next = resolveLayout()?.siteRoot;
		if (next === activeScope) {
			return;
		}
		activeScope = next;
		indexView.refresh();
		if (!next || !readSettings().indexEnabled) {
			return;
		}
		statusBar.setIndexing(true);
		void indexer
			.sync((message) => log().info(message))
			.then(() => {
				lsp.refreshDiagnostics();
			})
			.catch((err) => log().warn(`Индексация активной папки: ${errorMessage(err)}`))
			.finally(() => {
				statusBar.setIndexing(false);
				indexView.refresh();
			});
	};
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => onScopeChange()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => onScopeChange()),
	);
	return ext;
}

export async function deactivate(): Promise<void> {
	log().info('Bitrix Assistant деактивируется');
}

function registerWatchers(context: vscode.ExtensionContext, ext: ActiveExtension): void {
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async (document) => {
			if (document.uri.scheme !== 'file') {
				return;
			}
			const settings = readSettings();
			if (settings.indexEnabled) {
				const file = path.normalize(document.uri.fsPath);
				if (recentIndexed.size > 500) {
					recentIndexed.clear();
				}
				recentIndexed.set(file, Date.now() + 2000);
				void refreshSingleIndexedFile(ext, document.uri.fsPath).catch((err) =>
					log().debug(`Индексация ${file}: ${errorMessage(err)}`),
				);
			}
			if (!settings.uploadOnSave || !ext.connections.isConnected) {
				return;
			}
			if (!ext.sync.toRemotePath(document.uri.fsPath)) {
				return;
			}
			if (ext.sync.isExcludedPath(document.uri.fsPath)) {
				return;
			}
			const name = path.basename(document.uri.fsPath);
			const stopSpin = spinUpload(name);
			try {
				const outcome = await ext.sync.upload(document.uri.fsPath);
				stopSpin();
				if (outcome === 'uploaded') {
					log().info(`Загружено: ${document.uri.fsPath}`);
					flashUploaded(name);
				} else if (outcome === 'identical') {
					log().debug(`Без изменений (содержимое совпадает): ${document.uri.fsPath}`);
					flashIdentical(name);
				}
			} catch (err) {
				stopSpin();
				flashFailed(name);
				void vscode.window.showErrorMessage(`Bitrix Assistant: не удалось загрузить ${name}. ${errorMessage(err)}`);
			}
		}),
		vscode.workspace.onDidOpenTextDocument(async (document) => {
			const settings = readSettings();
			if (!settings.downloadOnOpen || !ext.connections.isConnected) {
				return;
			}
			if (document.uri.scheme !== 'file' || document.isDirty) {
				return;
			}
			const remotePath = ext.sync.toRemotePath(document.uri.fsPath);
			if (!remotePath || ext.sync.isExcludedPath(document.uri.fsPath)) {
				return;
			}
			try {
				const info = await ext.connections.stat(remotePath);
				if (!info) {
					return;
				}
				const local = await fs.promises.stat(document.uri.fsPath).catch(() => undefined);
				const localSeconds = local ? Math.round(local.mtimeMs / 1000) : 0;
				if (info.mtime <= localSeconds) {
					return;
				}
				await ext.sync.download(remotePath, document.uri.fsPath);
				if (!document.isDirty && vscode.window.activeTextEditor?.document === document) {
					await vscode.commands.executeCommand('workbench.action.files.revert');
				}
			} catch (err) {
				log().warn(`downloadOnOpen: ${errorMessage(err)}`);
			}
		}),
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (
				event.affectsConfiguration('bitrix.lsp') ||
				event.affectsConfiguration('bitrix.js.enableLibraryCheck') ||
				event.affectsConfiguration('bitrix.index.bitrixPath') ||
				event.affectsConfiguration('bitrix.php.version')
			) {
				await ext.lsp.restart();
			}
			if (event.affectsConfiguration('bitrix.ssh.exclude')) {
				ext.tree.refresh();
			}
			if (event.affectsConfiguration('bitrix.index')) {
				ext.indexView.refresh();
			}
		}),
	);
}

function setupIndexWatchers(context: vscode.ExtensionContext, ext: ActiveExtension): void {
	const pending = new Map<string, NodeJS.Timeout>();
	const handle = (uri: vscode.Uri, deleted: boolean): void => {
		if (uri.scheme !== 'file') {
			return;
		}
		const owner = vscode.workspace.getWorkspaceFolder(uri);
		const layout = owner ? resolveLayout(owner) : undefined;
		if (!layout) {
			return;
		}
		// Индексер ведёт одну активную папку; изменения в остальных подхватит
		// sync при переключении активной папки.
		if (layout.siteRoot !== resolveLayout()?.siteRoot) {
			return;
		}
		const settings = readSettings(uri);
		if (!settings.indexEnabled) {
			return;
		}
		const file = path.normalize(uri.fsPath);
		if (!file.startsWith(layout.siteRoot)) {
			return;
		}
		if (!isIndexableSource(file, layout)) {
			return;
		}
		if (isExcluded(path.relative(layout.siteRoot, file), settings.indexExclude)) {
			return;
		}
		if ((recentIndexed.get(file) ?? 0) > Date.now()) {
			recentIndexed.delete(file);
			return;
		}
		const previous = pending.get(file);
		if (previous) {
			clearTimeout(previous);
		}
		pending.set(
			file,
			setTimeout(async () => {
				pending.delete(file);
				try {
					const changed = deleted
						? await ext.indexer.removeFile(file)
						: await ext.indexer.reindexFile(vscode.Uri.file(file));
					if (changed) {
						ext.indexView.refresh();
						ext.lsp.refreshDiagnostics();
					}
				} catch (err) {
					log().warn(`Автоиндексация ${file}: ${errorMessage(err)}`);
				}
			}, 250),
		);
	};

	const watched = new Set<string>();
	const addFolder = (folder: vscode.WorkspaceFolder): void => {
		const layout = resolveLayout(folder);
		if (!layout) {
			return;
		}
		for (const root of [layout.bitrixDir, layout.localDir]) {
			if (watched.has(root) || !fs.existsSync(root)) {
				continue;
			}
			watched.add(root);
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.Uri.file(root), '**/*.{php,js,ts}'),
			);
			watcher.onDidChange((uri) => handle(uri, false));
			watcher.onDidCreate((uri) => handle(uri, false));
			watcher.onDidDelete((uri) => handle(uri, true));
			context.subscriptions.push(watcher);
		}
	};
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		addFolder(folder);
	}
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders((event) => {
			for (const folder of event.added) {
				addFolder(folder);
			}
		}),
		{
			dispose: () => {
				for (const timer of pending.values()) {
					clearTimeout(timer);
				}
				pending.clear();
			},
		},
	);
}

async function refreshSingleIndexedFile(ext: ActiveExtension, localPath: string): Promise<void> {
	if (!readSettings().indexEnabled) {
		return;
	}
	const changed = await ext.indexer.reindexFile(vscode.Uri.file(localPath));
	if (changed) {
		ext.indexView.refresh();
		ext.lsp.refreshDiagnostics();
	}
}

async function syncIndexAfterSsh(ext: ActiveExtension): Promise<void> {
	if (!readSettings().indexEnabled) {
		return;
	}
	ext.statusBar.setIndexing(true);
	try {
		await ext.indexer.sync((message) => log().info(message));
		ext.indexView.refresh();
		ext.lsp.refreshDiagnostics();
	} catch (err) {
		log().warn(`Индекс после SSH: ${errorMessage(err)}`);
	} finally {
		ext.statusBar.setIndexing(false);
	}
}

async function selectPhpVersion(ext: ActiveExtension): Promise<void> {
	const uri = vscode.window.activeTextEditor?.document.uri;
	const project = ext.phpProjects.projectName(uri);
	const current = ext.phpProjects.version(uri);
	const versions = ['auto', ...SELECTABLE_PHP_VERSIONS];
	const picked = await vscode.window.showQuickPick(
		versions.map((version) => ({
			label: version === 'auto' ? 'auto' : `PHP ${version}`,
			description:
				version === current
					? 'текущая'
					: version === 'auto'
						? 'что установлено на ПК (php из PATH), иначе встроенный PHP 8.4'
						: version === BUNDLED_PHP_VERSION
							? `встроенный PHP ${BUNDLED_PHP_VERSION}`
							: `php -l версии ${version} — нужен установленный PHP или путь`,
			version,
		})),
		{
			title: `Версия PHP для проекта «${project}»`,
			placeHolder: `Сейчас: ${current}. Версия хранится для проекта в состоянии расширения.`,
		},
	);
	if (!picked) {
		return;
	}
	await ext.phpProjects.setVersion(uri, picked.version);
	void vscode.window.showInformationMessage(
		`Bitrix Assistant: PHP ${picked.version} для проекта «${project}». Если версии нет — скачайте её или укажите путь командой «указать путь к PHP».`,
	);
	await ext.phpSyntax.verifySelectedRuntime();
}

async function connect(ext: ActiveExtension): Promise<void> {
	const defaultId = ext.store.getDefaultId();
	const defaultProfile = defaultId ? ext.store.find(defaultId) : undefined;
	const picked = defaultProfile ?? (await pickProfile(ext.store));
	if (picked === 'delete') {
		return;
	}
	let profile = picked;
	if (!profile) {
		const created = await ext.store.promptNew();
		if (!created) {
			return;
		}
		await ext.store.upsert(created.profile, created.secret);
		profile = created.profile;
	}
	await connectToProfile(ext, profile);
}

/** Терминал на сервере по сохранённому SSH-профилю — без ввода логина и пароля. */
async function openServerTerminal(ext: ActiveExtension): Promise<void> {
	const defaultId = ext.store.getDefaultId();
	const picked = ext.connections.activeProfile
		?? (defaultId ? ext.store.find(defaultId) : undefined)
		?? (await pickProfile(ext.store));
	if (!picked || picked === 'delete') {
		return;
	}
	const profile = picked;
	const pty = new SshTerminal(profile, () => ext.connections.openShell(profile));
	const terminal = vscode.window.createTerminal({
		name: `SSH: ${profile.name}`,
		iconPath: new vscode.ThemeIcon('remote'),
		pty,
	});
	terminal.show();
}

async function switchProfile(ext: ActiveExtension): Promise<void> {
	const picked = await pickProfile(ext.store, true);
	if (picked === 'delete') {
		await removeProfile(ext);
		return;
	}
	const profile = picked;
	if (!profile) {
		const created = await ext.store.promptNew();
		if (!created) {
			return;
		}
		await ext.store.upsert(created.profile, created.secret);
		await connectToProfile(ext, created.profile);
		return;
	}
	await connectToProfile(ext, profile);
}

async function connectToProfile(ext: ActiveExtension, profile: SshProfile): Promise<void> {
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Подключение к ${profile.name}` },
			() => ext.connections.connect(profile!),
		);
		await vscode.commands.executeCommand('setContext', 'bitrix.sshConnected', true);
		ext.tree.refresh();
		ext.statusBar.update();
		void vscode.window.showInformationMessage(
			`Bitrix Assistant: подключено к ${profile.username}@${profile.host}:${profile.port}`,
		);
	} catch (err) {
		void vscode.window.showErrorMessage(`Bitrix Assistant: SSH-подключение не удалось. ${errorMessage(err)}`);
	}
}

async function pickProfile(
	store: ProfileStore,
	allowDelete = false,
): Promise<SshProfile | 'delete' | undefined> {
	const profiles = store.list();
	if (profiles.length === 0) {
		return undefined;
	}
	const defaultId = store.getDefaultId();
	const ordered = [...profiles].sort((left, right) => {
		if (left.id === defaultId) {
			return -1;
		}
		if (right.id === defaultId) {
			return 1;
		}
		return left.name.localeCompare(right.name, 'ru');
	});
	// Помечаем профили без сохранённого пароля: иначе неочевидно, почему
	// подключение спрашивает пароль.
	const items: Array<{ label: string; description: string; detail: string; profile?: SshProfile }> = [];
	for (const profile of ordered) {
		const secret = await store.secrets(profile);
		const hasSecret = profile.authType === 'password' ? Boolean(secret.password) : Boolean(profile.privateKeyPath);
		items.push({
			label: `${profile.id === defaultId ? '$(star-full) ' : ''}${profile.name}`,
			description: `${profile.username}@${profile.host}:${profile.port}`
				+ (profile.id === defaultId ? ' · по умолчанию' : '')
				+ (hasSecret ? '' : ' · пароль не сохранён'),
			detail: profile.remoteRoot,
			profile,
		});
	}
	if (allowDelete) {
		items.push({
			label: '$(trash) Удалить SSH-профиль…',
			description: 'выбрать и удалить',
			detail: '',
		});
	}
	const picked = await vscode.window.showQuickPick(items, {
		title: 'SSH-профиль',
		placeHolder: 'Выберите сервер',
	});
	if (picked?.label.startsWith('$(trash)')) {
		return 'delete';
	}
	return picked?.profile;
}

async function setDefaultProfile(ext: ActiveExtension): Promise<void> {
	const profile = await pickProfile(ext.store);
	if (!profile || profile === 'delete') {
		return;
	}
	await ext.store.setDefaultId(profile.id);
	ext.statusBar.update();
	void vscode.window.showInformationMessage(`Bitrix Assistant: сервер по умолчанию — ${profile.name}`);
}

async function saveAndUpload(ext: ActiveExtension): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file') {
		void vscode.window.showWarningMessage('Bitrix Assistant: откройте локальный файл');
		return;
	}
	const uri = editor.document.uri;
	if (editor.document.isDirty) {
		await editor.document.save();
	}
	if (!ext.connections.isConnected) {
		void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
		return;
	}
	const name = path.basename(uri.fsPath);
	try {
		const outcome = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Bitrix Assistant: загрузка ${name}`,
				cancellable: false,
			},
			() => ext.sync.upload(uri.fsPath),
		);
		if (outcome === 'uploaded') {
			ext.tree.refresh();
			flashUploaded(name);
			void vscode.window.showInformationMessage(`Bitrix Assistant: ${name} загружен на сервер`);
		} else if (outcome === 'identical') {
			flashIdentical(name);
		} else if (outcome === 'excluded') {
			void vscode.window.showWarningMessage('Bitrix Assistant: файл исключён из синхронизации');
		}
	} catch (err) {
		flashFailed(name);
		void vscode.window.showErrorMessage(`Bitrix Assistant: не удалось загрузить ${name}. ${errorMessage(err)}`);
	}
}

async function manageHostKeys(ext: ActiveExtension): Promise<void> {
	const keys = ext.store.listHostKeys();
	if (keys.length === 0) {
		void vscode.window.showInformationMessage('Bitrix Assistant: сохранённых host key нет.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		keys.map((key) => ({
			label: `${key.host}:${key.port}`,
			description: key.fingerprint,
		})),
		{ title: 'Известные SSH host key', placeHolder: 'Выберите, чтобы забыть отпечаток' },
	);
	if (!picked) {
		return;
	}
	const separator = picked.label.lastIndexOf(':');
	const host = separator === -1 ? picked.label : picked.label.slice(0, separator);
	const port = separator === -1 ? 22 : Number(picked.label.slice(separator + 1));
	await ext.store.removeHostKey(host, port);
	void vscode.window.showInformationMessage(`Bitrix Assistant: host key ${picked.label} удалён.`);
}

async function addProfile(ext: ActiveExtension): Promise<void> {
	const created = await ext.store.promptNew();
	if (!created) {
		return;
	}
	await ext.store.upsert(created.profile, created.secret);
	void vscode.window.showInformationMessage(`Bitrix Assistant: профиль «${created.profile.name}» сохранён`);
}

async function removeProfile(ext: ActiveExtension): Promise<void> {
	const profile = await pickProfile(ext.store);
	if (!profile || profile === 'delete') {
		return;
	}
	const confirmed = await vscode.window.showWarningMessage(
		`Удалить профиль «${profile.name}»?`,
		{ modal: true },
		'Удалить',
	);
	if (confirmed !== 'Удалить') {
		return;
	}
	if (ext.connections.activeProfile?.id === profile.id) {
		await ext.connections.disconnect();
		await vscode.commands.executeCommand('setContext', 'bitrix.sshConnected', false);
	}
	await ext.store.remove(profile.id);
	ext.tree.refresh();
	ext.statusBar.update();
}

async function disconnect(ext: ActiveExtension): Promise<void> {
	await ext.connections.disconnect();
	await vscode.commands.executeCommand('setContext', 'bitrix.sshConnected', false);
	ext.tree.refresh();
	void vscode.window.showInformationMessage('Bitrix Assistant: SSH отключён');
}

function targetUri(arg?: vscode.Uri): vscode.Uri | undefined {
	if (arg && arg.scheme === 'file') {
		return arg;
	}
	const editor = vscode.window.activeTextEditor;
	if (editor && editor.document.uri.scheme === 'file') {
		return editor.document.uri;
	}
	return undefined;
}

async function upload(ext: ActiveExtension, arg?: vscode.Uri): Promise<void> {
	const uri = targetUri(arg);
	if (!uri) {
		void vscode.window.showWarningMessage('Bitrix Assistant: откройте локальный файл для загрузки');
		return;
	}
	if (!ext.connections.isConnected) {
		void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
		return;
	}
	const name = path.basename(uri.fsPath);
	try {
		const outcome = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Bitrix Assistant: загрузка ${name}`,
				cancellable: false,
			},
			() => ext.sync.upload(uri.fsPath),
		);
		if (outcome === 'uploaded') {
			ext.tree.refresh();
			flashUploaded(name);
			void vscode.window.showInformationMessage(`Bitrix Assistant: ${name} загружен на сервер`);
		} else if (outcome === 'identical') {
			flashIdentical(name);
		} else if (outcome === 'excluded') {
			void vscode.window.showWarningMessage('Bitrix Assistant: файл исключён из синхронизации');
		}
	} catch (err) {
		flashFailed(name);
		void vscode.window.showErrorMessage(`Bitrix Assistant: не удалось загрузить ${name}. ${errorMessage(err)}`);
	}
}

async function download(ext: ActiveExtension, arg?: vscode.Uri): Promise<void> {
	const uri = targetUri(arg);
	if (!uri) {
		void vscode.window.showWarningMessage('Bitrix Assistant: откройте локальный файл для скачивания');
		return;
	}
	if (!ext.connections.isConnected) {
		void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
		return;
	}
	const remotePath = ext.sync.toRemotePath(uri.fsPath);
	if (!remotePath) {
		void vscode.window.showWarningMessage('Bitrix Assistant: файл вне локального корня проекта');
		return;
	}
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Скачивание ${path.basename(uri.fsPath)}` },
			() => ext.sync.download(remotePath, uri.fsPath),
		);
		if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) {
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}
		void refreshSingleIndexedFile(ext, uri.fsPath);
	} catch (err) {
		void vscode.window.showErrorMessage(`Bitrix Assistant: скачивание не удалось. ${errorMessage(err)}`);
	}
}

async function syncAll(ext: ActiveExtension): Promise<void> {
	if (!ext.connections.isConnected) {
		void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		[
			{ label: 'Двусторонняя (по времени изменения)', value: 'both' as SyncMode },
			{ label: 'Только загрузить на сервер', value: 'upload' as SyncMode },
			{ label: 'Только скачать с сервера', value: 'download' as SyncMode },
		],
		{ title: 'Синхронизация' },
	);
	if (!picked) {
		return;
	}
	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Синхронизация проекта',
				cancellable: true,
			},
			async (progress, token) => {
				const result = await ext.sync.syncAll(
					picked.value,
					(message) => progress.report({ message }),
					token,
				);
				void vscode.window.showInformationMessage(
					`Bitrix Assistant: загружено ${result.uploaded}, скачано ${result.downloaded}, без изменений ${result.skipped}`,
				);
				if (result.downloaded > 0) {
					void syncIndexAfterSsh(ext);
				}
			},
		);
	} catch (err) {
		if (err instanceof vscode.CancellationError) {
			return;
		}
		void vscode.window.showErrorMessage(`Bitrix Assistant: синхронизация не удалась. ${errorMessage(err)}`);
	}
}

function remotePathOf(arg?: RemoteNode | string): string | undefined {
	if (typeof arg === 'string' && arg !== '') {
		return arg;
	}
	if (arg && typeof arg === 'object' && typeof arg.remotePath === 'string' && arg.remotePath !== '') {
		return arg.remotePath;
	}
	return undefined;
}

async function previewRemote(ext: ActiveExtension, arg?: RemoteNode | string): Promise<void> {
	const remotePath = remotePathOf(arg);
	if (!remotePath) {
		void vscode.window.showWarningMessage('Bitrix Assistant: не указан файл на сервере');
		return;
	}
	await ext.preview.open(remotePath);
}

async function downloadRemote(ext: ActiveExtension, arg?: RemoteNode | string): Promise<void> {
	const remotePath = remotePathOf(arg);
	if (!remotePath) {
		return;
	}
	if (!ext.connections.isConnected) {
		void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
		return;
	}
	const localPath = ext.sync.toLocalPath(remotePath);
	if (!localPath) {
		void vscode.window.showWarningMessage('Bitrix Assistant: путь вне remoteRoot');
		return;
	}
	try {
		const info = await ext.connections.stat(remotePath);
		if (!info) {
			void vscode.window.showErrorMessage(`Bitrix Assistant: на сервере не найдено ${remotePath}`);
			return;
		}
		const isDirectory = info.type === 'directory';
		if (fs.existsSync(localPath)) {
			const confirmed = await vscode.window.showWarningMessage(
				isDirectory
					? `Локальный каталог уже существует:\n${localPath}\n\nПерезаписать совпадающие файлы?`
					: `Локальный файл уже существует:\n${localPath}\n\nПерезаписать?`,
				{ modal: true },
				'Перезаписать',
			);
			if (confirmed !== 'Перезаписать') {
				return;
			}
		}
		let downloaded = 0;
		let skipped = 0;
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Скачивание ${path.posix.basename(remotePath)}`,
				cancellable: true,
			},
			async (progress, token) => {
				const result = await ext.sync.downloadEntry(
					remotePath,
					(message) => progress.report({ message }),
					token,
				);
				downloaded = result.downloaded;
				skipped = result.skipped;
			},
		);
		if (isDirectory) {
			void syncIndexAfterSsh(ext);
		} else {
			void refreshSingleIndexedFile(ext, localPath);
		}
		const message = `Bitrix Assistant: скачано файлов ${downloaded}${skipped > 0 ? `, пропущено ${skipped}` : ''}`;
		if (isDirectory) {
			void vscode.window.showInformationMessage(message);
			return;
		}
		const choice = await vscode.window.showInformationMessage(message, 'Открыть');
		if (choice === 'Открыть') {
			await vscode.window.showTextDocument(vscode.Uri.file(localPath), { preview: false });
		}
	} catch (err) {
		if (err instanceof vscode.CancellationError) {
			return;
		}
		void vscode.window.showErrorMessage(`Bitrix Assistant: скачивание не удалось. ${errorMessage(err)}`);
	}
}

async function openLocal(ext: ActiveExtension, arg?: RemoteNode | string): Promise<void> {
	const remotePath = remotePathOf(arg);
	if (!remotePath) {
		return;
	}
	const localPath = ext.sync.toLocalPath(remotePath);
	if (!localPath) {
		void vscode.window.showWarningMessage('Bitrix Assistant: путь вне remoteRoot');
		return;
	}
	if (!fs.existsSync(localPath)) {
		const choice = await vscode.window.showWarningMessage(
			`Локальная версия не найдена:\n${localPath}`,
			'Скачать с сервера',
		);
		if (choice === 'Скачать с сервера') {
			await vscode.commands.executeCommand('bitrix.ssh.downloadRemote', remotePath);
		}
		return;
	}
	await vscode.window.showTextDocument(vscode.Uri.file(localPath), { preview: false });
}

async function compareRemote(ext: ActiveExtension, arg?: RemoteNode | string): Promise<void> {
	if (!ext.connections.isConnected) {
		void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
		return;
	}
	// Без аргумента сравниваем файл из активного редактора (палитра команд, меню вкладки).
	let remotePath = remotePathOf(arg);
	if (!remotePath) {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('Bitrix Assistant: откройте локальный файл проекта');
			return;
		}
		remotePath = ext.sync.toRemotePath(editor.document.uri.fsPath);
	}
	if (!remotePath) {
		void vscode.window.showWarningMessage('Bitrix Assistant: файл вне локального корня проекта');
		return;
	}
	const localPath = ext.sync.toLocalPath(remotePath);
	if (!localPath) {
		void vscode.window.showWarningMessage('Bitrix Assistant: путь вне remoteRoot');
		return;
	}
	if (!fs.existsSync(localPath)) {
		const choice = await vscode.window.showWarningMessage(
			`Локальная версия не найдена:\n${localPath}`,
			'Скачать с сервера',
		);
		if (choice === 'Скачать с сервера') {
			await vscode.commands.executeCommand('bitrix.ssh.downloadRemote', remotePath);
		}
		return;
	}
	const state = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'Сравнение с сервером' },
		() => ext.sync.compare(localPath, remotePath),
	);
	if (state === 'missing') {
		const choice = await vscode.window.showWarningMessage(
			`На сервере нет файла ${remotePath}`,
			'Загрузить',
		);
		if (choice === 'Загрузить') {
			await vscode.commands.executeCommand('bitrix.ssh.uploadLocal', remotePath);
		}
		return;
	}
	if (state === 'identical') {
		void vscode.window.setStatusBarMessage(
			`$(check) ${path.basename(localPath)}: содержимое совпадает с сервером`,
			4000,
		);
		return;
	}
	const temp = await ext.preview.fetch(remotePath);
	if (!temp) {
		return;
	}
	await vscode.commands.executeCommand(
		'vscode.diff',
		vscode.Uri.file(localPath),
		vscode.Uri.file(temp),
		`${path.posix.basename(remotePath)} — локально ↔ сервер`,
		{ preview: true },
	);
}

async function cleanupLegacyIndex(ext: ActiveExtension, context: vscode.ExtensionContext): Promise<void> {
	const legacy = path.join(context.globalStorageUri.fsPath, 'bitrix-index.db');
	if (!fs.existsSync(legacy) || path.normalize(legacy) === path.normalize(ext.indexer.dbFile)) {
		void vscode.window.showInformationMessage('Bitrix Assistant: старой глобальной базы индекса нет.');
		return;
	}
	const confirmed = await vscode.window.showWarningMessage(
		`Удалить старую глобальную базу индекса?\n${legacy}`,
		{ modal: true },
		'Удалить',
	);
	if (confirmed !== 'Удалить') {
		return;
	}
	for (const suffix of ['', '-wal', '-shm']) {
		await fs.promises.rm(`${legacy}${suffix}`, { force: true }).catch(() => undefined);
	}
	void vscode.window.showInformationMessage('Bitrix Assistant: старая глобальная база индекса удалена.');
}

async function compactIndex(ext: ActiveExtension): Promise<void> {
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Bitrix Assistant: уплотнение индекса' },
		async () => {
			await ext.indexer.compact();
			ext.indexView.refresh();
			void vscode.window.showInformationMessage('Bitrix Assistant: база индекса уплотнена');
		},
	);
}

async function uploadLocal(ext: ActiveExtension, arg?: RemoteNode | string): Promise<void> {
	const remotePath = remotePathOf(arg);
	if (!remotePath) {
		return;
	}
	if (!ext.connections.isConnected) {
		void vscode.window.showWarningMessage('Bitrix Assistant: нет SSH-подключения');
		return;
	}
	const localPath = ext.sync.toLocalPath(remotePath);
	if (!localPath) {
		void vscode.window.showWarningMessage('Bitrix Assistant: путь вне remoteRoot');
		return;
	}
	const stat = await fs.promises.stat(localPath).catch(() => undefined);
	if (!stat) {
		const choice = await vscode.window.showWarningMessage(
			`Локальная версия не найдена:\n${localPath}`,
			'Скачать с сервера',
		);
		if (choice === 'Скачать с сервера') {
			await vscode.commands.executeCommand('bitrix.ssh.downloadRemote', remotePath);
		}
		return;
	}
	if (stat.isDirectory()) {
		const confirmed = await vscode.window.showWarningMessage(
			`Загрузить каталог на сервер?\n${localPath}\n\nСовпадающие файлы будут перезаписаны.`,
			{ modal: true },
			'Загрузить',
		);
		if (confirmed !== 'Загрузить') {
			return;
		}
	}
	try {
		let uploaded = 0;
		let skipped = 0;
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Загрузка ${path.posix.basename(remotePath)}`,
				cancellable: true,
			},
			async (progress, token) => {
				const result = await ext.sync.uploadEntry(
					localPath,
					(message) => progress.report({ message }),
					token,
				);
				uploaded = result.uploaded;
				skipped = result.skipped;
			},
		);
		ext.tree.refresh();
		const label = path.posix.basename(remotePath);
		if (uploaded > 0) {
			flashUploaded(label);
		} else {
			flashIdentical(label);
		}
		void vscode.window.showInformationMessage(
			`Bitrix Assistant: загружено файлов ${uploaded}${skipped > 0 ? `, пропущено ${skipped}` : ''}`,
		);
	} catch (err) {
		if (err instanceof vscode.CancellationError) {
			return;
		}
		flashFailed(path.posix.basename(remotePath));
		void vscode.window.showErrorMessage(`Bitrix Assistant: загрузка не удалась. ${errorMessage(err)}`);
	}
}

async function copyRemotePath(ext: ActiveExtension, arg?: RemoteNode | string): Promise<void> {
	const remotePath = remotePathOf(arg);
	if (!remotePath) {
		return;
	}
	await vscode.env.clipboard.writeText(remotePath);
	void vscode.window.showInformationMessage(`Bitrix Assistant: путь скопирован — ${remotePath}`);
}

async function showMenu(ext: ActiveExtension): Promise<void> {
	const connected = ext.connections.isConnected;
	const profile = ext.connections.activeProfile;
	interface MenuItem extends vscode.QuickPickItem {
		command?: string;
	}
	const items: MenuItem[] = [];
	if (connected) {
		items.push(
			{ label: '$(debug-disconnect) Отключиться', description: profile?.name, command: 'bitrix.ssh.disconnect' },
			{ label: '$(sync) Синхронизировать всё', command: 'bitrix.ssh.syncAll' },
			{ label: '$(refresh) Обновить дерево', command: 'bitrix.ssh.refresh' },
		);
	} else {
		items.push(
			{ label: '$(plug) Подключиться к серверу', command: 'bitrix.ssh.connect' },
			{ label: '$(add) Добавить профиль', command: 'bitrix.ssh.addProfile' },
		);
	}
	if (ext.store.list().length > 0) {
		items.push({ label: '$(trash) Удалить SSH-профиль', command: 'bitrix.ssh.removeProfile' });
	}
	items.push(
		{ label: '$(database) Статистика индекса', command: 'bitrix.index.stats' },
		{ label: '$(refresh) Перестроить индекс', command: 'bitrix.index.rebuild' },
		{ label: '$(output) Показать лог', command: 'bitrix.showLog' },
	);
	const picked = await vscode.window.showQuickPick(items, {
		title: 'Bitrix Assistant',
		placeHolder: connected ? `${profile?.username}@${profile?.host}` : 'Нет SSH-подключения',
	});
	if (picked?.command) {
		await vscode.commands.executeCommand(picked.command);
	}
}

/**
 * Проверка всего проекта после индексации (настройка bitrix.diagnostics.projectScan).
 * Ошибки не показываем: если LSP не поднялся, диагностика придёт по открытым файлам.
 */
async function runProjectScan(ext: ActiveExtension): Promise<void> {
	const config = vscode.workspace.getConfiguration('bitrix');
	if (!config.get<boolean>('diagnostics.projectScan', true)) {
		return;
	}
	const limit = config.get<number>('diagnostics.projectLimit', 500);
	try {
		const result = await ext.lsp.diagnoseAll(limit);
		log().info(`Проверка проекта: файлов ${result.files}, диагностик ${result.diagnostics}`);
	} catch (err) {
		log().debug(`Проверка проекта пропущена: ${errorMessage(err)}`);
	}
}

async function runIndexCommand(ext: ActiveExtension, full: boolean): Promise<void> {
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: full ? 'Bitrix Assistant: перестройка индекса' : 'Bitrix Assistant: обновление индекса',
			cancellable: true,
		},
		async (progress, token) => {
			ext.statusBar.setIndexing(true);
			try {
				const report = (message: string): void => progress.report({ message });
				if (full) {
					await ext.indexer.rebuild(report, token);
					// Атомарная замена файла: у LSP остаётся дескриптор старой базы.
					await ext.lsp.restart();
				} else {
					await ext.indexer.sync(report, token);
				}
				ext.indexView.refresh();
				ext.lsp.refreshDiagnostics();
				void runProjectScan(ext);
						const stats = await ext.indexer.stats();
				if (stats) {
					void vscode.window.showInformationMessage(
						`Bitrix Assistant: индекс обновлён — классов ${stats.classes}, методов ${stats.methods}, JS-расширений ${stats.jsExtensions}, JS-глобалов ${stats.jsGlobals}`,
					);
				}
			} catch (err) {
				if (err instanceof vscode.CancellationError) {
					return;
				}
				void vscode.window.showErrorMessage(`Bitrix Assistant: индексация не удалась. ${errorMessage(err)}`);
			} finally {
				ext.statusBar.setIndexing(false);
			}
		},
	);
}

async function reindexActiveFile(ext: ActiveExtension): Promise<void> {
	const uri = targetUri();
	if (!uri) {
		return;
	}
	const changed = await ext.indexer.reindexFile(uri);
	ext.indexView.refresh();
	if (changed) {
		ext.lsp.refreshDiagnostics();
	}
	void vscode.window.showInformationMessage(
		changed ? 'Bitrix Assistant: файл переиндексирован' : 'Bitrix Assistant: файл не входит в индекс',
	);
}

async function showStats(ext: ActiveExtension): Promise<void> {
	const stats = await ext.indexer.stats();
	if (!stats) {
		void vscode.window.showWarningMessage('Bitrix Assistant: индекс недоступен');
		return;
	}
	const lines = [
		`PHP-классы: ${stats.classes}`,
		`PHP-методы: ${stats.methods}`,
		`Компоненты: ${stats.components}`,
		`JS-расширения: ${stats.jsExtensions}`,
		`JS-глобалы: ${stats.jsGlobals}`,
		`Файл: ${stats.dbFile}`,
	];
	log().info(lines.join('\n'));
	void vscode.window.showInformationMessage(`Bitrix Assistant: индекс\n${lines.join('\n')}`, 'Показать лог').then((choice) => {
		if (choice === 'Показать лог') {
			showLog();
		}
	});
	const layout = resolveLayout();
	log().info(`Корень проекта: ${layout?.siteRoot ?? 'не найден'}`);
}

async function generateAnnotations(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		void vscode.window.showWarningMessage('Bitrix Assistant: откройте *Table.php');
		return;
	}
	const document = editor.document;
	if (document.languageId !== 'php') {
		void vscode.window.showWarningMessage('Bitrix Assistant: команда работает только для PHP-файлов');
		return;
	}
	const result = generateOrmAnnotation(document.getText());
	if (!result) {
		void vscode.window.showWarningMessage(
			'Bitrix Assistant: не найден класс таблицы с полями ORM (getMap + new *Field)',
		);
		return;
	}
	const edit = new vscode.WorkspaceEdit();
	if (result.existingDoc) {
		const endLineText = document.lineAt(result.existingDoc.endLine).text;
		edit.replace(
			document.uri,
			new vscode.Range(result.existingDoc.startLine, 0, result.existingDoc.endLine, endLineText.length),
			result.docblock,
		);
	} else {
		edit.insert(document.uri, new vscode.Position(result.classLine, 0), `${result.docblock}\n`);
	}
	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		void vscode.window.showErrorMessage('Bitrix Assistant: не удалось применить правку');
		return;
	}
	if (readSettings().uploadOnSave) {
		await document.save();
	}
	void vscode.window.showInformationMessage(
		`Bitrix Assistant: аннотации сгенерированы для ${result.fields.length} полей`,
	);
}
