<?php

declare(strict_types=1);

namespace BitrixLsp\Rpc;

/** Кадрирование LSP-сообщений (Content-Length) поверх потоков stdio. */
final class StdioTransport
{
	/**
	 * @param resource $in
	 * @param resource $out
	 */
	public function __construct(
		private $in,
		private $out,
	) {
	}

	/**
	 * @return array<string, mixed>|null null — поток закрыт
	 */
	public function read(): ?array
	{
		$headers = [];
		while (true) {
			$line = fgets($this->in);
			if ($line === false) {
				$meta = stream_get_meta_data($this->in);
				// PHP может ставить таймаут на stdio (default_socket_timeout=60):
				// это не EOF — ждём следующую строку, иначе сервер «сам» выходит.
				if (!empty($meta['timed_out']) && !feof($this->in)) {
					continue;
				}
				return null;
			}
			$trimmed = rtrim($line, "\r\n");
			if ($trimmed === '') {
				break;
			}
			$pos = strpos($trimmed, ':');
			if ($pos !== false) {
				$headers[strtolower(substr($trimmed, 0, $pos))] = trim(substr($trimmed, $pos + 1));
			}
		}
		if (!isset($headers['content-length'])) {
			return null;
		}
		$length = (int) $headers['content-length'];
		if ($length <= 0) {
			return null;
		}
		$body = '';
		while (strlen($body) < $length) {
			$chunk = fread($this->in, $length - strlen($body));
			if ($chunk === false || $chunk === '') {
				if (feof($this->in)) {
					return null;
				}
				$meta = stream_get_meta_data($this->in);
				if (empty($meta['timed_out'])) {
					usleep(1000);
				}
				continue;
			}
			$body .= $chunk;
		}
		$decoded = json_decode($body, true);
		return is_array($decoded) ? $decoded : null;
	}

	/**
	 * @param array<string, mixed> $message
	 */
	public function write(array $message): void
	{
		$json = json_encode($message, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
		if ($json === false) {
			return;
		}
		fwrite($this->out, 'Content-Length: ' . strlen($json) . "\r\n\r\n" . $json);
		fflush($this->out);
	}
}
