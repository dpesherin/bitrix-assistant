<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

/**
 * Небольшой справочник по DOM-методам, которые в легаси-бандлах вызываются
 * на нетипизированном `this` и поэтому не видны встроенному TS-серверу.
 */
final class JsNativeCatalog
{
	/**
	 * @var array<string, array{
	 *   owner: string,
	 *   params: array<int, array{name: string, type?: string, optional?: bool}>,
	 *   return: string,
	 *   doc: string
	 * }>
	 */
	private const METHODS = [
		'querySelector' => [
			'owner' => 'element',
			'params' => [['name' => 'selectors', 'type' => 'string']],
			'return' => 'Element | null',
			'doc' => 'Возвращает первый элемент, соответствующий CSS-селектору, или `null`.',
		],
		'querySelectorAll' => [
			'owner' => 'element',
			'params' => [['name' => 'selectors', 'type' => 'string']],
			'return' => 'NodeListOf<Element>',
			'doc' => 'Возвращает все элементы, соответствующие CSS-селектору.',
		],
		'getElementById' => [
			'owner' => 'document',
			'params' => [['name' => 'id', 'type' => 'string']],
			'return' => 'HTMLElement | null',
			'doc' => 'Возвращает элемент по `id`.',
		],
		'getElementsByClassName' => [
			'owner' => 'element',
			'params' => [['name' => 'names', 'type' => 'string']],
			'return' => 'HTMLCollectionOf<Element>',
			'doc' => 'Возвращает живую коллекцию элементов с указанными классами.',
		],
		'getElementsByTagName' => [
			'owner' => 'element',
			'params' => [['name' => 'tagName', 'type' => 'string']],
			'return' => 'HTMLCollectionOf<Element>',
			'doc' => 'Возвращает коллекцию элементов с указанным тегом.',
		],
		'addEventListener' => [
			'owner' => 'eventTarget',
			'params' => [
				['name' => 'type', 'type' => 'string'],
				['name' => 'listener', 'type' => 'EventListener'],
				['name' => 'options', 'type' => 'boolean | AddEventListenerOptions', 'optional' => true],
			],
			'return' => 'void',
			'doc' => 'Подписывает на событие. Третий аргумент — `capture` или объект настроек.',
		],
		'removeEventListener' => [
			'owner' => 'eventTarget',
			'params' => [
				['name' => 'type', 'type' => 'string'],
				['name' => 'listener', 'type' => 'EventListener'],
				['name' => 'options', 'type' => 'boolean | EventListenerOptions', 'optional' => true],
			],
			'return' => 'void',
			'doc' => 'Отписывает от события.',
		],
		'appendChild' => [
			'owner' => 'element',
			'params' => [['name' => 'node', 'type' => 'Node']],
			'return' => 'Node',
			'doc' => 'Добавляет узел в конец списка детей.',
		],
		'insertBefore' => [
			'owner' => 'element',
			'params' => [
				['name' => 'newNode', 'type' => 'Node'],
				['name' => 'referenceNode', 'type' => 'Node | null'],
			],
			'return' => 'Node',
			'doc' => 'Вставляет узел перед указанным.',
		],
		'removeChild' => [
			'owner' => 'element',
			'params' => [['name' => 'child', 'type' => 'Node']],
			'return' => 'Node',
			'doc' => 'Удаляет дочерний узел.',
		],
		'setAttribute' => [
			'owner' => 'element',
			'params' => [
				['name' => 'name', 'type' => 'string'],
				['name' => 'value', 'type' => 'string'],
			],
			'return' => 'void',
			'doc' => 'Устанавливает атрибут элемента.',
		],
		'getAttribute' => [
			'owner' => 'element',
			'params' => [['name' => 'name', 'type' => 'string']],
			'return' => 'string | null',
			'doc' => 'Возвращает значение атрибута.',
		],
		'removeAttribute' => [
			'owner' => 'element',
			'params' => [['name' => 'name', 'type' => 'string']],
			'return' => 'void',
			'doc' => 'Удаляет атрибут.',
		],
		'closest' => [
			'owner' => 'element',
			'params' => [['name' => 'selectors', 'type' => 'string']],
			'return' => 'Element | null',
			'doc' => 'Ищет ближайший родительский элемент по CSS-селектору.',
		],
		'matches' => [
			'owner' => 'element',
			'params' => [['name' => 'selectors', 'type' => 'string']],
			'return' => 'boolean',
			'doc' => 'Проверяет соответствие элемента CSS-селектору.',
		],
		'contains' => [
			'owner' => 'element',
			'params' => [['name' => 'other', 'type' => 'Node | null']],
			'return' => 'boolean',
			'doc' => 'Проверяет, содержит ли элемент другой узел.',
		],
		'focus' => [
			'owner' => 'element',
			'params' => [['name' => 'options', 'type' => 'FocusOptions', 'optional' => true]],
			'return' => 'void',
			'doc' => 'Ставит фокус на элемент.',
		],
		'click' => [
			'owner' => 'element',
			'params' => [],
			'return' => 'void',
			'doc' => 'Эмулирует клик по элементу.',
		],
		'remove' => [
			'owner' => 'element',
			'params' => [],
			'return' => 'void',
			'doc' => 'Удаляет элемент из DOM.',
		],
		'append' => [
			'owner' => 'element',
			'params' => [['name' => 'nodes', 'type' => '...Node | string']],
			'return' => 'void',
			'doc' => 'Добавляет узлы/строки в конец.',
		],
		'createElement' => [
			'owner' => 'document',
			'params' => [['name' => 'tagName', 'type' => 'string'], ['name' => 'options', 'type' => 'object', 'optional' => true]],
			'return' => 'HTMLElement',
			'doc' => 'Создаёт элемент с указанным тегом.',
		],
		'createTextNode' => [
			'owner' => 'document',
			'params' => [['name' => 'data', 'type' => 'string']],
			'return' => 'Text',
			'doc' => 'Создаёт текстовый узел.',
		],
		'createDocumentFragment' => [
			'owner' => 'document',
			'params' => [],
			'return' => 'DocumentFragment',
			'doc' => 'Создаёт фрагмент документа для пакетной вставки.',
		],
		'insertAdjacentHTML' => [
			'owner' => 'element',
			'params' => [['name' => 'position', 'type' => 'string'], ['name' => 'text', 'type' => 'string']],
			'return' => 'void',
			'doc' => 'Вставляет HTML рядом с элементом (`beforebegin`, `afterbegin`, `beforeend`, `afterend`).',
		],
		'getBoundingClientRect' => [
			'owner' => 'element',
			'params' => [],
			'return' => 'DOMRect',
			'doc' => 'Возвращает размеры и позицию элемента.',
		],
	];

