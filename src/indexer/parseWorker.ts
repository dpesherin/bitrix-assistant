/**
 * Воркер разбора: читает файлы и отдаёт готовые структуры в основной поток.
 *
 * Разбор — самая дорогая часть индексации (на большом проекте секунды), и он
 * целиком на CPU. В отдельном потоке он не занимает event loop расширения:
 * интерфейс остаётся отзывчивым, а несколько воркеров делят работу.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { JsGlobal, JsTypeShape, scanJsGlobals, scanJsTypeShapes } from './js/jsScanner';
import { ParsedPhpFile, parsePhpFile } from './php/phpParser';

/** Что разбирает воркер: PHP-файл (классы/функции) или JS (глобалы/типы). */
export type ParseKind = 'php' | 'js';

export interface ParseTask {
	kind: ParseKind;
	files: string[];
	/** Сколько файлов отдавать одним сообщением. */
	batch: number;
}

/** Общая часть результата: файл, хэш и метаданные для `file_hashes`. */
export interface ParsedFile {
	file: string;
	hash?: string;
	size?: number;
	mtime?: number;
	error?: string;
}

/** Результат разбора одного PHP-файла; `error` — файл не прочитался или упал разбор. */
export interface PhpParseResult extends ParsedFile {
	content?: string;
	parsed?: ParsedPhpFile;
}

/** Результат сканирования одного JS-файла. */
export interface JsParseResult extends ParsedFile {
	globals?: JsGlobal[];
	shapes?: JsTypeShape[];
}

export type ParseResult = PhpParseResult | JsParseResult;

export interface ParseMessage {
	batch?: ParseResult[];
	done?: boolean;
	/** Подтверждение от основного потока: пачка записана, можно присылать следующую. */
	ack?: boolean;
}

/**
 * Обратная связь: воркер отдаёт одну пачку и ждёт подтверждения. Без этого
 * очередь сообщений копилась и главный поток разгребал её одним заходом —
 * на большом проекте это давало залипания в сотни миллисекунд.
 */
let resumeAfterAck: (() => void) | undefined;

function waitForAck(): Promise<void> {
	return new Promise<void>((resolve) => {
		resumeAfterAck = resolve;
	});
}

async function runTask(task: ParseTask): Promise<void> {
	const port = parentPort;
	if (!port) {
		return;
	}
	const batchSize = Math.max(1, task.batch);
	let batch: ParseResult[] = [];
	for (const file of task.files) {
		let result: ParseResult;
		try {
			const stat = fs.statSync(file);
			const content = fs.readFileSync(file, 'utf8');
			const hash = crypto.createHash('sha1').update(content).digest('hex');
			const meta = { file, hash, size: stat.size, mtime: Math.round(stat.mtimeMs) };
			result = task.kind === 'js'
				? { ...meta, globals: scanJsGlobals(content), shapes: scanJsTypeShapes(content) }
				: { ...meta, content, parsed: parsePhpFile(content) };
		} catch (err) {
			result = { file, error: err instanceof Error ? err.message : String(err) };
		}
		batch.push(result);
		if (batch.length >= batchSize) {
			port.postMessage({ batch } satisfies ParseMessage);
			batch = [];
			await waitForAck();
		}
	}
	if (batch.length > 0) {
		port.postMessage({ batch } satisfies ParseMessage);
	}
	port.postMessage({ done: true } satisfies ParseMessage);
}

parentPort?.on('message', (message: ParseTask | ParseMessage) => {
	if (message && (message as ParseMessage).ack) {
		const resume = resumeAfterAck;
		resumeAfterAck = undefined;
		resume?.();
		return;
	}
	void runTask(message as ParseTask);
});
