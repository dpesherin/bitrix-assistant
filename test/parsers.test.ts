import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExcluded } from '../src/util/glob';
import { parseJsConfig } from '../src/indexer/js/jsConfigParser';
import { scanJsGlobals, scanJsTypeShapes } from '../src/indexer/js/jsScanner';
import { parsePhpFile } from '../src/indexer/php/phpParser';
import { buildUseEdit } from '../src/features/phpUseEdit';
import { parseParametersPhp, componentLocation } from '../src/indexer/php/componentParser';
import { parsePhpArrayLiteralForTest } from './helpers';

test('PHP: union-тип из @return сохраняется целиком', () => {
	const php = `<?php
namespace Vendor\\Demo;
abstract class Request
{
}
class HttpRequest extends Request
{
	public function getList()
	{
		return [];
	}
}
class Context
{
	/**
	 * @return Request | HttpRequest
	 */
	public function getRequest()
	{
		return null;
	}
}`;
	const parsed = parsePhpFile(php);
	const context = parsed.classes.find((item) => item.name === 'Context');
	const method = context?.methods.find((item) => item.name === 'getRequest');
	assert.equal(method?.returnType, 'Request | HttpRequest');
});

test('PHP: трейты и родители резолвятся через use-импорты', () => {
	const php = `<?php
namespace Vendor\\Biconnector;
use Bitrix\\Main\\ErrorableImplementation;
use Bitrix\\Main;
use Vendor\\Base\\ParentComponent;
class Foo extends ParentComponent implements Errorable
{
	use ErrorableImplementation;
	use Main\\SomeTrait;
	use \\Absolute\\TraitName;
	use LocalTrait;
}`;
	const parsed = parsePhpFile(php);
	const cls = parsed.classes[0];
	assert.deepEqual(cls.traits, [
		'Bitrix\\Main\\ErrorableImplementation',
		'Bitrix\\Main\\SomeTrait',
		'Absolute\\TraitName',
		'LocalTrait',
	]);
	assert.equal(cls.extends, 'Vendor\\Base\\ParentComponent');
	assert.deepEqual(cls.implements, ['Errorable']);
});
test('config.php: карта расширений с rel и skip_core', () => {
	const config = `<?php
$arJsConfig = array(
	'main.core' => array(
		'js' => array('/bitrix/js/main/core/core.js'),
		'rel' => array('main.polyfill.core'),
		'skip_core' => true,
	),
);`;
	const parsed = parseJsConfig(config, '/site/bitrix/js/main/core/config.php');
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].name, 'main.core');
	assert.equal(parsed[0].vendor, 'main');
	assert.deepEqual(parsed[0].rel, ['main.polyfill.core']);
	assert.equal(parsed[0].skipCore, true);
	assert.deepEqual(parsed[0].js, ['/site/bitrix/js/main/core/core.js']);
});

test('config.php: короткая форма + __DIR__', () => {
	const config = `<?php
return [
	'js' => [__DIR__ . '/script.js'],
	'rel' => ['popup'],
];`;
	const parsed = parseJsConfig(config, '/site/local/js/vendor/example/config.php');
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].name, 'vendor.example');
	assert.deepEqual(parsed[0].js, ['/site/local/js/vendor/example/script.js']);
	assert.deepEqual(parsed[0].rel, ['popup']);
	assert.equal(parsed[0].skipCore, false);
});

