<?php

declare(strict_types=1);

namespace BitrixLsp\Analyzer\PhpAnalyzer;

use BitrixLsp\Analyzer\JsAnalyzer\JsScanner;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\PhpSource;
use BitrixLsp\Support\TextDocument;

/** Осторожные семантические диагностики: аргументы, типы, неизвестные функции/переменные. */
final class PhpSemanticDiagnostics
{
	private const MAX = 30;

	/** Только проверки существования символов (работают без bitrix.php.semantic). */
	private bool $symbolsOnly = false;

	/** @var array<string, array<int, string>> */
	private const ADDED_FUNCTIONS = [
		'8.2' => ['ini_parse_quantity', 'memory_reset_peak_usage', 'mysqli_execute_query', 'openssl_cipher_key_length'],
		'8.3' => ['json_validate', 'mb_str_pad', 'str_increment', 'str_decrement', 'stream_context_set_options', 'posix_sysconf'],
		'8.4' => [
			'array_find', 'array_find_key', 'array_any', 'array_all', 'bcdivmod', 'bcceil', 'bcfloor', 'bcround',
			'grapheme_str_split', 'http_get_last_response_headers', 'http_clear_last_response_headers',
			'mb_ucfirst', 'mb_lcfirst', 'mb_trim', 'mb_ltrim', 'mb_rtrim', 'pcntl_getcpu',
			'pcntl_getqos_class', 'pcntl_setqos_class', 'request_parse_body',
		],
	];

