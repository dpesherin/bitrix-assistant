import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

type Check = [name: string, run: () => Promise<void> | void];

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('Таймаут ожидания условия');
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export async function run(): Promise<void> {
	const first = process.env.BITRIX_TEST_FIRST ?? '';
	const second = process.env.BITRIX_TEST_SECOND ?? '';
	assert.ok(first && second, 'нет путей тестовых площадок');
	const checks: Check[] = [
		[
			'активация расширения и API',
			async () => {
				const extension = vscode.extensions.getExtension('bitrix-local.bitrix-assistant');
				assert.ok(extension, 'расширение не найдено');
				const api = await extension.activate();
				assert.ok(api?.indexer, 'activate не вернул API');
			},
		],
		[
			'зарегистрированы команды',
			async () => {
				const commands = await vscode.commands.getCommands(true);
				for (const id of ['bitrix.ssh.connect', 'bitrix.index.rebuild', 'bitrix.lsp.restart']) {
					assert.ok(commands.includes(id), `нет команды ${id}`);
				}
			},
		],
		[
			'layout активной папки (мульти-рут)',
			async () => {
				const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
				vscode.workspace.updateWorkspaceFolders(folderCount, 0, { uri: vscode.Uri.file(second) });
				await waitFor(() => (vscode.workspace.workspaceFolders?.length ?? 0) >= 2);
				const file = vscode.Uri.file(`${second}/local/php_interface/init.php`);
				await vscode.workspace.fs.writeFile(file, Buffer.from('<?php\n'));
				const document = await vscode.workspace.openTextDocument(file);
				await vscode.window.showTextDocument(document);
				const { resolveLayout } = require('../../../src/indexer/indexer') as typeof import('../../../src/indexer/indexer');
				await waitFor(() => resolveLayout()?.siteRoot === second);
				assert.equal(resolveLayout()?.siteRoot, second);
			},
		],
		[
			'атомарная перестройка индекса',
			async () => {
				const extension = vscode.extensions.getExtension('bitrix-local.bitrix-assistant');
				const api = (await extension?.activate()) as { indexer: import('../../../src/indexer/indexer').BitrixIndexer };
				await api.indexer.rebuild();
				const stats = await api.indexer.stats();
				assert.ok(stats, 'нет статистики индекса');
				assert.ok(fs.existsSync(stats.dbFile), `нет файла индекса ${stats.dbFile}`);
				assert.ok(stats.classes >= 1, 'класс Demo\Service должен попасть в индекс');
			},
		],
		[
			'php -l: несохранённый untitled PHP',
			async () => {
				const document = await vscode.workspace.openTextDocument({
					language: 'php',
					content: '<?php\nfunction broken( {\n',
				});
				const editor = await vscode.window.showTextDocument(document);
				await new Promise((resolve) => setTimeout(resolve, 300));
				await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), ' '));
				await editor.edit((edit) => edit.delete(new vscode.Range(0, 0, 0, 1)));
				let found = false;
				for (let attempt = 0; attempt < 200 && !found; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 250));
					found = vscode.languages
						.getDiagnostics(document.uri)
						.some((diagnostic) => diagnostic.source === 'bitrix-php');
				}
				assert.ok(
					found,
					`php -l не показал синтаксическую ошибку до сохранения: ${JSON.stringify(
						vscode.languages.getDiagnostics(document.uri).map((item) => [item.source, item.message]),
					)} lang=${document.languageId}`,
				);
			},
		],
		[
			'LSP: несохранённый untitled PHP',
			async () => {
				const extension = vscode.extensions.getExtension('bitrix-local.bitrix-assistant');
				const api = (await extension?.activate()) as { lsp: { isRunning: boolean; restart(): Promise<void> } };
				if (!api.lsp.isRunning) {
					await api.lsp.restart();
				}
				await waitFor(() => api.lsp.isRunning, 30000);
				const document = await vscode.workspace.openTextDocument({
					language: 'php',
					content: '<?php\n$order = [];\n$ord',
				});
				await vscode.window.showTextDocument(document);
				let value = '';
				for (let attempt = 0; attempt < 20 && !/переменная/i.test(value); attempt++) {
					if (attempt > 0) {
						await new Promise((resolve) => setTimeout(resolve, 300));
					}
					const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
						'vscode.executeHoverProvider',
						document.uri,
						new vscode.Position(1, 2),
					);
					value = (hovers ?? [])
						.flatMap((hover) => hover.contents)
						.map((content) => (typeof content === 'string' ? content : content.value))
						.join('\n');
				}
				assert.match(value, /переменная/i, `нет hover переменной: ${value}`);
			},
		],
		[
			'LSP: hover и definition в Extension Host',
			async () => {
				const extension = vscode.extensions.getExtension('bitrix-local.bitrix-assistant');
				const api = (await extension?.activate()) as {
					lsp: { isRunning: boolean; restart(): Promise<void> };
				};
				const secondSite = process.env.BITRIX_TEST_SECOND ?? '';
				const file = vscode.Uri.file(`${secondSite}/local/php_interface/use.php`);
				const document = await vscode.workspace.openTextDocument(file);
				await vscode.window.showTextDocument(document);
				await api.lsp.restart();
				await waitFor(() => api.lsp.isRunning, 30000);
				const text = document.getText();
				const at = (needle: string, shift = 1): vscode.Position =>
					document.positionAt(text.indexOf(needle) + shift);
				let value = '';
				for (let attempt = 0; attempt < 20 && !value.includes('getItems'); attempt++) {
					if (attempt > 0) {
						await new Promise((resolve) => setTimeout(resolve, 300));
					}
					const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
						'vscode.executeHoverProvider',
						document.uri,
						at('getItems'),
					);
					value = (hovers ?? [])
						.flatMap((hover) => hover.contents)
						.map((content) => (typeof content === 'string' ? content : content.value))
						.join('\n');
				}
				assert.ok(value.includes('getItems'), `hover не содержит getItems: ${value}`);
				const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
					'vscode.executeDefinitionProvider',
					document.uri,
					at('Service', 2),
				);
				assert.ok(definitions && definitions.length > 0, 'definition класса не найден');
				assert.ok(
					definitions[0].uri.fsPath.endsWith('classes.php'),
					`definition ведёт в ${definitions[0].uri.fsPath}`,
				);
			},
		],
	];
	const failures: string[] = [];
	for (const [name, check] of checks) {
		try {
			await check();
			console.log(`PASS ${name}`);
		} catch (err) {
			failures.push(`${name}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
			console.error(`FAIL ${name}`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`Провалено проверок: ${failures.length}\n${failures.join('\n')}`);
	}
}