test('JS: глобалы, объектные ключи, prototype, export', () => {
	const js = `
BX.namespace('BX.Main');
BX.Main.Popup = function() {};
BX.Main.Popup.prototype.show = function() {};
BX.Main.Popup.prototype.hide = function() {};
BX.Main.Core = {
	init: function() {},
	version: '1',
};
window.BXCustom = {};
export function helper() {}
const aliases = { namespace: 'BX.Main.Popup' };
/**
 * @namespace {BX.UI.Buttons}
 */
function buttons() {}

/**
 * @memberOf BX.Main.Popup
 */
class Button {}
/**
 * @memberOf BX.Main.Popup
 */
function createPopup() {}

/**
 * Запускает действие.
 *
 * @param {string} action
 * @param {Object} config
 * @param {string} [config.method='POST']
 * @returns {Promise}
 */
BX.ajax = function(action, config) {};
`;
	const globals = scanJsGlobals(js);
	const names = globals.map((item) => item.name);
	assert.ok(names.includes('BX.Main'));
	assert.ok(names.includes('BX.Main.Popup'));
	assert.ok(names.includes('BX.Main.Popup.show'));
	assert.ok(names.includes('BX.Main.Popup.hide'));
	assert.ok(names.includes('BX.Main.Core'));
	assert.ok(names.includes('BX.Main.Core.init'));
	assert.ok(names.includes('BX.Main.Core.version'));
	assert.ok(names.includes('window.BXCustom'));
	assert.ok(names.includes('helper'));
	assert.ok(names.includes('BX.Main.Popup'));
	assert.ok(names.includes('BX.UI.Buttons'));
	assert.ok(names.includes('BX.Main.Popup.Button'));
	assert.ok(names.includes('BX.Main.Popup.createPopup'));
	assert.equal(globals.find((item) => item.name === 'BX.Main.Popup.show')?.type, 'method');
	const ajax = globals.find((item) => item.name === 'BX.ajax');
	assert.equal(ajax?.signature, 'ajax(action: string, config: Object)');
	assert.equal(ajax?.returnType, 'Promise');
	assert.match(ajax?.doc ?? '', /Запускает действие/);
	assert.equal(ajax?.params?.find((param) => param.name === 'config.method')?.optional, true);
	assert.equal(ajax?.params?.find((param) => param.name === 'config.method')?.defaultValue, 'POST');
});

test('JS: ES-классы и методы (.d.ts)', () => {
	const js = `import { Base } from './base.js';

/**
 * Профиль.
 */
export class Profile extends Base {
	count = 0;

	/**
	 * Выполняет действие.
	 *
	 * @param {string} name
	 * @param {Object} [options]
	 * @returns {Promise}
	 */
	execute(name, options) {}

	async load() {}

	static create() {}

	get title() { return ''; }
}

declare class Api {
	request(url: string, options?: Object): Promise;
}
`;
	const globals = scanJsGlobals(js);
	const names = globals.map((item) => item.name);
	assert.ok(names.includes('Profile'));
	assert.ok(names.includes('Profile.execute'));
	assert.ok(names.includes('Profile.load'));
	assert.ok(names.includes('Profile.create'));
	assert.ok(names.includes('Profile.title'));
	assert.ok(names.includes('Profile.count'));
	assert.ok(names.includes('Api'));
	assert.ok(names.includes('Api.request'));
	const execute = globals.find((item) => item.name === 'Profile.execute');
	assert.equal(execute?.type, 'method');
	assert.equal(execute?.signature, 'execute(name: string, options?: Object)');
	assert.equal(execute?.returnType, 'Promise');
	assert.match(execute?.doc ?? '', /Выполняет действие/);
});

test('PHP: глобальные функции и константы', () => {
	const php = `<?php
namespace Vendor\\Tools;

/** Склоняет строку. */
function plural(int $count, string $word): string { return $word; }

const TOOL_VERSION = 3;
define('TOOL_FLAG', true);

class Helper
{
	const INNER = 1;

	public function method(): void
	{
		define('INSIDE_METHOD', 1);
	}
}
`;
	const parsed = parsePhpFile(php);
	assert.equal(parsed.functions.length, 1);
	assert.equal(parsed.functions[0].name, 'plural');
	assert.equal(parsed.functions[0].fqcn, 'Vendor\\Tools\\plural');
	assert.equal(parsed.functions[0].returnType, 'string');
	assert.equal(parsed.functions[0].params.length, 2);
	assert.match(parsed.functions[0].doc ?? '', /Склоняет строку/);
	assert.deepEqual(parsed.constants.map((item) => item.name).sort(), ['TOOL_FLAG', 'TOOL_VERSION']);
});

