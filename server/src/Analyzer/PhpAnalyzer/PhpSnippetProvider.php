<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Support\TextDocument;

/**
 * Подсказки конструкций языка PHP: `if`, `foreach`, `switch`, `try` и т.п.
 *
 * Это не просто имена — вставляется готовая конструкция с фигурными скобками
 * и табуляциями, чтобы после подсказки сразу можно было писать тело:
 *
 *   foreach ($items as $key => $item) {
 *       ▮
 *   }
 */
final class PhpSnippetProvider
{
	/**
	 * Ключ — имя конструкции, значение — текст сниппета (LSP snippet syntax).
	 * `$0` — позиция курсора после вставки, `${1:...}` — поле с подсказкой.
	 *
	 * @var array<string, string>
	 */
	private const CONSTRUCTS = [
		'if' => "if (\${1:condition}) {\n\t\$0\n}",
		'ifelse' => "if (\${1:condition}) {\n\t\$0\n} else {\n\t\n}",
		'elseif' => "elseif (\${1:condition}) {\n\t\$0\n}",
		'else' => "else {\n\t\$0\n}",
		// `$${1:items}` — буквальный `$` и поле, а не переменная сниппета.
		'foreach' => "foreach (\$\${1:items} as \$\${2:key} => \$\${3:item}) {\n\t\$0\n}",
		'for' => "for (\$\${1:i} = 0; \$\${1:i} < \$\${2:count}; \$\${1:i}++) {\n\t\$0\n}",
		'while' => "while (\${1:condition}) {\n\t\$0\n}",
		'do' => "do {\n\t\$0\n} while (\${1:condition});",
		'switch' => "switch (\$\${1:value}) {\n\tcase \${2:value}:\n\t\t\$0\n\t\tbreak;\n}",
		'case' => "case \${1:value}:\n\t\$0\n\tbreak;",
		'match' => "match (\$\${1:value}) {\n\t\${2:value} => \${3:result},\n\tdefault => \$0,\n};",
		'try' => "try {\n\t\$0\n} catch (\\\\Throwable \$\${1:e}) {\n\t\n}",
		'catch' => "catch (\\\\Throwable \$\${1:e}) {\n\t\$0\n}",
		'finally' => "finally {\n\t\$0\n}",
		'function' => "function \${1:name}(\${2}) {\n\t\$0\n}",
		// Управляющие инструкции: `break`/`continue` — готовые с `;`, `return`
		// оставляет курсор перед `;`, чтобы сразу набрать выражение.
		'return' => 'return $0;',
		'break' => 'break;',
		'continue' => 'continue;',
	];

	/**
	 * Подсказки конструкций по введённому префиксу.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function items(TextDocument $document, int $offset, string $prefix): array
	{
		$prefix = strtolower($prefix);
		if ($prefix === '') {
			return [];
		}
		$range = $document->range($offset - strlen($prefix), $offset);
		$items = [];
		foreach (self::CONSTRUCTS as $name => $snippet) {
			if (!str_starts_with($name, $prefix)) {
				continue;
			}
			$items[] = [
				'label' => $name,
				'kind' => 14, // CompletionItemKind.Keyword
				'detail' => 'конструкция языка',
				'labelDetails' => ['detail' => '{}'],
				'filterText' => $name,
				'sortText' => '0_' . $name,
				'textEdit' => ['range' => $range, 'newText' => $snippet],
				'insertTextFormat' => 2, // snippet: поля и табуляции
				'documentation' => PhpKeywordHover::describe($name),
			];
		}
		return $items;
	}
}