	/**
	 * Встроенные объекты и их методы: `JSON.stringify`, `Math.max`, `console.log`.
	 * Подпись читается одной строкой — так таблица остаётся обозримой.
	 *
	 * @var array<string, array<string, array{0: string, 1: string}>>
	 */
	private const NAMESPACES = [
		'JSON' => [
			'stringify' => ['stringify(value: any, replacer?: Function | Array, space?: number | string): string | undefined', 'Превращает значение в JSON-строку.'],
			'parse' => ['parse(text: string, reviver?: Function): any', 'Разбирает JSON-строку. Невалидный JSON выбрасывает исключение.'],
		],
		'Math' => [
			'abs' => ['abs(x: number): number', 'Модуль числа.'],
			'ceil' => ['ceil(x: number): number', 'Округляет вверх до целого.'],
			'floor' => ['floor(x: number): number', 'Округляет вниз до целого.'],
			'round' => ['round(x: number, digits?: number): number', 'Округляет до ближайшего целого (или до `digits` знаков).'],
			'trunc' => ['trunc(x: number): number', 'Отбрасывает дробную часть.'],
			'sign' => ['sign(x: number): number', 'Знак числа: `-1`, `0` или `1`.'],
			'max' => ['max(...values: number): number', 'Наибольшее из аргументов.'],
			'min' => ['min(...values: number): number', 'Наименьшее из аргументов.'],
			'pow' => ['pow(base: number, exponent: number): number', 'Возводит в степень.'],
			'sqrt' => ['sqrt(x: number): number', 'Квадратный корень.'],
			'random' => ['random(): number', 'Случайное число от 0 до 1.'],
			'hypot' => ['hypot(...values: number): number', 'Длина гипотенузы по катетам.'],
			'log' => ['log(x: number): number', 'Натуральный логарифм.'],
			'log2' => ['log2(x: number): number', 'Логарифм по основанию 2.'],
			'log10' => ['log10(x: number): number', 'Логарифм по основанию 10.'],
		],
		'console' => [
			'log' => ['log(...data: any): void', 'Печатает значения в консоль.'],
			'info' => ['info(...data: any): void', 'Печатает информационное сообщение.'],
			'warn' => ['warn(...data: any): void', 'Печатает предупреждение.'],
			'error' => ['error(...data: any): void', 'Печатает ошибку.'],
			'debug' => ['debug(...data: any): void', 'Печатает отладочное сообщение.'],
			'table' => ['table(data: any, columns?: Array): void', 'Печатает данные таблицей.'],
			'time' => ['time(label?: string): void', 'Запускает таймер с меткой.'],
			'timeEnd' => ['timeEnd(label?: string): void', 'Останавливает таймер и печатает время.'],
			'group' => ['group(label?: string): void', 'Открывает группу в консоли.'],
			'groupEnd' => ['groupEnd(): void', 'Закрывает группу в консоли.'],
			'count' => ['count(label?: string): void', 'Считает вызовы с этой меткой.'],
			'assert' => ['assert(condition?: any, ...data: any): void', 'Печатает ошибку, если условие ложно.'],
			'trace' => ['trace(...data: any): void', 'Печатает стек вызовов.'],
		],
		'Object' => [
			'keys' => ['keys(obj: object): string[]', 'Массив собственных имён свойств.'],
			'values' => ['values(obj: object): any[]', 'Массив значений свойств.'],
			'entries' => ['entries(obj: object): Array', 'Пары `[ключ, значение]`.'],
			'assign' => ['assign(target: object, ...sources: object): object', 'Копирует свойства источников в цель.'],
			'fromEntries' => ['fromEntries(entries: Iterable): object', 'Собирает объект из пар `[ключ, значение]`.'],
			'freeze' => ['freeze(obj: object): object', 'Запрещает изменять объект.'],
			'create' => ['create(proto: object | null, properties?: object): object', 'Создаёт объект с указанным прототипом.'],
			'hasOwn' => ['hasOwn(obj: object, key: string): boolean', 'Есть ли у объекта собственное свойство.'],
			'getPrototypeOf' => ['getPrototypeOf(obj: object): object | null', 'Прототип объекта.'],
		],
		'Array' => [
			'isArray' => ['isArray(value: any): boolean', 'Является ли значение массивом.'],
			'from' => ['from(iterable: Iterable, mapFn?: Function): Array', 'Создаёт массив из итерируемого.'],
			'of' => ['of(...items: any): Array', 'Создаёт массив из аргументов.'],
		],
		'Number' => [
			'isInteger' => ['isInteger(value: any): boolean', 'Целое ли число.'],
			'isFinite' => ['isFinite(value: any): boolean', 'Конечное ли число.'],
			'isNaN' => ['isNaN(value: any): boolean', 'Является ли значение `NaN`.'],
			'parseInt' => ['parseInt(string: string, radix?: number): number', 'Разбирает целое из строки.'],
			'parseFloat' => ['parseFloat(string: string): number', 'Разбирает дробное из строки.'],
		],
		'String' => [
			'fromCharCode' => ['fromCharCode(...codes: number): string', 'Строка из кодов символов.'],
			'fromCodePoint' => ['fromCodePoint(...codes: number): string', 'Строка из кодов Unicode.'],
		],
		'Promise' => [
			'resolve' => ['resolve(value?: any): Promise', 'Уже выполненный промис.'],
			'reject' => ['reject(reason?: any): Promise', 'Промис с ошибкой.'],
			'all' => ['all(iterable: Iterable): Promise', 'Ждёт все промисы.'],
			'allSettled' => ['allSettled(iterable: Iterable): Promise', 'Ждёт все промисы, не падая на ошибках.'],
			'race' => ['race(iterable: Iterable): Promise', 'Первый завершившийся промис.'],
			'any' => ['any(iterable: Iterable): Promise', 'Первый успешный промис.'],
		],
		'localStorage' => [
			'getItem' => ['getItem(key: string): string | null', 'Читает значение по ключу.'],
			'setItem' => ['setItem(key: string, value: string): void', 'Записывает значение.'],
			'removeItem' => ['removeItem(key: string): void', 'Удаляет значение.'],
			'clear' => ['clear(): void', 'Очищает хранилище.'],
			'key' => ['key(index: number): string | null', 'Ключ по индексу.'],
		],
		'$' => [
			'ajax' => ['ajax(settings: object): jqXHR', 'AJAX-запрос. Настройки: `url`, `method`, `data`, `dataType`, `success`, `error`.'],
			'get' => ['get(url: string, data?: object, success?: Function, dataType?: string): jqXHR', 'GET-запрос.'],
			'post' => ['post(url: string, data?: object, success?: Function, dataType?: string): jqXHR', 'POST-запрос.'],
			'each' => ['each(collection: object | Array, callback: Function): object', 'Перебирает массив или объект.'],
			'map' => ['map(collection: object | Array, callback: Function): Array', 'Преобразует коллекцию.'],
			'trim' => ['trim(text: string): string', 'Убирает пробелы по краям.'],
			'extend' => ['extend(target: object, ...sources: object): object', 'Сливает объекты.'],
			'when' => ['when(...deferreds: any): Promise', 'Ждёт выполнения всех отложенных объектов.'],
			'contains' => ['contains(parent: Element, child: Element): boolean', 'Содержит ли элемент потомка.'],
			'isArray' => ['isArray(value: any): boolean', 'Является ли значение массивом.'],
		],
		'sessionStorage' => [
			'getItem' => ['getItem(key: string): string | null', 'Читает значение по ключу.'],
			'setItem' => ['setItem(key: string, value: string): void', 'Записывает значение.'],
			'removeItem' => ['removeItem(key: string): void', 'Удаляет значение.'],
			'clear' => ['clear(): void', 'Очищает хранилище.'],
		],
	];