test('PHP: вставка use для авто-импорта', () => {
	const plain = '<?php\n\nclass ClientProfile extends CBitrixComponent {}\n';
	const plainEdit = buildUseEdit(plain, 'Vendor\\Demo\\Service');
	assert.ok(plainEdit);
	assert.equal(plainEdit.text, 'use Vendor\\Demo\\Service;\n');
	assert.equal(plainEdit.offset, '<?php\n'.length);

	const declared = '<?php\ndeclare(strict_types=1);\n\nclass X {}\n';
	const declaredEdit = buildUseEdit(declared, 'Vendor\\Demo\\Service');
	assert.ok(declaredEdit);
	assert.equal(declaredEdit.offset, declared.indexOf('declare(strict_types=1);') + 'declare(strict_types=1);'.length);

	const withNamespace = '<?php\nnamespace App;\n\nuse Foo\\Bar;\n\nclass X {}\n';
	const namespaceEdit = buildUseEdit(withNamespace, 'Vendor\\Demo\\Service');
	assert.ok(namespaceEdit);
	assert.equal(namespaceEdit.text, '\nuse Vendor\\Demo\\Service;');
	assert.equal(namespaceEdit.offset, withNamespace.indexOf('use Foo\\Bar;') + 'use Foo\\Bar;'.length);

	const existing = '<?php\nuse Vendor\\Demo\\Service;\nclass X {}\n';
	assert.equal(buildUseEdit(existing, 'Vendor\\Demo\\Service'), undefined);

	const traitUse = '<?php\nclass X {\n\tuse SomeTrait;\n}\n';
	const traitEdit = buildUseEdit(traitUse, 'Vendor\\Demo\\Service');
	assert.ok(traitEdit);
	assert.equal(traitEdit.offset, '<?php\n'.length);
});

test('PHP: define в HTML/JS не считается константой', () => {
	const php = `<?php
const REAL_CONST = 1;
?>
<script>
define('item', instance ? instance.getItem(params.rowId) : null);
</script>
<?php
function realFunction(): void {}
?>`;
	const parsed = parsePhpFile(php);
	assert.deepEqual(parsed.constants.map((item) => item.name), ['REAL_CONST']);
	assert.deepEqual(parsed.functions.map((item) => item.name), ['realFunction']);
});

test('PHP: ?> внутри строки не закрывает PHP', () => {
	const php = `<?php
$sql = 'SELECT ?> FROM dual';
function afterStringClose(): void {}
?>`;
	const parsed = parsePhpFile(php);
	assert.deepEqual(parsed.functions.map((item) => item.name), ['afterStringClose']);
});

test('PHP: namespace, ORM, методы, deprecated', () => {
	const php = `<?php
namespace Vendor\\Module\\Model;

/**
 * @deprecated используйте NewTable
 */
class OldTable extends \\Bitrix\\Main\\ORM\\Data\\DataManager
{
	use SomeTrait;

	public int $count = 0;
	protected static $cache;
	private const LIMIT = 10;

	public static function getTableName(): string
	{
		return 'vendor_old';
	}

	public static function getMap(): array
	{
		return [
			new IntegerField('ID'),
		];
	}

	/** @deprecated */
	protected function legacy(int $x = 1): void {}

	/**
	 * Возвращает карту.
	 *
	 * @return array<string, mixed>
	 */
	public function map(): array { return []; }

	/**
	 * Без нативного типа.
	 *
	 * @return static|null
	 */
	public function make() { return null; }
}`;
	const parsed = parsePhpFile(php);
	assert.equal(parsed.namespace, 'Vendor\\Module\\Model');
	assert.equal(parsed.classes.length, 1);
	const cls = parsed.classes[0];
	assert.equal(cls.fqcn, 'Vendor\\Module\\Model\\OldTable');
	assert.equal(cls.isOrm, true);
	assert.equal(cls.deprecated, true);
	assert.equal(cls.methods.length, 5);
	assert.deepEqual(cls.traits, ['SomeTrait']);
	assert.equal(cls.properties.length, 2);
	assert.deepEqual(
		cls.properties.map((property) => [property.name, property.type, property.visibility, property.isStatic]),
		[
			['count', 'int', 'public', false],
			['cache', undefined, 'protected', true],
		],
	);
	assert.equal(cls.constants.length, 1);
	assert.equal(cls.constants[0].name, 'LIMIT');
	assert.equal(cls.methods[0].visibility, 'public');
	assert.equal(cls.methods[0].returnType, 'string');
	assert.equal(cls.methods[1].isStatic, true);
	assert.equal(cls.methods[2].visibility, 'protected');
	assert.equal(cls.methods[3].returnType, 'array');
	assert.match(cls.methods[3].doc ?? '', /Возвращает карту/);
	assert.equal(cls.methods[4].returnType, 'static|null');
	assert.equal(cls.methods[2].deprecated, true);
});

