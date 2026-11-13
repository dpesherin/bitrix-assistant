import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client, ClientChannel, ConnectConfig, FileEntry, SFTPWrapper, Stats } from 'ssh2';
import * as vscode from 'vscode';
import { log, errorMessage } from '../log';
import { ProfileStore } from './profiles';
import { ProfileSecret, RemoteEntry, SshProfile } from './types';

interface ActiveConnection {
	profile: SshProfile;
	client: Client;
	sftp: SFTPWrapper;
}

const S_IFMT = 0o170000;

function fileTypeFromMode(mode: number): RemoteEntry['type'] {
	switch (mode & S_IFMT) {
		case 0o040000:
			return 'directory';
		case 0o100000:
			return 'file';
		case 0o120000:
			return 'symlink';
		default:
			return 'other';
	}
}

function fingerprintHostKey(key: Buffer): string {
	return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** Ошибка аутентификации ssh2: неверный пароль, нет ключа, методы не подошли. */
function isAuthFailure(err: unknown): boolean {
	if ((err as { level?: string } | null)?.level === 'client-authentication') {
		return true;
	}
	const message = errorMessage(err).toLowerCase();
	return message.includes('authentication methods failed') || message.includes('authentication failed');
}

function timingSafeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left, 'utf8');
	const b = Buffer.from(right, 'utf8');
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Одно активное SSH-подключение (MVP): sftp-канал + сериализация запросов. */
export class SshConnectionManager implements vscode.Disposable {
	private active?: ActiveConnection;
	private pending?: Promise<void>;
	private lastProfile?: SshProfile;
	private reconnect?: Promise<void>;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeConnection = this.changed.event;

	constructor(private readonly store: ProfileStore) {}

	get activeProfile(): SshProfile | undefined {
		return this.active?.profile;
	}

	get isConnected(): boolean {
		return Boolean(this.active);
	}

	async connect(profile: SshProfile): Promise<void> {
		if (this.active?.profile.id === profile.id) {
			this.lastProfile = profile;
			return;
		}
		await this.disconnect();
		this.lastProfile = profile;
		this.pending = this.doConnect(profile).finally(() => {
			this.pending = undefined;
		});
		await this.pending;
	}

