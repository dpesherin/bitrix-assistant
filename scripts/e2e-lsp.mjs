#!/usr/bin/env node
/**
 * E2E-проверка LSP-сервера: поднимает PHP-процесс, шлёт JSON-RPC
 * (initialize → didOpen → completion/hover/definition/codeAction) и проверяет
 * ответы на реальной временной SQLite-базе.
 *
 * Запуск: npm run compile && node scripts/e2e-lsp.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiledDb = path.join(repoRoot, 'out/src/indexer/db.js');

let Database;
try {
	({ Database } = require(compiledDb));
} catch {
	console.error('Сначала соберите TS: npm run compile');
	process.exit(1);
}

const failures = [];
const check = (condition, message) => {
	if (condition) {
		console.log(`  ✓ ${message}`);
	} else {
		failures.push(message);
		console.log(`  ✗ ${message}`);
	}
};

const root = mkdtempSync(path.join(tmpdir(), 'bitrix-e2e-'));
const site = path.join(root, 'site');
const bitrix = path.join(site, 'bitrix');
mkdirSync(path.join(bitrix, 'js/main/popup'), { recursive: true });
writeFileSync(path.join(bitrix, 'js/main/popup/popup.js'), 'BX.Main.Popup = function() {};\n');
const moduleDir = path.join(site, 'local/js/app');
mkdirSync(moduleDir, { recursive: true });
writeFileSync(path.join(moduleDir, 'dep.js'), 'export class Helper {\n\trun() {}\n}\n');
writeFileSync(path.join(moduleDir, 'barrel.js'), "export { Helper as Reexported } from './dep.js';\n");
writeFileSync(
	path.join(site, 'tsconfig.json'),
	JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['local/js/app/*'] } } }, null, 2),
);
const typesDir = path.join(site, 'node_modules/@types/foo');
mkdirSync(typesDir, { recursive: true });
writeFileSync(path.join(typesDir, 'index.d.ts'), 'export declare class Foo {\n\tbar(): void;\n}\n');

const dbPath = path.join(root, 'bitrix-index.db');
const db = await Database.open(dbPath);
db.exec('BEGIN;');
db.run(
	'INSERT INTO js_extensions (name, vendor, path, config_path, js_files_json, rel_json, skip_core) VALUES (?,?,?,?,?,?,?)',
	'main.core',
	'main',
	path.join(bitrix, 'js/main/core'),
	path.join(bitrix, 'js/main/core/config.php'),
	JSON.stringify([path.join(bitrix, 'js/main/core/core.js')]),
	'[]',
	1,
);
db.run(
	'INSERT INTO js_extensions (name, vendor, path, config_path, js_files_json, rel_json, skip_core) VALUES (?,?,?,?,?,?,?)',
	'main.popup',
	'main',
	path.join(bitrix, 'js/main/popup'),
	path.join(bitrix, 'js/main/popup/config.php'),
	JSON.stringify([path.join(bitrix, 'js/main/popup/popup.js')]),
	JSON.stringify(['main.core']),
	0,
);
db.run(
	'INSERT INTO js_extensions (name, vendor, path, config_path, js_files_json, rel_json, skip_core) VALUES (?,?,?,?,?,?,?)',
	'vendor.example',
	'vendor',
	path.join(site, 'local/js/vendor/example'),
	path.join(bitrix, 'js/vendor/example/config.php'),
	JSON.stringify([path.join(site, 'local/js/vendor/example/script.js')]),
	JSON.stringify(['main.popup', 'ghost.lib']),
	0,
);
const insertGlobal = db.run.bind(db);
insertGlobal(
	'INSERT INTO js_globals (name, extension_name, type, source_file, line) VALUES (?,?,?,?,?)',
	'BX.Main',
	'main.core',
	'object',
	path.join(bitrix, 'js/main/core/core.js'),
	5,
);
insertGlobal(
	'INSERT INTO js_globals (name, extension_name, type, source_file, line) VALUES (?,?,?,?,?)',
	'BX.Main.Popup',
	'main.popup',
	'function',
	path.join(bitrix, 'js/main/popup/popup.js'),
	1,
);
insertGlobal(
	`INSERT INTO js_globals
		(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
	 VALUES (?,?,?,?,?,?,?,?,?)`,
	'BX.Demo.runAction',
	'demo',
	'method',
	path.join(site, 'local/js/demo/action.js'),
	3,
	'runAction(action: string, config: Object)',
	'Promise',
	JSON.stringify([
		{ name: 'action', type: 'string', optional: false },
		{ name: 'config', type: 'Object', optional: false },
		{ name: 'config.method', type: 'string', optional: true, defaultValue: 'POST' },
	]),
	'Запускает действие через ajax.',
);
const componentPath = path.join(site, 'local/components/vendor/comp');
mkdirSync(componentPath, { recursive: true });
writeFileSync(
	path.join(componentPath, 'class.php'),
	`<?php
class Comp extends CBitrixComponent
{
	/** @return array{DYNAMIC_KEY: string, ITEMS?: array} */
	public function getData(): array
	{
		return [];
	}

	private ?\\Demo\\Service $service;

	public function executeComponent()
	{
		$this->arResult['ITEMS'] = [];
		$this->arResult = ['TITLE' => ''];
		$this->arResult = $this->getData();
		$data = $this->getData();
		$this->arResult = $data;
		$this->arResult = $this->service->getData();
	}
}
`,
);
insertGlobal(
	'INSERT INTO components (name, namespace, module, path, parameters_file) VALUES (?,?,?,?,?)',
	'comp',
	'vendor',
	'local',
	componentPath,
	path.join(componentPath, '.parameters.php'),
);
const serviceFile = path.join(site, 'local/php_interface/service.php');
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Demo\\Service',
	'Service',
	'Demo',
	'class',
	'demo',
	serviceFile,
	1,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Demo\\Service',
	'getData',
	'getData(): array',
	'array',
	'[]',
	0,
	'public',
	serviceFile,
	2,
	'@return array{CHAIN_KEY: string}',
);
insertGlobal('INSERT INTO params (component, name, type, is_required) VALUES (?,?,?,?)', 'comp', 'DECLARED', 'STRING', 0);
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line, deprecated) VALUES (?,?,?,?,?,?,?,?)',
	'Vendor\\Legacy\\Old',
	'Old',
	'Vendor\\Legacy',
	'class',
	'legacy',
	path.join(bitrix, 'modules/legacy/lib/old.php'),
	7,
	1,
);
insertGlobal('INSERT INTO deprecated (subject) VALUES (?)', 'Vendor\\Legacy\\Old');
const methodFilePath = path.join(site, 'local/php_interface/item_table.php');
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ItemTable',
	'ItemTable',
	'Vendor\\Demo',
	'class',
	'demo',
	methodFilePath,
	4,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ItemTable',
	'getMap',
	'getMap(): array',
	'array',
	'[]',
	0,
	'public',
	methodFilePath,
	7,
	'Возвращает карту полей таблицы.',
);
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\Item',
	'Item',
	'Vendor\\Demo',
	'class',
	'demo',
	methodFilePath,
	20,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\Item',
	'getData',
	'getData(): array',
	'array',
	'[]',
	0,
	'public',
	methodFilePath,
	22,
	'Данные записи.',
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ItemTable',
	'create',
	'create(): ?Item',
	'?Item',
	'[]',
	1,
	'public',
	methodFilePath,
	25,
	'Создаёт запись.',
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ItemTable',
	'find',
	'find(int $id, array $params = []): ?array',
	'?array',
	JSON.stringify([
		{ name: 'id', type: 'int', variadic: false, byRef: false },
		{ name: 'params', type: 'array', default: '[]', variadic: false, byRef: false },
	]),
	1,
	'public',
	methodFilePath,
	9,
	'Ищет запись по ID.',
);

const articlePath = path.join(site, 'local/php_interface/article.php');
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\MetaInterface',
	'MetaInterface',
	'Vendor\\Demo',
	'interface',
	'demo',
	path.join(site, 'local/php_interface/meta_interface.php'),
	3,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\MetaInterface',
	'describe',
	'describe(): string',
	'string',
	'[]',
	0,
	'public',
	path.join(site, 'local/php_interface/meta_interface.php'),
	5,
	'Описание.',
);
insertGlobal(
	'INSERT INTO constants (class_fqcn, name, type, value, doc, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\MetaInterface',
	'KIND',
	'string',
	"'article'",
	'Вид материала.',
	path.join(site, 'local/php_interface/meta_interface.php'),
	4,
);
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\HasMeta',
	'HasMeta',
	'Vendor\\Demo',
	'trait',
	'demo',
	path.join(site, 'local/php_interface/has_meta.php'),
	3,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\HasMeta',
	'meta',
	'meta(): array',
	'array',
	'[]',
	0,
	'public',
	path.join(site, 'local/php_interface/has_meta.php'),
	5,
	'Метаданные.',
);
insertGlobal(
	'INSERT INTO properties (class_fqcn, name, type, default_value, visibility, is_static, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\HasMeta',
	'title',
	'string',
	"''",
	'public',
	0,
	path.join(site, 'local/php_interface/has_meta.php'),
	7,
	'Заголовок.',
);
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line, implements, traits_json) VALUES (?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\Article',
	'Article',
	'Vendor\\Demo',
	'class',
	'demo',
	articlePath,
	3,
	JSON.stringify(['Vendor\\Demo\\MetaInterface']),
	JSON.stringify(['Vendor\\Demo\\HasMeta']),
);

insertGlobal(
	'INSERT INTO php_functions (name, namespace, fqcn, signature, return_type, params_json, doc, deprecated, file, line) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'expect_worker',
	'',
	'expect_worker',
	'expect_worker(\\Vendor\\Demo\\ParentWorker $worker): void',
	'void',
	JSON.stringify([{ name: 'worker', type: '\\Vendor\\Demo\\ParentWorker', variadic: false, byRef: false }]),
	'Принимает рабочего (и его наследников).',
	0,
	path.join(site, 'local/php_interface/functions.php'),
	12,
);
const functionsPath = path.join(site, 'local/php_interface/functions.php');
insertGlobal(
	'INSERT INTO php_functions (name, namespace, fqcn, signature, return_type, params_json, doc, deprecated, file, line) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'test_helper',
	'',
	'test_helper',
	'test_helper(string $value): string',
	'string',
	JSON.stringify([{ name: 'value', type: 'string', variadic: false, byRef: false }]),
	'Тестовая глобальная функция.',
	0,
	functionsPath,
	3,
);
insertGlobal(
	'INSERT INTO php_constants (name, value, doc, file, line) VALUES (?,?,?,?,?)',
	'TEST_FLAG',
	'true',
	'Тестовый флаг.',
	functionsPath,
	5,
);
const parentPath = path.join(site, 'local/php_interface/parent_worker.php');
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ParentWorker',
	'ParentWorker',
	'Vendor\\Demo',
	'class',
	'demo',
	parentPath,
	3,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ParentWorker',
	'work',
	'work(): void',
	'void',
	'[]',
	0,
	'public',
	parentPath,
	5,
	'Выполняет работу компонента.',
);
const childPath = path.join(site, 'local/php_interface/child_worker.php');
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line, extends) VALUES (?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ChildWorker',
	'ChildWorker',
	'Vendor\\Demo',
	'class',
	'demo',
	childPath,
	3,
	'ParentWorker',
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line) VALUES (?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ChildWorker',
	'work',
	'work(): void',
	'void',
	'[]',
	0,
	'public',
	childPath,
	5,
);

const classJs = path.join(site, 'local/js/app/class.js');
insertGlobal(
	`INSERT INTO js_globals
		(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
	 VALUES (?,?,?,?,?,?,?,?,?)`,
	'BX.Demo.create',
	null,
	'function',
	path.join(bitrix, 'js/main/core/core.js'),
	1,
	'create()',
	'Helper',
	'[]',
	null,
);
insertGlobal(
	'INSERT INTO js_types (name, keys_json, extends_json, source_file, line) VALUES (?,?,?,?,?)',
	'BaseOptions',
	JSON.stringify(['icon']),
	'[]',
	path.join(bitrix, 'js/main/core/core.js'),
	1,
);
insertGlobal(
	'INSERT INTO js_types (name, keys_json, extends_json, source_file, line) VALUES (?,?,?,?,?)',
	'ButtonOptions',
	JSON.stringify(['size', 'color']),
	JSON.stringify(['BaseOptions']),
	path.join(bitrix, 'js/main/core/core.js'),
	1,
);
insertGlobal(
	`INSERT INTO js_globals
		(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
	 VALUES (?,?,?,?,?,?,?,?,?)`,
	'BX.UI.Typed',
	null,
	'function',
	path.join(bitrix, 'js/main/core/core.js'),
	1,
	'Typed(options: ButtonOptions)',
	null,
	JSON.stringify([{ name: 'options', type: 'ButtonOptions', optional: false }]),
	null,
);
insertGlobal(
	`INSERT INTO js_globals
		(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
	 VALUES (?,?,?,?,?,?,?,?,?)`,
	'BX.UI.Button',
	null,
	'function',
	path.join(bitrix, 'js/main/core/core.js'),
	1,
	'Button(options?: object)',
	null,
	JSON.stringify([{ name: 'options', type: 'object', optional: true, keys: ['size', 'color', 'icon'] }]),
	null,
);
for (let i = 0; i < 150; i++) {
	insertGlobal(
		`INSERT INTO js_globals
			(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
		'BX.Fake' + String(i).padStart(3, '0'),
		null,
		'object',
		path.join(bitrix, 'js/main/core/core.js'),
		1,
		null,
		null,
		null,
		null,
	);
}
insertGlobal(
	`INSERT INTO js_globals
		(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
	 VALUES (?,?,?,?,?,?,?,?,?)`,
	'Helper',
	null,
	'class',
	path.join(moduleDir, 'dep.js'),
	1,
	null,
	null,
	null,
	null,
);
insertGlobal(
	`INSERT INTO js_globals
		(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
	 VALUES (?,?,?,?,?,?,?,?,?)`,
	'Helper.run',
	null,
	'method',
	path.join(moduleDir, 'dep.js'),
	2,
	'run()',
	'void',
	'[]',
	null,
);
insertGlobal(
	`INSERT INTO js_globals
		(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
	 VALUES (?,?,?,?,?,?,?,?,?)`,
	'Profile',
	null,
	'class',
	classJs,
	1,
	null,
	null,
	null,
	null,
);
insertGlobal(
	`INSERT INTO js_globals
		(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
	 VALUES (?,?,?,?,?,?,?,?,?)`,
	'Profile.execute',
	null,
	'method',
	classJs,
	3,
	'execute(name: string)',
	'Promise',
	JSON.stringify([{ name: 'name', type: 'string', optional: false }]),
	'Выполняет действие.',
);
const chainPath = path.join(site, 'local/php_interface/chain.php');
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ChainContainer',
	'ChainContainer',
	'Vendor\\Demo',
	'class',
	'demo',
	chainPath,
	3,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ChainContainer',
	'getInstance',
	'getInstance(): self',
	'self',
	'[]',
	1,
	'public',
	chainPath,
	5,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ChainContainer',
	'getFactory',
	'getFactory(int $type): ChainFactory',
	'ChainFactory',
	JSON.stringify([{ name: 'type', type: 'int', variadic: false, byRef: false }]),
	0,
	'public',
	chainPath,
	9,
);
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ChainFactory',
	'ChainFactory',
	'Vendor\\Demo',
	'class',
	'demo',
	chainPath,
	15,
);
insertGlobal(
	'INSERT INTO methods (class_fqcn, name, signature, return_type, params_json, is_static, visibility, file, line, doc) VALUES (?,?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\ChainFactory',
	'make',
	'make(): void',
	'void',
	'[]',
	0,
	'public',
	chainPath,
	17,
);