test('компонент: путь и параметры', () => {
	const file = '/site/bitrix/components/bitrix/news.list/.parameters.php';
	const location = componentLocation(file);
	assert.deepEqual(location, {
		name: 'news.list',
		namespace: 'bitrix',
		module: undefined,
		path: '/site/bitrix/components/bitrix/news.list',
	});
});

test('параметры компонента из .parameters.php', () => {
	const content = `<?php
$arComponentParameters = array(
	'GROUPS' => array('BASE' => array('NAME' => 'Базовые')),
	'PARAMETERS' => array(
		'IBLOCK_ID' => array(
			'NAME' => 'Инфоблок',
			'TYPE' => 'LIST',
			'DEFAULT' => '',
			'REQUIRED' => 'Y',
		),
		'CACHE_TIME' => array('NAME' => 'Кеш', 'TYPE' => 'STRING', 'DEFAULT' => '3600'),
	),
);`;
	const params = parseParametersPhp(content);
	assert.equal(params.length, 2);
	assert.equal(params[0].name, 'IBLOCK_ID');
	assert.equal(params[0].type, 'LIST');
	assert.equal(params[0].required, true);
	assert.equal(params[1].defaultValue, '3600');
});

test('exclude: стандартные каталоги и min.js', () => {
	const patterns = [
		'bitrix/cache/**',
		'bitrix/managed_cache/**',
		'upload/**',
		'**/*.min.js',
	];
	assert.equal(isExcluded('bitrix/cache/s1/abc.php', patterns), true);
	assert.equal(isExcluded('bitrix/cache', patterns), true);
	assert.equal(isExcluded('bitrix/managed_cache/x.php', patterns), true);
	assert.equal(isExcluded('upload/file.jpg', patterns), true);
	assert.equal(isExcluded('bitrix/js/main/core/core.min.js', patterns), true);
	assert.equal(isExcluded('bitrix/js/main/core/core.js', patterns), false);
});

test('php-массив: мусорная пунктуация не зацикливает разбор', () => {
	const parsed = parsePhpArrayLiteralForTest("array('a' => 1; 'b' => 2)");
	assert.equal(parsed.kind, 'array');
	if (parsed.kind !== 'array') {
		return;
	}
	assert.ok(parsed.entries.length >= 1);
});

test('php-массив: вложенность и ключи', () => {
	const parsed = parsePhpArrayLiteralForTest(`array('a' => 1, 'b' => array('c' => true), 5)`);
	assert.equal(parsed.kind, 'array');
	if (parsed.kind !== 'array') {
		return;
	}
	assert.equal(parsed.entries.length, 3);
	assert.deepEqual(parsed.entries[0], { key: 'a', value: { kind: 'number', value: 1 } });
});

test('PHP: атрибуты не ломают свойства и методы', () => {
	const php = `<?php
namespace Demo;

#[Attribute]
class Service
{
	#[Inject('id')]
	private int $id = 0;

	#[Route('/run', options: ['method' => $id])]
	public function run(#[Attr] int $x): void {}
}`;
	const parsed = parsePhpFile(php);
	assert.equal(parsed.classes.length, 1);
	assert.deepEqual(parsed.classes[0].methods.map((method) => method.name), ['run']);
	assert.deepEqual(parsed.classes[0].properties.map((property) => property.name), ['id']);
});

