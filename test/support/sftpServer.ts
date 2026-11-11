/* In-process SFTP-сервер на ssh2 для автотестов: реальный FS во временном каталоге. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server, utils } from 'ssh2';

const { STATUS_CODE } = utils.sftp;

interface HandleState {
	fd?: number;
	entries?: string[];
	dir?: string;
	sent?: boolean;
}

interface Attrs {
	mode: number;
	uid: number;
	gid: number;
	size: number;
	atime: number;
	mtime: number;
}

function attrsOf(stat: fs.Stats): Attrs {
	return {
		mode: stat.mode,
		uid: stat.uid,
		gid: stat.gid,
		size: stat.size,
		atime: Math.floor(stat.atimeMs / 1000),
		mtime: Math.floor(stat.mtimeMs / 1000),
	};
}

export class TestSftpServer {
	readonly root: string;
	private server?: Server;
	private readonly clients = new Set<{ end(): void }>();
	private nextHandle = 1;
	private readonly handles = new Map<string, HandleState>();

	constructor() {
		this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitrix-sftp-'));
	}

	get port(): number {
		const address = this.server?.address();
		if (!address || typeof address === 'string') {
			throw new Error('SFTP-сервер не запущен');
		}
		return address.port;
	}

	async start(): Promise<void> {
		const { privateKey } = crypto.generateKeyPairSync('rsa', {
			modulusLength: 2048,
			privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' },
		});
		const server = new Server({ hostKeys: [privateKey] }, (client) => {
			this.clients.add(client);
			client.on('close', () => this.clients.delete(client));
			client.on('authentication', (ctx) => ctx.accept());
			client.on('ready', () => {
				client.on('session', (accept) => {
					const session = accept();
					session.on('sftp', (acceptSftp) => this.attach(acceptSftp()));
				});
			});
		});
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => resolve());
		});
	}

	/** Разрывает все активные клиентские соединения (имитация обрыва связи). */
	closeActive(): void {
		for (const client of this.clients) {
			client.end();
		}
		this.clients.clear();
	}

	async close(): Promise<void> {
		this.closeActive();
		await new Promise<void>((resolve) => {
			if (!this.server) {
				resolve();
				return;
			}
			this.server.close(() => resolve());
		});
		fs.rmSync(this.root, { recursive: true, force: true });
	}

	private resolve(remote: string): string {
		const normalized = path.posix.normalize(`/${remote.replace(/\\/g, '/')}`);
		const full = path.resolve(this.root, normalized.replace(/^\/+/, ''));
		if (full !== this.root && !full.startsWith(`${this.root}${path.sep}`)) {
			throw new Error('Путь вне корня тестового SFTP');
		}
		return full;
	}

	private handle(state: HandleState): Buffer {
		const id = String(this.nextHandle++);
		this.handles.set(id, state);
		return Buffer.from(id);
	}

	private state(handle: Buffer): HandleState | undefined {
		return this.handles.get(handle.toString());
	}

	private failure(sftp: any, reqid: number, err: NodeJS.ErrnoException): void {
		const code = err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE;
		sftp.status(reqid, code);
	}

	private attach(sftp: any): void {
		sftp.on('error', () => undefined);

		sftp.on('OPEN', (reqid: number, filename: string, flags: number) => {
			let full: string;
			try {
				full = this.resolve(filename);
			} catch {
				sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
				return;
			}
			const read = (flags & 0x1) !== 0;
			const write = (flags & 0x2) !== 0;
			const append = (flags & 0x4) !== 0;
			const trunc = (flags & 0x10) !== 0;
			let mode = 'r';
			if (write) {
				mode = append ? 'a' : trunc ? 'w' : read ? 'r+' : 'w';
			}
			fs.open(full, mode, (err, fd) => {
				if (err) {
					this.failure(sftp, reqid, err);
					return;
				}
				sftp.handle(reqid, this.handle({ fd }));
			});
		});

		sftp.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
			const state = this.state(handle);
			if (!state || state.fd === undefined) {
				sftp.status(reqid, STATUS_CODE.FAILURE);
				return;
			}
			fs.write(state.fd, data, 0, data.length, offset, (err) => {
				if (err) {
					sftp.status(reqid, STATUS_CODE.FAILURE);
					return;
				}
				sftp.status(reqid, STATUS_CODE.OK);
			});
		});

		sftp.on('READ', (reqid: number, handle: Buffer, offset: number, length: number) => {
			const state = this.state(handle);
			if (!state || state.fd === undefined) {
				sftp.status(reqid, STATUS_CODE.FAILURE);
				return;
			}
			const buffer = Buffer.alloc(length);
			fs.read(state.fd, buffer, 0, length, offset, (err, bytesRead, data) => {
				if (err) {
					sftp.status(reqid, STATUS_CODE.FAILURE);
					return;
				}
				if (bytesRead > 0) {
					sftp.data(reqid, data.subarray(0, bytesRead));
				}
				if (bytesRead < length) {
					sftp.status(reqid, STATUS_CODE.EOF);
				}
			});
		});

		sftp.on('CLOSE', (reqid: number, handle: Buffer) => {
			const state = this.state(handle);
			this.handles.delete(handle.toString());
			if (state?.fd === undefined) {
				sftp.status(reqid, STATUS_CODE.OK);
				return;
			}
			fs.close(state.fd, () => sftp.status(reqid, STATUS_CODE.OK));
		});

		sftp.on('OPENDIR', (reqid: number, dirname: string) => {
			let full: string;
			try {
				full = this.resolve(dirname);
			} catch {
				sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
				return;
			}
			fs.readdir(full, (err, names) => {
				if (err) {
					this.failure(sftp, reqid, err);
					return;
				}
				sftp.handle(reqid, this.handle({ entries: names, dir: full }));
			});
		});

		sftp.on('READDIR', (reqid: number, handle: Buffer) => {
			const state = this.state(handle);
			if (!state?.entries) {
				sftp.status(reqid, STATUS_CODE.FAILURE);
				return;
			}
			if (state.sent) {
				sftp.status(reqid, STATUS_CODE.EOF);
				return;
			}
			state.sent = true;
			const entries = state.entries.flatMap((name) => {
				try {
					const full = path.join(state.dir ?? this.root, name);
					const stat = fs.statSync(full);
					return [{ filename: name, longname: name, attrs: attrsOf(stat) }];
				} catch {
					return [];
				}
			});
			sftp.name(reqid, entries);
		});

		const replyStat = (reqid: number, remote: string): void => {
			let full: string;
			try {
				full = this.resolve(remote);
			} catch {
				sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
				return;
			}
			fs.stat(full, (err, stat) => {
				if (err) {
					this.failure(sftp, reqid, err);
					return;
				}
				sftp.attrs(reqid, attrsOf(stat));
			});
		};

		sftp.on('STAT', (reqid: number, remote: string) => replyStat(reqid, remote));
		sftp.on('LSTAT', (reqid: number, remote: string) => replyStat(reqid, remote));

		sftp.on('REMOVE', (reqid: number, remote: string) => {
			try {
				fs.unlinkSync(this.resolve(remote));
				sftp.status(reqid, STATUS_CODE.OK);
			} catch (err) {
				this.failure(sftp, reqid, err as NodeJS.ErrnoException);
			}
		});

		sftp.on('RENAME', (reqid: number, from: string, to: string) => {
			try {
				fs.renameSync(this.resolve(from), this.resolve(to));
				sftp.status(reqid, STATUS_CODE.OK);
			} catch (err) {
				this.failure(sftp, reqid, err as NodeJS.ErrnoException);
			}
		});

		sftp.on('MKDIR', (reqid: number, remote: string) => {
			try {
				fs.mkdirSync(this.resolve(remote));
				sftp.status(reqid, STATUS_CODE.OK);
			} catch (err) {
				this.failure(sftp, reqid, err as NodeJS.ErrnoException);
			}
		});

		sftp.on('RMDIR', (reqid: number, remote: string) => {
			try {
				fs.rmdirSync(this.resolve(remote));
				sftp.status(reqid, STATUS_CODE.OK);
			} catch (err) {
				this.failure(sftp, reqid, err as NodeJS.ErrnoException);
			}
		});

		sftp.on('REALPATH', (reqid: number, remote: string) => {
			sftp.name(reqid, [{ filename: remote, longname: remote, attrs: {} }]);
		});

		sftp.on('SETSTAT', (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));
		sftp.on('FSETSTAT', (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));
		sftp.on('EXTENDED', (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));
	}
}
