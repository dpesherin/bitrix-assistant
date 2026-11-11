<?php

declare(strict_types=1);

namespace BitrixLsp\Rpc;

use BitrixLsp\Analyzer\JsAnalyzer\DocumentContextBuilder;
use BitrixLsp\Analyzer\JsAnalyzer\JsCompletionProvider;
use BitrixLsp\Analyzer\JsAnalyzer\JsDefinitionProvider;
use BitrixLsp\Analyzer\JsAnalyzer\JsHoverProvider;
use BitrixLsp\Analyzer\JsAnalyzer\JsModuleResolver;
use BitrixLsp\Analyzer\JsAnalyzer\JsSignatureHelpProvider;
use BitrixLsp\Analyzer\JsAnalyzer\LibraryResolver;
use BitrixLsp\Analyzer\LibraryCheck\LibraryDiagnostics;
use BitrixLsp\Analyzer\LibraryCheck\LibraryQuickFix;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpCompletionProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpDefinitionProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpDiagnostics;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpMethodResolver;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpSemanticDiagnostics;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpSignatureHelpProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpTypeInference;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpHoverProvider;
use BitrixLsp\Config;
use BitrixLsp\Index\Repository;
use BitrixLsp\Support\Logger;
use BitrixLsp\Support\Paths;
use BitrixLsp\Support\TextDocument;
use Throwable;

/**
 * Диспетчер JSON-RPC и LSP-возможности. Все ответы — детерминированные:
 * индекс SQLite + правила разбора, без вызовов внешних моделей.
 */
final class Server
{
	private readonly Logger $logger;
	private readonly Config $config;
	private readonly Repository $repository;

	private readonly LibraryDiagnostics $libraryDiagnostics;
	private readonly LibraryQuickFix $libraryQuickFix;
	private readonly JsCompletionProvider $jsCompletion;
	private readonly JsHoverProvider $jsHover;
	private readonly JsDefinitionProvider $jsDefinition;
	private readonly PhpCompletionProvider $phpCompletion;
	private readonly PhpHoverProvider $phpHover;
	private readonly PhpDefinitionProvider $phpDefinition;
	private readonly PhpDiagnostics $phpDiagnostics;
	private readonly PhpSignatureHelpProvider $phpSignatureHelp;
	private readonly JsSignatureHelpProvider $jsSignatureHelp;

	/** @var array<string, TextDocument> */
	private array $documents = [];
	private bool $shutdown = false;
	private bool $exit = false;

	private const JS_LANGUAGES = ['javascript', 'javascriptreact'];

	public function __construct(private readonly StdioTransport $transport)
	{
		$this->logger = new Logger((getenv('BITRIX_LSP_LOG') ?: '1') !== '0');
		$this->config = Config::fromEnvironment();
		$this->repository = new Repository($this->config->dbPath, $this->logger);
		$resolver = new LibraryResolver($this->repository);
		$contexts = new DocumentContextBuilder($this->repository);
		$this->libraryDiagnostics = new LibraryDiagnostics(
			$this->repository,
			$resolver,
			$contexts,
			$this->config->bitrixPath,
		);
		$this->libraryQuickFix = new LibraryQuickFix();
		$jsModules = new JsModuleResolver();
		$this->jsCompletion = new JsCompletionProvider($this->repository, $jsModules);
		$this->jsHover = new JsHoverProvider($this->repository, $resolver, $jsModules);
		$this->jsDefinition = new JsDefinitionProvider($this->repository, $resolver, $jsModules);
		$this->jsSignatureHelp = new JsSignatureHelpProvider($this->repository);
		$typeInference = new PhpTypeInference($this->repository);
		$methodResolver = new PhpMethodResolver($this->repository, $typeInference);
		$this->phpCompletion = new PhpCompletionProvider($this->repository, $typeInference);
		$this->phpHover = new PhpHoverProvider($this->repository, $methodResolver);
		$this->phpDefinition = new PhpDefinitionProvider($this->repository, $methodResolver);
		$this->phpDiagnostics = new PhpDiagnostics(
			$this->repository,
			$this->config,
			new PhpSemanticDiagnostics($this->repository, $methodResolver, $this->config->phpVersion),
		);
		$this->phpSignatureHelp = new PhpSignatureHelpProvider($this->repository, $methodResolver);
	}

