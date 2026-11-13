import './support/vscodeMock';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { SshConnectionManager } from '../src/ssh/connection';
import { ProfileStore } from '../src/ssh/profiles';
import { SyncService } from '../src/ssh/sync';
import { SshProfile } from '../src/ssh/types';
import { isExcluded, toPosix } from '../src/util/glob';
import { mockState, mockFolder } from './support/vscodeMock';
import { TestSftpServer } from './support/sftpServer';

const server = new TestSftpServer();
let siteDir = '';
let manager: SshConnectionManager;
let sync: SyncService;

function profile(): SshProfile {
	return {
		id: 'test',
		name: 'test',
		host: '127.0.0.1',
		port: server.port,
		username: 'tester',
		authType: 'password',
		remoteRoot: '/site',
		localRoot: siteDir,
	};
}

const store = {
	secrets: async () => ({ password: 'secret' }),
	getHostKey: () => undefined,
	setHostKey: async () => undefined,
} as unknown as ProfileStore;

function read(relative: string): string {
	return fs.readFileSync(path.join(server.root, 'site', relative), 'utf8');
}

function writeLocal(name: string, content: string): string {
	const file = path.join(siteDir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

function makeRemoteNewer(relative: string, seconds = 120): void {
	const file = path.join(server.root, 'site', relative);
	const future = new Date(Date.now() + seconds * 1000);
	fs.utimesSync(file, future, future);
}

before(async () => {
	await server.start();
	siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-site-'));
	mockState.folders = [mockFolder(siteDir)];
	mockState.settings = {
		ssh: { exclude: ['**/*.bak', '**/*.bitrix-assistant-*.tmp', '**/*.min.js'] },
	};
	mockState.prompts = [];
	mockState.promptResult = undefined;
	manager = new SshConnectionManager(store);
	sync = new SyncService(manager);
	await manager.connect(profile());
});

after(async () => {
	await manager.disconnect();
	await server.close();
	fs.rmSync(siteDir, { recursive: true, force: true });
});

test('sftp: атомарная загрузка без временных файлов', async () => {
	writeLocal('a.php', 'v1');
	assert.equal(await sync.upload(path.join(siteDir, 'a.php')), 'uploaded');
	assert.equal(read('a.php'), 'v1');
	const leftovers = fs.readdirSync(path.join(server.root, 'site')).filter((name) => name.includes('.tmp'));
	assert.deepEqual(leftovers, []);
});

test('sftp: перезапись не оставляет серверный .bak', async () => {
	writeLocal('a.php', 'v2');
	assert.equal(await sync.upload(path.join(siteDir, 'a.php')), 'uploaded');
	assert.equal(read('a.php'), 'v2');
	assert.equal(fs.existsSync(path.join(server.root, 'site', 'a.php.bak')), false);
});

test('sftp: конфликт — отказ не перезаписывает сервер', async () => {
	writeLocal('a.php', 'v3');
	makeRemoteNewer('a.php');
	mockState.promptResult = undefined;
	assert.equal(await sync.upload(path.join(siteDir, 'a.php')), 'cancelled');
	assert.equal(read('a.php'), 'v2');
	assert.ok(mockState.prompts.at(-1)?.includes('новее'));
});

test('sftp: конфликт — подтверждение перезаписывает, без .bak', async () => {
	mockState.promptResult = 'Перезаписать';
	assert.equal(await sync.upload(path.join(siteDir, 'a.php')), 'uploaded');
	assert.equal(read('a.php'), 'v3');
	assert.equal(fs.existsSync(path.join(server.root, 'site', 'a.php.bak')), false);
});

test('sftp: одинаковое содержимое — не конфликт, без вопроса', async () => {
	writeLocal('a.php', 'v3');
	makeRemoteNewer('a.php');
	mockState.prompts = [];
	mockState.promptResult = undefined;
	assert.equal(await sync.upload(path.join(siteDir, 'a.php')), 'identical');
	assert.equal(read('a.php'), 'v3');
	assert.equal(mockState.prompts.length, 0);
});

test('сравнение с сервером: по содержимому, без mtime', async () => {
	const file = writeLocal('cmp.php', 'same');
	assert.equal(await sync.upload(file), 'uploaded');
	makeRemoteNewer('cmp.php');
	assert.equal(await sync.compare(file), 'identical');
	writeLocal('cmp.php', 'changed');
	assert.equal(await sync.compare(file), 'different');
	assert.equal(await sync.compare(file, '/site/nope.php'), 'missing');
});

test('sftp: каталог — один общий вопрос и пропуск новых', async () => {
	writeLocal('dir/one.php', 'one');
	writeLocal('dir/two.php', 'two');
	await sync.uploadEntry(path.join(siteDir, 'dir'));
	assert.equal(read('dir/one.php'), 'one');
	writeLocal('dir/one.php', 'one-updated');
	makeRemoteNewer('dir/one.php');
	mockState.prompts = [];
	mockState.promptResult = 'Пропустить новые';
	const result = await sync.uploadEntry(path.join(siteDir, 'dir'));
	assert.equal(mockState.prompts.length, 1);
	assert.ok(mockState.prompts[0].includes('1'));
	assert.equal(read('dir/one.php'), 'one');
	assert.ok(result.skipped >= 1);
});

test('sftp: upload каталога не доходит до fastPut (внятная ошибка вместо EISDIR)', async () => {
	writeLocal('dirForUpload/x.php', 'x');
	await assert.rejects(
		() => sync.upload(path.join(siteDir, 'dirForUpload')),
		/каталог/i,
	);
});

test('sftp: вложенные каталоги загружаются рекурсивно', async () => {
	writeLocal('nested/one.php', '1');
	writeLocal('nested/sub/two.php', '2');
	writeLocal('nested/sub/deep/three.php', '3');
	const result = await sync.uploadEntry(path.join(siteDir, 'nested'));
	assert.equal(result.uploaded, 3);
	assert.equal(read('nested/one.php'), '1');
	assert.equal(read('nested/sub/two.php'), '2');
	assert.equal(read('nested/sub/deep/three.php'), '3');
});

test('sftp: вложенные каталоги скачиваются рекурсивно с созданием подпапок', async () => {
	fs.rmSync(path.join(siteDir, 'nested'), { recursive: true, force: true });
	const result = await sync.downloadEntry('/site/nested');
	assert.equal(result.downloaded, 3);
	assert.equal(fs.readFileSync(path.join(siteDir, 'nested', 'one.php'), 'utf8'), '1');
	assert.equal(fs.readFileSync(path.join(siteDir, 'nested', 'sub', 'two.php'), 'utf8'), '2');
	assert.equal(
		fs.readFileSync(path.join(siteDir, 'nested', 'sub', 'deep', 'three.php'), 'utf8'),
		'3',
	);
});

test('sftp: скачивание перезаписывает без локального .bak', async () => {
	const local = writeLocal('b.php', 'old-local');
	fs.writeFileSync(path.join(server.root, 'site', 'b.php'), 'remote-new');
	makeRemoteNewer('b.php');
	await sync.download('/site/b.php', local);
	assert.equal(fs.readFileSync(local, 'utf8'), 'remote-new');
	assert.equal(fs.existsSync(`${local}.bak`), false);
});

test('sftp: переподключение после обрыва связи', async () => {
	server.closeActive();
	await new Promise((resolve) => setTimeout(resolve, 150));
	const entry = await manager.stat('/site/a.php');
	assert.ok(entry, 'stat после обрыва должен переподключиться');
	assert.equal(entry?.type, 'file');
	assert.equal(manager.isConnected, true);
});

test('sftp: после явного disconnect автопереподключения нет', async () => {
	await manager.disconnect();
	await assert.rejects(() => manager.readdir('/site'));
	assert.equal(manager.isConnected, false);
	await manager.connect(profile());
});

test('sftp: аутентификация по приватному ключу', async () => {
	const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-key-'));
	const { privateKey } = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048,
		privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});
	const keyPath = path.join(keyDir, 'id_rsa');
	fs.writeFileSync(keyPath, privateKey);
	const keyManager = new SshConnectionManager(store);
	try {
		await keyManager.connect({
			...profile(),
			authType: 'privateKey',
			privateKeyPath: keyPath,
		});
		const entry = await keyManager.stat('/site/a.php');
		assert.equal(entry?.type, 'file');
	} finally {
		await keyManager.disconnect();
		fs.rmSync(keyDir, { recursive: true, force: true });
	}
});

