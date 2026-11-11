<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Support\HoverColor;
use BitrixLsp\Support\TextDocument;

/** Hover для конструкций языка PHP: foreach, for, while, match, try и т.п. */
final class PhpKeywordHover
{
	/** @var array<string, array{signature: string, description: string, example?: string}> */
	private const KEYWORDS = [
		'foreach' => [
			'signature' => 'foreach (iterable $iterable as $key => $value) { ... }',
			'description' => 'Перебирает элементы массива или объекта. Ключ можно опустить: `foreach ($items as $item)`.',
			'example' => "foreach (\$items as \$key => \$item) {\n    echo \$key;\n}",
		],
		'for' => [
			'signature' => 'for (init; condition; increment) { ... }',
			'description' => 'Цикл со счётчиком: инициализация, условие и шаг выполняются в заданном порядке.',
			'example' => "for (\$i = 0; \$i < count(\$items); \$i++) {\n    echo \$items[\$i];\n}",
		],
		'while' => [
			'signature' => 'while (condition) { ... }',
			'description' => 'Цикл с предусловием: тело выполняется, пока условие истинно.',
		],
		'do' => [
			'signature' => 'do { ... } while (condition);',
			'description' => 'Цикл с постусловием: тело выполняется хотя бы один раз.',
		],
		'if' => [
			'signature' => 'if (condition) { ... } elseif (condition) { ... } else { ... }',
			'description' => 'Условная конструкция. Для альтернативного синтаксиса используется `endif`.',
		],
		'elseif' => [
			'signature' => 'elseif (condition) { ... }',
			'description' => 'Дополнительная ветка условия после `if`.',
		],
		'else' => [
			'signature' => 'else { ... }',
			'description' => 'Ветка, выполняемая, если предыдущие условия ложны.',
		],
		'switch' => [
			'signature' => 'switch ($value) { case ...: ...; default: ...; }',
			'description' => 'Сравнивает значение с вариантами `case`; не забывайте про `break`.',
		],
		'match' => [
			'signature' => 'match ($value) { 1 => ..., default => ... }',
			'description' => 'Выражение сопоставления, появилось в PHP 8.0. Возвращает значение ветки.',
		],
		'try' => [
			'signature' => 'try { ... } catch (Throwable $e) { ... } finally { ... }',
			'description' => 'Блок перехвата исключений; `finally` выполняется всегда.',
		],
		'catch' => [
			'signature' => 'catch (Throwable $e) { ... }',
			'description' => 'Перехватывает исключение указанного типа.',
		],
		'finally' => [
			'signature' => 'finally { ... }',
			'description' => 'Блок, который выполняется после `try`/`catch` в любом случае.',
		],
		'throw' => [
			'signature' => 'throw new Throwable(...);',
			'description' => 'Выбрасывает исключение.',
		],
		'return' => [
			'signature' => 'return $value;',
			'description' => 'Возвращает значение из функции и завершает её выполнение.',
		],
		'yield' => [
			'signature' => 'yield $key => $value;',
			'description' => 'Отдаёт значение из генератора.',
		],
		'function' => [
			'signature' => 'function name(type $param): ReturnType { ... }',
			'description' => 'Объявление функции или метода. Для короткой функции используется `fn`.',
		],
		'fn' => [
			'signature' => 'fn (type $param): ReturnType => expression',
			'description' => 'Стрелочная функция PHP 7.4+.',
		],
		'class' => [
			'signature' => 'class Name extends Parent implements Interface { ... }',
			'description' => 'Объявление класса.',
		],
		'interface' => [
			'signature' => 'interface Name extends OtherInterface { ... }',
			'description' => 'Объявление интерфейса.',
		],
		'trait' => [
			'signature' => 'trait Name { ... }',
			'description' => 'Объявление трейта — набора методов для повторного использования.',
		],
		'enum' => [
			'signature' => 'enum Name: string { case ...; }',
			'description' => 'Перечисление PHP 8.1+.',
		],
		'namespace' => [
			'signature' => 'namespace Vendor\\Package;',
			'description' => 'Задаёт пространство имён для последующего кода.',
		],
		'use' => [
			'signature' => 'use Vendor\\Package\\Class;',
			'description' => 'Импортирует класс/функцию/константу или подключает трейт внутри класса.',
		],
		'new' => [
			'signature' => 'new ClassName($arguments);',
			'description' => 'Создаёт экземпляр класса.',
		],
		'clone' => [
			'signature' => 'clone $object;',
			'description' => 'Создаёт поверхностную копию объекта.',
		],
		'isset' => [
			'signature' => 'isset($value, ...): bool',
			'description' => 'Проверяет, что переменная/ключ существует и не равна null.',
		],
		'empty' => [
			'signature' => 'empty($value): bool',
			'description' => 'Проверяет, что значение пустое.',
		],
		'unset' => [
			'signature' => 'unset($value);',
			'description' => 'Удаляет переменную или элемент массива.',
		],
		'list' => [
			'signature' => 'list($a, $b) = $array;',
			'description' => 'Деструктуризация массива в переменные; в современном PHP также `[$a, $b] = ...`.',
		],
		'array' => [
			'signature' => 'array $value = [...];',
			'description' => 'Тип массива или устаревший конструктор `array(...)`; используйте `[...]`.',
		],
		'include' => [
			'signature' => 'include $file;',
			'description' => 'Подключает файл; при отсутствии выдаёт warning.',
		],
		'require' => [
			'signature' => 'require $file;',
			'description' => 'Подключает файл; при отсутствии завершает выполнение с fatal error.',
		],
		'echo' => [
			'signature' => 'echo $value, ...;',
			'description' => 'Выводит одно или несколько значений.',
		],
		'print' => [
			'signature' => 'print $value;',
			'description' => 'Выводит значение и возвращает 1.',
		],
		'static' => [
			'signature' => 'static $var = ...;',
			'description' => 'Статическая переменная/метод/свойство; сохраняет значение между вызовами.',
		],
		'global' => [
			'signature' => 'global $var;',
			'description' => 'Делает глобальную переменную доступной внутри функции.',
		],
		'const' => [
			'signature' => 'const NAME = value;',
			'description' => 'Объявляет константу класса или пространства имён.',
		],
		'public' => [
			'signature' => 'public function method() {}',
			'description' => 'Модификатор доступности: доступно отовсюду.',
		],
		'protected' => [
			'signature' => 'protected function method() {}',
			'description' => 'Модификатор доступности: класс и наследники.',
		],
		'private' => [
			'signature' => 'private function method() {}',
			'description' => 'Модификатор доступности: только текущий класс.',
		],
		'abstract' => [
			'signature' => 'abstract class Name { ... }',
			'description' => 'Абстрактный класс/метод без реализации.',
		],
		'final' => [
			'signature' => 'final class Name { ... }',
			'description' => 'Запрещает наследование класса или переопределение метода.',
		],
		'readonly' => [
			'signature' => 'readonly class Name { ... }',
			'description' => 'Readonly-класс/свойство PHP 8.2+, значение задаётся один раз.',
		],
		'as' => [
			'signature' => 'foreach (... as $key => $value)',
			'description' => 'Разделяет перебираемое значение и переменные в `foreach`, а также задаёт алиас импорта.',
		],
		'instanceof' => [
			'signature' => '$object instanceof ClassName',
			'description' => 'Проверяет, является ли объект экземпляром класса/интерфейса.',
		],
		'insteadof' => [
			'signature' => 'A::method insteadof B;',
			'description' => 'Разрешает конфликт методов трейтов.',
		],
		'declare' => [
			'signature' => 'declare(strict_types=1);',
			'description' => 'Задаёт директиву выполнения для файла.',
		],
		'break' => [
			'signature' => 'break;',
			'description' => 'Прерывает текущий цикл или `switch`.',
		],
		'continue' => [
			'signature' => 'continue;',
			'description' => 'Переходит к следующей итерации цикла.',
		],
	];

	/**
	 * @return array<string, mixed>|null
	 */
	public static function provide(TextDocument $document, int $offset): ?array
	{
		$token = PhpUseMap::tokenAt($document->text, $offset);
		if ($token === null) {
			return null;
		}
		$keyword = strtolower($token['name']);
		$info = self::KEYWORDS[$keyword] ?? null;
		if ($info === null) {
			return null;
		}
		$lines = [
			HoverColor::span($keyword, 'keyword'),
			'`конструкция языка PHP`',
			"```php\n{$info['signature']}\n```",
			"**Описание**\n\n{$info['description']}",
		];
		if (!empty($info['example'])) {
			$lines[] = "**Пример**\n\n```php\n{$info['example']}\n```";
		}
		return [
			'contents' => ['kind' => 'markdown', 'value' => implode("\n\n", $lines)],
			'range' => $document->range($token['start'], $token['end']),
		];
	}
}