	public function __construct(
		private readonly Repository $repository,
		private readonly PhpMethodResolver $resolver,
		private readonly string $version = 'auto',
	) {
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	/**
	 * Неизвестные функции/методы — базовая проверка, включена всегда:
	 * такие ошибки видны в Problems независимо от `bitrix.php.semantic`.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function checkSymbols(TextDocument $document): array
	{
		$this->symbolsOnly = true;
		try {
			return $this->check($document);
		} finally {
			$this->symbolsOnly = false;
		}
	}

	public function check(TextDocument $document): array
	{
		$masked = JsScanner::maskCode(PhpSource::phpOnly($document->text), true);
		$diagnostics = [];
		$seen = [];
		$builtins = array_fill_keys(array_map('strtolower', get_defined_functions()['internal'] ?? []), true);
		$target = $this->version === 'auto' ? PHP_VERSION : $this->version;
		$runtime = PHP_VERSION;
		foreach (self::ADDED_FUNCTIONS as $introduced => $functions) {
			$add = version_compare($target, $introduced, '>=') && version_compare($runtime, $introduced, '<');
			$remove = version_compare($target, $introduced, '<') && version_compare($runtime, $introduced, '>=');
			foreach ($functions as $function) {
				if ($add) {
					$builtins[strtolower($function)] = true;
				} elseif ($remove) {
					unset($builtins[strtolower($function)]);
				}
			}
		}
		$keywords = array_fill_keys([
			'if', 'elseif', 'while', 'for', 'foreach', 'switch', 'catch', 'function', 'new',
			'isset', 'empty', 'unset', 'array', 'list', 'echo', 'print', 'include', 'include_once',
			'require', 'require_once', 'eval', 'match', 'return', 'exit', 'die', 'clone', 'yield',
			'static', 'global', 'declare', 'namespace', 'use', 'class', 'interface', 'trait',
		], true);

		$callRe = '/(?<![>\\w$:])\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)\\s*\\(/';
		if (preg_match_all($callRe, $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$name = $matches[1][$index][0];
				$lower = strtolower($name);
				if (isset($keywords[$lower]) || str_contains($name, '\\')) {
					continue;
				}
				$before = substr($masked, max(0, $whole[1] - 80), min(80, $whole[1]));
				if (preg_match('/\b(?:new|function|fn)\s+&?\s*$/', $before) === 1) {
					continue;
				}
				$open = $whole[1] + strrpos($whole[0], '(');
				$close = $this->matchingParen($masked, $open);
				if ($close <= $open) {
					continue;
				}
				$key = $name . ':' . $whole[1];
				if (isset($seen[$key])) {
					continue;
				}
				$seen[$key] = true;
				$function = $this->repository->findFunction($name);
				if ($function === null) {
					if (!isset($builtins[$lower]) && function_exists($name) === false) {
						$diagnostics[] = $this->warning(
							$document,
							$whole[1],
							$whole[1] + strlen($name),
							"Функция {$name}() не найдена в индексе и среди встроенных PHP-функций.",
							'bitrix.php.unknown-function',
							['kind' => 'unknown-function', 'name' => $name],
						);
					}
					continue;
				}
				if (!$this->symbolsOnly) {
					$diagnostics = array_merge(
						$diagnostics,
						$this->checkArguments($document, $function, $open, $close, $name),
					);
				}
				if (count($diagnostics) >= self::MAX) {
					return array_slice($diagnostics, 0, self::MAX);
				}
			}
		}

		$methodRe = '/(?:->|::)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(/';
		if (preg_match_all($methodRe, $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$name = $matches[1][$index][0];
				$nameOffset = $whole[1] + strpos($whole[0], $name);
				$reference = $this->resolver->resolve($document, $nameOffset);
				if ($reference === null) {
					$unknown = $this->unknownMethod($document, $nameOffset, $name);
					if ($unknown !== null) {
						$diagnostics[] = $unknown;
						if (count($diagnostics) >= self::MAX) {
							break;
						}
					}
					continue;
				}
				$open = $whole[1] + strrpos($whole[0], '(');
				$close = $this->matchingParen($masked, $open);
				if ($close <= $open) {
					continue;
				}
				if (!$this->symbolsOnly) {
					$diagnostics = array_merge(
						$diagnostics,
						$this->checkArguments(
							$document,
							$reference['method'],
							$open,
							$close,
							(string) $reference['method']['name'],
						),
					);
				}
				if (count($diagnostics) >= self::MAX) {
					break;
				}
			}
		}

		$unicodeMethodRe = '/(?:->|::)\s*([\p{L}_][\p{L}\p{N}_]*)\s*\(/u';
		if (preg_match_all($unicodeMethodRe, $masked, $unicodeMatches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($unicodeMatches[0] as $index => $whole) {
				$name = $unicodeMatches[1][$index][0];
				if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name) === 1) {
					continue; // обычные имена уже разобраны выше
				}
				$nameOffset = $whole[1] + strpos($whole[0], $name);
				$target = $this->resolver->resolveMemberTarget($document, $nameOffset);
				if ($target === null) {
					continue;
				}
				$class = ltrim($target['class'], '\\');
				if ($class === '' || $this->repository->classByName($class) === null) {
					continue;
				}
				$diagnostics[] = $this->warning(
					$document,
					$nameOffset,
					$nameOffset + mb_strlen($name),
					"Метод {$name}() не найден в классе {$class} (в имени не-ASCII символы — проверьте раскладку).",
					'bitrix.php.unknown-method',
					['kind' => 'unknown-method', 'name' => $name, 'class' => $class],
				);
				if (count($diagnostics) >= self::MAX) {
					break;
				}
			}
		}

		if (!$this->symbolsOnly) {
			$diagnostics = array_merge($diagnostics, $this->checkReturnTypes($document, $masked));
			$diagnostics = array_merge($diagnostics, $this->undefinedVariables($document, $masked));
		}
		return array_slice($diagnostics, 0, self::MAX);
	}

	/**
	 * Вызов метода, которого нет у известного класса (учитываются `__call`
	 * и встроенные классы PHP, которых нет в индексе).
	 *
	 * @return array<string, mixed>|null
	 */
	private function unknownMethod(TextDocument $document, int $nameOffset, string $name): ?array
	{
		if ($name === '' || str_starts_with($name, '__')) {
			return null;
		}
		$target = $this->resolver->resolveMemberTarget($document, $nameOffset);
		if ($target === null) {
			return null;
		}
		$class = ltrim($target['class'], '\\');
		if ($class === '') {
			return null;
		}
		if ($this->repository->classByName($class) === null) {
			// Класс объявлен в этом же (ещё не проиндексированном) файле:
			// проверяем по тексту документа, иначе молчим.
			$context = PhpDocumentContext::create($document);
			$local = $context->classAt($nameOffset);
			if ($local === null || strcasecmp(ltrim($local['fqcn'], '\\'), $class) !== 0) {
				return null;
			}
			if (preg_match('/function\s+&?\s*' . preg_quote($name, '/') . '\s*\(/i', $document->text) === 1) {
				return null;
			}
		}
		$row = $this->repository->classByName($class);
		if ($row !== null && stripos((string) ($row['doc'] ?? ''), '@method') !== false) {
			return null;
		}
		$magic = $target['operator'] === '::' ? '__callStatic' : '__call';
		if (
			$this->repository->findMethodInHierarchy($class, $magic) !== null
			|| $this->repository->findMethodInHierarchy($class, '__call') !== null
			|| $this->repository->findMethodInHierarchy($class, '__callStatic') !== null
		) {
			return null;
		}
		return $this->warning(
			$document,
			$nameOffset,
			$nameOffset + strlen($name),
			"Метод {$name}() не найден в классе {$class}.",
			'bitrix.php.unknown-method',
			['kind' => 'unknown-method', 'name' => $name, 'class' => $class],
		);
	}

	/**
	 * @param array<string, mixed> $callable
	 * @return array<int, array<string, mixed>>
	 */
	private function checkArguments(
		TextDocument $document,
		array $callable,
		int $open,
		int $close,
		string $name,
	): array {
		$params = json_decode((string) ($callable['params_json'] ?? '[]'), true);
		if (!is_array($params)) {
			return [];
		}
		$args = $this->splitArguments($document->text, $open + 1, $close);
		$required = 0;
		$variadic = false;
		foreach ($params as $param) {
			if (!empty($param['variadic'])) {
				$variadic = true;
			} elseif (!array_key_exists('default', $param)) {
				$required++;
			}
		}
		if (count($args) < $required || (!$variadic && count($args) > count($params))) {
			return [
				$this->warning(
					$document,
					$open - strlen($name),
					$close + 1,
					sprintf(
						'%s(): ожидается аргументов %d%s, передано %d.',
						$name,
						$required,
						$variadic ? '+' : '–' . count($params),
						count($args),
					),
					'bitrix.php.argument-count',
					['kind' => 'argument-count', 'name' => $name],
				),
			];
		}
		$diagnostics = [];
		foreach ($args as $index => $arg) {
			$param = $params[$index] ?? null;
			if (!is_array($param)) {
				break;
			}
			$expected = trim((string) ($param['type'] ?? ''));
			$actual = $this->literalType($arg);
			if ($expected === '' || $actual === null) {
				continue;
			}
			$allowed = array_map(
				static fn (string $type): string => strtolower(trim($type, " \\t\\n\\r?()")),
				preg_split('/[|&]/', $expected) ?: [],
			);
			if ($actual === 'int' && in_array('float', $allowed, true)) {
				continue;
			}
			if (!in_array($actual, $allowed, true) && !in_array('mixed', $allowed, true)) {
				$diagnostics[] = $this->warning(
					$document,
					$open + 1,
					$close,
					sprintf('%s(): аргумент %d ожидает %s, передан %s.', $name, $index + 1, $expected, $actual),
					'bitrix.php.argument-type',
					['kind' => 'argument-type', 'name' => $name],
				);
			}
		}
		return $diagnostics;
	}

	/**
	 * Проверка объявленного типа возврата: отсутствующий return, `return;`
	 * в не-void функции и литеральные несовпадения (включая union `array|false`).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private function checkReturnTypes(TextDocument $document, string $masked): array
	{
		$diagnostics = [];
		$re = '/\bfunction\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/';
		if (preg_match_all($re, $masked, $matches, PREG_OFFSET_CAPTURE) === false) {
			return [];
		}
		foreach ($matches[0] as $index => $whole) {
			if (count($diagnostics) >= self::MAX) {
				break;
			}
			$name = $matches[1][$index][0];
			$open = $whole[1] + strpos($whole[0], '(');
			$close = $this->matchingParen($masked, $open);
			if ($close <= $open) {
				continue;
			}
			$rest = substr($masked, $close + 1);
			if (preg_match('/^\s*:\s*([^{;]+)/', $rest, $typeMatch) !== 1) {
				continue;
			}
			$typeText = trim($typeMatch[1]);
			$bodyOpen = $close + 1 + strlen($typeMatch[0]);
			while ($bodyOpen < strlen($masked) && ctype_space($masked[$bodyOpen])) {
				$bodyOpen++;
			}
			if (($masked[$bodyOpen] ?? '') !== '{') {
				continue; // abstract/interface — тела нет
			}
			$bodyClose = $this->matchingBrace($masked, $bodyOpen);
			if ($bodyClose <= $bodyOpen) {
				continue;
			}
			$body = $this->withoutNestedFunctions(substr($masked, $bodyOpen + 1, $bodyClose - $bodyOpen - 1));
			$declared = strtolower(str_replace(' ', '', $typeText));
			$parts = array_map(
				static fn (string $part): string => ltrim(trim($part), '?'),
				explode('|', $declared),
			);
			$nullable = str_starts_with($declared, '?') || in_array('null', $parts, true);
			$isVoid = in_array('void', $parts, true);
			$isNever = in_array('never', $parts, true);
			$hasReturn = false;
			if (preg_match_all('/\breturn\b\s*([^;]*);/', $body, $returns, PREG_OFFSET_CAPTURE) > 0) {
				$hasReturn = true;
				foreach ($returns[0] as $returnIndex => $returnMatch) {
					$value = trim($returns[1][$returnIndex][0]);
					$offset = $bodyOpen + 1 + $returnMatch[1];
					if ($isNever) {
						$diagnostics[] = $this->warning(
							$document,
							$offset,
							$offset + 6,
							"Функция {$name}() объявлена как never и не должна возвращать управление.",
							'bitrix.php.return-type',
							['kind' => 'return-type', 'name' => $name],
						);
						continue;
					}
					if ($isVoid) {
						if ($value !== '') {
							$diagnostics[] = $this->warning(
								$document,
								$offset,
								$offset + strlen($returnMatch[0]),
								"Функция {$name}() объявлена как void и не должна возвращать значение.",
								'bitrix.php.return-type',
								['kind' => 'return-type', 'name' => $name],
							);
						}
						continue;
					}
					if ($value === '') {
						$diagnostics[] = $this->warning(
							$document,
							$offset,
							$offset + 6,
							"Функция {$name}() должна возвращать значение типа {$typeText}.",
							'bitrix.php.return-type',
							['kind' => 'return-type', 'name' => $name],
						);
						continue;
					}
					$actual = $this->literalType($value);
					if ($actual === null) {
						continue;
					}
					if ($this->returnTypeAllows($parts, $nullable, $value, $actual)) {
						continue;
					}
					$diagnostics[] = $this->warning(
						$document,
						$offset,
						$offset + strlen($returnMatch[0]),
						"Функция {$name}() объявляет возврат {$typeText}, а возвращает {$actual}.",
						'bitrix.php.return-type',
						['kind' => 'return-type', 'name' => $name],
					);
				}
			}
			if ($hasReturn || $isVoid || $isNever) {
				continue;
			}
			if (preg_match('/\b(?:yield|throw|exit|die)\b/', $body) === 1) {
				continue;
			}
			$diagnostics[] = $this->warning(
				$document,
				$bodyOpen,
				$bodyOpen + 1,
				"Функция {$name}() объявляет возврат {$typeText}, но не содержит return.",
				'bitrix.php.return-type',
				['kind' => 'return-type', 'name' => $name],
			);
		}
		return $diagnostics;
	}

	/**
	 * @param array<int, string> $parts
	 */
	private function returnTypeAllows(array $parts, bool $nullable, string $value, string $actual): bool
	{
		$raw = strtolower(trim($value));
		if ($raw === 'null' && $nullable) {
			return true;
		}
		if (in_array('mixed', $parts, true)) {
			return true;
		}
		if ($actual === 'bool') {
			if (in_array('bool', $parts, true)) {
				return true;
			}
			if ($raw === 'false' && in_array('false', $parts, true)) {
				return true;
			}
			if ($raw === 'true' && in_array('true', $parts, true)) {
				return true;
			}
			return false;
		}
		if ($actual === 'int' && in_array('float', $parts, true)) {
			return true;
		}
		return in_array($actual, $parts, true);
	}

	/** Маскирует вложенные `function (...) { ... }`, чтобы не читать их return. */
	private function withoutNestedFunctions(string $body): string
	{
		$out = $body;
		$offset = 0;
		while (preg_match('/\bfunction\b/', $out, $match, PREG_OFFSET_CAPTURE, $offset) === 1) {
			$start = $match[0][1];
			$brace = strpos($out, '{', $start);
			if ($brace === false) {
				break;
			}
			$close = $this->matchingBrace($out, $brace);
			if ($close <= $brace) {
				break;
			}
			$out = substr($out, 0, $start) . str_repeat(' ', $close - $start + 1) . substr($out, $close + 1);
			$offset = $close + 1;
		}
		return $out;
	}

	private function matchingBrace(string $text, int $open): int
	{
		$depth = 0;
		$length = strlen($text);
		for ($i = $open; $i < $length; $i++) {
			if ($text[$i] === '{') {
				$depth++;
			} elseif ($text[$i] === '}') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function undefinedVariables(TextDocument $document, string $masked): array
	{
		$declared = [];
		$assign = '/\\$([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\[[^\\]]*\\]\\s*)?(?:=|\\.=|\\+=|-=|\\*=|\\/=|\\?\\?=|%=)/';
		if (preg_match_all($assign, $masked, $matches) > 0) {
			foreach ($matches[1] as $name) {
				$declared[$name] = true;
			}
		}
		if (preg_match_all('/\bforeach\s*\(.*?\bas\b(.*?)\)/s', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		if (preg_match_all('/\bcatch\s*\(([^)]*)\)/', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		if (preg_match_all('/\blist\s*\(([^)]*)\)/', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		if (preg_match_all('/\buse\s*\(([^)]*)\)/', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		if (preg_match_all('/\b(?:global|static)\b([^;]*);/', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}

		if (preg_match_all('/\b(?:public|protected|private|var|readonly|static|final)\s+(?:[?\\\\A-Za-z0-9_|]+\s+)?\$([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/', $masked, $matches) > 0) {
			foreach ($matches[1] as $name) {
				$declared[$name] = true;
			}
		}
		if (preg_match_all('/\bfunction\s*[^()]*\(([^)]*)\)/', $masked, $matches) > 0) {
			foreach ($matches[1] as $body) {
				if (preg_match_all('/\$([A-Za-z_][A-Za-z0-9_]*)/', $body, $vars) > 0) {
					foreach ($vars[1] as $name) {
						$declared[$name] = true;
					}
				}
			}
		}
		$known = array_fill_keys([
			'this', 'GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION',
			'_REQUEST', '_ENV', 'APPLICATION', 'USER', 'DB', 'arParams', 'arResult', 'arCurrentValues',
			'component', 'templateFolder', 'componentPath', 'siteId', 'MESS', 'arTheme',
			'templateData', 'arElement', 'arSection', 'arItem', 'arFilter', 'arSelect', 'arOrder',
		], true);
		$diagnostics = [];
		$reported = [];
		if (preg_match_all('/\\$([A-Za-z_][A-Za-z0-9_]*)/', $masked, $matches, PREG_OFFSET_CAPTURE) > 0) {
			foreach ($matches[0] as $index => $whole) {
				$name = $matches[1][$index][0];
				if (isset($known[$name]) || isset($declared[$name]) || isset($reported[$name])) {
					continue;
				}
				$before = substr($masked, max(0, $whole[1] - 2), 2);
				if ($before === '->' || $before === '::') {
					continue;
				}
				$reported[$name] = true;
				$diagnostics[] = $this->warning(
					$document,
					$whole[1],
					$whole[1] + strlen($name) + 1,
					"Переменная \${$name} используется, но не объявлена в этом файле.",
					'bitrix.php.undefined-variable',
					['kind' => 'undefined-variable', 'name' => $name],
				);
				if (count($diagnostics) >= self::MAX) {
					break;
				}
			}
		}
		return $diagnostics;
	}

	/**
	 * @return array<int, string>
	 */
	private function splitArguments(string $text, int $start, int $end): array
	{
		$args = [];
		$depth = 0;
		$last = $start;
		for ($i = $start; $i < $end; $i++) {
			$ch = $text[$i];
			if ($ch === '(' || $ch === '[' || $ch === '{') {
				$depth++;
			} elseif ($ch === ')' || $ch === ']' || $ch === '}') {
				$depth--;
			} elseif ($ch === ',' && $depth === 0) {
				$args[] = trim(substr($text, $last, $i - $last));
				$last = $i + 1;
			}
		}
		$tail = trim(substr($text, $last, $end - $last));
		if ($tail !== '') {
			$args[] = $tail;
		}
		return $args;
	}

	private function literalType(string $arg): ?string
	{
		$arg = trim($arg);
		if (preg_match('/^([\'"]).*\\1$/s', $arg) === 1) {
			return 'string';
		}
		if (preg_match('/^-?\\d+$/', $arg) === 1) {
			return 'int';
		}
		if (preg_match('/^-?\\d+\\.\\d+$/', $arg) === 1) {
			return 'float';
		}
		if (preg_match('/^(true|false)$/i', $arg) === 1) {
			return 'bool';
		}
		if (strtolower($arg) === 'null') {
			return 'null';
		}
		if (str_starts_with($arg, '[') || preg_match('/^array\\s*\\(/', $arg) === 1) {
			return 'array';
		}
		return null;
	}

	private function matchingParen(string $text, int $open): int
	{
		$depth = 0;
		$length = strlen($text);
		for ($i = $open; $i < $length; $i++) {
			if ($text[$i] === '(') {
				$depth++;
			} elseif ($text[$i] === ')') {
				$depth--;
				if ($depth === 0) {
					return $i;
				}
			}
		}
		return $length;
	}

	/**
	 * @param array<string, mixed> $data
	 * @return array<string, mixed>
	 */
	private function warning(
		TextDocument $document,
		int $start,
		int $end,
		string $message,
		string $code,
		array $data,
	): array {
		return [
			'range' => $document->range($start, $end),
			'severity' => 2,
			'source' => 'bitrix',
			'code' => $code,
			'message' => $message,
			'data' => $data,
		];
	}
}