	public function run(): void
	{
		$this->logger->info('Сервер запущен, база: ' . ($this->config->dbPath ?? 'нет'));
		while (!$this->exit) {
			$message = $this->transport->read();
			if ($message === null) {
				break;
			}
			try {
				$this->handle($message);
			} catch (Throwable $error) {
				$this->logger->error('Ошибка обработки: ' . $error->getMessage());
				if (isset($message['id'])) {
					$this->error($message['id'], -32603, $error->getMessage());
				}
			}
		}
		$this->logger->info('Сервер остановлен');
	}

	/**
	 * @param array<string, mixed> $message
	 */
	private function handle(array $message): void
	{
		$method = $message['method'] ?? null;
		if (!is_string($method)) {
			return; // ответ клиента на запрос сервера — не обрабатываем
		}
		$params = is_array($message['params'] ?? null) ? $message['params'] : [];
		$id = $message['id'] ?? null;

		switch ($method) {
			case 'initialize':
				$this->initialize($params);
				$this->respond($id, $this->capabilities());
				break;
			case 'initialized':
				break;
			case 'shutdown':
				$this->shutdown = true;
				$this->respond($id, null);
				break;
			case 'exit':
				$this->exit = true;
				break;
			case 'textDocument/didOpen':
				$this->didOpen($params);
				break;
			case 'textDocument/didChange':
				$this->didChange($params);
				break;
			case 'textDocument/didSave':
				$this->didSave($params);
				break;
			case 'textDocument/didClose':
				$this->didClose($params);
				break;
			case 'textDocument/completion':
				$this->respond($id, $this->completion($params));
				break;
			case 'textDocument/hover':
				$this->respond($id, $this->hover($params));
				break;
			case 'textDocument/definition':
				$this->respond($id, $this->definition($params));
				break;
			case 'textDocument/signatureHelp':
				$this->respond($id, $this->signatureHelp($params));
				break;
			case 'textDocument/codeAction':
				$this->respond($id, $this->codeAction($params));
				break;
			case 'workspace/symbol':
				$this->respond($id, $this->workspaceSymbol($params));
				break;
			case 'textDocument/documentSymbol':
				$this->respond($id, $this->documentSymbol($params));
				break;
			case 'workspace/didChangeConfiguration':
				$this->config->applySettings(is_array($params['settings'] ?? null) ? $params['settings'] : []);
				foreach (array_keys($this->documents) as $uri) {
					$this->validate($uri);
				}
				break;
			default:
				if ($id !== null) {
					$this->respond($id, null);
				}
		}
	}

