import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Database } from '../src/indexer/db';
import { IndexWriter } from '../src/indexer/indexWriter';

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, 'utf8');
}

test('IndexWriter: конфиги, глобалы, PHP-классы, компоненты, удаление', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-index-test-'));
	const site = path.join(root, 'site');
	const bitrix = path.join(site, 'bitrix');
	const dbPath = path.join(root, 'index.db');
	const db = await Database.open(dbPath);
	const writer = new IndexWriter(db, (message) => {
		throw new Error(message);
	});

	// 1. Модули
	write(path.join(bitrix, 'modules/mymodule/install/index.php'), '<?php');
	write(path.join(site, 'local/modules/localmod/install/index.php'), '<?php');
	writer.indexModules(bitrix, path.join(site, 'local'));
	assert.deepEqual(
		db.all<{ name: string; kind: string }>('SELECT name, kind FROM modules ORDER BY name').map((row) => [row.name, row.kind]),
		[
			['localmod', 'local'],
			['mymodule', 'core'],
		],
	);

	// 2. config.php расширения
	const jsDir = path.join(bitrix, 'js/vendor/example');
	const jsFile = path.join(jsDir, 'script.js');
	write(jsFile, "BX.namespace('BX.Vendor.Ext');\nBX.Vendor.Ext.run = function() {};\n");
	write(
		path.join(jsDir, 'config.php'),
		`<?php
$arJsConfig = [
	'vendor.example' => [
		'js' => ['/bitrix/js/vendor/example/script.js'],
		'rel' => ['main.core', 'main.popup'],
		'skip_core' => false,
	],
];`,
	);
	writer.writeConfigFile(path.join(jsDir, 'config.php'));
	assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM js_extensions')?.n, 1);
	const rawConfig = db.get<{ config_json: string }>('SELECT config_json FROM js_extensions')?.config_json;
	assert.deepEqual(JSON.parse(rawConfig ?? '{}').rel, ['main.core', 'main.popup']);
	assert.deepEqual(
		db.all<{ depends_on_name: string }>('SELECT depends_on_name FROM js_dependencies ORDER BY depends_on_name').map((row) => row.depends_on_name),
		['main.core', 'main.popup'],
	);

	// 3. JS-глобалы с привязкой к расширению
	const map = writer.loadExtensionFileMap();
	assert.equal(map.get(IndexWriter.jsFileKey(jsFile)), 'vendor.example');
	writer.writeJsFile(jsFile, map.get(IndexWriter.jsFileKey(jsFile)));
	const globals = db.all<{ name: string; extension_name: string; type: string }>(
		'SELECT name, extension_name, type FROM js_globals ORDER BY name',
	);
	assert.deepEqual(globals.map((row) => [row.name, row.extension_name]), [
		['BX.Vendor.Ext', 'vendor.example'],
		['BX.Vendor.Ext.run', 'vendor.example'],
	]);

	// 4. PHP-класс ORM + deprecated
	const tableFile = path.join(bitrix, 'modules/mymodule/lib/model/itemtable.php');
	write(
		tableFile,
		`<?php
namespace Vendor\\MyModule\\Model;

/**
 * @deprecated используйте ItemTable2
 */
class ItemTable extends \\Bitrix\\Main\\ORM\\Data\\DataManager
{
	public int $count = 0;
	private const LIMIT = 10;

	public static function getTableName(): string { return 'vendor_item'; }
	public static function getMap(): array
	{
		return [
			(new IntegerField('ID'))->configurePrimary(),
			new StringField('NAME'),
		];
	}
}`,
	);
	writer.writePhpFile(tableFile);
	const cls = db.get<{ fqcn: string; module: string; is_orm: number; deprecated: number; line: number }>(
		'SELECT fqcn, module, is_orm, deprecated, line FROM classes',
	);
	assert.ok(cls);
	assert.equal(cls.fqcn, 'Vendor\\MyModule\\Model\\ItemTable');
	assert.equal(cls.module, 'mymodule');
	assert.equal(cls.is_orm, 1);
	assert.equal(cls.deprecated, 1);
	assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM methods')?.n, 2);
	assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM properties')?.n, 1);
	assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM constants')?.n, 1);
	// тот же FQCN во втором файле не должен ломать первичный ключ deprecated
	const duplicate = path.join(bitrix, 'modules/mymodule/lib/model/legacycopy.php');
	write(duplicate, `<?php
namespace Vendor\\MyModule\\Model;
/** @deprecated */
class ItemTable {}
`);
	writer.writePhpFile(duplicate);
	writer.refreshDeprecated();
	assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deprecated')?.n, 1);

	// 5. Компонент и параметры
	const componentDir = path.join(site, 'local/components/vendor/comp');
	write(
		path.join(componentDir, '.parameters.php'),
		`<?php
$arComponentParameters = [
	'PARAMETERS' => [
		'IBLOCK_ID' => ['NAME' => 'Инфоблок', 'TYPE' => 'LIST', 'REQUIRED' => 'Y'],
		'LIMIT' => ['NAME' => 'Лимит', 'TYPE' => 'STRING', 'DEFAULT' => '10'],
	],
];`,
	);
	writer.writePhpFile(path.join(componentDir, '.parameters.php'));
	const component = db.get<{ name: string; module: string; parameters_file: string }>(
		'SELECT name, module, parameters_file FROM components',
	);
	assert.equal(component?.name, 'comp');
	assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM params')?.n, 2);

	// 6. Удаление файла чистит связанные строки
	writer.deleteFile(duplicate);
	writer.deleteFile(tableFile);
	assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM classes')?.n, 0);
	assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM methods')?.n, 0);

	// 7. Смена версии схемы пересоздаёт индекс (кеш, данные не жалко)
	db.exec('PRAGMA user_version = 1');
	db.close();
	const reopened = await Database.open(dbPath);
	const columns = reopened
		.all<{ name: string }>("SELECT name FROM pragma_table_info('js_extensions')")
		.map((row) => row.name);
	assert.ok(columns.includes('config_json'));
	assert.equal(reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM classes')?.n, 0);
	reopened.close();
	fs.rmSync(root, { recursive: true, force: true });
});