	/**
	 * Глобальные функции браузера: `parseInt`, `setTimeout`, `console`-независимые.
	 *
	 * @var array<string, array{0: string, 1: string}>
	 */
	private const GLOBALS = [
		'$' => ['$(selector: string | Element, context?: Element): jquery', 'Находит элементы по CSS-селектору или оборачивает DOM-узел в jQuery-объект.'],
		'jQuery' => ['jQuery(selector: string | Element, context?: Element): jquery', 'То же, что `$(…)`.'],
		'parseInt' => ['parseInt(string: string, radix?: number): number', 'Разбирает целое из строки.'],
		'parseFloat' => ['parseFloat(string: string): number', 'Разбирает дробное из строки.'],
		'isNaN' => ['isNaN(value: any): boolean', 'Является ли значение `NaN`.'],
		'isFinite' => ['isFinite(value: any): boolean', 'Конечное ли число.'],
		'setTimeout' => ['setTimeout(callback: Function, delay?: number, ...args: any): number', 'Вызывает функцию один раз через задержку.'],
		'setInterval' => ['setInterval(callback: Function, delay?: number, ...args: any): number', 'Вызывает функцию повторно с интервалом.'],
		'clearTimeout' => ['clearTimeout(id?: number): void', 'Отменяет таймер.'],
		'clearInterval' => ['clearInterval(id?: number): void', 'Отменяет интервальный таймер.'],
		'alert' => ['alert(message?: string): void', 'Показывает модальное сообщение.'],
		'confirm' => ['confirm(message?: string): boolean', 'Показывает подтверждение и возвращает выбор.'],
		'prompt' => ['prompt(message?: string, defaultValue?: string): string | null', 'Запрашивает строку у пользователя.'],
		'encodeURIComponent' => ['encodeURIComponent(uri: string): string', 'Кодирует часть URI.'],
		'decodeURIComponent' => ['decodeURIComponent(uri: string): string', 'Декодирует часть URI.'],
		'encodeURI' => ['encodeURI(uri: string): string', 'Кодирует URI целиком.'],
		'decodeURI' => ['decodeURI(uri: string): string', 'Декодирует URI целиком.'],
		'requestAnimationFrame' => ['requestAnimationFrame(callback: Function): number', 'Вызывает функцию перед следующей перерисовкой.'],
		'cancelAnimationFrame' => ['cancelAnimationFrame(id: number): void', 'Отменяет кадр.'],
		'structuredClone' => ['structuredClone(value: any): any', 'Глубокая копия значения.'],
		'queueMicrotask' => ['queueMicrotask(callback: Function): void', 'Ставит задачу в очередь микрозадач.'],
	];