const membersPath = path.join(site, 'local/php_interface/members.php');
insertGlobal(
	'INSERT INTO classes (fqcn, name, namespace, kind, module, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\HoverMembers',
	'HoverMembers',
	'Vendor\\Demo',
	'class',
	'demo',
	membersPath,
	3,
);
insertGlobal(
	'INSERT INTO constants (class_fqcn, name, type, value, doc, file, line) VALUES (?,?,?,?,?,?,?)',
	'Vendor\\Demo\\HoverMembers',
	'LIMIT',
	'int',
	'10',
	'Тестовая константа.',
	membersPath,
	5,
);
insertGlobal(
	'INSERT INTO properties (class_fqcn, name, type, visibility, is_static, default_value, doc, file, line) VALUES (?,?,?,?,?,?,?,?,?)',
	'Vendor\\Demo\\HoverMembers',
	'cache',
	'?string',
	'private',
	0,
	'null',
	'Тестовое свойство.',
	membersPath,
	6,
);
// Файлы для references: объявление на диске и вызов в соседнем файле.
mkdirSync(path.dirname(methodFilePath), { recursive: true });
writeFileSync(
	methodFilePath,
	[
		'<?php',
		'namespace Vendor\\Demo;',
		'',
		'class ItemTable',
		'{',
		'    public static function find(',
		'    public static function getMap(): array',
		'    {',
		'        return [];',
		'    }',
		'}',
		'',
	].join('\n'),
);
const referenceUsagePath = path.join(site, 'local/php_interface/item_usage.php');
writeFileSync(
	referenceUsagePath,
	['<?php', 'namespace Vendor\\Demo;', '', '$table = new ItemTable();', '$table->getMap();', ''].join('\n'),
);
for (const indexed of [methodFilePath, referenceUsagePath]) {
	const stat = statSync(indexed);
	db.run(
		'INSERT OR REPLACE INTO file_hashes (path, hash, size, mtime) VALUES (?,?,?,?)',
		indexed,
		'e2e',
		stat.size,
		Math.floor(stat.mtimeMs / 1000),
	);
}

db.exec('COMMIT;');




