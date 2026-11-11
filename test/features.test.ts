import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateOrmAnnotation, parseOrmFields } from '../src/features/ormAnnotations';
import { platformKey, resolveLspLaunch, staticBinaryName } from '../src/lsp/platform';
import { updateKeybindings } from '../src/features/hotkeysConfig';
import { parseLintOutput } from '../src/features/phpLint';
import { selectRuntimeAsset } from '../src/php/runtimeAssets';
import { parse } from 'jsonc-parser';

test('PHP runtime: выбор prebuilt-сборки под платформу', () => {
	const names = [
		'php-8.2.29-cli-macos-aarch64.tar.gz',
		'php-8.2.35-cli-macos-aarch64.tar.gz',
		'php-8.2.35-cli-linux-x86_64.tar.gz',
		'php-8.3.36-cli-macos-aarch64.tar.gz',
		'php-8.4.27-cli-linux-aarch64.tar.gz',
		'php-8.4.27-cli-win.zip',
	];
	assert.equal(selectRuntimeAsset(names, '8.2', 'darwin', 'arm64')?.name, 'php-8.2.35-cli-macos-aarch64.tar.gz');
	assert.equal(selectRuntimeAsset(names, '8.2', 'linux', 'x64')?.version, '8.2.35');
	assert.equal(selectRuntimeAsset(names, '8.4', 'win32', 'x64')?.name, 'php-8.4.27-cli-win.zip');
	assert.equal(selectRuntimeAsset(names, '8.3', 'linux', 'arm64'), undefined);
});

test('php -l: разбор ошибки и чистого вывода', () => {
	assert.equal(parseLintOutput('No syntax errors detected in /tmp/a.php'), undefined);
	assert.equal(parseLintOutput(''), undefined);
	const problem = parseLintOutput(
		'PHP Parse error:  syntax error, unexpected token ")" in /tmp/a.php on line 7',
	);
	assert.ok(problem);
	assert.equal(problem.line, 7);
	assert.match(problem.message, /unexpected token/);
});

test('keybindings: обновление с сохранением комментариев', () => {
	const empty = updateKeybindings('[]\n', [
		{ key: 'cmd+alt+p', command: 'bitrix.ssh.switchProfile' },
		{ key: 'cmd+alt+u', command: 'bitrix.ssh.upload', when: 'editorTextFocus' },
	]);
	const emptyParsed = parse(empty);
	assert.equal(Array.isArray(emptyParsed), true);
	assert.equal(emptyParsed.length, 2);
	assert.equal(emptyParsed[1].key, 'cmd+alt+u');

	const existing = `[
	// мой комментарий
	{ "key": "old", "command": "bitrix.ssh.upload", "when": "editorTextFocus" },
]
`;
	const updated = updateKeybindings(existing, [
		{ key: 'ctrl+alt+u', command: 'bitrix.ssh.upload', when: 'editorTextFocus' },
	]);
	assert.match(updated, /мой комментарий/);
	const parsed = parse(updated);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].key, 'ctrl+alt+u');
});

test('платформы: 5 поддерживаемых комбинаций', () => {
	assert.equal(platformKey('win32', 'x64'), 'win32-x64');
	assert.equal(platformKey('darwin', 'x64'), 'darwin-x64');
	assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
	assert.equal(platformKey('linux', 'x64'), 'linux-x64');
	assert.equal(platformKey('linux', 'arm64'), 'linux-arm64');
	assert.equal(platformKey('freebsd', 'x64'), undefined);
	assert.equal(staticBinaryName('win32-x64'), 'php-win32-x64.exe');
	assert.equal(staticBinaryName('linux-arm64'), 'php-linux-arm64');
});

test('выбор бинарника: настройка > static > system', () => {
	const existing = new Set([
		'/ext/server/bin/bitrix-lsp.phar',
		'/ext/server/bin/php-darwin-arm64',
	]);
	const exists = (p: string): boolean => existing.has(p);
	const staticLaunch = resolveLspLaunch({
		extensionPath: '/ext',
		platform: 'darwin',
		arch: 'arm64',
		exists,
	});
	assert.equal(staticLaunch.source, 'static');
	assert.equal(staticLaunch.command, '/ext/server/bin/php-darwin-arm64');
	assert.deepEqual(staticLaunch.args, ['/ext/server/bin/bitrix-lsp.phar']);

	const configured = resolveLspLaunch({
		extensionPath: '/ext',
		configuredBinary: '/usr/bin/php',
		platform: 'darwin',
		arch: 'arm64',
		exists,
	});
	assert.equal(configured.source, 'setting');
	assert.equal(configured.command, '/usr/bin/php');

	const fallback = resolveLspLaunch({
		extensionPath: '/ext',
		platform: 'linux',
		arch: 'x64',
		exists: (p) => p.endsWith('main.php'),
	});
	assert.equal(fallback.source, 'system');
	assert.equal(fallback.command, 'php');
	assert.ok(fallback.warning);
});

test('ORM: поля getMap и doc-блок', () => {
	const php = `<?php
namespace Vendor\\Module\\Model;

use Bitrix\\Main\\ORM\\Data\\DataManager;
use Bitrix\\Main\\ORM\\Fields\\IntegerField;
use Bitrix\\Main\\ORM\\Fields\\StringField;
use Bitrix\\Main\\ORM\\Fields\\DatetimeField;

class ItemTable extends DataManager
{
	public static function getMap(): array
	{
		return [
			(new IntegerField('ID'))
				->configurePrimary()
				->configureAutocomplete(),
			(new StringField('NAME'))
				->configureRequired(),
			(new DatetimeField('CREATED_AT'))
				->setRequired(false),
		];
	}
}`;
	const fields = parseOrmFields(php);
	assert.deepEqual(
		fields.map((field) => [field.name, field.type, field.nullable, field.primary]),
		[
			['ID', 'int', false, true],
			['NAME', 'string', false, false],
			['CREATED_AT', '\\Bitrix\\Main\\Type\\DateTime', true, false],
		],
	);
	const result = generateOrmAnnotation(php);
	assert.ok(result);
	assert.equal(result.fields.length, 3);
	assert.match(result.docblock, /@property int \$ID/);
	assert.match(result.docblock, /@property string \$NAME/);
	assert.match(result.docblock, /@property \\Bitrix\\Main\\Type\\DateTime\|null \$CREATED_AT/);
	assert.equal(result.existingDoc, undefined);
});
