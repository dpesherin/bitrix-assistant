/** Человекочитаемые размер и дата для дерева/панелей. */

export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} Б`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} КБ`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

export function formatMtime(seconds: number): string {
	if (!seconds) {
		return '—';
	}
	const date = new Date(seconds * 1000);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatNumber(value: number): string {
	return value.toLocaleString('ru-RU');
}
