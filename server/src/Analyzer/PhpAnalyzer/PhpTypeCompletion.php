<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Support\HoverColor;
use BitrixLsp\Support\TextDocument;

/**
 * Подсказки встроенных типов PHP в позиции типа.
 *
 * Без них на `public function test(): str` в списке оказывались функции
 * (`strlen`, `str_contains`) и классы индекса, а самого `string` не было.
 *
 * Поддержаны все места, где PHP ждёт тип, и любые стили записи — сигнатура
 * может занимать несколько строк, скобка может стоять на своей строке:
 *
 * - тип возврата: `function f(): str`, `fn($x): str`, `)` и `:` на разных строках;
 * - тип параметра: `function f(str`, список параметров в несколько строк;
 * - тип свойства: `public str`, `private ?Foo`, `protected static arr`;
 * - типизированная константа: `const str`;
 * - union/intersection и nullable: `string|arr`, `?str`, `A&arr`.
 *
 * Имена классов в этой позиции по-прежнему приходят из индекса (клиентский
 * провайдер `phpClassCompletion`), здесь только встроенные типы PHP.
 */
final class PhpTypeCompletion
{
	/** встроенный тип => пояснение в документации подсказки */
	private const TYPES = [
		'string' => 'Строка произвольной длины (встроенный тип PHP).',
		'int' => 'Целое число.',
		'float' => 'Число с плавающей точкой.',
		'bool' => 'Логическое значение: `true` или `false`.',
		'array' => 'Массив с произвольными ключами и значениями.',
		'iterable' => 'Массив или объект, реализующий `Traversable` — годится для `foreach`.',
		'object' => 'Любой объект.',
		'callable' => 'Вызываемое значение: имя функции, замыкание, `[объект, метод]`.',
		'mixed' => 'Любое значение, проверка типа не выполняется.',
		'void' => 'Функция ничего не возвращает (только для типа возврата).',
		'never' => 'Функция никогда не возвращает управление: `throw` или `exit`.',
		'null' => 'Нулевое значение — обычно в union-типе или с `?`.',
		'false' => 'Литерал `false` как тип (PHP 8.2+).',
		'true' => 'Литерал `true` как тип (PHP 8.2+).',
		'self' => 'Текущий класс.',
		'static' => 'Текущий класс с поздним статическим связыванием.',
		'parent' => 'Родительский класс.',
	];

	/** Ключевые слова, которые не могут быть типом: по их префиксу отдаём управление другим провайдерам. */
	private const NOT_TYPES = ['function', 'const'];