db.close();

const phpBinary = process.env.BITRIX_LSP_PHP || 'php';
const phpEntry = process.env.BITRIX_LSP_ENTRY || path.join(repoRoot, 'server/src/main.php');
const server = spawn(phpBinary, [phpEntry], {
	env: {
		...process.env,
		BITRIX_DB: dbPath,
		BITRIX_ROOT: site,
		BITRIX_BITRIX_PATH: bitrix,
		BITRIX_JS_LIB_CHECK: '1',
		BITRIX_LSP_LOG: '0',
	},
	stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.on('data', (chunk) => {
	stderr += chunk;
});

let buffer = Buffer.alloc(0);
const messages = [];
const waiters = [];
server.stdout.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const sep = buffer.indexOf('\r\n\r\n');
		if (sep === -1) {
			break;
		}
		const header = buffer.subarray(0, sep).toString('utf8');
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		if (!match) {
			throw new Error(`Некорректный заголовок: ${header}`);
		}
		const length = Number(match[1]);
		if (buffer.length < sep + 4 + length) {
			break;
		}
		const body = buffer.subarray(sep + 4, sep + 4 + length).toString('utf8');
		buffer = buffer.subarray(sep + 4 + length);
		const message = JSON.parse(body);
		messages.push(message);
		for (const waiter of [...waiters]) {
			if (waiter.predicate(message)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		}
	}
});

function send(message) {
	const json = Buffer.from(JSON.stringify(message), 'utf8');
	server.stdin.write(`Content-Length: ${json.length}\r\n\r\n`);
	server.stdin.write(json);
}

function waitFor(predicate, timeout = 5000) {
	const existing = messages.find(predicate);
	if (existing) {
		return Promise.resolve(existing);
	}
	return new Promise((resolve, reject) => {
		const waiter = { predicate, resolve };
		waiters.push(waiter);
		setTimeout(() => {
			const index = waiters.indexOf(waiter);
			if (index !== -1) {
				waiters.splice(index, 1);
			}
			reject(new Error('Таймаут ожидания сообщения LSP'));
		}, timeout);
	});
}

let nextId = 1;
const request = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, params });

const jsUri = pathToFileURL(path.join(site, 'local/js/app/script.js')).toString();
const jsText = 'BX.Main.Popup.show();\nBX.SomeLib.run();\nfunction f() { BX.Main. }\n';

send(request('initialize', {
	processId: process.pid,
	rootUri: pathToFileURL(site).toString(),
	capabilities: {},
	initializationOptions: { dbPath, bitrixRoot: site, bitrixPath: bitrix, jsLibraryCheck: true },
}));
const initialize = await waitFor((message) => message.id === 1);
check(Boolean(initialize.result?.capabilities?.completionProvider), 'initialize: completionProvider');
check(initialize.result?.capabilities?.textDocumentSync?.change === 1, 'initialize: full sync');
send({ jsonrpc: '2.0', method: 'initialized', params: {} });

send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: jsUri, languageId: 'javascript', version: 1, text: jsText } },
});
const jsDiagnostics = await waitFor((message) => message.method === 'textDocument/publishDiagnostics');
const diagnostics = jsDiagnostics.params.diagnostics;
check(
	diagnostics.some((item) => item.code === 'bitrix.js.library-not-loaded' && item.data?.extension === 'main.popup'),
	'JS: диагностика неподключённой main.popup',
);
check(
	!diagnostics.some((item) => item.data?.extension === 'main.core'),
	'JS: main.core считается загруженным',
);

send(request('textDocument/completion', {
	textDocument: { uri: jsUri },
	position: { line: 2, character: 23 },
}));
const completion = await waitFor((message) => message.id === 2);
check(Array.isArray(completion.result) && completion.result.some((item) => item.label === 'Popup'), 'JS: completion BX.Main. → Popup');

send(request('textDocument/hover', {
	textDocument: { uri: jsUri },
	position: { line: 0, character: 8 },
}));
const hover = await waitFor((message) => message.id === 3);
check(hover.result?.contents?.value?.includes('main.popup'), 'JS: hover с расширением');

send(request('textDocument/definition', {
	textDocument: { uri: jsUri },
	position: { line: 0, character: 8 },
}));
const definition = await waitFor((message) => message.id === 4);
check(
	definition.result?.[0]?.uri?.endsWith('/bitrix/js/main/popup/popup.js'),
	'JS: definition → popup.js',
);

send(request('textDocument/codeAction', {
	textDocument: { uri: jsUri },
	range: diagnostics[0].range,
	context: { diagnostics },
}));
const jsActions = await waitFor((message) => message.id === 5);
check(
	jsActions.result.some((action) => action.title.includes("BX.loadExt('main.popup')")),
	'JS: quick fix BX.loadExt',
);

