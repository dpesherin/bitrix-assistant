import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from '../log';
import { RuntimeArch, RuntimePlatform, selectRuntimeAsset } from '../php/runtimeAssets';

const BASE = 'https://dl.static-php.dev/v3/php-bin';
const BUCKETS: Record<RuntimePlatform, string[]> = {
	darwin: ['bulk'],
	linux: ['gnu-bulk', 'bulk'],
	win32: ['spc-max'],
};

export interface DownloadedRuntime {
	command: string;
	version: string;
}

export interface DownloadOptions {
	signal?: AbortSignal;
	onProgress?: (received: number, total: number, delta: number) => void;
}

export interface CachedRuntime extends DownloadedRuntime {
	platform: RuntimePlatform;
	arch: RuntimeArch;
	size: number;
}

/** Скачанные рантаймы из globalStorage/php-runtimes. */
export async function listCachedRuntimes(
	context: vscode.ExtensionContext,
): Promise<CachedRuntime[]> {
	const root = path.join(context.globalStorageUri.fsPath, 'php-runtimes');
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const result: CachedRuntime[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const match = /^php-(\d+\.\d+)-(darwin|linux|win32)-(x64|arm64)$/.exec(entry.name);
		if (!match) {
			continue;
		}
		const command = path.join(root, entry.name, match[2] === 'win32' ? 'php.exe' : 'php');
		try {
			const stat = await fs.promises.stat(command);
			result.push({ version: match[1], platform: match[2] as RuntimePlatform, arch: match[3] as RuntimeArch, command, size: stat.size });
		} catch {
			// пустая/повреждённая запись
		}
	}
	return result.sort((left, right) => right.version.localeCompare(left.version, 'en', { numeric: true }));
}

export async function removeCachedRuntime(
	context: vscode.ExtensionContext,
	runtime: CachedRuntime,
): Promise<void> {
	await fs.promises.rm(path.dirname(runtime.command), { recursive: true, force: true });
}

export function runtimeCachePath(
	context: vscode.ExtensionContext,
	version: string,
	platform: RuntimePlatform,
	arch: RuntimeArch,
): string {
	return path.join(
		context.globalStorageUri.fsPath,
		'php-runtimes',
		`php-${version}-${platform}-${arch}`,
		platform === 'win32' ? 'php.exe' : 'php',
	);
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${url}`);
	}
	return response.text();
}

async function sha256(buffer: Buffer): Promise<string> {
	return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function extractBinary(archive: string, target: string, zip: boolean): Promise<void> {
	const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bitrix-php-'));
	try {
		await new Promise<void>((resolve, reject) => {
			execFile(
				'tar',
				[zip ? '-xf' : '-xzf', archive, '-C', temp],
				{ timeout: 120_000, maxBuffer: 1024 * 1024 },
				(error) => (error ? reject(error) : resolve()),
			);
		});
		const find = async (dir: string, depth: number): Promise<string | undefined> => {
			if (depth > 3) {
				return undefined;
			}
			for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isFile() && (entry.name === 'php' || entry.name === 'php.exe')) {
					return full;
				}
				if (entry.isDirectory()) {
					const found = await find(full, depth + 1);
					if (found) {
						return found;
					}
				}
			}
			return undefined;
		};
		const binary = await find(temp, 0);
		if (!binary) {
			throw new Error('в архиве не найден php');
		}
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		await fs.promises.copyFile(binary, target);
		await fs.promises.chmod(target, 0o755).catch(() => undefined);
	} finally {
		await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Скачивает prebuilt static PHP в globalStorage и возвращает путь к нему. */
export async function downloadRuntime(
	context: vscode.ExtensionContext,
	version: string,
	options: DownloadOptions = {},
): Promise<DownloadedRuntime> {
	const platform = process.platform as RuntimePlatform;
	const arch = (process.arch === 'arm64' ? 'arm64' : 'x64') as RuntimeArch;
	const cached = runtimeCachePath(context, version, platform, arch);
	if (fs.existsSync(cached)) {
		return { command: cached, version };
	}
	if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
		throw new Error(`Платформа ${process.platform} не поддерживается`);
	}
	let selected: { name: string; version: string } | undefined;
	let bucket = '';
	for (const candidate of BUCKETS[platform]) {
		try {
			const listing = JSON.parse(await fetchText(`${BASE}/${candidate}/?format=json`, options.signal)) as Array<{ name?: string }>;
			selected = selectRuntimeAsset(
				listing.map((item) => item.name ?? ''),
				version,
				platform,
				arch,
			);
			if (selected) {
				bucket = candidate;
				break;
			}
		} catch (err) {
			log().debug(`PHP runtime listing ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (!selected) {
		throw new Error(
			`готовой сборки PHP ${version} для ${platform}-${arch} нет; укажите bitrix.php.lintBinary`,
		);
	}
	const url = `${BASE}/${bucket}/${selected.name}`;
	const response = await fetch(url, { signal: options.signal });
	if (!response.ok) {
		throw new Error(`не удалось скачать ${url}: HTTP ${response.status}`);
	}
	const total = Number(response.headers.get('content-length') ?? 0);
	const chunks: Buffer[] = [];
	if (response.body) {
		const reader = response.body.getReader();
		let received = 0;
		for (;;) {
			if (options.signal?.aborted) {
				await reader.cancel();
				throw new Error('скачивание отменено');
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			chunks.push(Buffer.from(value));
			received += value.byteLength;
			options.onProgress?.(received, total, value.byteLength);
		}
	}
	const archive = Buffer.concat(chunks);
	try {
		const shaUrl = `${url}.sha256`;
		const expected = (await fetchText(shaUrl, options.signal)).trim().split(/\s+/)[0]?.toLowerCase();
		if (expected && (await sha256(archive)) !== expected) {
			throw new Error('контрольная сумма PHP-архива не совпала');
		}
	} catch (err) {
		if (err instanceof Error && /контрольная сумма/.test(err.message)) {
			throw err;
		}
		log().debug(`PHP runtime checksum недоступен: ${selected.name}`);
	}
	const tempArchive = path.join(os.tmpdir(), `bitrix-${selected.name}`);
	try {
		await fs.promises.writeFile(tempArchive, archive);
		await extractBinary(tempArchive, cached, selected.name.endsWith('.zip'));
	} finally {
		await fs.promises.unlink(tempArchive).catch(() => undefined);
	}
	log().info(`PHP runtime скачан: ${selected.name} -> ${cached}`);
	return { command: cached, version: selected.version };
}
