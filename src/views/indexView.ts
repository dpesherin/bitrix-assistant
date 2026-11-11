import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { BitrixIndexer } from '../indexer/indexer';
import { formatNumber, formatSize } from '../util/format';

interface IconSpec {
	id: string;
	color: string;
}

class IndexNode extends vscode.TreeItem {
	children: IndexNode[] = [];

	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		options: {
			description?: string;
			icon?: IconSpec;
			command?: vscode.Command;
			tooltip?: string | vscode.MarkdownString;
		} = {},
	) {
		super(label, collapsibleState);
		this.description = options.description;
		this.tooltip = options.tooltip;
		this.command = options.command;
		if (options.icon) {
			this.iconPath = new vscode.ThemeIcon(options.icon.id, new vscode.ThemeColor(options.icon.color));
		}
	}
}

/** Панель «Индекс»: сгруппированная сводка по SQLite-базе и быстрые действия. */
export class IndexViewProvider implements vscode.TreeDataProvider<IndexNode> {
	private readonly emitter = new vscode.EventEmitter<IndexNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly indexer: BitrixIndexer) {}

	refresh(): void {
		this.emitter.fire();
	}

	getTreeItem(element: IndexNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: IndexNode): Promise<IndexNode[]> {
		if (element) {
			return element.children;
		}
		return this.buildRoot();
	}

	private async buildRoot(): Promise<IndexNode[]> {
		const stats = await this.indexer.stats();
		if (!stats) {
			return [
				new IndexNode('Индекс недоступен', vscode.TreeItemCollapsibleState.None, {
					description: 'node:sqlite не поддерживается',
					icon: { id: 'warning', color: 'charts.orange' },
				}),
			];
		}

		const core = new IndexNode('Ядро и модули', vscode.TreeItemCollapsibleState.Expanded, {
			icon: { id: 'shield', color: 'charts.blue' },
			tooltip: 'PHP-классы, методы, функции, константы и компоненты из bitrix/ и local/',
		});
		core.children = [
			new IndexNode('PHP-классы', vscode.TreeItemCollapsibleState.None, {
				description: formatNumber(stats.classes),
				icon: { id: 'symbol-class', color: 'charts.purple' },
			}),
			new IndexNode('PHP-методы', vscode.TreeItemCollapsibleState.None, {
				description: formatNumber(stats.methods),
				icon: { id: 'symbol-method', color: 'charts.purple' },
			}),
			new IndexNode('PHP-функции', vscode.TreeItemCollapsibleState.None, {
				description: formatNumber(stats.functions),
				icon: { id: 'symbol-function', color: 'charts.purple' },
			}),
			new IndexNode('PHP-константы', vscode.TreeItemCollapsibleState.None, {
				description: formatNumber(stats.phpConstants),
				icon: { id: 'symbol-constant', color: 'charts.purple' },
			}),
			new IndexNode('Компоненты', vscode.TreeItemCollapsibleState.None, {
				description: formatNumber(stats.components),
				icon: { id: 'symbol-module', color: 'charts.blue' },
			}),
		];

		const javascript = new IndexNode('JavaScript', vscode.TreeItemCollapsibleState.Expanded, {
			icon: { id: 'symbol-namespace', color: 'charts.yellow' },
			tooltip: 'Расширения из config.php и глобальные объекты BX.*',
		});
		javascript.children = [
			new IndexNode('Расширения', vscode.TreeItemCollapsibleState.None, {
				description: formatNumber(stats.jsExtensions),
				icon: { id: 'package', color: 'charts.yellow' },
			}),
			new IndexNode('Глобальные объекты', vscode.TreeItemCollapsibleState.None, {
				description: formatNumber(stats.jsGlobals),
				icon: { id: 'symbol-variable', color: 'charts.yellow' },
			}),
		];

		const databaseSize = await fs.promises
			.stat(this.indexer.dbFile)
			.then((stat) => stat.size)
			.catch(() => 0);
		const database = new IndexNode('База индекса', vscode.TreeItemCollapsibleState.None, {
			description: databaseSize > 0 ? formatSize(databaseSize) : 'bitrix-index.db',
			icon: { id: 'database', color: 'charts.green' },
			tooltip: this.indexer.dbFile,
			command: { command: 'bitrix.index.stats', title: 'Статистика индекса' },
		});

		const actions = new IndexNode('Действия', vscode.TreeItemCollapsibleState.Expanded, {
			icon: { id: 'tools', color: 'descriptionForeground' },
		});
		actions.children = [
			new IndexNode('Перестроить индекс', vscode.TreeItemCollapsibleState.None, {
				icon: { id: 'refresh', color: 'charts.blue' },
				command: { command: 'bitrix.index.rebuild', title: 'Перестроить индекс' },
			}),
			new IndexNode('Переиндексировать файл', vscode.TreeItemCollapsibleState.None, {
				icon: { id: 'file-sync', color: 'charts.blue' },
				command: { command: 'bitrix.index.reindexFile', title: 'Переиндексировать файл' },
			}),
			new IndexNode('Уплотнить базу (VACUUM)', vscode.TreeItemCollapsibleState.None, {
				icon: { id: 'database', color: 'charts.green' },
				command: { command: 'bitrix.index.compact', title: 'Уплотнить базу' },
			}),
			new IndexNode('Статистика и путь к базе', vscode.TreeItemCollapsibleState.None, {
				icon: { id: 'info', color: 'charts.blue' },
				command: { command: 'bitrix.index.stats', title: 'Статистика' },
			}),
			new IndexNode('Показать лог', vscode.TreeItemCollapsibleState.None, {
				icon: { id: 'output', color: 'descriptionForeground' },
				command: { command: 'bitrix.showLog', title: 'Показать лог' },
			}),
		];

		return [core, javascript, database, actions];
	}
}