// PHP-шаблон без подключения библиотеки → диагностика и два PHP-quickfix.
const phpUri = pathToFileURL(path.join(site, 'local/components/vendor/comp/templates/.default/template.php')).toString();
const phpText = '<?php\n?>\n<script>BX.Main.Popup.show();</script>\n';
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: phpUri, languageId: 'php', version: 1, text: phpText } },
});
const phpDiagnostics = await waitFor(
	(message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === phpUri,
);
const phpDiags = phpDiagnostics.params.diagnostics.filter((item) => item.data?.kind === 'library-not-loaded');
check(phpDiags.length === 1, 'PHP: диагностика неподключённой библиотеки');
send(request('textDocument/codeAction', {
	textDocument: { uri: phpUri },
	range: phpDiags[0].range,
	context: { diagnostics: phpDiags },
}));
const phpActions = await waitFor((message) => message.id === 6);
const titles = phpActions.result.map((action) => action.title);
check(titles.some((title) => title.includes('CJSCore::Init')), 'PHP: quick fix CJSCore::Init');
check(titles.some((title) => title.includes('Extension::load')), 'PHP: quick fix Extension::load');
const phpEdit = phpActions.result.find((action) => action.title.includes('Extension::load'))?.edit?.changes?.[phpUri]?.[0];
check(phpEdit?.newText === "\\Bitrix\\Main\\UI\\Extension::load('main.popup');\n", 'PHP: текст вставки корректен');
check(phpEdit?.range?.start?.line === 1, 'PHP: вставка после строки <?php');

// PHP с CJSCore::Init(['main.popup']) → диагностика снимается.
const phpOkUri = pathToFileURL(path.join(site, 'local/components/vendor/comp/templates/.default/template2.php')).toString();
const phpOkText = "<?php\nCJSCore::Init(['main.popup']);\n?>\n<script>BX.Main.Popup.show();</script>\n";
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: phpOkUri, languageId: 'php', version: 1, text: phpOkText } },
});
const phpOkDiagnostics = await waitFor(
	(message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === phpOkUri,
);
check(
	!phpOkDiagnostics.params.diagnostics.some((item) => item.data?.kind === 'library-not-loaded'),
	'PHP: CJSCore::Init снимает диагностику',
);

// Расширение-владелец файла: rel-зависимость ghost.lib отсутствует в индексе.
const vendorUri = pathToFileURL(path.join(site, 'local/js/vendor/example/script.js')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: vendorUri, languageId: 'javascript', version: 1, text: 'BX.Vendor.Ext.run();\n' } },
});
const vendorDiagnostics = await waitFor(
	(message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === vendorUri,
);
check(
	vendorDiagnostics.params.diagnostics.some((item) => item.code === 'bitrix.js.missing-dependency'),
	'JS: диагностика отсутствующей rel-зависимости',
);

// PHP-диагностики: необъявленный $arParams и deprecated-класс.
const phpParamUri = pathToFileURL(path.join(componentPath, 'templates/.default/template3.php')).toString();
const phpParamText = '<?php\nuse Vendor\\Legacy\\Old;\n\n$arParams[\'DECLARED\'];\n$arParams[\'UNDECLARED\'];\nnew Old();\n$arParams[\'\n';
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: phpParamUri, languageId: 'php', version: 1, text: phpParamText } },
});
const phpParamDiagnostics = await waitFor(
	(message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === phpParamUri,
);
const codes = phpParamDiagnostics.params.diagnostics.map((item) => item.code);
check(codes.includes('bitrix.php.undeclared-param'), 'PHP: диагностика необъявленного $arParams');
check(codes.includes('bitrix.php.deprecated-class'), 'PHP: диагностика @deprecated');
check(
	!phpParamDiagnostics.params.diagnostics.some((item) => item.data?.param === 'DECLARED'),
	'PHP: объявленный параметр не считается ошибкой',
);
const semanticUri = pathToFileURL(path.join(site, 'local/php_interface/semantic.php')).toString();
const semanticText = `<?php
declare(strict_types=1);
test_helper();
test_helper(123);
missing_function();
$notDeclared;
function no_return(): array { $x = 1; }
function wrong_return(): array { return 'x'; }
function union_return(): array|false { return 5; }
function ok_return(): array|false { return []; }
function fine_void(): void { return; }
function number(): int { return '5'; }
expect_worker(new \\Vendor\\Demo\\ChildWorker());
expect_worker(new \\Vendor\\Demo\\Item());
test_helper(null);
`;
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: semanticUri, languageId: 'php', version: 1, text: semanticText } },
});
const semanticDiagnostics = await waitFor(
	(message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === semanticUri,
);
const semanticCodes = semanticDiagnostics.params.diagnostics.map((item) => item.code);
check(semanticCodes.includes('bitrix.php.argument-count'), 'PHP: семантика — число аргументов');
check(semanticCodes.includes('bitrix.php.argument-type'), 'PHP: семантика — тип аргумента');
check(semanticCodes.includes('bitrix.php.unknown-function'), 'PHP: семантика — неизвестная функция');
check(semanticCodes.includes('bitrix.php.undefined-variable'), 'PHP: семантика — неизвестная переменная');
check(semanticCodes.includes('bitrix.php.return-type'), 'PHP: семантика — тип возврата');
const returnMessages = semanticDiagnostics.params.diagnostics
	.filter((item) => item.code === 'bitrix.php.return-type')
	.map((item) => String(item.message));
check(returnMessages.length >= 3, `PHP: return-type сработал ${returnMessages.length} раз`);
check(!returnMessages.some((message) => message.includes('ok_return')), 'PHP: корректный array|false не ругается');
check(!returnMessages.some((message) => message.includes('fine_void')), 'PHP: void с return; не ругается');

const argumentMessages = semanticDiagnostics.params.diagnostics
	.filter((item) => item.code === 'bitrix.php.argument-type')
	.map((item) => String(item.message));
check(
	argumentMessages.some((message) => message.includes('strict_types=1')),
	'PHP: strict_types отмечен в сообщении о типе аргумента',
);
check(
	argumentMessages.some((message) => message.includes('передан null')),
	'PHP: null в non-nullable параметр — ошибка',
);
check(
	!argumentMessages.some((message) => message.includes('ChildWorker')),
	'PHP: наследник подходит под тип родителя',
);
check(
	argumentMessages.some((message) => message.includes('передан Vendor\\Demo\\Item')),
	'PHP: посторонний класс не подходит под тип параметра',
);
check(
	returnMessages.some((message) => message.includes('strict_types=1')),
	'PHP: strict_types отмечен в сообщении о типе возврата',
);

const hoverPosition = (text, index) => {
	const before = text.slice(0, index);
	const line = before.split('\n').length - 1;
	return { line, character: index - before.lastIndexOf('\n') - 1 };
};
const hoverText = '<?php\nfunction hoverDemo(array $settings): void\n{\n    $bitrix = $settings;\n    foreach ($bitrix as $key => $item) {\n        $item;\n    }\n}\n';
const hoverUri = pathToFileURL(path.join(site, 'local/php_interface/hover.php')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: hoverUri, languageId: 'php', version: 1, text: hoverText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === hoverUri);
const settingsOffset = hoverText.indexOf('$settings') + 2;
const paramHoverRequest = request('textDocument/hover', {
	textDocument: { uri: hoverUri },
	position: hoverPosition(hoverText, settingsOffset),
});
send(paramHoverRequest);
const paramHover = await waitFor((message) => message.id === paramHoverRequest.id);
check(
	paramHover.result?.contents?.value?.includes('параметр') &&
		paramHover.result?.contents?.value?.includes('array'),
	'PHP: hover параметра функции',
);
const bitrixOffset = hoverText.indexOf('$bitrix') + 2;
const localHoverRequest = request('textDocument/hover', {
	textDocument: { uri: hoverUri },
	position: hoverPosition(hoverText, bitrixOffset),
});
send(localHoverRequest);
const localHover = await waitFor((message) => message.id === localHoverRequest.id);
check(
	localHover.result?.contents?.value?.includes('локальная переменная') &&
		localHover.result?.contents?.value?.includes('array'),
	'PHP: hover локальной переменной',
);
const foreachOffset = hoverText.indexOf('foreach') + 2;
const keywordHoverRequest = request('textDocument/hover', {
	textDocument: { uri: hoverUri },
	position: hoverPosition(hoverText, foreachOffset),
});
send(keywordHoverRequest);
const keywordHover = await waitFor((message) => message.id === keywordHoverRequest.id);
check(
	keywordHover.result?.contents?.value?.includes('foreach') &&
		keywordHover.result?.contents?.value?.includes('Перебирает'),
	'PHP: hover конструкции foreach',
);

const unresolvedUri = pathToFileURL(path.join(site, 'local/php_interface/unresolved.php')).toString();
const unresolvedText = '<?php\nnew ItemTable();\n';
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: unresolvedUri, languageId: 'php', version: 1, text: unresolvedText } },
});
const unresolvedDiagnostics = await waitFor(
	(message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === unresolvedUri,
);
const unresolved = unresolvedDiagnostics.params.diagnostics.find(
	(item) => item.code === 'bitrix.php.unresolved-class',
);
check(Boolean(unresolved), 'PHP: диагностика класса без use');
check(unresolved?.data?.name === 'ItemTable', 'PHP: диагностика предлагает короткое имя класса');
check(unresolved?.range?.start?.character === 4, 'PHP: диапазон диагностики указывает на имя класса');

const paramCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: phpParamUri },
	position: { line: 6, character: 12 },
});
send(paramCompletionRequest);
const paramCompletion = await waitFor((message) => message.id === paramCompletionRequest.id);
check(
	Array.isArray(paramCompletion.result) && paramCompletion.result.some((item) => item.label === 'DECLARED'),
	'PHP: completion $arParams[\' → DECLARED',
);

// PHP-методы: completion, hover с return type, definition, signature help.
const methodUri = pathToFileURL(methodFilePath).toString();
const methodText = [
	'<?php',
	'namespace Vendor\\Demo;',
	'',
	'class ItemTable',
	'{',
	'    public function foo(): void',
	'    {',
	'        self::getMap();',
	'        $this->getMap();',
	'        self::find(',
	'        $item = self::create();',
	'        $item->getData();',
	'        ChainContainer::getInstance()->getFactory(1)->make();',
	'        ChainContainer::getInstance()->getF',
	'        new ItemTable();',
	'    }',
	'}',
	'',
].join('\n');
const positionAt = (text, index) => {
	const before = text.slice(0, index);
	const line = before.split('\n').length - 1;
	return { line, character: index - before.lastIndexOf('\n') - 1 };
};
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: methodUri, languageId: 'php', version: 1, text: methodText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === methodUri);

const getMapCall = methodText.indexOf('self::getMap');
const methodCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, getMapCall + 'self::getMa'.length),
});
send(methodCompletionRequest);
const methodCompletion = await waitFor((message) => message.id === methodCompletionRequest.id);
check(
	Array.isArray(methodCompletion.result) && methodCompletion.result.some((item) => item.label === 'getMap'),
	'PHP: completion self::get → getMap',
);
const thisCall = methodText.indexOf('$this->getMap');
const thisCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, thisCall + '$this->getMa'.length),
});
send(thisCompletionRequest);
const thisCompletion = await waitFor((message) => message.id === thisCompletionRequest.id);
check(
	Array.isArray(thisCompletion.result) && thisCompletion.result.some((item) => item.label === 'getMap'),
	'PHP: completion $this->get → getMap',
);

const methodHoverRequest = request('textDocument/hover', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, getMapCall + 'self::get'.length),
});
send(methodHoverRequest);
const methodHover = await waitFor((message) => message.id === methodHoverRequest.id);
check(
	methodHover.result?.contents?.value?.includes('getMap') &&
		methodHover.result?.contents?.value?.includes('array'),
	'PHP: hover метода с возвращаемым типом',
);

const methodDefinitionRequest = request('textDocument/definition', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, getMapCall + 'self::get'.length),
});
send(methodDefinitionRequest);
const methodDefinition = await waitFor((message) => message.id === methodDefinitionRequest.id);
check(
	methodDefinition.result?.[0]?.uri?.endsWith('/item_table.php') &&
		methodDefinition.result?.[0]?.range?.start?.line === 6,
	'PHP: definition метода → файл класса',
);

const getMapReferences = request('textDocument/references', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, getMapCall + 'self::get'.length),
	context: { includeDeclaration: true },
});
send(getMapReferences);
const referencesResult = await waitFor((message) => message.id === getMapReferences.id);
const referenceLocations = Array.isArray(referencesResult.result) ? referencesResult.result : [];
const declarationLocation = referenceLocations.find((item) => item.uri?.endsWith('/item_table.php'));
const usageLocation = referenceLocations.find((item) => item.uri?.endsWith('/item_usage.php'));
check(Boolean(declarationLocation), 'PHP: references находит объявление метода');
check(
	declarationLocation?.range?.start?.line === 6 &&
		declarationLocation?.range?.end?.character > declarationLocation?.range?.start?.character,
	'PHP: references подсвечивает имя в объявлении, а не всю строку',
);
check(
	usageLocation?.range?.start?.line === 4 && usageLocation?.range?.start?.character === 8,
	'PHP: references находит вызов в другом файле',
);

