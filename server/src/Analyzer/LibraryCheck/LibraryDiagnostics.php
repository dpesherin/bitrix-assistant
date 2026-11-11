<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\LibraryCheck;

use BitrixLsp\Analyzer\JsAnalyzer\DocumentContextBuilder;
use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Analyzer\JsAnalyzer\LibraryResolver;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/**
 * Диагностика «библиотека не подключена»:
 * 1) используется `BX.SomeLib.*`, расширение известно индексу, но не входит
 *    в контекст подключений документа (ни явно, ни через `rel`;
 * 2) у собственного расширения файла есть `rel`-зависимость, которой нет в индексе.
 */
final class LibraryDiagnostics
{
	public const CODE_NOT_LOADED = 'bitrix.js.library-not-loaded';
	public const CODE_MISSING_DEPENDENCY = 'bitrix.js.missing-dependency';

	private const LANGUAGES = ['javascript', 'javascriptreact', 'php'];
	private const MAX_DIAGNOSTICS = 40;

	public function __construct(
		private readonly Repository $repository,
		private readonly LibraryResolver $resolver,
		private readonly DocumentContextBuilder $contexts,
		private readonly ?string $bitrixPath = null,
	) {
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	public function check(TextDocument $document, bool $enabled): array
	{
		if (!$enabled || !in_array($document->languageId, self::LANGUAGES, true)) {
			return [];
		}
		// Ядро Битрикса — вендорный код: не линтуем его подключения,
		// иначе сотни ложных предупреждений на каждый bundle ядра.
		if ($this->isVendorDocument($document)) {
			return [];
		}
		$context = $this->contexts->build($document);
		$grouped = [];
		foreach (JsScanner::usages($document->text) as $usage) {
			$extension = $this->resolver->resolveUsage($usage['name']);
			if ($extension === null || isset($context->loaded[$extension])) {
				continue;
			}
			if (!isset($grouped[$extension])) {
				$grouped[$extension] = ['usage' => $usage, 'count' => 0, 'others' => []];
			}
			$grouped[$extension]['count']++;
			if ($grouped[$extension]['count'] > 1) {
				$grouped[$extension]['others'][] = $document->range($usage['start'], $usage['end']);
			}
		}

		$diagnostics = [];
		foreach ($grouped as $extension => $info) {
			$range = $document->range($info['usage']['start'], $info['usage']['end']);
			$related = [];
			foreach (array_slice($info['others'], 0, 10) as $otherRange) {
				$related[] = [
					'location' => ['uri' => $document->uri, 'range' => $otherRange],
					'message' => 'Здесь библиотека используется ещё раз',
				];
			}
			$diagnostics[] = [
				'range' => $range,
				'severity' => 2,
				'source' => 'bitrix',
				'code' => self::CODE_NOT_LOADED,
				'message' => sprintf(
					'Библиотека «%s» не подключена в этом контексте (используется %s).',
					$extension,
					$info['usage']['name'],
				),
				'data' => [
					'kind' => 'library-not-loaded',
					'extension' => $extension,
					'usage' => $info['usage']['name'],
					'language' => $document->languageId,
					'count' => $info['count'],
				],
				'relatedInformation' => $related,
			];
			if (count($diagnostics) >= self::MAX_DIAGNOSTICS) {
				break;
			}
		}

		$diagnostics = array_merge($diagnostics, $this->dependencyDiagnostics($document, $context));

		return array_slice($diagnostics, 0, self::MAX_DIAGNOSTICS);
	}

	private function isVendorDocument(TextDocument $document): bool
	{
		$path = Paths::uriToPath($document->uri);
		if ($path === null || $this->bitrixPath === null || $this->bitrixPath === '') {
			return false;
		}
		$root = rtrim(Paths::normalize($this->bitrixPath), '/');
		return $path === $root || str_starts_with($path, $root . '/');
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function dependencyDiagnostics(TextDocument $document, \BitrixLsp\Analyzer\JsAnalyzer\DocumentContext $context): array
	{
		$diagnostics = [];
		$reported = [];
		foreach ($context->ownExtensions as $extension) {
			$rel = json_decode((string) $extension['rel_json'], true);
			if (!is_array($rel)) {
				continue;
			}
			foreach ($rel as $dependency) {
				if (!is_string($dependency) || $dependency === '') {
					continue;
				}
				$key = $extension['name'] . '>' . $dependency;
				if (isset($reported[$key]) || $this->repository->extensionByName($dependency) !== null) {
					continue;
				}
				$reported[$key] = true;
				$diagnostics[] = [
					'range' => ['start' => ['line' => 0, 'character' => 0], 'end' => ['line' => 0, 'character' => 0]],
					'severity' => 3,
					'source' => 'bitrix',
					'code' => self::CODE_MISSING_DEPENDENCY,
					'message' => sprintf(
						'Зависимость «%s» расширения «%s» не найдена в индексе: проверьте config.php или перестройте индекс.',
						$dependency,
						$extension['name'],
					),
					'data' => [
						'kind' => 'missing-dependency',
						'extension' => $extension['name'],
						'dependency' => $dependency,
						'language' => $document->languageId,
					],
				];
			}
		}
		return $diagnostics;
	}
}
