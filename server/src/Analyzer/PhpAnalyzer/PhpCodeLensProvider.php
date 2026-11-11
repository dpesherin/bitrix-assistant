<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/**
 * CodeLens над объявлениями PHP:
 * — «N наследников» над классом/интерфейсом,
 * — «N переопределений» над методом интерфейса или базового класса.
 *
 * Клик открывает стандартный список ссылок VS Code (`editor.action.showReferences`),
 * поэтому отдельных команд в расширении не требуется.
 */
final class PhpCodeLensProvider
{
	private const MAX_DESCENDANTS = 200;
	private const MAX_LOCATIONS = 50;

	public function __construct(private readonly Repository $repository)
	{
	}

	/**
	 * @param array<string, mixed> $range запрошенный LSP-Range: линзы только для видимых строк
	 * @return array<int, array<string, mixed>>
	 */
	public function provide(TextDocument $document, array $range): array
	{
		$path = Paths::uriToPath($document->uri);
		if ($path === null) {
			return [];
		}
		$from = (int) ($range['start']['line'] ?? 0);
		$to = (int) ($range['end']['line'] ?? PHP_INT_MAX);
		$lenses = [];
		foreach ($this->repository->classesForFile($path) as $class) {
			$fqcn = ltrim((string) ($class['fqcn'] ?? ''), '\\');
			$line = max(0, (int) ($class['line'] ?? 1) - 1);
			if ($fqcn === '') {
				continue;
			}
			$descendants = $this->repository->descendantsOf($fqcn, self::MAX_DESCENDANTS);
			if ($descendants !== [] && $line >= $from && $line <= $to) {
				$lenses[] = $this->lens(
					$document,
					$line,
					$this->plural(count($descendants), 'наследник', 'наследника', 'наследников'),
					$descendants,
				);
			}
			if ($descendants === []) {
				continue;
			}
			$methods = $this->repository->methodsForClass($fqcn);
			foreach ($methods as $method) {
				$methodLine = max(0, (int) ($method['line'] ?? 1) - 1);
				if ($methodLine < $from || $methodLine > $to) {
					continue;
				}
				$name = (string) ($method['name'] ?? '');
				if ($name === '') {
					continue;
				}
				$overrides = [];
				foreach ($descendants as $descendant) {
					$override = $this->repository->methodByName((string) ($descendant['fqcn'] ?? ''), $name);
					if ($override !== null) {
						$overrides[] = $override;
					}
				}
				if ($overrides === []) {
					continue;
				}
				$lenses[] = $this->lens(
					$document,
					$methodLine,
					$this->plural(count($overrides), 'переопределение', 'переопределения', 'переопределений'),
					$overrides,
				);
			}
		}
		return $lenses;
	}

	/**
	 * @param array<int, array<string, mixed>> $rows
	 * @return array<string, mixed>
	 */
	private function lens(TextDocument $document, int $line, string $label, array $rows): array
	{
		$position = ['line' => $line, 'character' => 0];
		return [
			'range' => ['start' => $position, 'end' => $position],
			'command' => [
				'title' => $label,
				'command' => 'editor.action.showReferences',
				'arguments' => [
					$document->uri,
					$position,
					$this->locations($rows),
				],
			],
		];
	}

	/**
	 * @param array<int, array<string, mixed>> $rows
	 * @return array<int, array<string, mixed>>
	 */
	private function locations(array $rows): array
	{
		$locations = [];
		$seen = [];
		foreach ($rows as $row) {
			$file = (string) ($row['file'] ?? '');
			$line = (int) ($row['line'] ?? 0);
			if ($file === '' || str_starts_with($file, '<')) {
				continue;
			}
			$key = $file . ':' . $line;
			if (isset($seen[$key])) {
				continue;
			}
			$seen[$key] = true;
			$zeroBased = max(0, $line - 1);
			$locations[] = [
				'uri' => Paths::pathToUri($file),
				'range' => [
					'start' => ['line' => $zeroBased, 'character' => 0],
					'end' => ['line' => $zeroBased, 'character' => 0],
				],
			];
			if (count($locations) >= self::MAX_LOCATIONS) {
				break;
			}
		}
		return $locations;
	}

	/** Русское склонение по числу: 1 наследник, 2 наследника, 5 наследников. */
	private function plural(int $count, string $one, string $few, string $many): string
	{
		$mod100 = $count % 100;
		$mod10 = $count % 10;
		if ($mod100 >= 11 && $mod100 <= 14) {
			$word = $many;
		} elseif ($mod10 === 1) {
			$word = $one;
		} elseif ($mod10 >= 2 && $mod10 <= 4) {
			$word = $few;
		} else {
			$word = $many;
		}
		return $count . ' ' . $word;
	}
}