const highlightRequest = request('textDocument/documentHighlight', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, getMapCall + 'self::get'.length),
});
send(highlightRequest);
const highlightResult = await waitFor((message) => message.id === highlightRequest.id);
const highlightRanges = Array.isArray(highlightResult.result) ? highlightResult.result : [];
const cursorLine = positionAt(methodText, getMapCall + 'self::get'.length).line;
check(highlightRanges.length === 2, 'PHP: documentHighlight находит все вхождения в файле');
check(
	highlightRanges.some((item) => item.range?.start?.line === cursorLine) &&
		highlightRanges.every((item) => item.kind === 1),
	'PHP: documentHighlight попадает в строку курсора',
);

const navText = [
	'<?php',
	'namespace Vendor\\Demo;',
	'',
	'function useWorker(\\Vendor\\Demo\\ParentWorker $worker): void',
	'{',
	'    $worker->work();',
	'}',
	'',
].join('\n');
const navUri = pathToFileURL(path.join(site, 'local/php_interface/navigation.php')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: navUri, languageId: 'php', version: 1, text: navText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === navUri);

const typeDefinitionRequest = request('textDocument/typeDefinition', {
	textDocument: { uri: navUri },
	position: { line: 5, character: 6 },
});
send(typeDefinitionRequest);
const typeDefinition = await waitFor((message) => message.id === typeDefinitionRequest.id);
check(
	Array.isArray(typeDefinition.result) && typeDefinition.result[0]?.uri?.endsWith('/parent_worker.php'),
	'PHP: typeDefinition переменной → её класс',
);

const classImplementationRequest = request('textDocument/implementation', {
	textDocument: { uri: navUri },
	position: { line: 3, character: 26 },
});
send(classImplementationRequest);
const classImplementation = await waitFor((message) => message.id === classImplementationRequest.id);
check(
	Array.isArray(classImplementation.result) && classImplementation.result.some((item) => item.uri?.endsWith('/child_worker.php')),
	'PHP: implementation класса → наследник',
);

const methodImplementationRequest = request('textDocument/implementation', {
	textDocument: { uri: navUri },
	position: { line: 5, character: 15 },
});
send(methodImplementationRequest);
const methodImplementation = await waitFor((message) => message.id === methodImplementationRequest.id);
check(
	Array.isArray(methodImplementation.result) && methodImplementation.result.some((item) => item.uri?.endsWith('/child_worker.php')),
	'PHP: implementation метода → переопределение в наследнике',
);

const narrowText = [
	'<?php',
	'namespace Vendor\\Demo;',
	'',
	'function narrow(mixed $value): void',
	'{',
	'    if ($value instanceof \\Vendor\\Demo\\ParentWorker) {',
	'        $value->work();',
	'    }',
	'}',
	'',
].join('\n');
const narrowUri = pathToFileURL(path.join(site, 'local/php_interface/narrow.php')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: narrowUri, languageId: 'php', version: 1, text: narrowText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === narrowUri);

const narrowHoverRequest = request('textDocument/hover', {
	textDocument: { uri: narrowUri },
	position: { line: 6, character: 10 },
});
send(narrowHoverRequest);
const narrowHover = await waitFor((message) => message.id === narrowHoverRequest.id);
check(
	String(narrowHover.result?.contents?.value ?? '').replace(/<[^>]+>/g, '').includes('ParentWorker'),
	'PHP: тип переменной сужен внутри instanceof',
);

const narrowTypeRequest = request('textDocument/typeDefinition', {
	textDocument: { uri: narrowUri },
	position: { line: 6, character: 10 },
});
send(narrowTypeRequest);
const narrowType = await waitFor((message) => message.id === narrowTypeRequest.id);
check(
	Array.isArray(narrowType.result) && narrowType.result[0]?.uri?.endsWith('/parent_worker.php'),
	'PHP: typeDefinition учитывает сужение instanceof',
);

const hintText = [
	'<?php',
	'namespace Vendor\\Demo;',
	'',
	'test_helper(5);',
	'test_helper(value: 5);',
	'test_helper($missing);',
	'',
].join('\n');
const hintUri = pathToFileURL(path.join(site, 'local/php_interface/inlay.php')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: hintUri, languageId: 'php', version: 1, text: hintText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === hintUri);

const hintRequest = request('textDocument/inlayHint', {
	textDocument: { uri: hintUri },
	range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
});
send(hintRequest);
const hintResult = await waitFor((message) => message.id === hintRequest.id);
const hints = Array.isArray(hintResult.result) ? hintResult.result : [];
check(
	hints.length === 2 && hints.every((hint) => hint.label === 'value: ' && hint.kind === 2),
	'PHP: inlayHint подписывает аргументы, кроме именованных',
);
check(
	hints[0]?.position?.line === 3 && hints[1]?.position?.line === 5,
	'PHP: inlayHint приходит в позиции аргумента',
);

const renameText = [
	'<?php',
	'namespace Vendor\\Demo;',
	'',
	'function rename_me(int $value): void',
	'{',
	'    $value = $value + 1;',
	'    echo $value;',
	'}',
	'',
].join('\n');
const renameUri = pathToFileURL(path.join(site, 'local/php_interface/rename.php')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: renameUri, languageId: 'php', version: 1, text: renameText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === renameUri);

const prepareRenameRequest = request('textDocument/prepareRename', {
	textDocument: { uri: renameUri },
	position: { line: 5, character: 6 },
});
send(prepareRenameRequest);
const prepareRename = await waitFor((message) => message.id === prepareRenameRequest.id);
check(
	prepareRename.result?.placeholder === 'value' && prepareRename.result?.range?.start?.character === 4,
	'PHP: prepareRename для локальной переменной',
);
const prepareRenameEcho = request('textDocument/prepareRename', {
	textDocument: { uri: renameUri },
	position: { line: 6, character: 6 },
});
send(prepareRenameEcho);
const prepareRenameEchoResult = await waitFor((message) => message.id === prepareRenameEcho.id);
check(prepareRenameEchoResult.result === null, 'PHP: prepareRename не для переменной → null');

const renameRequest = request('textDocument/rename', {
	textDocument: { uri: renameUri },
	position: { line: 5, character: 6 },
	newName: 'amount',
});
send(renameRequest);
const renameResult = await waitFor((message) => message.id === renameRequest.id);
const renameEdits = renameResult.result?.changes?.[renameUri] ?? [];
check(renameEdits.length === 4, 'PHP: rename переименовывает параметр и все использования');
check(
	renameEdits.every((edit) => edit.newText === 'amount') &&
		renameEdits.some((edit) => edit.range.start.line === 3),
	'PHP: rename покрывает объявление параметра',
);
const renameStringRequest = request('textDocument/rename', {
	textDocument: { uri: renameUri },
	position: { line: 5, character: 6 },
	newName: 'bad-name',
});
send(renameStringRequest);
const renameStringResult = await waitFor((message) => message.id === renameStringRequest.id);
check(renameStringResult.result === null, 'PHP: rename с недопустимым именем → отказ');

const lensPath = path.join(site, 'local/php_interface/parent_worker.php');
const lensUri = pathToFileURL(lensPath).toString();
const lensText = [
	'<?php',
	'namespace Vendor\\Demo;',
	'',
	'class ParentWorker',
	'{',
	'    public function work(): void',
	'    {',
	'    }',
	'}',
	'',
].join('\n');
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: lensUri, languageId: 'php', version: 1, text: lensText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === lensUri);

const lensRequest = request('textDocument/codeLens', {
	textDocument: { uri: lensUri },
	range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
});
send(lensRequest);
const lensResult = await waitFor((message) => message.id === lensRequest.id);
const lenses = Array.isArray(lensResult.result) ? lensResult.result : [];
check(lenses.length === 2, 'PHP: codeLens — наследники класса и переопределение метода');
check(
	lenses[0]?.command?.title === '1 наследник' &&
		lenses[0]?.range?.start?.line < lenses[1]?.range?.start?.line,
	'PHP: codeLens «1 наследник» над классом',
);
check(
	lenses[1]?.command?.title === '1 переопределение' &&
		lenses[1]?.command?.arguments?.[2]?.[0]?.uri?.endsWith('/child_worker.php'),
	'PHP: codeLens «переопределение» ведёт к реализации',
);

const foldingRequest = request('textDocument/foldingRange', { textDocument: { uri: methodUri } });
send(foldingRequest);
const foldingResult = await waitFor((message) => message.id === foldingRequest.id);
const folding = Array.isArray(foldingResult.result) ? foldingResult.result : [];
const classFold = folding.find((item) => item.startLine === 3 && item.endLine === 16);
const methodFold = folding.find((item) => item.startLine === 5 && item.endLine === 15);
check(Boolean(classFold), 'PHP: foldingRange сворачивает тело класса');
check(Boolean(methodFold), 'PHP: foldingRange сворачивает тело метода');
check(
	folding.every((item) => item.endLine > item.startLine),
	'PHP: foldingRange не отдаёт однострочные диапазоны',
);