	/**
	 * Методы прототипов: работают на литералах и значениях известного типа.
	 *
	 * @var array<string, array<string, array{0: string, 1: string}>>
	 */
	private const PROTOTYPES = [
		'string' => [
			'charAt' => ['charAt(index: number): string', 'Символ по индексу.'],
			'charCodeAt' => ['charCodeAt(index: number): number', 'Код символа по индексу.'],
			'includes' => ['includes(search: string, position?: number): boolean', 'Содержит ли строка подстроку.'],
			'indexOf' => ['indexOf(search: string, position?: number): number', 'Позиция подстроки или `-1`.'],
			'lastIndexOf' => ['lastIndexOf(search: string, position?: number): number', 'Последняя позиция подстроки.'],
			'slice' => ['slice(start?: number, end?: number): string', 'Часть строки.'],
			'substring' => ['substring(start: number, end?: number): string', 'Подстрока по индексам.'],
			'split' => ['split(separator: string | RegExp, limit?: number): string[]', 'Делит строку на массив.'],
			'replace' => ['replace(search: string | RegExp, replaceValue: string | Function): string', 'Заменяет первое вхождение.'],
			'replaceAll' => ['replaceAll(search: string | RegExp, replaceValue: string | Function): string', 'Заменяет все вхождения.'],
			'toLowerCase' => ['toLowerCase(): string', 'В нижний регистр.'],
			'toUpperCase' => ['toUpperCase(): string', 'В верхний регистр.'],
			'trim' => ['trim(): string', 'Убирает пробелы по краям.'],
			'trimStart' => ['trimStart(): string', 'Убирает пробелы слева.'],
			'trimEnd' => ['trimEnd(): string', 'Убирает пробелы справа.'],
			'startsWith' => ['startsWith(search: string, position?: number): boolean', 'Начинается ли с подстроки.'],
			'endsWith' => ['endsWith(search: string, position?: number): boolean', 'Заканчивается ли подстрокой.'],
			'padStart' => ['padStart(length: number, pad?: string): string', 'Дополняет строку слева.'],
			'padEnd' => ['padEnd(length: number, pad?: string): string', 'Дополняет строку справа.'],
			'repeat' => ['repeat(count: number): string', 'Повторяет строку.'],
			'concat' => ['concat(...values: string): string', 'Склеивает строки.'],
			'match' => ['match(regexp: RegExp): RegExpMatchArray | null', 'Совпадения с регулярным выражением.'],
			'search' => ['search(regexp: RegExp): number', 'Позиция первого совпадения.'],
			'localeCompare' => ['localeCompare(that: string): number', 'Сравнение строк с учётом локали.'],
		],
		'array' => [
			'push' => ['push(...items: any): number', 'Добавляет в конец, возвращает длину.'],
			'pop' => ['pop(): any', 'Убирает последний элемент.'],
			'shift' => ['shift(): any', 'Убирает первый элемент.'],
			'unshift' => ['unshift(...items: any): number', 'Добавляет в начало.'],
			'slice' => ['slice(start?: number, end?: number): any[]', 'Копия части массива.'],
			'splice' => ['splice(start: number, deleteCount?: number, ...items: any): any[]', 'Удаляет и вставляет элементы.'],
			'join' => ['join(separator?: string): string', 'Склеивает элементы в строку.'],
			'map' => ['map(callback: Function, thisArg?: any): any[]', 'Преобразует каждый элемент.'],
			'filter' => ['filter(callback: Function, thisArg?: any): any[]', 'Оставляет элементы по условию.'],
			'reduce' => ['reduce(callback: Function, initialValue?: any): any', 'Сворачивает массив в одно значение.'],
			'forEach' => ['forEach(callback: Function, thisArg?: any): void', 'Обходит элементы.'],
			'find' => ['find(callback: Function, thisArg?: any): any', 'Первый элемент по условию.'],
			'findIndex' => ['findIndex(callback: Function, thisArg?: any): number', 'Индекс первого элемента по условию.'],
			'includes' => ['includes(value: any, fromIndex?: number): boolean', 'Есть ли значение в массиве.'],
			'indexOf' => ['indexOf(value: any, fromIndex?: number): number', 'Индекс значения или `-1`.'],
			'some' => ['some(callback: Function, thisArg?: any): boolean', 'Хотя бы один элемент подходит.'],
			'every' => ['every(callback: Function, thisArg?: any): boolean', 'Все элементы подходят.'],
			'sort' => ['sort(compareFn?: Function): any[]', 'Сортирует массив.'],
			'reverse' => ['reverse(): any[]', 'Разворачивает массив.'],
			'concat' => ['concat(...items: any): any[]', 'Склеивает массивы.'],
			'flat' => ['flat(depth?: number): any[]', 'Разворачивает вложенные массивы.'],
			'flatMap' => ['flatMap(callback: Function, thisArg?: any): any[]', '`map` и `flat` за один проход.'],
			'fill' => ['fill(value: any, start?: number, end?: number): any[]', 'Заполняет элементы значением.'],
			'at' => ['at(index: number): any', 'Элемент по индексу, поддерживает отрицательные.'],
		],
		'jquery' => [
			'on' => ['on(events: string, selector?: string, handler?: Function): jquery', 'Подписывает на событие.'],
			'off' => ['off(events: string, selector?: string, handler?: Function): jquery', 'Отписывает от события.'],
			'click' => ['click(handler?: Function): jquery', 'Клик по элементу или вызов обработчика.'],
			'done' => ['done(callback: Function): jqXHR', 'Успешное завершение AJAX-запроса.'],
			'fail' => ['fail(callback: Function): jqXHR', 'Ошибка AJAX-запроса.'],
			'always' => ['always(callback: Function): jqXHR', 'Завершение AJAX-запроса в любом случае.'],
			'attr' => ['attr(name: string, value?: string): string | jquery', 'Атрибут элемента: чтение или запись.'],
			'val' => ['val(value?: string): string | jquery', 'Значение поля: чтение или запись.'],
			'data' => ['data(key?: string, value?: any): any', 'Данные элемента: чтение или запись.'],
			'css' => ['css(property: string | object, value?: string): string | jquery', 'Стиль элемента.'],
			'addClass' => ['addClass(className: string): jquery', 'Добавляет класс.'],
			'removeClass' => ['removeClass(className?: string): jquery', 'Убирает класс.'],
			'toggleClass' => ['toggleClass(className: string): jquery', 'Переключает класс.'],
			'siblings' => ['siblings(selector?: string): jquery', 'Соседние элементы.'],
			'parents' => ['parents(selector?: string): jquery', 'Предки элемента.'],
			'closest' => ['closest(selector: string): jquery', 'Ближайший предок по селектору.'],
			'find' => ['find(selector: string): jquery', 'Потомки по селектору.'],
			'children' => ['children(selector?: string): jquery', 'Дочерние элементы.'],
			'parent' => ['parent(selector?: string): jquery', 'Родительский элемент.'],
			'append' => ['append(content: string | Element | object): jquery', 'Вставляет в конец.'],
			'prepend' => ['prepend(content: string | Element | object): jquery', 'Вставляет в начало.'],
			'html' => ['html(content?: string): string | jquery', 'HTML-содержимое.'],
			'text' => ['text(content?: string): string | jquery', 'Текст элемента.'],
			'remove' => ['remove(): jquery', 'Удаляет элемент из DOM.'],
			'hide' => ['hide(): jquery', 'Скрывает элемент.'],
			'show' => ['show(): jquery', 'Показывает элемент.'],
			'each' => ['each(callback: Function): jquery', 'Перебирает элементы набора.'],
			'eq' => ['eq(index: number): jquery', 'Элемент по индексу.'],
			'first' => ['first(): jquery', 'Первый элемент набора.'],
			'last' => ['last(): jquery', 'Последний элемент набора.'],
			'get' => ['get(index?: number): Element | Array', 'DOM-узел по индексу или весь массив.'],
		],
		'number' => [
			'toFixed' => ['toFixed(digits?: number): string', 'Строка с фиксированным числом знаков.'],
			'toString' => ['toString(radix?: number): string', 'Строковое представление.'],
			'toPrecision' => ['toPrecision(precision?: number): string', 'Строка с заданной точностью.'],
			'toLocaleString' => ['toLocaleString(locales?: string, options?: object): string', 'Форматирует по локали.'],
		],
	];

