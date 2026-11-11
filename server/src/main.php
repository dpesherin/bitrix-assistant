<?php

declare(strict_types=1);

/**
 * Точка входа LSP-сервера. Запускается либо встроенным static-php-cli
 * бинарником, либо системным PHP (режим разработки).
 *
 * Критично: stdout занят JSON-RPC, поэтому любой вывод — только в stderr.
 */

namespace BitrixLsp;

use BitrixLsp\Rpc\Server;
use BitrixLsp\Rpc\StdioTransport;

error_reporting(E_ALL);
ini_set('display_errors', 'stderr');
ini_set('log_errors', '1');
ini_set('memory_limit', '512M');

spl_autoload_register(static function (string $class): void {
	$prefix = 'BitrixLsp\\';
	if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
		return;
	}
	$relative = substr($class, strlen($prefix));
	$file = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';
	if (is_file($file)) {
		require $file;
	}
});

$transport = new StdioTransport(STDIN, STDOUT);
$server = new Server($transport);
$server->run();
