import * as path from 'node:path';
import * as vscode from 'vscode';
import { readSettings } from '../settings';
import { isExcluded, toPosix } from '../util/glob';
import { SshConnectionManager } from './connection';
import { formatMtime, formatSize } from '../util/format';
import { RemoteEntry } from './types';

export type RemoteNodeKind = 'root' | 'directory' | 'file';

export class RemoteNode extends vscode.TreeItem {
	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		readonly kind: RemoteNodeKind,
		readonly remotePath: string,
		readonly entry?: RemoteEntry,
	) {
		super(label, collapsibleState);
		this.contextValue = kind === 'file' ? 'remoteFile' : kind === 'root' ? 'remoteRoot' : 'remoteDirectory';
	}
}

/** Дерево удалённой файловой системы: файлы открываются только для просмотра. */
export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteNode> {
	private readonly emitter = new vscode.EventEmitter<RemoteNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly connections: SshConnectionManager) {
		this.connections.onDidChangeConnection(() => this.refresh());
	}

	refresh(): void {
		this.emitter.fire();
	}

	getTreeItem(element: RemoteNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: RemoteNode): Promise<RemoteNode[]> {
		const profile = this.connections.activeProfile;
		if (!profile) {
			return [];
		}
		if (!element) {
			const root = new RemoteNode(
				profile.name,
				vscode.TreeItemCollapsibleState.Expanded,
				'root',
				profile.remoteRoot,
			);
			root.id = `bitrix-remote:${profile.remoteRoot}`;
			root.description = `${profile.username}@${profile.host}`;
			root.iconPath = new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue'));
			const tooltip = new vscode.MarkdownString();
			tooltip.appendMarkdown(`**${profile.name}**\n\n`);
			tooltip.appendMarkdown(`\`${profile.username}@${profile.host}:${profile.port}\`\n\n`);
			tooltip.appendMarkdown(`Корень: \`${profile.remoteRoot}\`\n\n`);
			tooltip.appendMarkdown('Файлы открываются только для просмотра.');
			root.tooltip = tooltip;
			return [root];
		}
		if (element.kind === 'file') {
			return [];
		}
		return this.readDirectory(element.remotePath);
	}

	private async readDirectory(dir: string): Promise<RemoteNode[]> {
		const profile = this.connections.activeProfile;
		if (!profile) {
			return [];
		}
		let entries: RemoteEntry[];
		try {
			entries = await this.connections.readdir(dir);
		} catch (err) {
			void vscode.window.showWarningMessage(
				`Bitrix Assistant: не удалось прочитать ${dir}. ${err instanceof Error ? err.message : String(err)}`,
			);
			return [];
		}
		const excludes = readSettings().sshExclude;
		const nodes: RemoteNode[] = [];
		for (const entry of entries) {
			const relative = toPosix(path.posix.relative(profile.remoteRoot, entry.path));
			if (isExcluded(relative, excludes)) {
				continue;
			}
			const isDir = entry.type === 'directory';
			const node = new RemoteNode(
				entry.name,
				isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
				isDir ? 'directory' : 'file',
				entry.path,
				entry,
			);
			node.id = entry.path;
			node.resourceUri = vscode.Uri.file(entry.path);
			// Явный iconPath нужен, потому что удалённый путь не существует
			// локально и тема иконок не всегда применяет file/folder иконки.
			node.iconPath = new vscode.ThemeIcon(isDir ? 'folder' : fileIcon(entry.name));
			node.description = isDir
				? formatMtime(entry.mtime)
				: `${formatSize(entry.size)} · ${formatMtime(entry.mtime)}`;
			const tooltip = new vscode.MarkdownString();
			tooltip.appendMarkdown(`**${entry.name}**\n\n`);
			tooltip.appendMarkdown(`\`${entry.path}\`\n\n`);
			if (!isDir) {
				tooltip.appendMarkdown(`Размер: **${formatSize(entry.size)}**\n\n`);
			}
			tooltip.appendMarkdown(`Изменён: ${formatMtime(entry.mtime)}\n\n`);
			tooltip.appendMarkdown(
				isDir ? 'Каталог на сервере' : 'Файл на сервере · открывается только для просмотра',
			);
			node.tooltip = tooltip;
			if (!isDir) {
				node.command = {
					command: 'bitrix.ssh.preview',
					title: 'Открыть для просмотра',
					arguments: [entry.path],
				};
			}
			nodes.push(node);
		}
		nodes.sort((a, b) => {
			const aDir = a.kind === 'directory' ? 0 : 1;
			const bDir = b.kind === 'directory' ? 0 : 1;
			return (
				aDir - bDir ||
				a.label!.toString().localeCompare(b.label!.toString(), 'ru', { numeric: true })
			);
		});
		return nodes;
	}
}

function fileIcon(name: string): string {
	const ext = path.extname(name).toLowerCase();
	if (['.php', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
		return 'file-code';
	}
	if (['.json', '.jsonc', '.yml', '.yaml', '.xml', '.ini'].includes(ext)) {
		return 'json';
	}
	if (['.md', '.txt', '.log', '.csv'].includes(ext)) {
		return 'file-text';
	}
	if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) {
		return 'file-media';
	}
	if (['.zip', '.gz', '.tar', '.tgz', '.7z', '.rar'].includes(ext)) {
		return 'file-zip';
	}
	return 'file';
}