	/**
	 * @return array<string, mixed>|null
	 */
	public static function find(string $name): ?array
	{
		$method = self::METHODS[$name] ?? null;
		return $method === null ? null : self::formatDom($name, $method);
	}

	/**
	 * Члены DOM-объекта: `document.` показывает и методы элемента — у документа
	 * они тоже есть (`querySelector`, `addEventListener`).
	 *
	 * @return array<string, array<string, mixed>>
	 */
	public static function domMembers(string $owner): array
	{
		$result = [];
		foreach (self::METHODS as $name => $method) {
			$methodOwner = (string) ($method['owner'] ?? '');
			// Документ умеет всё, что элемент, а элемент — всё, что EventTarget:
			// `querySelector` и `addEventListener` есть у обоих.
			$fits = $methodOwner === $owner
				|| ($owner === 'document' && ($methodOwner === 'element' || $methodOwner === 'eventTarget'))
				|| ($owner === 'element' && $methodOwner === 'eventTarget');
			if (!$fits) {
				continue;
			}
			$result[$name] = self::formatDom($name, $method);
		}
		return $result;
	}

	/**
	 * @param array<string, mixed> $method
	 * @return array<string, mixed>
	 */
	private static function formatDom(string $name, array $method): array
	{
		$labels = [];
		foreach ($method['params'] as $param) {
			$label = (string) $param['name'];
			$label .= !empty($param['optional']) ? '?' : '';
			if (!empty($param['type'])) {
				$label .= ': ' . (string) $param['type'];
			}
			$labels[] = [
				'label' => $label,
				'type' => (string) ($param['type'] ?? ''),
				'name' => (string) $param['name'],
				'optional' => !empty($param['optional']),
			];
		}
		return [
			'name' => $name,
			'type' => 'method',
			'owner' => (string) $method['owner'],
			'signature' => $name . '(' . implode(', ', array_map(
				static fn (array $label): string => (string) $label['label'],
				$labels,
			)) . ')',
			'params' => $labels,
			'return_type' => (string) $method['return'],
			'doc' => (string) $method['doc'],
		];
	}