const findCall = methodText.indexOf('self::find(');
const signatureHelpRequest = request('textDocument/signatureHelp', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, findCall + 'self::find('.length),
});
send(signatureHelpRequest);
const signatureHelp = await waitFor((message) => message.id === signatureHelpRequest.id);
check(
	signatureHelp.result?.signatures?.[0]?.label?.includes('find') &&
		signatureHelp.result?.signatures?.[0]?.parameters?.length === 2,
	'PHP: signature help с параметрами',
);

const createCall = methodText.indexOf('self::create');
const getDataCall = methodText.indexOf('getData(', createCall);
const inferredHoverRequest = request('textDocument/hover', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, getDataCall + 2),
});
send(inferredHoverRequest);
const inferredHover = await waitFor((message) => message.id === inferredHoverRequest.id);
// hover приходит с цветными <span>, поэтому сверяем текст без разметки.
const plainHover = (value) => String(value ?? '').replace(/<[^>]+>/g, '');
check(
	plainHover(inferredHover.result?.contents?.value).includes('Item::getData'),
	'PHP: тип переменной выведен из возвращаемого типа метода',
);
const newCall = methodText.indexOf('new ItemTable(');
const newSignatureRequest = request('textDocument/signatureHelp', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, newCall + 'new ItemTable('.length),
});
send(newSignatureRequest);
const newSignature = await waitFor((message) => message.id === newSignatureRequest.id);
check(
	newSignature.result?.signatures?.[0]?.label?.includes('__construct'),
	'PHP: signatureHelp в new ItemTable( показывает конструктор',
);

const chainCall = methodText.indexOf('getFactory');
const chainHoverRequest = request('textDocument/hover', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, chainCall + 2),
});
send(chainHoverRequest);
const chainHover = await waitFor((message) => message.id === chainHoverRequest.id);
check(
	chainHover.result?.contents?.value?.includes('getFactory') &&
		chainHover.result?.contents?.value?.includes('ChainContainer'),
	'PHP: hover в цепочке Container::getInstance()->getFactory()',
);
const chainCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: methodUri },
	position: positionAt(methodText, methodText.lastIndexOf('getF') + 'getF'.length),
});
send(chainCompletionRequest);
const chainCompletion = await waitFor((message) => message.id === chainCompletionRequest.id);
console.log('DEBUG chaincomp', JSON.stringify(chainCompletion));
check(
	Array.isArray(chainCompletion.result) && chainCompletion.result.some((item) => item.label === 'getFactory'),
	'PHP: completion в цепочке getInstance()->getF',
);
const membersText = '<?php\nnamespace Vendor\\Demo;\nclass HoverMembers\n{\n    private const LIMIT = 10;\n    private ?string $cache;\n}\n';
const membersUri = pathToFileURL(membersPath).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: membersUri, languageId: 'php', version: 1, text: membersText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === membersUri);
for (const [needle, expected, label] of [
	['LIMIT', 'константа', 'PHP: hover объявления константы'],
	['$cache', 'свойство', 'PHP: hover объявления свойства'],
]) {
	const offset = membersText.indexOf(needle) + (needle.startsWith('$') ? 2 : 2);
	const memberHoverRequest = request('textDocument/hover', {
		textDocument: { uri: membersUri },
		position: positionAt(membersText, offset),
	});
	send(memberHoverRequest);
	const memberHover = await waitFor((message) => message.id === memberHoverRequest.id);
	check(memberHover.result?.contents?.value?.includes(expected), label);
}

// JS: сигнатура и параметры в hover/signature help.
const demoUri = pathToFileURL(path.join(site, 'local/js/demo/action.js')).toString();
const demoText = "BX.Demo.runAction('test', {\n\tmode: 'ajax',\n});\n";
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: demoUri, languageId: 'javascript', version: 1, text: demoText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === demoUri);
const demoCall = demoText.indexOf('BX.Demo.runAction');
const hoverRequest = request('textDocument/hover', {
	textDocument: { uri: demoUri },
	position: positionAt(demoText, demoCall + 'BX.Demo.'.length + 2),
});
send(hoverRequest);
const demoHover = await waitFor((message) => message.id === hoverRequest.id);
check(
	demoHover.result?.contents?.value?.includes('Параметры') &&
		demoHover.result?.contents?.value?.includes('string'),
	'JS: hover с таблицей параметров и типами',
);
const signatureRequest = request('textDocument/signatureHelp', {
	textDocument: { uri: demoUri },
	position: positionAt(demoText, demoCall + 'BX.Demo.runAction('.length),
});
send(signatureRequest);
const demoSignature = await waitFor((message) => message.id === signatureRequest.id);
check(
	demoSignature.result?.signatures?.[0]?.parameters?.length === 2,
	'JS: signature help для BX.ajax-подобного метода',
);

// PHP-иерархия: методы/свойства из traits и интерфейсов.
const articleText = [
	'<?php',
	'namespace Vendor\\Demo;',
	'',
	'class Article implements MetaInterface',
	'{',
	'    use HasMeta;',
	'',
	'    public function foo(): void',
	'    {',
	'        $this->meta();',
	'        $this->describe();',
	'        $this->title;',
	'        self::KIND;',
	'    }',
	'}',
	'',
].join('\n');
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: pathToFileURL(articlePath).toString(), languageId: 'php', version: 1, text: articleText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === pathToFileURL(articlePath).toString());
const articleUri = pathToFileURL(articlePath).toString();
const traitHoverRequest = request('textDocument/hover', {
	textDocument: { uri: articleUri },
	position: positionAt(articleText, articleText.indexOf('$this->meta') + '$this->met'.length),
});
send(traitHoverRequest);
const traitHover = await waitFor((message) => message.id === traitHoverRequest.id);
check(traitHover.result?.contents?.value?.includes('meta'), 'PHP: hover метода из trait');
const traitDefinitionRequest = request('textDocument/definition', {
	textDocument: { uri: articleUri },
	position: positionAt(articleText, articleText.indexOf('$this->meta') + '$this->met'.length),
});
send(traitDefinitionRequest);
const traitDefinition = await waitFor((message) => message.id === traitDefinitionRequest.id);
check(
	traitDefinition.result?.[0]?.uri?.endsWith('/has_meta.php'),
	'PHP: переход к методу trait',
);
const interfaceCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: articleUri },
	position: positionAt(articleText, articleText.indexOf('$this->describe') + '$this->des'.length),
});
send(interfaceCompletionRequest);
const interfaceCompletion = await waitFor((message) => message.id === interfaceCompletionRequest.id);
check(
	Array.isArray(interfaceCompletion.result) && interfaceCompletion.result.some((item) => item.label === 'describe'),
	'PHP: completion метода интерфейса через реализующий класс',
);
const propertyHoverRequest = request('textDocument/hover', {
	textDocument: { uri: articleUri },
	position: positionAt(articleText, articleText.indexOf('$this->title') + '$this->title'.length - 1),
});
send(propertyHoverRequest);
const propertyHover = await waitFor((message) => message.id === propertyHoverRequest.id);
check(propertyHover.result?.contents?.value?.includes('title'), 'PHP: hover свойства из trait');
const constantCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: articleUri },
	position: positionAt(articleText, articleText.indexOf('self::KIND') + 'self::K'.length),
});
send(constantCompletionRequest);
const constantCompletion = await waitFor((message) => message.id === constantCompletionRequest.id);
check(
	Array.isArray(constantCompletion.result) && constantCompletion.result.some((item) => item.label === 'KIND'),
	'PHP: completion константы интерфейса',
);

// PHP: глобальные функции/константы и hover объявления унаследованного метода.
const globalText = [
	'<?php',
	'$x = test_helper(',
	'TEST_FLAG;',
	'',
].join('\n');
const globalUri = pathToFileURL(path.join(site, 'local/php_interface/global.php')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: globalUri, languageId: 'php', version: 1, text: globalText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === globalUri);
const helperCall = globalText.indexOf('test_helper');
const helperHoverRequest = request('textDocument/hover', {
	textDocument: { uri: globalUri },
	position: positionAt(globalText, helperCall + 2),
});
send(helperHoverRequest);
const helperHover = await waitFor((message) => message.id === helperHoverRequest.id);
check(
	helperHover.result?.contents?.value?.includes('глобальная функция') &&
		helperHover.result?.contents?.value?.includes('value'),
	'PHP: hover глобальной функции',
);
const helperCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: globalUri },
	position: positionAt(globalText, helperCall + 'test_he'.length),
});
send(helperCompletionRequest);
const helperCompletion = await waitFor((message) => message.id === helperCompletionRequest.id);
check(
	Array.isArray(helperCompletion.result) && helperCompletion.result.some((item) => item.label === 'test_helper'),
	'PHP: completion глобальной функции',
);
const helperDefinitionRequest = request('textDocument/definition', {
	textDocument: { uri: globalUri },
	position: positionAt(globalText, helperCall + 2),
});
send(helperDefinitionRequest);
const helperDefinition = await waitFor((message) => message.id === helperDefinitionRequest.id);
check(
	helperDefinition.result?.[0]?.uri?.endsWith('/functions.php'),
	'PHP: definition глобальной функции',
);
const helperSignatureRequest = request('textDocument/signatureHelp', {
	textDocument: { uri: globalUri },
	position: positionAt(globalText, helperCall + 'test_helper('.length),
});
send(helperSignatureRequest);
const helperSignature = await waitFor((message) => message.id === helperSignatureRequest.id);
check(
	helperSignature.result?.signatures?.[0]?.label?.includes('test_helper') &&
		helperSignature.result?.signatures?.[0]?.parameters?.length === 1,
	'PHP: signature help глобальной функции',
);
const constantOffset = globalText.indexOf('TEST_FLAG');
const constantHoverRequest = request('textDocument/hover', {
	textDocument: { uri: globalUri },
	position: positionAt(globalText, constantOffset + 2),
});
send(constantHoverRequest);
const constantHover = await waitFor((message) => message.id === constantHoverRequest.id);
check(
	constantHover.result?.contents?.value?.includes('глобальная константа'),
	'PHP: hover глобальной константы',
);

