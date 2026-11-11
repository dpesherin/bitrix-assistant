import { arrayEntries, arrayGet, asBool, asString, findAssignedArray } from '../php/phpArray';

export interface ParsedComponentParam {
	name: string;
	type?: string;
	defaultValue?: string;
	required: boolean;
}

export interface ComponentLocation {
	name: string;
	namespace: string;
	module?: string;
	path: string;
}

/**
 * `.../components/<namespace>/<name>/.parameters.php`
 * `.../modules/<module>/install/components/<namespace>/<name>/.parameters.php`
 */
export function componentLocation(filePath: string): ComponentLocation | undefined {
	const posix = filePath.replace(/\\/g, '/');
	if (!posix.endsWith('/.parameters.php') && !posix.endsWith('.parameters.php')) {
		return undefined;
	}
	const parts = posix.split('/');
	const marker = parts.lastIndexOf('components');
	if (marker === -1) {
		return undefined;
	}
	const rest = parts.slice(marker + 1, -1);
	if (rest.length < 2) {
		return undefined;
	}
	const namespace = rest[rest.length - 2];
	const name = rest[rest.length - 1];
	const modulesIndex = parts.lastIndexOf('modules');
	const module = modulesIndex !== -1 && modulesIndex < marker ? parts[modulesIndex + 1] : undefined;
	return { name, namespace, module, path: parts.slice(0, -1).join('/') };
}

/** Параметры компонента из `$arComponentParameters['PARAMETERS']`. */
export function parseParametersPhp(content: string): ParsedComponentParam[] {
	const root = findAssignedArray(content, '$arComponentParameters');
	if (!root) {
		return [];
	}
	const parameters = arrayGet(root, 'PARAMETERS');
	const result: ParsedComponentParam[] = [];
	for (const entry of arrayEntries(parameters)) {
		if (typeof entry.key !== 'string' || entry.value.kind !== 'array') {
			continue;
		}
		const label = asString(arrayGet(entry.value, 'NAME'));
		result.push({
			name: entry.key,
			type: asString(arrayGet(entry.value, 'TYPE')) ?? label,
			defaultValue: asString(arrayGet(entry.value, 'DEFAULT')),
			required: asBool(arrayGet(entry.value, 'REQUIRED')) ?? false,
		});
	}
	return result;
}
