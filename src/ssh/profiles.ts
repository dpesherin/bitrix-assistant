import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { SshProfile, ProfileSecret } from './types';

const STORE_KEY = 'bitrix.ssh.profiles';
const DEFAULT_KEY = 'bitrix.ssh.defaultProfileId';
const WORKSPACE_INIT_KEY = 'bitrix.ssh.workspaceInitialized';
const SECRET_PREFIX = 'bitrix.ssh.secret';
const HOST_KEY = 'bitrix.ssh.hostKeys';

/**
 * Профили привязаны к workspace: у каждого проекта свой список хостов.
 * При первом открытии проекта старый глобальный список копируется в workspace;
 * после этого удаление профиля в одном проекте не затрагивает другие.
 * Пароли и парольные фразы — в SecretStorage; отпечатки host key — глобально.
 */
export class ProfileStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	private get scopedState(): vscode.Memento {
		return vscode.workspace.workspaceFolders?.length
			? this.context.workspaceState
			: this.context.globalState;
	}

	private ensureWorkspace(): SshProfile[] | undefined {
		if (!vscode.workspace.workspaceFolders?.length) {
			return undefined;
		}
		if (this.context.workspaceState.get<boolean>(WORKSPACE_INIT_KEY, false)) {
			return undefined;
		}
		const legacy = this.context.globalState.get<SshProfile[]>(STORE_KEY, []);
		if (Array.isArray(legacy) && legacy.length > 0) {
			void this.context.workspaceState.update(STORE_KEY, legacy);
			const legacyDefault = this.context.globalState.get<string>(DEFAULT_KEY);
			if (legacyDefault && legacy.some((profile) => profile.id === legacyDefault)) {
				void this.context.workspaceState.update(DEFAULT_KEY, legacyDefault);
			}
		}
		void this.context.workspaceState.update(WORKSPACE_INIT_KEY, true);
		return Array.isArray(legacy) ? legacy : [];
	}

	list(): SshProfile[] {
		const migrated = this.ensureWorkspace();
		if (migrated !== undefined) {
			return migrated;
		}
		const raw = this.scopedState.get<SshProfile[]>(STORE_KEY, []);
		return Array.isArray(raw) ? raw : [];
	}

	find(id: string): SshProfile | undefined {
		return this.list().find((profile) => profile.id === id);
	}

	getDefaultId(): string | undefined {
		const migrated = this.ensureWorkspace();
		const id = this.scopedState.get<string>(DEFAULT_KEY) ?? 
			(migrated ? this.context.globalState.get<string>(DEFAULT_KEY) : undefined);
		return typeof id === 'string' && id !== '' && this.find(id) ? id : undefined;
	}

	async setDefaultId(id: string | undefined): Promise<void> {
		await this.scopedState.update(DEFAULT_KEY, id);
	}

	async upsert(profile: SshProfile, secret?: ProfileSecret): Promise<void> {
		const profiles = this.list();
		const index = profiles.findIndex((item) => item.id === profile.id);
		if (index === -1) {
			profiles.push(profile);
		} else {
			profiles[index] = profile;
		}
		await this.scopedState.update(STORE_KEY, profiles);
		if (secret?.password !== undefined) {
			await this.context.secrets.store(this.secretKey(profile.id, 'password'), secret.password);
		}
		if (secret?.passphrase !== undefined) {
			await this.context.secrets.store(this.secretKey(profile.id, 'passphrase'), secret.passphrase);
		}
	}

	async remove(id: string): Promise<void> {
		const profiles = this.list().filter((profile) => profile.id !== id);
		await this.scopedState.update(STORE_KEY, profiles);
		if (this.scopedState.get<string>(DEFAULT_KEY) === id) {
			await this.scopedState.update(DEFAULT_KEY, undefined);
		}
		// Старый глобальный список иначе «воскресит» удалённый профиль при первом
		// открытии следующего проекта — уже без пароля (секрет удалён ниже).
		const legacy = this.context.globalState.get<SshProfile[]>(STORE_KEY, []);
		if (Array.isArray(legacy) && legacy.some((profile) => profile.id === id)) {
			await this.context.globalState.update(
				STORE_KEY,
				legacy.filter((profile) => profile.id !== id),
			);
			if (this.context.globalState.get<string>(DEFAULT_KEY) === id) {
				await this.context.globalState.update(DEFAULT_KEY, undefined);
			}
		}
		await this.context.secrets.delete(this.secretKey(id, 'password'));
		await this.context.secrets.delete(this.secretKey(id, 'passphrase'));
	}

	getHostKey(host: string, port: number): string | undefined {
		const keys = this.context.globalState.get<Record<string, string>>(HOST_KEY, {});
		const value = keys[`${host}:${port}`];
		return typeof value === 'string' && value !== '' ? value : undefined;
	}

	listHostKeys(): Array<{ host: string; port: number; fingerprint: string }> {
		const keys = this.context.globalState.get<Record<string, string>>(HOST_KEY, {});
		return Object.entries(keys).map(([address, fingerprint]) => {
			const separator = address.lastIndexOf(':');
			return {
				host: separator === -1 ? address : address.slice(0, separator),
				port: separator === -1 ? 22 : Number(address.slice(separator + 1)),
				fingerprint,
			};
		});
	}

	async removeHostKey(host: string, port: number): Promise<void> {
		const keys = this.context.globalState.get<Record<string, string>>(HOST_KEY, {});
		delete keys[`${host}:${port}`];
		await this.context.globalState.update(HOST_KEY, keys);
	}

	async setHostKey(host: string, port: number, fingerprint: string): Promise<void> {
		const keys = this.context.globalState.get<Record<string, string>>(HOST_KEY, {});
		keys[`${host}:${port}`] = fingerprint;
		await this.context.globalState.update(HOST_KEY, keys);
	}

	async secrets(profile: SshProfile): Promise<ProfileSecret> {
		const password = await this.context.secrets.get(this.secretKey(profile.id, 'password'));
		const passphrase = await this.context.secrets.get(this.secretKey(profile.id, 'passphrase'));
		return { password: password ?? undefined, passphrase: passphrase ?? undefined };
	}

	private secretKey(id: string, kind: 'password' | 'passphrase'): string {
		return `${SECRET_PREFIX}.${id}.${kind}`;
	}

	/** Диалог создания профиля. */
	async promptNew(): Promise<{ profile: SshProfile; secret: ProfileSecret } | undefined> {
		const name = await vscode.window.showInputBox({ title: 'Имя профиля', placeHolder: 'prod' });
		if (!name) {
			return undefined;
		}
		const host = await vscode.window.showInputBox({ title: 'Хост', placeHolder: 'example.com' });
		if (!host) {
			return undefined;
		}
		const portRaw = await vscode.window.showInputBox({
			title: 'Порт',
			value: '22',
			validateInput: (value) => (/^\d+$/.test(value) ? undefined : 'Число'),
		});
		if (!portRaw) {
			return undefined;
		}
		const username = await vscode.window.showInputBox({ title: 'Пользователь', value: 'root' });
		if (!username) {
			return undefined;
		}
		const authPick = await vscode.window.showQuickPick(
			[
				{ label: 'Пароль', value: 'password' as const },
				{ label: 'Приватный ключ', value: 'privateKey' as const },
			],
			{ title: 'Аутентификация' },
		);
		if (!authPick) {
			return undefined;
		}
		const secret: ProfileSecret = {};
		let privateKeyPath: string | undefined;
		if (authPick.value === 'password') {
			const password = await vscode.window.showInputBox({ title: 'Пароль', password: true });
			if (!password) {
				return undefined;
			}
			secret.password = password;
		} else {
			privateKeyPath = await vscode.window.showInputBox({
				title: 'Путь к приватному ключу',
				value: `${process.env.HOME ?? ''}/.ssh/id_rsa`,
			});
			if (!privateKeyPath) {
				return undefined;
			}
			const passphrase = await vscode.window.showInputBox({
				title: 'Парольная фраза ключа (если есть)',
				password: true,
			});
			if (passphrase) {
				secret.passphrase = passphrase;
			}
		}
		const remoteRoot = await vscode.window.showInputBox({
			title: 'Корень проекта на сервере',
			value: '/var/www/site',
		});
		if (!remoteRoot) {
			return undefined;
		}
		return {
			profile: {
				id: crypto.randomUUID(),
				name,
				host,
				port: Number(portRaw),
				username,
				authType: authPick.value,
				privateKeyPath,
				remoteRoot: remoteRoot.replace(/\/+$/, ''),
			},
			secret,
		};
	}
}
