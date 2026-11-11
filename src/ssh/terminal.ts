import { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { errorMessage } from '../log';
import { SshProfile } from './types';

export interface ShellSession {
	client: Client;
	stream: ClientChannel;
}

/**
 * Псевдотерминал VS Code поверх интерактивного ssh-канала: пароль/ключ
 * берутся из сохранённого профиля, вводить их в терминале не нужно.
 */
export class SshTerminal implements vscode.Pseudoterminal, vscode.Disposable {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	private session?: ShellSession;
	private disposed = false;
	private dimensions?: vscode.TerminalDimensions;

	constructor(
		readonly profile: SshProfile,
		private readonly openShell: () => Promise<ShellSession>,
	) {}

	open(initialDimensions?: vscode.TerminalDimensions): void {
		this.dimensions = initialDimensions;
		void this.start(initialDimensions);
	}

	close(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.session?.stream.end();
		this.session?.client.end();
		this.session = undefined;
	}

	dispose(): void {
		this.close();
		this.writeEmitter.dispose();
		this.closeEmitter.dispose();
	}

	handleInput(data: string): void {
		this.session?.stream.write(data);
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.dimensions = dimensions;
		this.session?.stream.setWindow(dimensions.rows, dimensions.columns, 0, 0);
	}

	private async start(initial?: vscode.TerminalDimensions): Promise<void> {
		try {
			this.writeEmitter.fire(`Подключение к ${this.profile.username}@${this.profile.host}:${this.profile.port}…\r\n`);
			const session = await this.openShell();
			if (this.disposed) {
				session.stream.end();
				session.client.end();
				return;
			}
			this.session = session;
			session.stream.setEncoding('utf8');
			const dimensions = this.dimensions ?? initial;
			if (dimensions) {
				session.stream.setWindow(dimensions.rows, dimensions.columns, 0, 0);
			}
			session.stream.on('data', (chunk: string) => this.writeEmitter.fire(chunk));
			session.stream.stderr.on('data', (chunk: string) => this.writeEmitter.fire(chunk));
			session.stream.on('close', () => this.finish(0));
			session.stream.on('error', (err: Error) => {
				this.writeEmitter.fire(`\r\nОшибка SSH: ${errorMessage(err)}\r\n`);
				this.finish(1);
			});
			session.client.on('close', () => this.finish(0));
		} catch (err) {
			this.writeEmitter.fire(`\r\nНе удалось открыть терминал: ${errorMessage(err)}\r\n`);
			this.finish(1);
		}
	}

	private finish(code: number): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const session = this.session;
		this.session = undefined;
		session?.client.end();
		this.closeEmitter.fire(code);
	}
}
