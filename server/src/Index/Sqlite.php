<?php

declare(strict_types=1);

namespace BitrixLsp\Index;

use BitrixLsp\Support\Logger;
use PDO;
use RuntimeException;
use SQLite3;
use Throwable;

/**
 * Доступ к SQLite-индексу только на чтение.
 *
 * Драйвер выбирается автоматически:
 *  1) `pdo_sqlite` — кастомная сборка по craft.yml;
 *  2) `sqlite3` — встречается в готовых bulk-сборках static-php-cli,
 *     где pdo_sqlite может отсутствовать.
 *
 * Оба варианта работают с одним и тем же файлом; запись выполняет только
 * расширение VS Code.
 */
final class Sqlite
{
	private ?PDO $pdo = null;
	private ?SQLite3 $sqlite = null;

	public function __construct(
		private readonly string $path,
		private readonly Logger $logger,
	) {
		$this->open();
	}

	private function open(): void
	{
		if (class_exists('PDO')) {
			try {
				if (in_array('sqlite', PDO::getAvailableDrivers(), true)) {
					$pdo = new PDO('sqlite:' . $this->path, null, null, [
						PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
						PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
						PDO::ATTR_TIMEOUT => 3,
					]);
					$pdo->exec('PRAGMA query_only = 1');
					$pdo->exec('PRAGMA busy_timeout = 3000');
					$this->pdo = $pdo;
					return;
				}
			} catch (Throwable $error) {
				$this->logger->info('pdo_sqlite недоступен: ' . $error->getMessage());
			}
		}
		if (class_exists('SQLite3')) {
			try {
				$this->sqlite = new SQLite3($this->path, SQLITE3_OPEN_READONLY);
				$this->sqlite->busyTimeout(3000);
				return;
			} catch (Throwable $error) {
				$this->logger->error('sqlite3: ' . $error->getMessage());
				return;
			}
		}
		$this->logger->error(
			'В PHP-рантайме LSP нет ни pdo_sqlite, ни sqlite3 — индекс читаться не будет. '
			. 'Пересоберите бинарник по craft.yml или используйте сборку с sqlite3.',
		);
	}

	public function isAvailable(): bool
	{
		return $this->pdo !== null || $this->sqlite !== null;
	}

	/**
	 * @param array<int, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	public function rows(string $sql, array $params = []): array
	{
		try {
			return $this->pdo !== null
				? $this->rowsViaPdo($sql, $params)
				: $this->rowsViaSqlite3($sql, $params);
		} catch (Throwable $error) {
			$this->logger->error('SQL: ' . $error->getMessage());
			return [];
		}
	}

	/**
	 * @param array<int, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function rowsViaPdo(string $sql, array $params): array
	{
		$statement = $this->pdo->prepare($sql);
		if ($statement === false) {
			return [];
		}
		$statement->execute($params);
		$result = $statement->fetchAll();
		return is_array($result) ? $result : [];
	}

	/**
	 * @param array<int, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function rowsViaSqlite3(string $sql, array $params): array
	{
		if ($this->sqlite === null) {
			return [];
		}
		$statement = $this->sqlite->prepare($sql);
		if ($statement === false) {
			throw new RuntimeException($this->sqlite->lastErrorMsg());
		}
		foreach ($params as $index => $value) {
			$type = SQLITE3_TEXT;
			if ($value === null) {
				$type = SQLITE3_NULL;
			} elseif (is_int($value)) {
				$type = SQLITE3_INTEGER;
			} elseif (is_float($value)) {
				$type = SQLITE3_FLOAT;
			}
			$statement->bindValue($index + 1, $value, $type);
		}
		$result = $statement->execute();
		if ($result === false) {
			throw new RuntimeException($this->sqlite->lastErrorMsg());
		}
		$rows = [];
		while (($row = $result->fetchArray(SQLITE3_ASSOC)) !== false) {
			$rows[] = $row;
		}
		$result->finalize();
		$statement->close();
		return $rows;
	}
}
