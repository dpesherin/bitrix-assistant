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
		'getBoundingClientRect' => [
			'owner' => 'element',
			'params' => [],
			'return' => 'DOMRect',
			'doc' => 'Возвращает размеры и позицию элемента.',
		],
	];

	/**
	 * @return array<string, mixed>|null
	 */
	public static function find(string $name): ?array
	{
		$method = self::METHODS[$name] ?? null;
		if ($method === null) {
			return null;
		}
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
}