const functionSymbolRequest = request('workspace/symbol', { query: 'test_helper' });
send(functionSymbolRequest);
const functionSymbols = await waitFor((message) => message.id === functionSymbolRequest.id);
check(
	Array.isArray(functionSymbols.result) &&
		functionSymbols.result.some((item) => item.name === 'test_helper' && item.kind === 12),
	'PHP: workspace/symbol находит глобальную функцию',
);
const functionDocSymbolRequest = request('textDocument/documentSymbol', {
	textDocument: { uri: pathToFileURL(functionsPath).toString() },
});
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: {
		textDocument: {
			uri: pathToFileURL(functionsPath).toString(),
			languageId: 'php',
			version: 1,
			text: '<?php\n',
		},
	},
});
send(functionDocSymbolRequest);
const functionDocSymbols = await waitFor((message) => message.id === functionDocSymbolRequest.id);
check(
	Array.isArray(functionDocSymbols.result) &&
		functionDocSymbols.result.some((item) => item.name === 'test_helper()') &&
		functionDocSymbols.result.some((item) => item.name === 'TEST_FLAG'),
	'PHP: documentSymbol включает функцию и константу',
);

const childText = [
	'<?php',
	'namespace Vendor\\Demo;',
	'',
	'class ChildWorker extends ParentWorker',
	'{',
	'    public function work(): void',
	'    {',
	'    }',
	'}',
	'',
].join('\n');
const childUri = pathToFileURL(childPath).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: childUri, languageId: 'php', version: 1, text: childText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === childUri);
const workOffset = childText.indexOf('function work');
const declarationRequest = request('textDocument/hover', {
	textDocument: { uri: childUri },
	position: positionAt(childText, workOffset + 'function wor'.length),
});
send(declarationRequest);
const declarationHover = await waitFor((message) => message.id === declarationRequest.id);
check(
	declarationHover.result?.contents?.value?.includes('Выполняет работу компонента') &&
		declarationHover.result?.contents?.value?.includes('Переопределяет'),
	'PHP: hover объявления подхватывает doc родителя',
);

// PHP: $arResult в шаблоне компонента.
const resultUri = pathToFileURL(path.join(componentPath, 'templates/.default/template-result.php')).toString();
const resultText = '<?php\n$arResult[\'ITEM\'];\n';
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: resultUri, languageId: 'php', version: 1, text: resultText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === resultUri);
const resultHoverRequest = request('textDocument/hover', {
	textDocument: { uri: resultUri },
	position: positionAt(resultText, resultText.indexOf('$arResult') + 3),
});
send(resultHoverRequest);
const resultHover = await waitFor((message) => message.id === resultHoverRequest.id);
check(resultHover.result?.contents?.value?.includes('результат компонента'), 'PHP: hover $arResult');
const resultCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: resultUri },
	position: positionAt(resultText, resultText.indexOf("$arResult['") + "$arResult['".length),
});
send(resultCompletionRequest);
const resultCompletion = await waitFor((message) => message.id === resultCompletionRequest.id);
check(
	Array.isArray(resultCompletion.result) &&
		resultCompletion.result.some((item) => item.label === 'ITEMS') &&
		resultCompletion.result.some((item) => item.label === 'TITLE') &&
		resultCompletion.result.some((item) => item.label === 'DYNAMIC_KEY') &&
		resultCompletion.result.some((item) => item.label === 'CHAIN_KEY'),
	'PHP: completion ключей $arResult (включая @return array{…}, цепочки и локальные)',
);

// JS: ES-класс, this.* и .d.ts-подобные члены.
const classUri = pathToFileURL(classJs).toString();
const classText = 'class Profile {\n\t/** Выполняет действие. */\n\texecute(name) {}\n\trun() {\n\t\tthis.exec\n\t}\n}\nconst p = new Profile();\np.exec\nnew Profile().exec\n';
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: classUri, languageId: 'javascript', version: 1, text: classText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === classUri);
const thisCallOffset = classText.indexOf('this.exec');
const jsThisCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: classUri },
	position: positionAt(classText, thisCallOffset + 'this.exec'.length),
});
send(jsThisCompletionRequest);
const jsThisCompletion = await waitFor((message) => message.id === jsThisCompletionRequest.id);
check(
	Array.isArray(jsThisCompletion.result) && jsThisCompletion.result.some((item) => item.label === 'execute'),
	'JS: completion this.exec → execute в ES-классе',
);
const methodCallOffset = classText.indexOf('execute(name)') + 2;
const classHoverRequest = request('textDocument/hover', {
	textDocument: { uri: classUri },
	position: positionAt(classText, methodCallOffset),
});
send(classHoverRequest);
const classHover = await waitFor((message) => message.id === classHoverRequest.id);
check(classHover.result?.contents?.value?.includes('Profile.execute'), 'JS: hover метода ES-класса');
const inferredCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: classUri },
	position: positionAt(classText, classText.lastIndexOf('p.exec') + 'p.exec'.length),
});
send(inferredCompletionRequest);
const inferredCompletion = await waitFor((message) => message.id === inferredCompletionRequest.id);
check(
	Array.isArray(inferredCompletion.result) && inferredCompletion.result.some((item) => item.label === 'execute'),
	'JS: completion метода через const p = new Profile()',
);
const directCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: classUri },
	position: positionAt(classText, classText.lastIndexOf('new Profile().exec') + 'new Profile().exec'.length),
});
send(directCompletionRequest);
const directCompletion = await waitFor((message) => message.id === directCompletionRequest.id);
check(
	Array.isArray(directCompletion.result) && directCompletion.result.some((item) => item.label === 'execute'),
	'JS: completion метода через new Profile().',
);

