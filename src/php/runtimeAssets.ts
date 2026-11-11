/** Выбор prebuilt-архива static-php-cli под платформу и версию PHP. */

export type RuntimePlatform = 'darwin' | 'linux' | 'win32';
export type RuntimeArch = 'x64' | 'arm64';

export interface RuntimeAsset {
	name: string;
	version: string;
	url?: string;
}

function platformToken(platform: RuntimePlatform): string {
	return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'win' : 'linux';
}

function archToken(arch: RuntimeArch): string {
	return arch === 'arm64' ? 'aarch64' : 'x86_64';
}

function parseVersion(name: string): string | undefined {
	const match = /^php-(\d+\.\d+\.\d+)-cli-/.exec(name);
	return match ? match[1] : undefined;
}

function matches(name: string, platform: RuntimePlatform, arch: RuntimeArch): boolean {
	if (!/^php-\d+\.\d+\.\d+-cli-(macos|linux|win)(?:-(aarch64|x86_64))?\.(?:tar\.gz|zip)$/.test(name)) {
		return false;
	}
	const os = platformToken(platform);
	if (platform === 'win32') {
		return name.includes('-cli-win') && arch === 'x64';
	}
	return name.includes(`-cli-${os}-${archToken(arch)}`);
}

/** Самый свежий патч выбранной minor-версии для платформы. */
export function selectRuntimeAsset(
	names: string[],
	version: string,
	platform: RuntimePlatform,
	arch: RuntimeArch,
): RuntimeAsset | undefined {
	const candidates = names
		.filter((name) => parseVersion(name)?.startsWith(`${version}.`) === true)
		.filter((name) => matches(name, platform, arch))
		.map((name) => ({ name, version: parseVersion(name) as string }))
		.sort((left, right) => {
			const a = left.version.split('.').map(Number);
			const b = right.version.split('.').map(Number);
			for (let index = 0; index < 3; index++) {
				if (a[index] !== b[index]) {
					return b[index] - a[index];
				}
			}
			return 0;
		});
	return candidates[0];
}
