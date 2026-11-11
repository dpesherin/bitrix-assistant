/** Чистый разбор вывода `php -l` (без VS Code API). */

export interface SyntaxProblem {
	line: number;
	message: string;
}

/** Разбор вывода `php -l` в диагностическое сообщение. */
export function parseLintOutput(output: string): SyntaxProblem | undefined {
	const text = output.trim();
	if (text === '') {
		return undefined;
	}
	if (/no syntax errors/i.test(text)) {
		return undefined;
	}
	if (!/parse error|fatal error|syntax error/i.test(text)) {
		return undefined;
	}
	const line = /on line (\d+)/i.exec(text)?.[1];
	return {
		line: Math.max(1, Number(line ?? 1)),
		message: text
			.split('\n')
			.map((part) => part.trim())
			.filter(Boolean)
			.slice(0, 3)
			.join('\n'),
	};
}

