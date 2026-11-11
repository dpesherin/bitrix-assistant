import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateOrmAnnotation, parseOrmFields } from '../src/features/ormAnnotations';
import { platformKey, resolveLspLaunch, staticBinaryName } from '../src/lsp/platform';
import { updateKeybindings } from '../src/features/hotkeysConfig';
import { parseLintOutput } from '../src/features/phpLint';
import { selectRuntimeAsset } from '../src/php/runtimeAssets';
import {
	BUNDLED_PHP_VERSION,
	candidateCommands,
	expandConfigPath,
	normalizePhpEntry,
	projectStorageKey,
	versionMatches,
} from '../src/php/interpreter';
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

test('PHP: версия сравнивается по major.minor', () => {
	assert.equal(versionMatches('8.3', '8.3'), true);
	assert.equal(versionMatches('8.3', '8.3.14'), true);
	assert.equal(versionMatches('8.3', '8.4'), false);
	assert.equal(versionMatches('7.4', '8.4'), false);
	assert.equal(versionMatches('auto', '8.1'), true);
});

test('PHP: встроен только 8.4', () => {
	assert.equal(BUNDLED_PHP_VERSION, '8.4');
	const bundled = '/ext/server/bin/php-darwin-arm64';
	assert.deepEqual(
		candidateCommands({ selected: '8.4', bundled, platform: 'linux' }).map((item) => item.source),
		['bundled', 'versioned'],
	);
	assert.deepEqual(
		candidateCommands({ selected: '8.4', bundled, platform: 'darwin' }).map((item) => item.source),
		['bundled', 'versioned', 'versioned', 'versioned'],
	);
	assert.deepEqual(
		candidateCommands({ selected: '8.3', bundled }).map((item) => item.source),
		['versioned', 'versioned', 'versioned'],
	);
});

test('PHP: путь из bitrix.php.paths важнее встроенного рантайма', () => {
	const commands = candidateCommands({
		selected: '8.3',
		paths: { '8.3': '/usr/local/bin/php83' },
		lintBinary: '/usr/bin/php',
		downloaded: '/tmp/php-8.3.14/php',
		bundled: '/ext/server/bin/php-linux-x64',
		platform: 'linux',
	});
	assert.equal(commands[0].command, '/usr/local/bin/php83');
	assert.equal(commands[0].source, 'paths');
	assert.deepEqual(
		commands.map((item) => item.source),
		['paths', 'lintBinary', 'downloaded', 'versioned'],
	);
});

test('PHP: auto берёт php из PATH, затем встроенный 8.4', () => {
	const commands = candidateCommands({ selected: 'auto', bundled: '/ext/server/bin/php-win32-x64.exe', platform: 'win32' });
	assert.deepEqual(commands.map((item) => item.command), ['php', '/ext/server/bin/php-win32-x64.exe']);
	assert.deepEqual(commands.map((item) => item.source), ['path', 'bundled']);
});

test('PHP: дубликаты путей не повторяются', () => {
	const commands = candidateCommands({
		selected: '8.4',
		paths: { '8.4': '/usr/bin/php' },
		lintBinary: '/usr/bin/php',
		bundled: '/usr/bin/php',
		platform: 'linux',
	});
	assert.equal(commands.filter((item) => item.command === '/usr/bin/php').length, 1);
});

test('PHP: пути из настроек раскрывают ~ и ${env:VAR}', () => {
	const env = { HOME: '/home/denis', PHP83: '/opt/php83/bin/php' } as NodeJS.ProcessEnv;
	assert.equal(expandConfigPath('~/.php/8.3/bin/php', env, '/home/denis'), '/home/denis/.php/8.3/bin/php');
	assert.equal(expandConfigPath('/usr/bin/php8.3', env, '/home/denis'), '/usr/bin/php8.3');
	assert.equal(expandConfigPath('${env:PHP83}', env, '/home/denis'), '/opt/php83/bin/php');
	assert.equal(expandConfigPath('  /usr/bin/php  ', env, '/home/denis'), '/usr/bin/php');
	assert.equal(expandConfigPath('', env, '/home/denis'), '');
	assert.equal(expandConfigPath('${env:MISSING}', env, '/home/denis'), '${env:MISSING}');
});

test('PHP: запись проекта нормализуется (версия + пути)', () => {
	const entry = normalizePhpEntry(' 8.3 ', { '8.3': ' /usr/bin/php83 ', '8.2': '', bad: 42 });
	assert.equal(entry.version, '8.3');
	assert.deepEqual(entry.paths, { '8.3': '/usr/bin/php83' });
	assert.deepEqual(normalizePhpEntry(undefined, undefined), { version: 'auto', paths: {} });
	assert.deepEqual(normalizePhpEntry('   ', null), { version: 'auto', paths: {} });
});

test('PHP: ключ проекта — путь папки, без хвостового слэша', () => {
	assert.equal(projectStorageKey('/srv/www/site/', 'linux'), '/srv/www/site');
	assert.equal(projectStorageKey('/srv/www/site//', 'darwin'), '/srv/www/site');
	assert.equal(projectStorageKey(undefined, 'linux'), 'workspace');
	assert.equal(projectStorageKey('C:\\Sites\\Shop', 'win32'), 'c:\\sites\\shop');
});
