import * as vscode from 'vscode';

/**
 * Обратная связь при загрузке файла на сервер.
 *
 * VS Code в стандартных уведомлениях не рисует codicons в тексте, поэтому
 * «зелёная галочка» и «красный крестик» показываются в статус-баре: там иконки
 * из `$(...)` работают, а цвет задаётся через `ThemeColor`
 * (`testing.iconPassed` — зелёный, `testing.iconFailed` — красный).
 */

const PASSED = 'testing.iconPassed';
const FAILED = 'testing.iconFailed';

/** Всплеск в статус-баре: иконка + текст, исчезает сам. */
function flash(text: string, color: string, ms = 5000): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	item.text = text;
	item.tooltip = text;
	item.color = new vscode.ThemeColor(color);
	item.show();
	setTimeout(() => item.dispose(), ms);
}

/** Зелёная галочка: файл загружен. */
export function flashUploaded(name: string): void {
	flash(`$(check) ${name}: загружено`, PASSED);
}

/** Зелёная галочка: содержимое уже совпадает с сервером. */
export function flashIdentical(name: string): void {
	flash(`$(check) ${name}: уже совпадает`, PASSED);
}

/** Красный крестик: загрузка не удалась. */
export function flashFailed(name: string): void {
	flash(`$(error) ${name}: не загружено`, FAILED);
}

/** Спиннер в статус-баре на время операции; вернуть — остановить. */
export function spinUpload(name: string): () => void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	item.text = `$(sync~spin) ${name}: загрузка…`;
	item.tooltip = `Bitrix Assistant: загрузка ${name}`;
	item.show();
	let stopped = false;
	return () => {
		if (!stopped) {
			stopped = true;
			item.dispose();
		}
	};
}
