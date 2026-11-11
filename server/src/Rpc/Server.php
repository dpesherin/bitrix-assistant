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
use BitrixLsp\Analyzer\PhpAnalyzer\PhpCallHierarchyProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpCodeLensProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpCompletionProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpDefinitionProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpDiagnostics;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpDocumentLinkProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpFormattingProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpFoldingProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpInlayHintProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpMethodResolver;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpReferenceProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpRenameProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpSemanticDiagnostics;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpSignatureHelpProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpTypeInference;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpTypeHierarchyProvider;
use BitrixLsp\Analyzer\PhpAnalyzer\PhpTypeNavigation;
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
	private readonly PhpReferenceProvider $phpReferences;
	private readonly PhpFoldingProvider $phpFolding;
	private readonly PhpTypeNavigation $phpNavigation;
	private readonly PhpInlayHintProvider $phpInlayHints;
	private readonly PhpRenameProvider $phpRename;
	private readonly PhpCodeLensProvider $phpCodeLens;
	private readonly PhpCallHierarchyProvider $phpCalls;
	private readonly PhpTypeHierarchyProvider $phpTypes;
	private readonly PhpDocumentLinkProvider $phpLinks;
	private readonly PhpFormattingProvider $phpFormatter;
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
		$this->phpHover = new PhpHoverProvider($this->repository, $methodResolver, $typeInference);
		$this->phpDefinition = new PhpDefinitionProvider($this->repository, $methodResolver);
		$this->phpReferences = new PhpReferenceProvider($this->repository, $methodResolver);
		$this->phpFolding = new PhpFoldingProvider();
		$this->phpNavigation = new PhpTypeNavigation($this->repository, $methodResolver, $typeInference);
		$this->phpInlayHints = new PhpInlayHintProvider($this->repository, $methodResolver);
		$this->phpRename = new PhpRenameProvider();
		$this->phpCodeLens = new PhpCodeLensProvider($this->repository);
		$this->phpCalls = new PhpCallHierarchyProvider($this->repository, $methodResolver);
		$this->phpTypes = new PhpTypeHierarchyProvider($this->repository);
		$this->phpLinks = new PhpDocumentLinkProvider();
		$this->phpFormatter = new PhpFormattingProvider();
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
			case 'textDocument/typeDefinition':
				$this->respond($id, $this->typeDefinition($params));
				break;
			case 'textDocument/implementation':
				$this->respond($id, $this->implementation($params));
				break;
			case 'textDocument/references':
				$this->respond($id, $this->references($params));
				break;
			case 'textDocument/documentHighlight':
				$this->respond($id, $this->documentHighlight($params));
				break;
			case 'textDocument/foldingRange':
				$this->respond($id, $this->foldingRange($params));
				break;
			case 'textDocument/inlayHint':
				$this->respond($id, $this->inlayHint($params));
				break;
			case 'textDocument/prepareRename':
				$this->respond($id, $this->prepareRename($params));
				break;
			case 'textDocument/rename':
				$this->respond($id, $this->rename($params));
				break;
			case 'textDocument/codeLens':
				$this->respond($id, $this->codeLens($params));
				break;
			case 'textDocument/documentLink':
				$this->respond($id, $this->documentLink($params));
				break;
			case 'textDocument/formatting':
				$this->respond($id, $this->formatting($params, null));
				break;
			case 'textDocument/rangeFormatting':
				$this->respond($id, $this->formatting($params, is_array($params['range'] ?? null) ? $params['range'] : []));
				break;
			case 'textDocument/prepareCallHierarchy':
				$this->respond($id, $this->prepareCallHierarchy($params));
				break;
			case 'callHierarchy/incomingCalls':
				$this->respond($id, $this->incomingCalls($params));
				break;
			case 'callHierarchy/outgoingCalls':
				$this->respond($id, $this->outgoingCalls($params));
				break;
			case 'textDocument/prepareTypeHierarchy':
				$this->respond($id, $this->prepareTypeHierarchy($params));
				break;
			case 'typeHierarchy/supertypes':
				$this->respond($id, $this->typeSupertypes($params));
				break;
			case 'typeHierarchy/subtypes':
				$this->respond($id, $this->typeSubtypes($params));
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
				// `_` в триггерах: после него редактор запрашивает список заново
				// (иначе фильтрует уже показанные элементы и `str_con_` прячет
				// `str_contains` до следующей буквы).
				'completionProvider' => ['triggerCharacters' => ['.', '\\', ':', '>', '$', '_'], 'resolveProvider' => false],
				'hoverProvider' => true,
				'definitionProvider' => true,
				'typeDefinitionProvider' => true,
				'implementationProvider' => true,
				'referencesProvider' => true,
				'documentHighlightProvider' => true,
				'foldingRangeProvider' => true,
				'inlayHintProvider' => true,
				'renameProvider' => ['prepareProvider' => true],
				'callHierarchyProvider' => true,
				'typeHierarchyProvider' => true,
				'signatureHelpProvider' => ['triggerCharacters' => ['(', ','], 'retriggerCharacters' => [',']],
				'codeActionProvider' => ['codeActionKinds' => ['quickfix']],
				'codeLensProvider' => ['resolveProvider' => false],
				'documentLinkProvider' => ['resolveProvider' => false],
				'documentFormattingProvider' => true,
				'documentRangeFormattingProvider' => true,
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
	/** Позиция внутри PHP-блока (`<?php … ?>`, `<?= … ?>`, `<? … ?>`). */
	private function isPhpContext(string $text, int $offset): bool
	{
		$before = substr($text, 0, max(0, $offset));
		$open = strrpos($before, '<?');
		$close = strrpos($before, '?>');
		return $open !== false && ($close === false || $open > $close);
	}

	/** Позиция внутри <script>…</script> (инлайн-JS в PHP-шаблоне). */
	private function isJsContext(string $text, int $offset): bool
	{
		$before = substr($text, 0, max(0, $offset));
		$open = strripos($before, '<script');
		if ($open === false) {
			return false;
		}
		$close = strripos($before, '</script');
		return $close === false || $close < $open;
	}

	private function completion(array $params): array
	{
		$document = $this->document($params);
		if ($document === null) {
			return [];
		}
		$offset = $this->offset($document, $params);
		// Клиент мог запросить подсказки раньше, чем прислал didChange: позиция
		// «за концом» документа означает устаревший текст — лучше ничего не
		// показывать, чем чужие элементы (например, константы по префиксу `s`).
		if ($this->positionBeyondEnd($document, $params)) {
			return [];
		}
		$from = max(0, $offset - 200);
		$before = substr($document->text, $from, $offset - $from);
		$items = [];
		$inPhp = $document->languageId === 'php' && $this->isPhpContext($document->text, $offset);
		$jsOnly = in_array($document->languageId, self::JS_LANGUAGES, true)
			|| ($document->languageId === 'php'
				&& !$this->isPhpContext($document->text, $offset)
				&& $this->isJsContext($document->text, $offset));
		if ($jsOnly) {
			// Внутри <script> PHP-подсказки не примешиваем: иначе в параметрах
			// JS-вызова появлялись функции PHP.
			return $this->jsCompletion->provide($document, $offset);
		}
		return $this->phpCompletion->provide($document, $offset);
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
			if (!$this->isPhpContext($document->text, $offset) && $this->isJsContext($document->text, $offset)) {
				return $this->jsHover->provide($document, $offset);
			}
			// Сначала PHP: JS-анализатор ищет по имени члена и на PHP-коде
			// находит чужие методы (`time` из bitrix/js/...).
			return $this->phpHover->provide($document, $offset);
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
			if (!$this->isPhpContext($document->text, $offset) && $this->isJsContext($document->text, $offset)) {
				return $this->jsDefinition->provide($document, $offset);
			}
			return $this->phpDefinition->provide($document, $offset);
		}
		return [];
	}

	/**
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	/**
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function references(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		$context = is_array($params['context'] ?? null) ? $params['context'] : [];
		return $this->phpReferences->references(
			$document,
			$this->offset($document, $params),
			(bool) ($context['includeDeclaration'] ?? true),
		);
	}

	/**
	 * Форматирование (консервативное): пробелы в конце строк и перевод строки в конце файла.
	 *
	 * @param array<string, mixed> $params
	 * @param array<string, mixed>|null $range
	 * @return array<int, array<string, mixed>>
	 */
	private function formatting(array $params, ?array $range): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		return $this->phpFormatter->format($document, $range);
	}

	/**
	 * Ссылки из `require`/`include` на файлы.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function documentLink(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		return $this->phpLinks->provide($document);
	}

	/**
	 * Иерархия типов: класс/интерфейс под курсором.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function prepareTypeHierarchy(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		return $this->phpTypes->prepare($document, $this->offset($document, $params));
	}

	/**
	 * Родители и интерфейсы класса.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function typeSupertypes(array $params): array
	{
		$item = is_array($params['item'] ?? null) ? $params['item'] : [];
		return $this->phpTypes->supertypes(is_array($item['data'] ?? null) ? $item['data'] : []);
	}

	/**
	 * Наследники и реализации класса.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function typeSubtypes(array $params): array
	{
		$item = is_array($params['item'] ?? null) ? $params['item'] : [];
		return $this->phpTypes->subtypes(is_array($item['data'] ?? null) ? $item['data'] : []);
	}

	/**
	 * Иерархия вызовов: символ под курсором.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function prepareCallHierarchy(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		return $this->phpCalls->prepare($document, $this->offset($document, $params));
	}

	/**
	 * Кто вызывает символ (по тексту проиндексированных файлов).
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function incomingCalls(array $params): array
	{
		$item = is_array($params['item'] ?? null) ? $params['item'] : [];
		$data = is_array($item['data'] ?? null) ? $item['data'] : [];
		return $this->phpCalls->incoming($data);
	}

	/**
	 * Кого вызывает символ (разбор тела объявления).
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function outgoingCalls(array $params): array
	{
		$item = is_array($params['item'] ?? null) ? $params['item'] : [];
		$data = is_array($item['data'] ?? null) ? $item['data'] : [];
		return $this->phpCalls->outgoing($data);
	}

	/**
	 * Линзы «N наследников» / «N переопределений» над объявлениями.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function codeLens(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		$range = is_array($params['range'] ?? null) ? $params['range'] : [];
		return $this->phpCodeLens->provide($document, $range);
	}

	/**
	 * Можно ли переименовать символ под курсором (локальные переменные).
	 *
	 * @param array<string, mixed> $params
	 * @return array<string, mixed>|null
	 */
	private function prepareRename(array $params): ?array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return null;
		}
		return $this->phpRename->prepare($document, $this->offset($document, $params));
	}

	/**
	 * Переименование локальной переменной в текущем документе.
	 *
	 * @param array<string, mixed> $params
	 * @return array<string, mixed>|null
	 */
	private function rename(array $params): ?array
	{
		$document = $this->document($params);
		$newName = is_string($params['newName'] ?? null) ? trim($params['newName']) : '';
		if ($document === null || $document->languageId !== 'php' || $newName === '') {
			return null;
		}
		return $this->phpRename->rename($document, $this->offset($document, $params), $newName);
	}

	/**
	 * Подсказки с именами параметров в вызовах.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function inlayHint(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		$range = is_array($params['range'] ?? null) ? $params['range'] : [];
		return $this->phpInlayHints->provide($document, $range);
	}

	/**
	 * Тип выражения под курсором (переменная/метод/свойство/класс).
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function typeDefinition(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		return $this->phpNavigation->typeDefinition($document, $this->offset($document, $params));
	}

	/**
	 * Реализации интерфейса и переопределения метода в наследниках.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function implementation(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		return $this->phpNavigation->implementations($document, $this->offset($document, $params));
	}

	/**
	 * Folding ranges: тела классов/функций, `#region`, блочные комментарии.
	 *
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function foldingRange(array $params): array
	{
		$document = $this->document($params);
		if ($document === null) {
			return [];
		}
		return $this->phpFolding->folding($document);
	}

	/**
	 * @param array<string, mixed> $params
	 * @return array<int, array<string, mixed>>
	 */
	private function documentHighlight(array $params): array
	{
		$document = $this->document($params);
		if ($document === null || $document->languageId !== 'php') {
			return [];
		}
		return $this->phpReferences->highlight($document, $this->offset($document, $params));
	}

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
			$jsInline = !$this->isPhpContext($document->text, $offset)
				&& $this->isJsContext($document->text, $offset);
			return $jsInline
				? $this->jsSignatureHelp->provide($document, $offset)
				: $this->phpSignatureHelp->provide($document, $offset);
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
	/** Позиция запроса лежит за концом документа (клиент ещё не прислал didChange). */
	private function positionBeyondEnd(TextDocument $document, array $params): bool
	{
		$position = $params['position'] ?? null;
		if (!is_array($position)) {
			return false;
		}
		$line = (int) ($position['line'] ?? 0);
		$char = (int) ($position['character'] ?? 0);
		$text = $document->text;
		$lastNewline = strrpos($text, "\n");
		$endLine = $lastNewline === false ? 0 : substr_count($text, "\n");
		if ($line > $endLine) {
			return true;
		}
		if ($line < $endLine) {
			return false;
		}
		$lastLine = $lastNewline === false ? $text : substr($text, $lastNewline + 1);
		return $char > mb_strlen($lastLine);
	}

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
