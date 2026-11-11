<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

/**
 * Встроенные классы PHP, которых нет в индексе.
 *
 * Нужны для подсказок по классам, которые не индексируются (их исходников нет
 * в проекте): `new \DateTimeImmutable(...)`, исключения, наследующие
 * `\Exception` и берущие конструктор оттуда.
 *
 * Хранится минимум: конструктор и короткое описание. Методы намеренно не
 * перечислены — их подсказывает PHP-расширение/hover по встроенным функциям.
 */
final class PhpNativeCatalog
{
	/**
	 * @var array<string, array{kind: string, doc: string, ctor: array{signature: string, params: array<int, array<string, mixed>>, doc: string}|null}>|null
	 */
	private static ?array $classes = null;

	/**
	 * @return array<string, array{kind: string, doc: string, ctor: array{signature: string, params: array<int, array<string, mixed>>, doc: string}|null}>
	 */
	public static function all(): array
	{
		if (self::$classes !== null) {
			return self::$classes;
		}
		$throwableCtor = [
			'signature' => '__construct(string $message = "", int $code = 0, ?\Throwable $previous = null)',
			'params' => [
				['name' => 'message', 'type' => 'string', 'default' => '""', 'variadic' => false],
				['name' => 'code', 'type' => 'int', 'default' => '0', 'variadic' => false],
				['name' => 'previous', 'type' => '?\Throwable', 'default' => 'null', 'variadic' => false],
			],
			'doc' => 'Конструктор исключения: сообщение, код и предыдущее исключение.',
		];
		$classes = [];
		foreach (
			[
				'Exception' => 'Базовое исключение PHP.',
				'Error' => 'Базовый класс ошибок PHP (начиная с PHP 7).',
				'RuntimeException' => 'Исключение времени выполнения.',
				'LogicException' => 'Ошибка логики программы.',
				'InvalidArgumentException' => 'Неверный аргумент.',
				'OutOfRangeException' => 'Значение вне допустимого диапазона.',
				'DomainException' => 'Значение вне допустимого домена.',
				'RangeException' => 'Ошибка диапазона.',
				'LengthException' => 'Неверная длина.',
				'UnexpectedValueException' => 'Неожиданное значение.',
				'OverflowException' => 'Переполнение.',
				'UnderflowException' => 'Опустошение коллекции.',
				'BadFunctionCallException' => 'Неверный вызов функции.',
				'BadMethodCallException' => 'Неверный вызов метода.',
				'JsonException' => 'Ошибка JSON (нужен JSON_THROW_ON_ERROR).',
				'PDOException' => 'Ошибка PDO.',
				'TypeError' => 'Неверный тип аргумента или возвращаемого значения.',
				'ValueError' => 'Неверное значение аргумента.',
			] as $name => $doc
		) {
			$parent = $name === 'PDOException' ? 'Exception' : ($name === 'Error' || $name === 'TypeError' || $name === 'ValueError' ? 'Error' : 'Exception');
			$classes[strtolower($name)] = self::entry($name, $doc, $parent, $throwableCtor);
		}
		$classes['throwable'] = self::entry('Throwable', 'Интерфейс всех бросаемых объектов PHP.', null, null) + ['kind' => 'interface'];

		$classes['datetimeimmutable'] = self::entry('DateTimeImmutable', 'Неизменяемая дата-время (класс PHP).', null, [
			'signature' => '__construct(string $datetime = "now", ?\DateTimeZone $timezone = null)',
			'params' => [
				['name' => 'datetime', 'type' => 'string', 'default' => '"now"', 'variadic' => false],
				['name' => 'timezone', 'type' => '?\DateTimeZone', 'default' => 'null', 'variadic' => false],
			],
			'doc' => 'Создаёт неизменяемый объект даты-времени.',
		]);
		$classes['datetime'] = self::entry('DateTime', 'Изменяемая дата-время (класс PHP).', null, [
			'signature' => '__construct(string $datetime = "now", ?\DateTimeZone $timezone = null)',
			'params' => [
				['name' => 'datetime', 'type' => 'string', 'default' => '"now"', 'variadic' => false],
				['name' => 'timezone', 'type' => '?\DateTimeZone', 'default' => 'null', 'variadic' => false],
			],
			'doc' => 'Создаёт объект даты-времени.',
		]);
		$classes['datetimezone'] = self::entry('DateTimeZone', 'Часовой пояс (класс PHP).', null, [
			'signature' => '__construct(string $timezone)',
			'params' => [['name' => 'timezone', 'type' => 'string', 'variadic' => false]],
			'doc' => 'Создаёт объект часового пояса.',
		]);
		$classes['dateinterval'] = self::entry('DateInterval', 'Интервал дат (класс PHP).', null, [
			'signature' => '__construct(string $duration)',
			'params' => [['name' => 'duration', 'type' => 'string', 'variadic' => false]],
			'doc' => 'Разбирает строку интервала вида `P1Y2M3DT4H5M6S`.',
		]);
		$classes['arrayobject'] = self::entry('ArrayObject', 'Объект-обёртка над массивом (класс PHP).', null, [
			'signature' => '__construct(array|object $array = [], int $flags = 0, string $iteratorClass = ArrayIterator::class)',
			'params' => [
				['name' => 'array', 'type' => 'array|object', 'default' => '[]', 'variadic' => false],
				['name' => 'flags', 'type' => 'int', 'default' => '0', 'variadic' => false],
				['name' => 'iteratorClass', 'type' => 'string', 'default' => 'ArrayIterator::class', 'variadic' => false],
			],
			'doc' => 'Оборачивает массив в объект.',
		]);
		$classes['arrayiterator'] = self::entry('ArrayIterator', 'Итератор массива (класс PHP).', null, [
			'signature' => '__construct(array|object $array = [], int $flags = 0)',
			'params' => [
				['name' => 'array', 'type' => 'array|object', 'default' => '[]', 'variadic' => false],
				['name' => 'flags', 'type' => 'int', 'default' => '0', 'variadic' => false],
			],
			'doc' => 'Итератор по массиву или свойствам объекта.',
		]);
		$classes['simplexmlelement'] = self::entry('SimpleXMLElement', 'XML-элемент (расширение SimpleXML).', null, [
			'signature' => '__construct(string $data, int $options = 0, bool $dataIsURL = false, string $namespaceOrPrefix = "", bool $isPrefix = false)',
			'params' => [
				['name' => 'data', 'type' => 'string', 'variadic' => false],
				['name' => 'options', 'type' => 'int', 'default' => '0', 'variadic' => false],
			],
			'doc' => 'Создаёт XML-элемент из строки или файла.',
		]);
		$classes['stdclass'] = self::entry('stdClass', 'Пустой класс-контейнер свойств (класс PHP).', null, null);
		$classes['closure'] = self::entry('Closure', 'Анонимная функция (класс PHP).', null, [
			'signature' => '__construct()',
			'params' => [],
			'doc' => 'Создаётся только через `function () {}` или `Closure::fromCallable()`.',
		]);

		self::$classes = $classes;
		return self::$classes;
	}