	/** Есть ли у этого имени встроенные члены (`JSON.`, `Math.`, `console.`, `$.`). */
	public static function isNamespace(string $name): bool
	{
		return isset(self::NAMESPACES[$name]) || $name === 'jQuery';
	}

	/** `jQuery` — псевдоним `$`: таблица методов одна. */
	private static function namespaceKey(string $name): string
	{
		return $name === 'jQuery' ? '$' : $name;
	}

	/**
	 * Члены встроенного объекта: для подсказок после `JSON.` и подобных.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	public static function namespaceMembers(string $name): array
	{
		$methods = self::NAMESPACES[self::namespaceKey($name)] ?? [];
		$result = [];
		foreach ($methods as $method => $entry) {
			$result[$method] = self::parse($name, $method, $entry);
		}
		return $result;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public static function namespaceMember(string $name, string $method): ?array
	{
		$entry = self::NAMESPACES[self::namespaceKey($name)][$method] ?? null;
		return $entry === null ? null : self::parse($name, $method, $entry);
	}

	/**
	 * Глобальная встроенная функция (`parseInt`, `setTimeout`).
	 *
	 * @return array<string, mixed>|null
	 */
	public static function globalFunction(string $name): ?array
	{
		$entry = self::GLOBALS[$name] ?? null;
		return $entry === null ? null : self::parse('', $name, $entry);
	}

