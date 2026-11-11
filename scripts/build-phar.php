<?php

declare(strict_types=1);

/**
 * Упаковка PHP-исходников LSP в phar.
 * Запуск: php -d phar.readonly=0 scripts/build-phar.php
 */

if (ini_get('phar.readonly') === '1' && getenv('BITRIX_PHAR_RELAUNCH') !== '1') {
	$command = [PHP_BINARY, '-d', 'phar.readonly=0', __FILE__];
	$env = $_ENV + ['BITRIX_PHAR_RELAUNCH' => '1'];
	$process = proc_open($command, [STDIN, STDOUT, STDERR], $pipes, null, $env);
	exit(is_resource($process) ? proc_close($process) : 1);
}

$root = dirname(__DIR__);
$source = $root . '/server/src';
$target = $root . '/server/bin/bitrix-lsp.phar';

if (!is_dir($source)) {
	fwrite(STDERR, "Не найден каталог $source\n");
	exit(1);
}
if (!is_dir(dirname($target))) {
	mkdir(dirname($target), 0777, true);
}
if (is_file($target)) {
	unlink($target);
}

$phar = new Phar($target, 0, 'bitrix-lsp.phar');
$phar->startBuffering();

$iterator = new RecursiveIteratorIterator(
	new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS),
);
$count = 0;
foreach ($iterator as $file) {
	if (!$file instanceof SplFileInfo || !$file->isFile() || $file->getExtension() !== 'php') {
		continue;
	}
	$absolute = $file->getPathname();
	$relative = str_replace('\\', '/', substr($absolute, strlen($root) + 1));
	$phar->addFile($absolute, $relative);
	$count++;
}

$phar->setStub(<<<'STUB'
<?php
Phar::mapPhar('bitrix-lsp.phar');
require 'phar://bitrix-lsp.phar/server/src/main.php';
__HALT_COMPILER();
STUB);

$phar->stopBuffering();

printf("phar: %s (%d файлов, %d КБ)\n", $target, $count, (int) (filesize($target) / 1024));
