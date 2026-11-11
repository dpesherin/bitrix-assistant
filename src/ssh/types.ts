export type SshAuthType = 'password' | 'privateKey';

export interface SshProfile {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	authType: SshAuthType;
	/** Путь к приватному ключу (для authType = privateKey). */
	privateKeyPath?: string;
	/** Корень проекта на сервере, например `/var/www/site`. */
	remoteRoot: string;
	/** Локальный корень проекта; по умолчанию — корень workspace. */
	localRoot?: string;
}

export interface RemoteEntry {
	name: string;
	path: string;
	type: 'file' | 'directory' | 'symlink' | 'other';
	size: number;
	/** Unix-время в секундах. */
	mtime: number;
}

export interface ProfileSecret {
	password?: string;
	passphrase?: string;
}
