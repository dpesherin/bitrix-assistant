#!/usr/bin/env node
/**
 * Замер производительности индексатора на синтетической площадке.
 *
 * Строит дерево в форме настоящего проекта (bitrix/modules/<module>/lib,
 * local/components, bitrix/js/<vendor>/<ext>) и гоняет по нему реальный
 * BitrixIndexer: полная перестройка, инкрементальный sync, sync после правки
 * одного файла, переиндексация файла, запросы автодополнения.
 *
 * Запуск: npm run compile && npm run bench:index
 * Параметры: --php 3000 --js 800 --threads 0 (0 — авто, 1 — без воркеров),
 * --keep (не удалять площадку после прогона)
 */
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : Number(args[index + 1]);
};
const phpFiles = option('php', 3000);
const jsFiles = option('js', 800);
const keep = args.includes('--keep');
const threads = option('threads', 0);

let mock;
let indexerModule;
try {
	mock = require(path.join(repoRoot, 'out/test/support/vscodeMock.js'));
	indexerModule = require(path.join(repoRoot, 'out/src/indexer/indexer.js'));
} catch (error) {
	console.error('Сначала соберите TypeScript: npm run compile');
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const vscode = require('vscode');
vscode.window.visibleTextEditors = [];
const { BitrixIndexer } = indexerModule;

/* ---------- площадка ---------- */
const root = mkdtempSync(path.join(tmpdir(), 'bitrix-bench-'));
const site = path.join(root, 'site');
const bitrix = path.join(site, 'bitrix');
const storage = path.join(root, 'storage');

function write(file, content) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function phpClass(index) {
	const namespace = `Perf\\Module${index % 20}`;
	const methods = [];
	for (let method = 0; method < 12; method++) {
		methods.push(
			'\t/**\n'
			+ `\t * Метод ${method} класса ${index}.\n`
			+ '\t * @param array $arParams параметры компонента\n'
			+ '\t * @return array\n'
			+ '\t */\n'
			+ `\tpublic function method${method}(array $arParams = []): array\n`
			+ '\t{\n'
			+ '\t\t$result = [];\n'
			+ '\t\tforeach ($arParams as $key => $value) {\n'
			+ '\t\t\t$result[$key] = $value;\n'
			+ '\t\t}\n'
			+ `\t\t$result['index'] = ${index};\n`
			+ '\t\treturn $result;\n'
			+ '\t}',
		);
	}
	return `<?php\nnamespace ${namespace};\n\nclass Class${index}\n{\n${methods.join('\n\n')}\n}\n`;
}

const generationStarted = performance.now();
for (let index = 0; index < phpFiles; index++) {
	const module = `module${index % 20}`;
	write(path.join(bitrix, 'modules', module, 'lib', `Class${index}.php`), phpClass(index));
	write(
		path.join(site, 'local', 'components', 'perf', `comp${index}`, 'component.php'),
		'<?php\n$arResult = ["ITEMS" => []];\n$this->IncludeComponentTemplate();\n',
	);
}
write(path.join(bitrix, 'modules', 'main', 'include.php'), '<?php\n');
write(path.join(bitrix, 'modules', 'main', 'jscore.php'), '<?php\n$arJSCoreConfig = [];\n');
for (let index = 0; index < jsFiles; index++) {
	const directory = path.join(bitrix, 'js', 'perf', `ext${index}`);
	write(
		path.join(directory, 'script.js'),
		`BX.namespace('BX.Perf.Ext${index}');\nBX.Perf.Ext${index} = { init: function(options) { this.options = options; } };\n`,
	);
	write(
		path.join(directory, 'config.php'),
		`<?php\n$arJsConfig = ["perf_ext${index}" => ["js" => "/bitrix/js/perf/ext${index}/script.js"]];\n`,
	);
}
const generationMs = performance.now() - generationStarted;

mock.mockState.folders = [mock.mockFolder(site)];
mock.mockState.settings = {
	index: { enabled: true, phpStubs: true, vendor: true, exclude: [], bitrixPath: 'bitrix', threads },
};

const context = {
	extensionPath: repoRoot,
	storageUri: { fsPath: storage },
	globalStorageUri: { fsPath: storage },
};

const indexer = new BitrixIndexer(context);

/** Максимальная задержка таймера: показывает, насколько операция занимает event loop. */
async function withLag(run) {
	let last = performance.now();
	let maxLag = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxLag = Math.max(maxLag, now - last - 10);
		last = now;
	}, 10);
	const started = performance.now();
	try {
		await run();
	} finally {
		clearInterval(timer);
	}
	return { ms: performance.now() - started, maxLag };
}

async function time(label, run) {
	const started = performance.now();
	await run();
	const ms = Math.round(performance.now() - started);
	console.log(`${label.padEnd(38)} ${String(ms).padStart(6)} мс`);
	return ms;
}

const size = (file) => {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
};

try {
	console.log(`Node ${process.version}, ${process.platform}/${process.arch}, потоки разбора: ${threads === 0 ? 'авто' : threads}`);
	console.log(`Площадка: PHP ${phpFiles * 2 + 2}, JS ${jsFiles * 2 + 2} файлов, генерация ${Math.round(generationMs)} мс\n`);

	const rebuild = await withLag(() => indexer.rebuild(() => undefined));
	console.log(`${'полная перестройка индекса'.padEnd(38)} ${String(Math.round(rebuild.ms)).padStart(6)} мс`
		+ `  (event loop стоял до ${rebuild.maxLag.toFixed(0)} мс)`);
	const stats = await indexer.stats();
	const dbFile = path.join(storage, 'bitrix-index.db');
	console.log(`  классов ${stats.classes}, методов ${stats.methods}, JS-расширений ${stats.jsExtensions}`);
	console.log(`  база ${(size(dbFile) / 1024 / 1024).toFixed(1)} МБ\n`);

	await time('sync без изменений', () => indexer.sync(() => undefined));
	await time('sync без изменений (повтор)', () => indexer.sync(() => undefined));

	const target = path.join(site, 'local', 'components', 'perf', 'comp7', 'component.php');
	appendFileSync(target, '// правка\n');
	await time('sync после правки одного файла', () => indexer.sync(() => undefined));

	await time('reindexFile одного файла', () => indexer.reindexFile({ scheme: 'file', fsPath: target }));
	await time('compact (VACUUM)', () => indexer.compact());

	const rows = await indexer.completionClasses('Class12', false, 20);
	console.log(`\ncompletionClasses: ${rows.length} строк`);
	const memory = process.memoryUsage();
	console.log(`RSS ${(memory.rss / 1024 / 1024).toFixed(0)} МБ, heap ${(memory.heapUsed / 1024 / 1024).toFixed(0)} МБ`);
} finally {
	indexer.dispose();
	if (keep) {
		console.log(`\nПлощадка сохранена: ${root}`);
	} else {
		rmSync(root, { recursive: true, force: true });
	}
}
