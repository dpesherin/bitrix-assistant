<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

use BitrixLsp\Analyzer\PhpAnalyzer\PhpLoadScanner;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;

/**
 * Собирает контекст документа: собственное расширение файла, явные подключения
 * (CJSCore::Init / Extension::load / BX.loadExt) и транзитивные `rel`.
 */
final class DocumentContextBuilder
{
	public function __construct(private readonly Repository $repository)
	{
	}

	public function build(TextDocument $document): DocumentContext
	{
		$path = Paths::uriToPath($document->uri);
		$own = [];
		if ($path !== null) {
			$own = $this->repository->extensionsForFile($path);
			if ($own === []) {
				// Файлы из поставки (`install/js/...`) и развёрнутые `bitrix/js/...`
				// могут не совпадать по абсолютным путям — определяем по каталогу.
				$byPath = $this->repository->extensionForFilePath($path);
				if ($byPath !== null) {
					$own = [$byPath];
				}
			}
		}
		$explicit = JsScanner::explicitLoads($document->text);
		if ($document->languageId === 'php') {
			$explicit = array_merge($explicit, PhpLoadScanner::loads($document->text));
		}
		$seeds = ['main.core'];
		foreach ($own as $extension) {
			$name = $extension['name'] ?? null;
			if (is_string($name) && $name !== '') {
				$seeds[] = $name;
			}
		}
		$seeds = array_merge($seeds, $explicit);
		$seeds = array_values(array_unique(array_filter(
			$seeds,
			static fn ($name): bool => is_string($name) && $name !== '',
		)));
		$loaded = $this->repository->dependencyClosure($seeds);
		foreach ($seeds as $seed) {
			$loaded[$seed] = true;
		}
		return new DocumentContext($loaded, array_fill_keys($explicit, true), $own);
	}
}