test('sftp: syncAll спрашивает перед массовой перезаписью', async () => {
	const local = writeLocal('c.php', 'local-old');
	fs.writeFileSync(path.join(server.root, 'site', 'c.php'), 'remote-new');
	makeRemoteNewer('c.php');
	mockState.prompts = [];
	mockState.promptResult = undefined;
	const cancelled = await sync.syncAll('download');
	assert.ok(mockState.prompts.some((message) => message.includes('перезапишет')));
	assert.equal(fs.readFileSync(local, 'utf8'), 'local-old');
	assert.ok(cancelled.skipped > 0);

	mockState.promptResult = 'Синхронизировать';
	const done = await sync.syncAll('download');
	assert.equal(fs.readFileSync(local, 'utf8'), 'remote-new');
	assert.ok(done.downloaded >= 1);
});

test('пути: Windows-разделители нормализуются', () => {
	assert.equal(toPosix('C:\\site\\local\\a.php'), 'C:/site/local/a.php');
	assert.equal(isExcluded('bitrix\\cache\\x.php', ['bitrix/cache/**']), true);
});

test('sftp: много файлов в каталоге — параллельно, с прогрессом по файлам и байтам', async () => {
	const files: string[] = [];
	for (let index = 0; index < 12; index++) {
		files.push(writeLocal(`many/dir${index % 3}/file${index}.php`, `content-${index}`));
	}
	const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
	const states: Array<{ doneFiles: number; totalFiles: number; doneBytes: number; totalBytes: number }> = [];
	const result = await sync.uploadEntry(
		path.join(siteDir, 'many'),
		() => undefined,
		undefined,
		(state) => states.push({ ...state }),
	);
	assert.equal(result.uploaded, 12);
	assert.equal(read('many/dir0/file0.php'), 'content-0');
	assert.equal(read('many/dir2/file11.php'), 'content-11');
	assert.ok(states.length > 0, 'прогресс должен приходить');
	assert.deepEqual(states[0].totalFiles, 12);
	assert.deepEqual(states.at(-1)?.totalFiles, 12);
	assert.deepEqual(states.at(-1)?.doneFiles, 12);
	assert.deepEqual(states.at(-1)?.totalBytes, totalBytes);
	assert.deepEqual(states.at(-1)?.doneBytes, totalBytes);
});

