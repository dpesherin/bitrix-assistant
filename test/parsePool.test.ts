import './support/vscodeMock';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ParsePool } from '../src/indexer/parsePool';
import { parsePhpFile } from '../src/indexer/php/phpParser';
import type { PhpParseResult } from '../src/indexer/parseWorker';

test('пул воркеров: разбор совпадает с разбором в основном потоке', async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-parse-pool-'));
	const files: string[] = [];
	for (let index = 0; index < 5; index++) {
		const file = path.join(directory, `Class${index}.php`);
		fs.writeFileSync(
			file,
			`<?php\nnamespace Demo\\N${index};\n\n/** Класс ${index}. */\nclass Class${index}\n{\n`
				+ '\t/** Метод. */\n\tpublic function run(array $params = []): array { return $params; }\n}\n',
		);
		files.push(file);
	}
	const missing = path.join(directory, 'Missing.php');
	files.push(missing);

	const pool = new ParsePool(2);
	const results: PhpParseResult[] = [];
	try {
		await pool.parsePhpStream(files, (batch: PhpParseResult[]) => results.push(...batch));
	} finally {
		await pool.dispose();
	}

	assert.equal(results.length, files.length);
	for (const result of results) {
		if (result.file === missing) {
			assert.ok(result.error, 'для нечитаемого файла должна быть ошибка');
			continue;
		}
		const content = fs.readFileSync(result.file, 'utf8');
		assert.deepEqual(result.parsed, parsePhpFile(content));
		assert.equal(result.content, content);
		assert.equal(result.hash, crypto.createHash('sha1').update(content).digest('hex'));
		assert.equal(result.size, Buffer.byteLength(content));
	}
	fs.rmSync(directory, { recursive: true, force: true });
});
