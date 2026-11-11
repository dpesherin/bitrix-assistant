<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\JsAnalyzer;

/** Контекст подключения: какие расширения загружены в документе (с учётом rel). */
final class DocumentContext
{
	/**
	 * @param array<string, true> $loaded
	 * @param array<string, true> $explicit
	 * @param array<int, array<string, mixed>> $ownExtensions
	 */
	public function __construct(
		public readonly array $loaded,
		public readonly array $explicit,
		public readonly array $ownExtensions,
	) {
	}
}