test('JS: ключи options из тела функции', () => {
	const js = `
BX.UI.Button = function(options)
{
	options.size;
	options.color;
	this.setSize(options.size);
	this.setColor(options.color);
};
`;
	const globals = scanJsGlobals(js);
	const button = globals.find((item) => item.name === 'BX.UI.Button' && item.type === 'function');
	assert.ok(button);
	assert.deepEqual(button.params?.[0]?.keys, ['size', 'color']);
});

test('JS: TS-формы type/interface и типы параметров', () => {
	const shapes = scanJsTypeShapes(`
type BaseOptions = { icon?: string; size?: string };
type ButtonOptions = BaseOptions & {
	size?: string;
	color?: string;
	/** комментарий */
	noCaps?: boolean;
};
interface Extra extends BaseOptions {
	active: boolean;
}
`);
	const options = shapes.find((shape) => shape.name === 'ButtonOptions');
	assert.deepEqual(options?.keys, ['size', 'color', 'noCaps']);
	assert.deepEqual(options?.extends, ['BaseOptions']);
	const extra = shapes.find((shape) => shape.name === 'Extra');
	assert.deepEqual(extra?.keys, ['active']);
	assert.deepEqual(extra?.extends, ['BaseOptions']);

	const globals = scanJsGlobals('BX.Demo = function(options: ButtonOptions) { options.size; };');
	const demo = globals.find((item) => item.name === 'BX.Demo');
	assert.equal(demo?.params?.[0]?.type, 'ButtonOptions');
});

test('JS: JSDoc @typedef даёт ключи объекта', () => {
	const shapes = scanJsTypeShapes(`
/**
 * @typedef {object} blockOptions
 * @property {string} code
 * @property {number} [position]
 * @property {Object} data
 */
`);
	const options = shapes.find((shape) => shape.name === 'blockOptions');
	assert.deepEqual(options?.keys, ['code', 'position', 'data']);
});

test('PHP: замыкание в значении параметра не ломает сигнатуру', () => {
	const php = `<?php
namespace Demo;
class Svc
{
	public function run(callable $cb = function (int $x) { return $x; }, array $opts = ['a' => 1]): void
	{
		$inner = function () { return 1; };
	}
}`;
	const parsed = parsePhpFile(php);
	const method = parsed.classes[0].methods.find((item) => item.name === 'run');
	assert.ok(method);
	assert.deepEqual(method.params.map((param) => param.name), ['cb', 'opts']);
});

test('JS: @namespace + export default class даёт BX-класс', () => {
	const js = `
	 * @namespace {BX.UI}
	 */
	export default class Button
	{
		constructor(options: ButtonOptions)
		{
			this.options = options;
		}

		render(): void {}
	}
	`;
	const globals = scanJsGlobals(js);
	const button = globals.find((item) => item.name === 'BX.UI.Button' && item.type === 'class');
	assert.ok(button);
	assert.equal(button.params?.[0]?.type, 'ButtonOptions');
	assert.ok(globals.some((item) => item.name === 'BX.UI.Button.render' && item.type === 'method'));
});

test('JS: @memberOf и несколько экспортов в файле', () => {
	const js = `
/**
 * @namespace {BX.UI}
 */
export class Button { render(): void {} }
export class Icon { draw(): void {} }
`;
	const globals = scanJsGlobals(js);
	assert.ok(globals.some((item) => item.name === 'BX.UI.Button.render'));
	assert.ok(globals.some((item) => item.name === 'BX.UI.Icon.draw'));

	const memberOf = scanJsGlobals(`
/** @memberOf BX.Main */
class Popup { show(): void {} }
`);
	assert.ok(memberOf.some((item) => item.name === 'BX.Main.Popup'));
	assert.ok(memberOf.some((item) => item.name === 'BX.Main.Popup.show'));
});