	/**
	 * @return array<string, mixed>
	 */
	private function capabilities(): array
	{
		return [
			'capabilities' => [
				'textDocumentSync' => ['openClose' => true, 'change' => 1, 'save' => ['includeText' => true]],
				'completionProvider' => ['triggerCharacters' => ['.', '\\', ':', '>', '$'], 'resolveProvider' => false],
				'hoverProvider' => true,
				'definitionProvider' => true,
				'signatureHelpProvider' => ['triggerCharacters' => ['(', ','], 'retriggerCharacters' => [',']],
				'codeActionProvider' => ['codeActionKinds' => ['quickfix']],
				'workspaceSymbolProvider' => true,
				'documentSymbolProvider' => true,
				'workspace' => ['workspaceFolders' => ['supported' => true, 'changeNotifications' => false]],
			],
			'serverInfo' => ['name' => 'bitrix-lsp', 'version' => '0.1.0'],
		];
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function initialize(array $params): void
	{
		$options = is_array($params['initializationOptions'] ?? null) ? $params['initializationOptions'] : [];
		if (isset($options['dbPath']) && is_string($options['dbPath'])) {
			$this->repository->setDbPath($options['dbPath']);
		}
		if (isset($options['jsLibraryCheck'])) {
			$this->config->jsLibraryCheck = (bool) $options['jsLibraryCheck'];
		}
		$this->logger->info(sprintf(
			'initialize: root=%s bitrix=%s libCheck=%s',
			(string) ($options['bitrixRoot'] ?? ''),
			(string) ($options['bitrixPath'] ?? ''),
			$this->config->jsLibraryCheck ? 'on' : 'off',
		));
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function didOpen(array $params): void
	{
		$document = $params['textDocument'] ?? null;
		if (!is_array($document)) {
			return;
		}
		$uri = (string) ($document['uri'] ?? '');
		if ($uri === '') {
			return;
		}
		$this->documents[$uri] = new TextDocument(
			$uri,
			(string) ($document['languageId'] ?? ''),
			(string) ($document['text'] ?? ''),
			(int) ($document['version'] ?? 0),
		);
		$this->validate($uri);
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function didChange(array $params): void
	{
		$document = $params['textDocument'] ?? null;
		if (!is_array($document)) {
			return;
		}
		$uri = (string) ($document['uri'] ?? '');
		$current = $this->documents[$uri] ?? null;
		if ($current === null) {
			return;
		}
		$changes = $params['contentChanges'] ?? [];
		if (!is_array($changes) || $changes === []) {
			return;
		}
		$text = $current->text;
		foreach ($changes as $change) {
			if (!is_array($change)) {
				continue;
			}
			$newText = (string) ($change['text'] ?? '');
			if (isset($change['range']) && is_array($change['range'])) {
				$start = $this->offsetFromRange($current, $change['range'], true);
				$end = $this->offsetFromRange($current, $change['range'], false);
				$text = substr($text, 0, $start) . $newText . substr($text, $end);
			} else {
				$text = $newText;
			}
		}
		$this->documents[$uri] = new TextDocument($uri, $current->languageId, $text, (int) ($document['version'] ?? $current->version));
		$this->validate($uri);
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function didSave(array $params): void
	{
		$document = $params['textDocument'] ?? null;
		if (!is_array($document)) {
			return;
		}
		$uri = (string) ($document['uri'] ?? '');
		$current = $this->documents[$uri] ?? null;
		if ($current === null) {
			return;
		}
		if (isset($params['text']) && is_string($params['text'])) {
			$this->documents[$uri] = new TextDocument($uri, $current->languageId, $params['text'], $current->version);
		}
		$this->validate($uri);
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function didClose(array $params): void
	{
		$document = $params['textDocument'] ?? null;
		if (!is_array($document)) {
			return;
		}
		$uri = (string) ($document['uri'] ?? '');
		unset($this->documents[$uri]);
		$this->notify('textDocument/publishDiagnostics', ['uri' => $uri, 'diagnostics' => []]);
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function completion(array $params): array
	{
		$document = $this->document($params);
		if ($document === null) {
			return [];
		}
		$offset = $this->offset($document, $params);
		$from = max(0, $offset - 200);
		$before = substr($document->text, $from, $offset - $from);
		$items = [];
		$isJs = in_array($document->languageId, self::JS_LANGUAGES, true)
			|| preg_match('/\bBX\.[A-Za-z0-9_.$]*$/', $before) === 1;
		if ($isJs) {
			$items = $this->jsCompletion->provide($document, $offset);
		}
		if ($items === [] && $document->languageId === 'php') {
			$items = $this->phpCompletion->provide($document, $offset);
		}
		return $items;
	}

	/**
	 * @param array<string, mixed> $params
	 * @return array<string, mixed>|null
	 */
	private function hover(array $params): ?array
	{
		$document = $this->document($params);
		if ($document === null) {
			return null;
		}
		$offset = $this->offset($document, $params);
		if (in_array($document->languageId, self::JS_LANGUAGES, true)) {
			return $this->jsHover->provide($document, $offset);
		}
		if ($document->languageId === 'php') {
			return $this->jsHover->provide($document, $offset) ?? $this->phpHover->provide($document, $offset);
		}
		return null;
	}

	/**
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function definition(array $params): array
	{
		$document = $this->document($params);
		if ($document === null) {
			return [];
		}
		$offset = $this->offset($document, $params);
		if (in_array($document->languageId, self::JS_LANGUAGES, true)) {
			return $this->jsDefinition->provide($document, $offset);
		}
		if ($document->languageId === 'php') {
			$js = $this->jsDefinition->provide($document, $offset);
			return $js !== [] ? $js : $this->phpDefinition->provide($document, $offset);
		}
		return [];
	}

	/**
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function workspaceSymbol(array $params): array
	{
		$query = is_string($params['query'] ?? null) ? trim($params['query']) : '';
		$symbols = [];
		foreach ($this->repository->searchSymbols($query, 100) as $row) {
			$line = max(0, (int) ($row['line'] ?? 1) - 1);
			$symbols[] = [
				'name' => (string) ($row['name'] ?? ''),
				'kind' => 5,
				'location' => [
					'uri' => Paths::pathToUri((string) $row['file']),
					'range' => [
						'start' => ['line' => $line, 'character' => 0],
						'end' => ['line' => $line, 'character' => 0],
					],
				],
				'containerName' => (string) ($row['namespace'] ?? ''),
			];
		}
		foreach ($this->repository->searchFunctions($query, 50) as $row) {
			$line = max(0, (int) ($row['line'] ?? 1) - 1);
			$symbols[] = [
				'name' => (string) ($row['name'] ?? ''),
				'kind' => 12,
				'location' => [
					'uri' => Paths::pathToUri((string) $row['file']),
					'range' => [
						'start' => ['line' => $line, 'character' => 0],
						'end' => ['line' => $line, 'character' => 0],
					],
				],
				'containerName' => (string) ($row['fqcn'] ?? ''),
			];
		}
		foreach ($this->repository->searchMethods($query, 50) as $row) {
			$line = max(0, (int) ($row['line'] ?? 1) - 1);
			$symbols[] = [
				'name' => (string) ($row['name'] ?? '') . '()',
				'kind' => 6,
				'location' => [
					'uri' => Paths::pathToUri((string) $row['file']),
					'range' => [
						'start' => ['line' => $line, 'character' => 0],
						'end' => ['line' => $line, 'character' => 0],
					],
				],
				'containerName' => (string) ($row['class_fqcn'] ?? ''),
			];
		}
		return $symbols;
	}

	/**
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function documentSymbol(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		$path = Paths::uriToPath($document->uri);
		if ($path === null) {
			return [];
		}
		$symbols = [];
		foreach ($this->repository->classesForFile($path) as $class) {
			$classLine = max(0, (int) ($class['line'] ?? 1) - 1);
			$classSymbol = [
				'name' => (string) ($class['name'] ?? ''),
				'kind' => 5,
				'detail' => (string) ($class['fqcn'] ?? ''),
				'range' => [
					'start' => ['line' => $classLine, 'character' => 0],
					'end' => ['line' => $classLine, 'character' => 0],
				],
				'selectionRange' => [
					'start' => ['line' => $classLine, 'character' => 0],
					'end' => ['line' => $classLine, 'character' => 0],
				],
				'children' => [],
			];
			$fqcn = (string) ($class['fqcn'] ?? '');
			if ($fqcn !== '') {
				foreach ($this->repository->methodsForClass($fqcn) as $method) {
					$line = max(0, (int) ($method['line'] ?? 1) - 1);
					$classSymbol['children'][] = $this->documentSymbolNode(
						(string) $method['name'] . '()',
						6,
						(string) ($method['signature'] ?? ''),
						$line,
					);
				}
				foreach ($this->repository->propertiesForClass($fqcn) as $property) {
					$line = max(0, (int) ($property['line'] ?? 1) - 1);
					$classSymbol['children'][] = $this->documentSymbolNode(
						'$' . (string) $property['name'],
						7,
						(string) ($property['type'] ?? ''),
						$line,
					);
				}
				foreach ($this->repository->constantsForClass($fqcn) as $constant) {
					$line = max(0, (int) ($constant['line'] ?? 1) - 1);
					$classSymbol['children'][] = $this->documentSymbolNode(
						(string) $constant['name'],
						14,
						(string) ($constant['value'] ?? ''),
						$line,
					);
				}
			}
			$symbols[] = $classSymbol;
		}
		foreach ($this->repository->functionsForFile($path) as $function) {
			$line = max(0, (int) ($function['line'] ?? 1) - 1);
			$symbols[] = $this->documentSymbolNode(
				(string) $function['name'] . '()',
				12,
				(string) ($function['signature'] ?? ''),
				$line,
			);
		}
		foreach ($this->repository->globalConstantsForFile($path) as $constant) {
			$line = max(0, (int) ($constant['line'] ?? 1) - 1);
			$symbols[] = $this->documentSymbolNode(
				(string) $constant['name'],
				14,
				(string) ($constant['value'] ?? ''),
				$line,
			);
		}
		return $symbols;
	}

	/**
	 * @return array<string, mixed>
	 */
	private function documentSymbolNode(string $name, int $kind, string $detail, int $line): array
	{
		return [
			'name' => $name,
			'kind' => $kind,
			'detail' => $detail,
			'range' => [
				'start' => ['line' => $line, 'character' => 0],
				'end' => ['line' => $line, 'character' => 0],
			],
			'selectionRange' => [
				'start' => ['line' => $line, 'character' => 0],
				'end' => ['line' => $line, 'character' => 0],
			],
		];
	}

	/**
	 * @param array<string, mixed> $params
	 * @return array<string, mixed>|null
	 */
	private function signatureHelp(array $params): ?array
	{
		$document = $this->document($params);
		if ($document === null) {
			return null;
		}
		$offset = $this->offset($document, $params);
		if ($document->languageId === 'php') {
			return $this->phpSignatureHelp->provide($document, $offset);
		}
		if (in_array($document->languageId, self::JS_LANGUAGES, true)) {
			return $this->jsSignatureHelp->provide($document, $offset);
		}
		return null;
	}

	/**
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function codeAction(array $params): array
	{
		$document = $this->document($params);
		if ($document === null) {
			return [];
		}
		$context = is_array($params['context'] ?? null) ? $params['context'] : [];
		$diagnostics = is_array($context['diagnostics'] ?? null) ? $context['diagnostics'] : [];
		if ($diagnostics === []) {
			$diagnostics = $this->collectDiagnostics($document);
		}
		return $this->libraryQuickFix->provide($document, $diagnostics);
	}

	private function validate(string $uri): void
	{
		$document = $this->documents[$uri] ?? null;
		if ($document === null) {
			return;
		}
		$this->notify('textDocument/publishDiagnostics', [
			'uri' => $uri,
			'diagnostics' => $this->collectDiagnostics($document),
		]);
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private function collectDiagnostics(TextDocument $document): array
	{
		$diagnostics = [];
		if ($document->languageId === 'php') {
			$diagnostics = array_merge($diagnostics, $this->phpDiagnostics->check($document));
		}
		$diagnostics = array_merge(
			$diagnostics,
			$this->libraryDiagnostics->check($document, $this->config->jsLibraryCheck),
		);
		return $diagnostics;
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function document(array $params): ?TextDocument
	{
		$document = $params['textDocument'] ?? null;
		if (!is_array($document)) {
			return null;
		}
		$uri = (string) ($document['uri'] ?? '');
		return $this->documents[$uri] ?? null;
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function offset(TextDocument $document, array $params): int
	{
		$position = $params['position'] ?? null;
		if (!is_array($position)) {
			return 0;
		}
		return $document->offsetAt((int) ($position['line'] ?? 0), (int) ($position['character'] ?? 0));
	}

	/**
	 * @param array<string, mixed> $range
	 */
	private function offsetFromRange(TextDocument $document, array $range, bool $start): int
	{
		$position = $range[$start ? 'start' : 'end'] ?? null;
		if (!is_array($position)) {
			return $start ? 0 : strlen($document->text);
		}
		return $document->offsetAt((int) ($position['line'] ?? 0), (int) ($position['character'] ?? 0));
	}

	/**
	 * @param mixed $id
	 * @param mixed $result
	 */
	private function respond($id, $result): void
	{
		if ($id === null) {
			return;
		}
		$this->transport->write(['jsonrpc' => '2.0', 'id' => $id, 'result' => $result]);
	}

	/**
	 * @param mixed $id
	 */
	private function error($id, int $code, string $message): void
	{
		$this->transport->write([
			'jsonrpc' => '2.0',
			'id' => $id,
			'error' => ['code' => $code, 'message' => $message],
		]);
	}

	/**
	 * @param array<string, mixed> $params
	 */
	private function notify(string $method, array $params): void
	{
		$this->transport->write(['jsonrpc' => '2.0', 'method' => $method, 'params' => $params]);
	}
}
