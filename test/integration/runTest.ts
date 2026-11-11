import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

function makeSite(root: string, marker: string): void {
	fs.mkdirSync(path.join(root, 'bitrix', 'modules', 'main'), { recursive: true });
	fs.mkdirSync(path.join(root, 'local', 'php_interface'), { recursive: true });
	fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'bitrix', 'modules', 'main', 'include.php'),
		`<?php\nfunction ${marker}_helper(): void {}\n`,
	);
	fs.writeFileSync(
		path.join(root, 'local', 'php_interface', 'classes.php'),
		'<?php\nnamespace Demo;\nclass Service {\n\tpublic function getItems(): array { return []; }\n}\n',
	);
	fs.writeFileSync(
		path.join(root, 'local', 'php_interface', 'use.php'),
		'<?php\n$service = new \\Demo\\Service();\n$service->getItems();\n',
	);
	fs.writeFileSync(
		path.join(root, '.vscode', 'settings.json'),
		JSON.stringify({ 'bitrix.index.enabled': false }, null, 2),
	);
}

async function main(): Promise<void> {
	// DSH запускает дочерние процессы с ELECTRON_RUN_AS_NODE=1 — для VS Code это недопустимо.
	delete process.env.ELECTRON_RUN_AS_NODE;
	const extensionRoot = path.resolve(__dirname, '..', '..', '..');
	const cache = path.join(os.tmpdir(), 'bitrix-vscode-test');
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-host-'));
	const first = path.join(fixture, 'site-a');
	const second = path.join(fixture, 'site-b');
	makeSite(first, 'site_a');
	makeSite(second, 'site_b');
	try {
		await runTests({
			extensionDevelopmentPath: extensionRoot,
			extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
			cachePath: cache,
			launchArgs: [
				first,
				`--user-data-dir=${path.join(cache, 'user-data')}`,
				`--extensions-dir=${path.join(cache, 'extensions')}`,
				'--disable-workspace-trust',
				'--skip-welcome',
				'--skip-release-notes',
				'--no-sandbox',
			],
			extensionTestsEnv: {
				BITRIX_TEST_FIRST: first,
				BITRIX_TEST_SECOND: second,
			},
		});
	} finally {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
}

void main().catch((err) => {
	console.error(err);
	process.exit(1);
});
