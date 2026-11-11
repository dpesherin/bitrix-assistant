<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\TextDocument;

/** Поиск метода JS: глобал `BX.*`, `this.method` в текущем файле или DOM-справочник. */
final class JsMemberResolver
{
	private readonly JsModuleResolver $modules;
	private readonly JsTypeInference $types;

	public function __construct(private readonly Repository $repository, ?JsModuleResolver $modules = null)
	{
		$this->modules = $modules ?? new JsModuleResolver();
		$this->types = new JsTypeInference($this->modules, $this->repository);
	}

	/**
	 * @return array{kind: 'index', row: array<string, mixed>}|array{kind: 'native', data: array<string, mixed>}|null
	 */
	public function resolve(TextDocument $document, int $offset, string $method): ?array
	{
		$method = trim($method);
		if ($method === '') {
			return null;
		}
		if (str_starts_with($method, 'BX.')) {
			$row = $this->repository->globalByName($method);
			return $row !== null ? ['kind' => 'index', 'row' => $row] : null;
		}

		$dot = strrpos($method, '.');
		$receiverName = $dot === false ? null : substr($method, 0, $dot);
		if ($receiverName !== null && $receiverName !== 'this' && !str_starts_with($receiverName, 'BX')) {
			$import = $this->modules->resolve($document, $receiverName);
			if ($import !== null) {
				$member = $this->modules->member($document, $receiverName, $shortName = substr($method, $dot + 1));
				if ($member !== null) {
					return ['kind' => 'module', 'data' => $member];
				}
			}
			$class = $this->types->classForVariable($document, $receiverName, $offset);
			if ($class !== null) {
				$row = $this->repository->globalByName($class . '.' . substr($method, $dot + 1));
				if ($row !== null) {
					return ['kind' => 'index', 'row' => $row];
				}
			}
		}

		$token = JsScanner::tokenAt($document->text, $offset);
		if ($token !== null) {
			$before = rtrim(substr($document->text, 0, $token['start']));
			$directClass = $this->types->classFromNewExpression($before);
			if ($directClass !== null) {
				$resolvedClass = $this->modules->resolve($document, $directClass);
				$class = $resolvedClass !== null ? (string) $resolvedClass['name'] : $directClass;
				$row = $this->repository->globalByName($class . '.' . $method);
				if ($row !== null) {
					return ['kind' => 'index', 'row' => $row];
				}
			}
			if (preg_match('/([A-Za-z_$][\w$]*)\.$/', $before, $receiver) === 1) {
				$variable = $receiver[1];
				if ($variable !== 'this' && !str_starts_with($variable, 'BX')) {
					$import = $this->modules->resolve($document, $variable);
					if ($import !== null) {
						$member = $this->modules->member($document, $variable, $method);
						if ($member !== null) {
							return ['kind' => 'module', 'data' => $member];
						}
					}
					$class = $this->types->classForVariable($document, $variable, $offset);
					if ($class !== null) {
						$row = $this->repository->globalByName($class . '.' . $method);
						if ($row !== null) {
							return ['kind' => 'index', 'row' => $row];
						}
					}
				}
			}
		}

		$short = $dot === false ? $method : substr($method, $dot + 1);
		$context = JsDocumentContext::create($document);
		$base = $context->baseAt($offset);
		if ($base !== null) {
			$row = $this->repository->globalByName($base . '.' . $short);
			if ($row !== null) {
				return ['kind' => 'index', 'row' => $row];
			}
		}

		$unique = [];
		foreach ($this->repository->jsGlobalsByShortName($short, 30) as $row) {
			$name = (string) $row['name'];
			if (!isset($unique[$name])) {
				$unique[$name] = $row;
			} elseif (empty($unique[$name]['signature']) && !empty($row['signature'])) {
				$unique[$name] = $row;
			}
		}
		if (count($unique) === 1) {
			return ['kind' => 'index', 'row' => reset($unique)];
		}

		$native = JsNativeCatalog::find($short);
		return $native !== null ? ['kind' => 'native', 'data' => $native] : null;
	}
}