	private async doConnect(profile: SshProfile): Promise<void> {
		const client = await this.authenticate(profile);
		client.on('error', (err) => log().warn(`SSH: ${errorMessage(err)}`));
		client.on('close', () => {
			if (this.active?.client === client) {
				this.active = undefined;
				this.changed.fire();
			}
		});
		const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
			client.sftp((err, channel) => {
				if (err) {
					reject(err);
					return;
				}
				resolve(channel);
			});
		});
		this.active = { profile, client, sftp };
		this.changed.fire();
		log().info(`SSH подключён: ${profile.username}@${profile.host}:${profile.port} (${profile.remoteRoot})`);
	}

	/**
	 * Подключается и проверяет host key. Если сохранённый пароль не подошёл
	 * (или его нет), один раз спрашивает новый и сохраняет в SecretStorage.
	 */
	private async authenticate(profile: SshProfile): Promise<Client> {
		let secret = await this.store.secrets(profile);
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.openClient(profile, secret);
			} catch (err) {
				if (attempt > 0 || !isAuthFailure(err)) {
					throw err;
				}
				const password = await this.askPassword(profile, secret.password !== undefined);
				if (password === undefined) {
					throw err;
				}
				await this.store.upsert(profile, { password });
				secret = { ...secret, password };
			}
		}
	}

	private async openClient(profile: SshProfile, secret: ProfileSecret): Promise<Client> {
		const knownHostKey = this.store.getHostKey(profile.host, profile.port);
		let seenHostKey: string | undefined;
		const options = this.buildConfig(profile, secret);
		options.hostVerifier = (key: Buffer): boolean => {
			seenHostKey = fingerprintHostKey(key);
			if (knownHostKey === undefined) {
				return true; // TOFU: запоминаем после успешного подключения
			}
			return timingSafeEqual(knownHostKey, seenHostKey);
		};
		const client = new Client();
		// Часть серверов отдаёт пароль только через keyboard-interactive (PAM).
		client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
			finish(prompts.map(() => secret.password ?? ''));
		});
		try {
			await new Promise<void>((resolve, reject) => {
				client.once('ready', () => {
					if (knownHostKey === undefined && seenHostKey !== undefined) {
						void this.store.setHostKey(profile.host, profile.port, seenHostKey);
					}
					resolve();
				});
				client.once('error', reject);
				client.connect(options);
			});
			return client;
		} catch (err) {
			client.end();
			throw err;
		}
	}

	private async askPassword(profile: SshProfile, wrongStored: boolean): Promise<string | undefined> {
		const password = await vscode.window.showInputBox({
			title: `SSH: пароль для ${profile.username}@${profile.host}`,
			prompt: wrongStored
				? 'Сохранённый пароль не подошёл. Введи новый — он сохранится в SecretStorage.'
				: 'Пароль для этого профиля не сохранён. Введи его — он сохранится в SecretStorage.',
			password: true,
			ignoreFocusOut: true,
		});
		return password === undefined || password === '' ? undefined : password;
	}

	private buildConfig(profile: SshProfile, secret: ProfileSecret): ConnectConfig {
		const base: ConnectConfig = {
			host: profile.host,
			port: profile.port,
			username: profile.username,
			readyTimeout: 20_000,
			keepaliveInterval: 10_000,
			tryKeyboard: true,
		};
		if (profile.authType === 'privateKey' && profile.privateKeyPath) {
			return {
				...base,
				privateKey: fs.readFileSync(profile.privateKeyPath),
				passphrase: secret.passphrase,
			};
		}
		return { ...base, password: secret.password };
	}

	/**
	 * Интерактивный shell в отдельном подключении — для терминала VS Code.
	 * Не трогает активную sftp-сессию, поэтому терминал и синхронизация живут
	 * независимо друг от друга.
	 */
	async openShell(profile: SshProfile): Promise<{ client: Client; stream: ClientChannel }> {
		const client = await this.authenticate(profile);
		const stream = await new Promise<ClientChannel>((resolve, reject) => {
			client.shell({ term: 'xterm-256color' }, (err, channel) => (err ? reject(err) : resolve(channel)));
		});
		log().info(`SSH терминал: ${profile.username}@${profile.host}:${profile.port}`);
		return { client, stream };
	}

	async disconnect(): Promise<void> {
		this.lastProfile = undefined;
		if (this.pending) {
			await this.pending.catch(() => undefined);
		}
		const active = this.active;
		this.active = undefined;
		if (active) {
			active.client.end();
			this.changed.fire();
			log().info('SSH отключён');
		}
	}

	/** Возвращает sftp-канал; при обрыве связи один раз переподключается. */
	private async channel(): Promise<SFTPWrapper> {
		const current = this.active;
		if (current) {
			return current.sftp;
		}
		const profile = this.lastProfile;
		if (!profile) {
			throw new Error('Нет активного SSH-подключения');
		}
		if (!this.reconnect) {
			this.reconnect = this.doConnect(profile)
				.catch((err) => {
					throw new Error(`SSH переподключение не удалось: ${errorMessage(err)}`);
				})
				.finally(() => {
					this.reconnect = undefined;
				});
		}
		await this.reconnect;
		const active = this.active as ActiveConnection | undefined;
		if (!active) {
			throw new Error('Нет активного SSH-подключения');
		}
		return active.sftp;
	}

	/** Выполняет sftp-операцию, повторяя её один раз после переподключения. */
	private async call<T>(operation: (channel: SFTPWrapper) => Promise<T>): Promise<T> {
		const first = await this.channel();
		try {
			return await operation(first);
		} catch (err) {
			if (!this.lastProfile) {
				throw err;
			}
			log().warn(`SSH: операция не удалась, переподключаюсь (${errorMessage(err)})`);
			this.disconnectActive();
			const second = await this.channel();
			return operation(second);
		}
	}

	private disconnectActive(): void {
		const active = this.active;
		this.active = undefined;
		if (active) {
			active.client.end();
			this.changed.fire();
		}
	}

	async readdir(remotePath: string): Promise<RemoteEntry[]> {
		const list = await this.call((channel) => new Promise<FileEntry[]>((resolve, reject) => {
			channel.readdir(remotePath, (err, entries) => {
				if (err) {
					reject(err);
					return;
				}
				resolve(entries);
			});
		}));
		return list.map((entry) => ({
			name: entry.filename,
			path: path.posix.join(remotePath, entry.filename),
			type: fileTypeFromMode(entry.attrs.mode),
			size: entry.attrs.size,
			mtime: entry.attrs.mtime,
		}));
	}

	async stat(remotePath: string): Promise<RemoteEntry | undefined> {
		try {
			const stats = await this.call((channel) => new Promise<Stats>((resolve, reject) => {
				channel.stat(remotePath, (err, value) => {
					if (err) {
						reject(err);
						return;
					}
					resolve(value);
				});
			}));
			return {
				name: path.posix.basename(remotePath),
				path: remotePath,
				type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
				size: stats.size,
				mtime: stats.mtime,
			};
		} catch {
			return undefined;
		}
	}

	async readFile(remotePath: string): Promise<Buffer> {
		return this.call((channel) => new Promise<Buffer>((resolve, reject) => {
			channel.readFile(remotePath, (err, data) => {
				if (err) {
					reject(err);
					return;
				}
				resolve(data);
			});
		}));
	}

	async writeFile(remotePath: string, data: Buffer | string): Promise<void> {
		await this.call((channel) => new Promise<void>((resolve, reject) => {
			channel.writeFile(remotePath, data, (err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		}));
	}

	async fastGet(remotePath: string, localPath: string): Promise<void> {
		await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
		await this.call((channel) => new Promise<void>((resolve, reject) => {
			channel.fastGet(remotePath, localPath, (err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		}));
	}

	async fastPut(localPath: string, remotePath: string): Promise<void> {
		await this.call((channel) => new Promise<void>((resolve, reject) => {
			channel.fastPut(localPath, remotePath, (err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		}));
	}

	async rename(from: string, to: string): Promise<void> {
		await this.call((channel) => new Promise<void>((resolve, reject) => {
			channel.rename(from, to, (err) => (err ? reject(err) : resolve()));
		}));
	}

	/**
	 * Замена файла без резервной копии: posix-rename (атомарная перезапись) там,
	 * где сервер его поддерживает, иначе unlink + обычный rename. Обычный
	 * SSH_FXP_RENAME по протоколу не перезаписывает существующую цель.
	 */
	async replace(from: string, to: string): Promise<void> {
		await this.call((channel) => new Promise<void>((resolve, reject) => {
			const fallback = (): void => {
				channel.unlink(to, () => {
					channel.rename(from, to, (err) => (err ? reject(err) : resolve()));
				});
			};
			try {
				channel.ext_openssh_rename(from, to, (err) => (err ? fallback() : resolve()));
			} catch {
				// расширение posix-rename@openssh.com не поддерживается
				fallback();
			}
		}));
	}

	async unlink(remotePath: string): Promise<void> {
		await this.call((channel) => new Promise<void>((resolve) => {
			channel.unlink(remotePath, () => resolve());
		}));
	}

	async mkdir(remotePath: string): Promise<void> {
		await this.call((channel) => new Promise<void>((resolve) => {
			channel.mkdir(remotePath, { mode: 0o755 }, () => resolve());
		}));
	}

	async mkdirp(remotePath: string): Promise<void> {
		const normalized = remotePath.replace(/\/+$/, '');
		if (normalized === '' || normalized === '/') {
			return;
		}
		const parts = normalized.split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current += `/${part}`;
			const info = await this.stat(current);
			if (!info) {
				await this.mkdir(current);
			}
		}
	}

	dispose(): void {
		const active = this.active;
		this.active = undefined;
		active?.client.end();
		this.changed.dispose();
	}
}