	/** @return array<int, string> */
	public static function globalNames(): array
	{
		return array_merge(array_keys(self::GLOBALS), array_keys(self::NAMESPACES));
	}

	/**
	 * Методы прототипа для значения известного типа (`'строка'`, `[...]`, число).
	 *
	 * @return array<string, array<string, mixed>>
	 */
	public static function prototypeMembers(string $type): array
	{
		$methods = self::PROTOTYPES[$type] ?? [];
		$result = [];
		foreach ($methods as $method => $entry) {
			$result[$method] = self::parse($type, $method, $entry);
		}
		return $result;
	}

	/**
	 * @return array<string, mixed>|null
	 */
	public static function prototypeMember(string $type, string $method): ?array
	{
		$entry = self::PROTOTYPES[$type][$method] ?? null;
		return $entry === null ? null : self::parse($type, $method, $entry);
	}

	/**
	 * Разбирает компактную подпись `name(param: type, rest?: type): Return`
	 * в структуру, которую понимают подсказки и signature help.
	 *
	 * @param array{0: string, 1: string} $entry
	 * @return array<string, mixed>
	 */
	private static function parse(string $owner, string $name, array $entry): array
	{
		[$signature, $doc] = $entry;
		$params = [];
		$returnType = '';
		if (preg_match('/^[\w$]+\(([^)]*)\)(?::\s*(.+))?$/', $signature, $match) === 1) {
			$returnType = trim($match[2] ?? '');
			foreach (explode(',', $match[1]) as $part) {
				$part = trim($part);
				if ($part === '') {
					continue;
				}
				$variadic = str_starts_with($part, '...');
				$part = ltrim($part, '.');
				$paramName = $part;
				$optional = false;
				$paramType = '';
				if (preg_match('/^([\w$]+)(\?)?(?::\s*(.+))?$/', $part, $pieces) === 1) {
					$paramName = $pieces[1];
					$optional = ($pieces[2] ?? '') === '?';
					$paramType = trim($pieces[3] ?? '');
				}
				$label = ($variadic ? '...' : '') . $paramName . ($optional ? '?' : '');
				if ($paramType !== '') {
					$label .= ': ' . $paramType;
				}
				$params[] = [
					'label' => $label,
					'name' => $paramName,
					'type' => $paramType,
					'optional' => $optional,
				];
			}
		}
		return [
			'name' => $name,
			'type' => 'method',
			'owner' => $owner,
			'signature' => $signature,
			'params' => $params,
			'return_type' => $returnType,
			'doc' => $doc,
		];
	}
}
