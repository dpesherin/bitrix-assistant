import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Database } from '../src/indexer/db';

test('Database: вложенная транзакция не открывает вторую и откатывается вместе с внешней', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-db-'));
	const db = await Database.open(path.join(directory, 'nested.db'));
	try {
		db.exec('CREATE TABLE numbers (value INTEGER);');
		db.transaction(() => {
			db.run('INSERT INTO numbers (value) VALUES (?)', 1);
			db.transaction(() => {
				db.run('INSERT INTO numbers (value) VALUES (?)', 2);
			});
		});
		assert.deepEqual(
			db.all<{ value: number }>('SELECT value FROM numbers ORDER BY value').map((row) => row.value),
			[1, 2],
		);

		assert.throws(() =>
			db.transaction(() => {
				db.run('INSERT INTO numbers (value) VALUES (?)', 3);
				db.transaction(() => {
					throw new Error('сбой внутри');
				});
			}),
		);
		assert.deepEqual(
			db.all<{ value: number }>('SELECT value FROM numbers ORDER BY value').map((row) => row.value),
			[1, 2],
			'вложенная ошибка должна откатить всю пачку',
		);
	} finally {
		db.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