	/**
	 * Ищет встроенный класс по имени: сначала точное FQCN, затем последний
	 * сегмент (`\DateTimeImmutable` → `datetimeimmutable`).
	 *
	 * @return array{kind: string, doc: string, ctor: array{signature: string, params: array<int, array<string, mixed>>, doc: string}|null}|null
	 */
	public static function find(string $name): ?array
	{
		$all = self::all();
		$key = strtolower(ltrim(trim($name), '\\'));
		if (isset($all[$key])) {
			return $all[$key];
		}
		if (str_contains($key, '\\')) {
			// Пространства имён встроенных классов (DateTime, Json, PDO...):
			// ищем по последнему сегменту — индекс их не содержит.
			$parts = explode('\\', $key);
			$short = end($parts);
			if (is_string($short) && isset($all[$short])) {
				return $all[$short];
			}
		}
		return null;
	}

	/** Каноническое имя встроенного класса (`\Exception`, `\DateTimeImmutable`). */
	public static function nameOf(string $name): ?string
	{
		$entry = self::find($name);
		return $entry === null ? null : '\\' . (string) $entry['name'];
	}

	/**
	 * Конструктор встроенного класса, если он есть в каталоге.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function constructorOf(string $name): ?array
	{
		$entry = self::find($name);
		if ($entry === null || $entry['ctor'] === null) {
			return null;
		}
		$ctor = $entry['ctor'];
		return [
			'name' => '__construct',
			'signature' => $ctor['signature'],
			'params_json' => json_encode($ctor['params'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '[]',
			'doc' => $ctor['doc'],
			'file' => '',
			'line' => 0,
		];
	}

	/**
	 * @param array{signature: string, params: array<int, array<string, mixed>>, doc: string}|null $ctor
	 * @return array{kind: string, doc: string, ctor: array{signature: string, params: array<int, array<string, mixed>>, doc: string}|null}
	 */
	private static function entry(string $name, string $doc, ?string $parent, ?array $ctor): array
	{
		$description = $doc;
		if ($parent !== null) {
			$description .= ' Наследует `\\' . $parent . '`.';
		}
		return [
			'kind' => 'class',
			'name' => $name,
			'doc' => $description,
			'ctor' => $ctor,
		];
	}
}
