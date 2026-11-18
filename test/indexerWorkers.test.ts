import './support/vscodeMock';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { BitrixIndexer } from '../src/indexer/indexer';
import { mockFolder, mockState } from './support/vscodeMock';

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

/** Площадка чуть больше порога воркеров (150 файлов), чтобы включился разбор в потоках. */
function makeSite(root: string): void {
	const site = path.join(root, 'site');
	const bitrix = path.join(site, 'bitrix');
	for (let index = 0; index < 200; index++) {
		write(
			path.join(bitrix, 'modules', `module${index % 5}`, 'lib', `Class${index}.php`),
			`<?php\nnamespace Demo\\M${index % 5};\n\nclass Class${index}\n{\n`
				+ `\t/** Метод. */\n\tpublic function run(array $params = []): array { return $params; }\n`
				+ `\tpublic function stop(): void {}\n}\n`,
		);
	}
	write(path.join(bitrix, 'modules', 'main', 'include.php'), '<?php\n');
	write(path.join(bitrix, 'modules', 'main', 'jscore.php'), '<?php\n$arJSCoreConfig = [];\n');
	for (let index = 0; index < 160; index++) {
		const directory = path.join(bitrix, 'js', 'demo', `ext${index}`);
		write(
			path.join(directory, 'script.js'),
			`BX.namespace('BX.Demo.Ext${index}');\nBX.Demo.Ext${index} = { init: function(options) { this.options = options; } };\n`,
		);
		write(
			path.join(directory, 'config.php'),
			`<?php\n$arJsConfig = ["demo_ext${index}" => ["js" => "/bitrix/js/demo/ext${index}/script.js"]];\n`,
		);
	}
	mockState.folders = [mockFolder(site)];
}

async function buildIndex(siteRoot: string, storage: string, threads: number): Promise<BitrixIndexer> {
	mockState.settings = {
		index: { enabled: true, phpStubs: true, vendor: true, exclude: [], bitrixPath: 'bitrix', threads },
	};
	const indexer = new BitrixIndexer({
		extensionPath: siteRoot,
		storageUri: { fsPath: storage },
		globalStorageUri: { fsPath: storage },
	} as never);
	await indexer.rebuild(() => undefined);
	return indexer;
}

function dump(db: { all<T>(sql: string): T[] }): Record<string, unknown> {
	return {
		classes: db.all('SELECT fqcn, name, namespace, line FROM classes ORDER BY fqcn'),
		methods: db.all('SELECT class_fqcn, name, signature FROM methods ORDER BY class_fqcn, name'),
		jsGlobals: db.all('SELECT name, type, extension_name FROM js_globals ORDER BY name'),
		jsExtensions: db.all('SELECT name FROM js_extensions ORDER BY name'),
		components: db.all('SELECT name, namespace, module FROM components ORDER BY name'),
	};
}

test('индексатор: разбор в воркерах и в основном потоке даёт одинаковый индекс', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-workers-'));
	try {
		makeSite(root);
		const site = path.join(root, 'site');
		const single = await buildIndex(site, path.join(root, 'storage-1'), 1);
		const singleDump = dump(await single.ensureOpen() as never);
		single.dispose();

		const parallel = await buildIndex(site, path.join(root, 'storage-2'), 2);
		const parallelDump = dump(await parallel.ensureOpen() as never);
		parallel.dispose();

		assert.ok((singleDump.classes as unknown[]).length > 0, 'индекс собрался');
		assert.deepEqual(parallelDump, singleDump);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('индексатор: отмена прерывает перестройку', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-cancel-'));
	try {
		makeSite(root);
		mockState.settings = {
			index: { enabled: true, phpStubs: true, vendor: true, exclude: [], bitrixPath: 'bitrix', threads: 2 },
		};
		const indexer = new BitrixIndexer({
			extensionPath: root,
			storageUri: { fsPath: path.join(root, 'storage') },
			globalStorageUri: { fsPath: path.join(root, 'storage') },
		} as never);
		const token = {
			isCancellationRequested: true,
			onCancellationRequested: () => ({ dispose: () => undefined }),
		};
		await assert.rejects(() => indexer.rebuild(() => undefined, token as never));
		indexer.dispose();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
