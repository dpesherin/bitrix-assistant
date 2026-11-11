<?php

declare(strict_types=1);

namespace BitrixLsp\Support;

/** Логи только в stderr: stdout — канал JSON-RPC. */
final class Logger
{
	public function __construct(private readonly bool $enabled = true)
	{
	}

	public function info(string $message): void
	{
		if ($this->enabled) {
			fwrite(STDERR, '[bitrix-lsp] ' . $message . "\n");
		}
	}

	public function error(string $message): void
	{
		fwrite(STDERR, '[bitrix-lsp][error] ' . $message . "\n");
	}
}