	/** Символы типа (тело класса символов): `?Foo\Bar|baz&qux`. */
	private const TYPE_CHARS = '?\\\\A-Za-z0-9_|&';

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, int $offset, string $before): array
	{
		$prefix = self::typePrefix($before);
		if ($prefix === null) {
			return [];
		}
		// В union/intersection подсказываем только последний сегмент: заменять
		// весь `string|arr` нельзя, иначе пропадёт уже набранная часть.
		$segment = $prefix;
		$pipe = strrpos($segment, '|');
		$amp = strrpos($segment, '&');
		$cut = max($pipe === false ? -1 : $pipe, $amp === false ? -1 : $amp);
		if ($cut >= 0) {
			$segment = substr($segment, $cut + 1);
		}
		// `?str` — заменяем только имя, знак `?` остаётся в тексте.
		$token = ltrim($segment, '?');
		$start = $offset - strlen($token);
		$lower = strtolower($token);
		$items = [];
		foreach (self::TYPES as $type => $description) {
			if ($lower !== '' && !str_starts_with($type, $lower)) {
				continue;
			}
			$items[] = [
				'label' => $type,
				'kind' => 14, // Keyword
				'detail' => 'встроенный тип PHP',
				'labelDetails' => ['detail' => 'тип'],
				'filterText' => $type,
				'sortText' => '0_' . $type,
				'textEdit' => ['range' => $document->range($start, $offset), 'newText' => $type],
				'documentation' => [
					'kind' => 'markdown',
					'value' => HoverColor::signature($type) . "\n\n" . $description,
				],
			];
		}
		return $items;
	}

	/**
	 * Префикс типа в текущей позиции или null, если это не позиция типа.
	 * Смотрит не на одну строку, а на текущую инструкцию: сигнатура в несколько
	 * строк — обычное дело.
	 */
	private static function typePrefix(string $before): ?string
	{
		$token = '[' . self::TYPE_CHARS . ']*';
		$tail = self::statementTail($before);

		// 1. Тип возврата: `function f(): str`, `fn($x): ?Foo`, `): string|`.
		if (preg_match('/\)\s*:\s*(' . $token . ')$/s', $tail, $matches) === 1) {
			// Совпадение начинается с `)`: её позиция — начало найденного хвоста.
			$close = strlen($tail) - strlen($matches[0]);
			if (self::isFunctionParamList($tail, $close)) {
				return self::accepted($matches[1]);
			}
		}

		// 2. Тип параметра: внутри скобок объявления функции или замыкания.
		$open = self::enclosingOpenParen($tail);
		if ($open !== null && self::isFunctionParenHead(substr($tail, 0, $open))) {
			$segment = self::lastParameterSegment(substr($tail, $open + 1));
			if (preg_match(
				'/^[\s]*(?:(?:public|protected|private|readonly)\s+)*(' . $token . ')$/',
				$segment,
				$matches,
			) === 1) {
				return self::accepted($matches[1]);
			}
			return null;
		}

		$line = self::lastLine($tail);

		// 3. Тип свойства: `public str`, `private ?Foo`, `protected static arr`.
		if (preg_match(
			'/^[\t ]*(?:(?:public|protected|private|var|readonly|static)\s+)+(' . $token . ')$/',
			$line,
			$matches,
		) === 1) {
			return self::accepted($matches[1]);
		}

		// 4. Типизированная константа: `const str`.
		if (preg_match(
			'/^[\t ]*(?:(?:public|protected|private|final)\s+)*const\s+(' . $token . ')$/',
			$line,
			$matches,
		) === 1) {
			return self::accepted($matches[1]);
		}

		return null;
	}

	/** Последняя инструкция перед курсором: после `;`, `{`, `}` или `?>`. */
	private static function statementTail(string $before): string
	{
		$cut = -1;
		foreach ([';', '{', '}', '?>'] as $delimiter) {
			$position = strrpos($before, $delimiter);
			if ($position !== false && $position > $cut) {
				$cut = $position;
			}
		}
		return $cut === -1 ? $before : substr($before, $cut + 1);
	}

	/** Последняя строка текста. */
	private static function lastLine(string $text): string
	{
		$start = strrpos($text, "\n");
		return $start === false ? $text : substr($text, $start + 1);
	}

	/**
	 * Позиция незакрытой `(` перед курсором (с учётом вложенности) или null.
	 * Нужна, чтобы понять, что курсор внутри списка параметров, даже если
	 * сигнатура занимает несколько строк и содержит вызовы в значениях по умолчанию.
	 */
	private static function enclosingOpenParen(string $text): ?int
	{
		$depth = 0;
		for ($index = strlen($text) - 1; $index >= 0; $index--) {
			$char = $text[$index];
			if ($char === ')') {
				$depth++;
				continue;
			}
			if ($char !== '(') {
				continue;
			}
			if ($depth === 0) {
				return $index;
			}
			$depth--;
		}
		return null;
	}

	/** Относится ли `)` в позиции $close к списку параметров объявления функции. */
	private static function isFunctionParamList(string $text, int $close): bool
	{
		$open = self::matchingOpenParen($text, $close);
		return $open !== null && self::isFunctionParenHead(substr($text, 0, $open));
	}

	/** Позиция `(`, соответствующей `)` в позиции $close. */
	private static function matchingOpenParen(string $text, int $close): ?int
	{
		$depth = 0;
		for ($index = $close; $index >= 0; $index--) {
			$char = $text[$index];
			if ($char === ')') {
				$depth++;
				continue;
			}
			if ($char !== '(') {
				continue;
			}
			$depth--;
			if ($depth === 0) {
				return $index;
			}
		}
		return null;
	}

	/** Текст перед `(` — объявление `function name`, `function` (замыкание) или `fn`. */
	private static function isFunctionParenHead(string $head): bool
	{
		return preg_match(
			'/(?:^|[;{}\s])(?:(?:public|protected|private|static|final|abstract|readonly)\s+)*function\s*&?\s*[A-Za-z_][A-Za-z0-9_]*\s*$/s',
			$head,
		) === 1
			|| preg_match('/(?:^|[;{}\s])(?:(?:public|protected|private|static|final|abstract|readonly)\s+)*function\s*&?\s*$/s', $head) === 1
			|| preg_match('/(?:^|[;{}\s=,(])fn\s*&?\s*$/s', $head) === 1;
	}

	/** Сегмент после последней запятой верхнего уровня: `array $a, private str` → ` private str`. */
	private static function lastParameterSegment(string $params): string
	{
		$depth = 0;
		$start = 0;
		$length = strlen($params);
		for ($index = 0; $index < $length; $index++) {
			$char = $params[$index];
			if ($char === '(' || $char === '[' || $char === '{') {
				$depth++;
				continue;
			}
			if ($char === ')' || $char === ']' || $char === '}') {
				$depth--;
				continue;
			}
			if ($char === ',' && $depth === 0) {
				$start = $index + 1;
			}
		}
		return substr($params, $start);
	}

	/**
	 * Отсекает префиксы `function`/`const`: там ждут сниппет объявления,
	 * а не тип, хотя состоят они из тех же букв.
	 */
	private static function accepted(string $prefix): ?string
	{
		$token = strtolower(ltrim($prefix, '?'));
		if ($token === '') {
			return $prefix;
		}
		foreach (self::NOT_TYPES as $keyword) {
			if (str_starts_with($keyword, $token)) {
				return null;
			}
		}
		return $prefix;
	}
}