// JS: import-алиасы, относительные модули и node_modules/@types.
const moduleFile = path.join(moduleDir, 'main.js');
const moduleText = "import { Helper as H } from './dep.js';\nimport * as NS from './dep.js';\nimport { Reexported } from './barrel.js';\nnew H();\nH.\nNS.Helper;\nnew Reexported();\nimport { Foo } from 'foo';\nimport { Helper as AliasHelper } from '@app/dep.js';\n/** @type {Helper} */\nconst docTyped = makeHelper();\ndocTyped.\nnew Foo();\nnew Fo\nnew AliasHelper();\nBX.\nBX.UI.Button({\nBX.UI.Typed({\nconst made = BX.Demo.create();\nmade.\n";
const moduleUri = pathToFileURL(moduleFile).toString();
writeFileSync(moduleFile, moduleText);
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: moduleUri, languageId: 'javascript', version: 1, text: moduleText } },
});
await waitFor((message) => message.method === 'textDocument/publishDiagnostics' && message.params.uri === moduleUri);
const aliasOffset = moduleText.indexOf('new H') + 4;
const moduleHoverRequest = request('textDocument/hover', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, aliasOffset),
});
send(moduleHoverRequest);
const moduleHover = await waitFor((message) => message.id === moduleHoverRequest.id);
check(
	moduleHover.result?.contents?.value?.includes('dep.js') &&
		moduleHover.result?.contents?.value?.includes('Helper'),
	'JS: hover import-алиаса из относительного модуля',
);
const moduleDefinitionRequest = request('textDocument/definition', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, aliasOffset),
});
send(moduleDefinitionRequest);
const moduleDefinition = await waitFor((message) => message.id === moduleDefinitionRequest.id);
check(moduleDefinition.result?.[0]?.uri?.endsWith('/dep.js'), 'JS: definition import-алиаса');
const typesOffset = moduleText.indexOf('new Foo') + 4;
const typesHoverRequest = request('textDocument/hover', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, typesOffset),
});
send(typesHoverRequest);
const typesHover = await waitFor((message) => message.id === typesHoverRequest.id);
check(
	typesHover.result?.contents?.value?.includes('@types/foo') &&
		typesHover.result?.contents?.value?.includes('Foo'),
	'JS: hover декларации из node_modules/@types',
);
const tsconfigOffset = moduleText.indexOf('new AliasHelper') + 4;
const tsconfigHoverRequest = request('textDocument/hover', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, tsconfigOffset),
});
send(tsconfigHoverRequest);
const tsconfigHover = await waitFor((message) => message.id === tsconfigHoverRequest.id);
check(
	tsconfigHover.result?.contents?.value?.includes('dep.js') &&
		tsconfigHover.result?.contents?.value?.includes('Helper'),
	'JS: hover import-алиаса из tsconfig paths',
);
const docTypedCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, moduleText.indexOf('docTyped.') + 'docTyped.'.length),
});
send(docTypedCompletionRequest);
const docTypedCompletion = await waitFor((message) => message.id === docTypedCompletionRequest.id);
check(
	Array.isArray(docTypedCompletion.result) && docTypedCompletion.result.some((item) => item.label === 'run'),
	'JS: completion по JSDoc @type',
);
const bxCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, moduleText.indexOf('BX.\n') + 'BX.'.length),
});
send(bxCompletionRequest);
const bxCompletion = await waitFor((message) => message.id === bxCompletionRequest.id);
check(
	Array.isArray(bxCompletion.result) &&
		bxCompletion.result.some((item) => item.label === 'Fake149') &&
		bxCompletion.result.some((item) => item.label === 'UI'),
	'JS: BX. показывает все сегменты без лимита 100',
);
const objectKeysRequest = request('textDocument/completion', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, moduleText.lastIndexOf('BX.UI.Button({') + 'BX.UI.Button({'.length),
});
send(objectKeysRequest);
const objectKeys = await waitFor((message) => message.id === objectKeysRequest.id);
check(
	Array.isArray(objectKeys.result) && objectKeys.result.some((item) => item.label === 'size'),
	'JS: ключи объекта в BX.UI.Button({ … })',
);
const typedKeysRequest = request('textDocument/completion', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, moduleText.lastIndexOf('BX.UI.Typed({') + 'BX.UI.Typed({'.length),
});
send(typedKeysRequest);
const typedKeys = await waitFor((message) => message.id === typedKeysRequest.id);
const typedLabels = (typedKeys.result ?? []).map((item) => item.label);
check(
	typedLabels.includes('size') && typedLabels.includes('color') && typedLabels.includes('icon'),
	'JS: ключи из TS-типа (extends + собственные)',
);
const newCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, moduleText.lastIndexOf('new Fo') + 'new Fo'.length),
});
send(newCompletionRequest);
const newCompletion = await waitFor((message) => message.id === newCompletionRequest.id);
check(
	Array.isArray(newCompletion.result) && newCompletion.result.some((item) => item.label === 'Foo'),
	'JS: completion импортированного класса после new',
);
const memberCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, moduleText.indexOf('H.') + 'H.'.length),
});
send(memberCompletionRequest);
const memberCompletion = await waitFor((message) => message.id === memberCompletionRequest.id);
check(
	Array.isArray(memberCompletion.result) && memberCompletion.result.some((item) => item.label === 'run'),
	'JS: completion методов импортированного класса',
);
const namespaceOffset = moduleText.indexOf('NS.Helper') + 'NS.'.length;
const namespaceHoverRequest = request('textDocument/hover', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, namespaceOffset),
});
send(namespaceHoverRequest);
const namespaceHover = await waitFor((message) => message.id === namespaceHoverRequest.id);
check(
	namespaceHover.result?.contents?.value?.includes('Helper') &&
		namespaceHover.result?.contents?.value?.includes('dep.js'),
	'JS: hover члена namespace-импорта',
);
const reexportOffset = moduleText.indexOf('Reexported') + 2;
const reexportHoverRequest = request('textDocument/hover', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, reexportOffset),
});
send(reexportHoverRequest);
const reexportHover = await waitFor((message) => message.id === reexportHoverRequest.id);
check(
	reexportHover.result?.contents?.value?.includes('Helper') &&
		reexportHover.result?.contents?.value?.includes('dep.js'),
	'JS: hover re-export-алиаса',
);

// JS: локальные переменные несохранённого документа.
const jsLocalText = 'function demo(param) {\n\tconst localValue = 1;\n\tlocalVa\n}\n';
const jsLocalUri = pathToFileURL(path.join(site, 'local/js/app/local.js')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: jsLocalUri, languageId: 'javascript', version: 1, text: jsLocalText } },
});
const jsLocalRequest = request('textDocument/completion', {
	textDocument: { uri: jsLocalUri },
	position: { line: 2, character: jsLocalText.split('\n')[2].indexOf('localVa') + 'localVa'.length },
});
send(jsLocalRequest);
const jsLocalResult = await waitFor((message) => message.id === jsLocalRequest.id);
check(
	Array.isArray(jsLocalResult.result) && jsLocalResult.result.some((item) => item.label === 'localValue'),
	'JS: локальная переменная до сохранения',
);

// JS: локальные переменные ограничены текущей функцией.
const jsScopeText = 'function a() { const alpha = 1; }\nfunction b() { const beta = 2; be }\n';
const jsScopeUri = pathToFileURL(path.join(site, 'local/js/app/scope.js')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: jsScopeUri, languageId: 'javascript', version: 1, text: jsScopeText } },
});
const jsScopeRequest = request('textDocument/completion', {
	textDocument: { uri: jsScopeUri },
	position: { line: 1, character: jsScopeText.split('\n')[1].indexOf('be') + 2 },
});
send(jsScopeRequest);
const jsScopeResult = await waitFor((message) => message.id === jsScopeRequest.id);
const jsScopeLabels = (jsScopeResult.result ?? []).map((item) => item.label);
check(jsScopeLabels.includes('beta') && !jsScopeLabels.includes('alpha'), 'JS: переменные только из текущей функции');

// PHP: переменные ограничены текущей функцией.
const scopeText = '<?php\nfunction a() { $alpha = 1; }\nfunction b() { $beta = 2; $ }\n';
const scopeUri = pathToFileURL(path.join(site, 'scope.php')).toString();
send({
	jsonrpc: '2.0',
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: scopeUri, languageId: 'php', version: 1, text: scopeText } },
});
const scopeRequest = request('textDocument/completion', {
	textDocument: { uri: scopeUri },
	position: { line: 2, character: scopeText.split('\n')[2].lastIndexOf('$') + 1 },
});
send(scopeRequest);
const scopeResult = await waitFor((message) => message.id === scopeRequest.id);
const scopeLabels = (scopeResult.result ?? []).map((item) => item.label);
check(!scopeLabels.includes('$alpha') && scopeLabels.includes('$beta'), 'PHP: переменные только из текущей функции');

// PHP: переменные из несохранённого документа и untitled (без индекса).
const unsavedText = '<?php\n$order = [];\n$ord';
for (const [uri, label] of [
	[pathToFileURL(path.join(site, 'public-page.php')).toString(), 'несохранённый файл в корне'],
	['untitled:Untitled-1', 'untitled'],
]) {
	send({
		jsonrpc: '2.0',
		method: 'textDocument/didOpen',
		params: { textDocument: { uri, languageId: 'php', version: 1, text: unsavedText } },
	});
	const varRequest = request('textDocument/completion', {
		textDocument: { uri },
		position: { line: 2, character: unsavedText.split('\n')[2].length },
	});
	send(varRequest);
	const varResult = await waitFor((message) => message.id === varRequest.id);
	const varLabels = (varResult.result ?? []).map((item) => item.label);
	check(varLabels.includes('$order'), `PHP: локальная переменная (${label})`);
	const hoverRequest = request('textDocument/hover', {
		textDocument: { uri },
		position: { line: 1, character: 2 },
	});
	send(hoverRequest);
	const hoverResult = await waitFor((message) => message.id === hoverRequest.id);
	check(
		/локальная переменная/i.test(String(hoverResult.result?.contents?.value ?? '')),
		`PHP: hover переменной (${label})`,
	);
}

const madeCompletionRequest = request('textDocument/completion', {
	textDocument: { uri: moduleUri },
	position: positionAt(moduleText, moduleText.lastIndexOf('made.') + 'made.'.length),
});
send(madeCompletionRequest);
const madeCompletion = await waitFor((message) => message.id === madeCompletionRequest.id);
console.error('MADE', JSON.stringify((madeCompletion.result ?? []).map((item) => item.label)));
check(
	Array.isArray(madeCompletion.result) && madeCompletion.result.some((item) => item.label === 'run'),
	'JS: тип переменной из @returns фабрики',
);

send(request('shutdown', {}));



await waitFor((message) => message.id === nextId - 1);
send({ jsonrpc: '2.0', method: 'exit', params: {} });
server.kill();

if (stderr.trim() !== '' && !stderr.includes('[bitrix-lsp]')) {
	console.error(stderr);
}
if (failures.length > 0) {
	console.error(`\nE2E FAILED: ${failures.length}`);
	process.exit(1);
}
console.log(`\nE2E OK (php: ${phpBinary}, entry: ${path.basename(phpEntry)})`);