test('sftp: прогресс скачивания каталога доходит до конца', async () => {
	const states: Array<{ doneFiles: number; totalFiles: number; doneBytes: number; totalBytes: number }> = [];
	fs.rmSync(path.join(siteDir, 'many'), { recursive: true, force: true });
	const result = await sync.downloadEntry(
		'/site/many',
		() => undefined,
		undefined,
		(state) => states.push({ ...state }),
	);
	assert.equal(result.downloaded, 12);
	assert.equal(states.at(-1)?.doneFiles, 12);
	assert.ok((states.at(-1)?.doneBytes ?? 0) > 0);
	assert.equal(fs.readFileSync(path.join(siteDir, 'many', 'dir1', 'file1.php'), 'utf8'), 'content-1');
});

test('sftp: ошибка операции не рвёт соединение (без лишнего переподключения)', async () => {
	await assert.rejects(() => manager.readFile('/site/definitely-missing.php'));
	assert.equal(manager.isConnected, true);
	// Соединение живое: следующая операция проходит без рукопожатия.
	assert.equal((await manager.stat('/site/a.php'))?.type, 'file');
});

test('sftp: fastPut отдаёт прогресс по байтам и финальный размер', async () => {
	const local = writeLocal('progress.php', 'x'.repeat(200_000));
	const seen: Array<[number, number]> = [];
	await manager.fastPut(local, '/site/progress.php', (done, total) => seen.push([done, total]));
	assert.ok(seen.length > 0);
	assert.deepEqual(seen.at(-1), [200_000, 200_000]);
	await manager.unlink('/site/progress.php');
});
