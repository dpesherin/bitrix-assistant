# Bitrix Assistant: разработка

Техническая документация расширения: устройство индекса, LSP-сервер, сборка и упаковка.
Пользовательское описание, команды и настройки — в [README](../README.md).

## Возможности (MVP)

### SSH
- Профили подключений (host, port, user, пароль или приватный ключ, `remoteRoot`, `localRoot`).
- Дерево удалённой ФС в отдельной панели Activity Bar с ленивой загрузкой каталогов.
- Исключения по умолчанию: `bitrix/cache`, `bitrix/managed_cache`, `bitrix/stack_cache`,
  `bitrix/backup`, `upload`, `*.min.js`.
- Загрузка/скачивание одного файла, `syncAll` в трёх режимах, `uploadOnSave`, `downloadOnOpen`.
- Контекстное меню в дереве сервера: «Открыть для просмотра», «Скачать с сервера»,
  «Загрузить локальную версию» (для файлов и каталогов), «Скопировать путь».
- Просмотр серверных файлов — только чтение: копия скачивается во временный каталог
  расширения, открывается с флагом read-only сессии и правами `0444`; серверный файл
  не изменяется.

### Индекс
- PHP: `/bitrix/modules/*/lib`, `/local/modules/*/lib`, легаси-классы
  `/bitrix/modules/*/classes` и `install/classes` (CFile, CMain, CUser и т.п.),
  компоненты (`/bitrix/components`, `/local/components`,
  `/bitrix/modules/*/install/components`), `/bitrix/php_interface`, `/local/php_interface`.
- JS: `config.php` расширений в `/bitrix/js/**` и `/local/js/**`
  (ключи `js`, `css`, `lang`, `rel`, `skip_core`), JS-файлы (кроме `.min.js`),
  дополнительно `/bitrix/modules/*/install/js/**` и `/bitrix/modules/main/jscore.php`.
- Кеш — SQLite `bitrix-index.db` в workspace storage; в мульти-руте у каждой папки
  своя база `bitrix-index-<hash>.db`.
- Инкрементальная синхронизация по `size + mtime`, полная перестройка — по команде.

### Проверка синтаксиса PHP

Расширение запускает `php -l` для открытых PHP-файлов и показывает ошибки в
Problems. Версия выбирается настройкой `bitrix.php.version` или кликом по
индикатору **`PHP <версия>`** в нижней строке статус-бара: `auto` берёт `php`
из PATH, иначе встроенный статический PHP; для выбранной версии ищется
`php8.x` или путь из `bitrix.php.lintBinary`. Проверка выполняется на
несохранённом буфере, с задержкой 400 мс; для `untitled:`-документа с `<?php`
тоже, через временный файл в `$TMPDIR`. Если начать печатать `<?php` в пустом
untitled, расширение само переключает язык документа на PHP.

Если выбранной версии PHP нет ни в PATH, ни во встроенной сборке, расширение
предлагает **скачать** готовую static-php-cli сборку: архив скачивается в
`globalStorage/php-runtimes`, проверяется SHA-256 (если sidecar доступен) и
распаковывается. Команда: **Bitrix Assistant: скачать PHP для проверки синтаксиса**.
Исходники PHP для этого не нужны — только бинарник `php`. Для macOS 8.4
готовой prebuilt-сборки нет: используется системный PHP или `bitrix.php.lintBinary`.

### LSP (PHP-сервер)
- PHP: completion классов (`\CF`, `CFile`, `Bitrix\Main\Lo…`) с автоматическим `use`,
  completion методов/свойств/констант (`Class::`, `$this->`, `$var->`), hover/переход
  для свойств и констант, поиск классов по Ctrl+T (`workspace/symbol`) и outline
  (`document/symbol`), hover объявления метода (включая doc родителя при переопределении),
  глобальные функции и константы (`GetMessage`, `ShowError`, `B_PROLOG_INCLUDED`):
  completion, hover, definition и signature help, hover с сигнатурой,
  возвращаемым типом и doc-блоком метода, definition класса и метода, signature help,
  диагностика `@deprecated` и необъявленных параметров `$arParams` (сверка с `.parameters.php`).
- JS: completion `BX.` и `BX.Main.` (в контексте `new BX.` — классы/конструкторы),
  hover с расширением/`rel`/config.php, definition в JS-файл или `config.php`,
  `this.method` и частые DOM-методы (`querySelector`, `addEventListener` и т.п.),
  ES-классы (`class Foo` / `declare class Foo`) и их методы, `.d.ts`-декларации,
  `this.*` внутри ES-класса, опциональная диагностика «библиотека не подключена»
  (по умолчанию выключена).
- Quick Fix: `CJSCore::Init(['lib'])`, `\Bitrix\Main\UI\Extension::load('lib')` для PHP
  и `BX.loadExt('lib')` для JS; для PHP — «Импортировать <FQCN>» по короткому имени
  класса из индекса (добавляет `use` после последнего `use`/`namespace`).
- Навигация и анализ (PHP): `references` и `documentHighlight` (поиск по тексту
  проиндексированных файлов, лимиты 4000 файлов / 400 результатов), `typeDefinition`
  (переменная → присваивание/параметр/`$this`, метод → `return type`, `static` → тип
  получателя), `implementation` и `typeHierarchy/*` (`Repository::descendantsOf()` /
  `directChildrenOf()` + проверка иерархии), `callHierarchy/*` (входящие — текстовый поиск
  с атрибуцией вызывающего, исходящие — разбор тела), `codeLens` (наследники,
  переопределения), `inlayHint` (имена параметров).
- Типы: `PhpTypeInference` — литералы, `new`, `@var`/`@param`/`@return`, `Foo[]`,
  `array<Foo>`, `array{KEY: Foo[]}`, `foreach`/`$items[0]`, flow-narrowing после
  `instanceof`/`assert`; для параметров работает и в обычных функциях
  (`PhpDocumentContext::functionParamsAt`).
- Правки: `rename` — только локальные переменные в текущем файле, с отказами при
  вхождениях в строках, `compact()`, `$$var`, суперглобальных и занятом имени;
  `formatting`/`rangeFormatting` — только хвостовые пробелы и один перевод строки в конце,
  файлы с heredoc пропускаются; `documentLink` — существующие пути из `require`/`include`.

---

## Структура проекта

```
.
├── package.json                 # contributes: commands/configuration/views, activation
├── tsconfig.json
├── craft.yml                    # конфиг static-php-cli (сборка бинарников PHP)
├── .vscodeignore                # исходники PHP/TS не попадают в .vsix, bin/ и phar — попадают
├── media/bitrix.svg           # монохромная иконка activity bar (знак Bitrix)
├── media/icon.svg / icon.png  # цветная иконка расширения (маркетплейс)
├── src/
│   ├── extension.ts             # активация, команды, watcher'ы
│   ├── settings.ts
│   ├── log.ts
│   ├── ssh/
│   │   ├── types.ts
│   │   ├── profiles.ts          # globalState + SecretStorage
│   │   ├── connection.ts        # ssh2: sftp
│   │   ├── sync.ts              # маппинг local↔remote, upload/download/syncAll
│   │   └── remoteTree.ts        # TreeView удалённой ФС
│   ├── indexer/
│   │   ├── db.ts                # node:sqlite (встроенный, без нативных сборок)
│   │   ├── schema.ts            # схема SQLite
│   │   ├── indexWriter.ts       # запись индекса (без VS Code API, тестируется отдельно)
│   │   ├── indexer.ts           # обход ФС, инкремент, прогресс, отмена
│   │   ├── php/
│   │   │   ├── phpArray.ts      # разбор PHP-литералов (config.php, .parameters.php)
│   │   │   ├── phpParser.ts     # классы/методы/extends/deprecated/ORM
│   │   │   └── componentParser.ts
│   │   └── js/
│   │       ├── jsConfigParser.ts # config.php → js/css/lang/rel/skip_core
│   │       └── jsScanner.ts      # BX.*, window.*, prototype, export, ключи объектов
│   ├── lsp/
│   │   ├── platform.ts          # выбор бинарника по платформе (5 вариантов)
│   │   └── lspClient.ts         # LanguageClient, env, documentSelector
│   ├── features/ormAnnotations.ts
│   ├── views/indexView.ts
│   └── util/glob.ts
├── server/
│   ├── src/                     # PHP LSP (в .vsix едет только phar)
│   │   ├── main.php
│   │   ├── Config.php
│   │   ├── Rpc/{StdioTransport,Server}.php
│   │   ├── Support/{TextDocument,Paths,Logger}.php
│   │   ├── Index/Repository.php
│   │   └── Analyzer/
│   │       ├── JsAnalyzer/     # сканер BX.*, completion/hover/definition, резолв расширений
│   │       ├── PhpAnalyzer/    # load-сканер, use-map, completion/hover/definition/диагностика
│   │       └── LibraryCheck/   # диагностика и quick fix «библиотека не подключена»
│   └── bin/                     # php-<os>-<arch> + bitrix-lsp.phar (в git не коммитятся)
├── scripts/
│   ├── build-php.sh             # phar + статический PHP (spc)
│   ├── build-phar.php
│   └── e2e-lsp.mjs              # сквозной тест LSP по JSON-RPC
└── test/                        # unit-тесты + integration (Extension Host)
```

---

## Требования к окружению (технические)

- VS Code с Extension Host на Node ≥ 22.5 (используется встроенный `node:sqlite`).
  Проверено на VS Code 1.144 (Node 24.22). На старых версиях расширение покажет
  понятную ошибку вместо падения.
- Node.js и npm — только для сборки/тестов.
- PHP для LSP **не требуется**: он поставляется статическим бинарником
  (`server/bin/php-<os>-<arch>`, ~8 МБ). Локальный PHP нужен только разработчику
  расширения (собрать phar, прогнать `php -l`).

---

## Быстрый старт для разработки (F5)

```bash
npm install
npm run compile
```

1. Откройте каталог расширения в VS Code.
2. F5 → запускается Extension Development Host (конфигурация `Run Extension`).
3. В новом окне откройте папку сайта (та, внутри которой лежит `bitrix/`).
4. Индекс построится автоматически; прогресс — в Output → «Bitrix Assistant».
5. Панель «Bitrix Assistant» в Activity Bar: дерево сервера и статистика индекса.

Для запуска LSP на системном PHP (удобно при отладке сервера):

- конфигурация `Run Extension (system php for LSP)`; или
- настройка `bitrix.lsp.phpBinary` = `/usr/bin/php` (Windows: `C:\\php\\php.exe`).

Отладка PHP-сервера — конфигурация `Attach to PHP LSP (Xdebug)` (порт 9003);
запускать сервер с `-dxdebug.mode=debug -dxdebug.start_with_request=yes`.

---

## SSH: детали реализации

- Профили привязаны к workspace: у каждого проекта свой список хостов в `workspaceState`.
  При первом открытии проекта старый глобальный список копируется в него; удаление хоста
  в одном проекте не затрагивает другие. Пароль и парольная фраза — в `SecretStorage`,
  отпечатки host key — глобально.
- Одно активное SSH-подключение (осознанно, без мультиподключений). Все операции — через
  `sftp` (`fastGet` / `fastPut`). Есть команда управления известными host key.
- Если сохранённый пароль не подошёл или его нет, подключение один раз спрашивает пароль
  и сохраняет его в `SecretStorage`. Дополнительно поддерживается `keyboard-interactive`
  (PAM-серверы без `PasswordAuthentication`).
- Загрузка атомарна: файл пишется во временное имя `*.bitrix-assistant-<pid>.tmp`,
  затем переименовывается поверх целевого; при ошибке temp удаляется.
- При обрыве связи менеджер один раз переподключается тем же профилем и повторяет
  sftp-операцию; после явного `disconnect` автопереподключения нет.
- Конфликт версий решается по содержимому: если серверный файл новее, но содержимое
  совпадает (сравнение размера и sha256), загрузка пропускается без вопроса — mtime
  локального файла стареет, даже когда содержимое не менялось. Если содержимое разное,
  одиночная загрузка спрашивает подтверждение, каталог — один общий вопрос на пакет
  («Перезаписать все» / «Пропустить новые»). `syncAll` такие файлы тоже пропускает.
- Перед перезаписью сохраняется предыдущая версия: на сервере — `<файл>.bak`,
  локально — `<файл>.bak`. Паттерны `**/*.bak` и `**/*.bitrix-assistant-*.tmp`
  добавлены в `bitrix.ssh.exclude` по умолчанию, чтобы бэкапы не синхронизировались.
- Маппинг путей: `remoteRoot` ↔ `localRoot` (по умолчанию — корень активной папки workspace).
- `syncAll` сравнивает `mtime` (секунды); при равенстве файл считается синхронным.
  Перед массовой перезаписью — один общий вопрос «Синхронизация перезапишет N файлов».
- `downloadOnOpen` не трогает документ с несохранёнными изменениями и не перезаписывает
  локально более новый файл.
- Клик по файлу в дереве сервера открывает **предпросмотр** (read-only), а не локальную
  рабочую копию. Явные действия «Скачать с сервера» / «Загрузить локальную версию»
  находятся в контекстном меню и подтверждают перезапись.
- Статус-бар слева показывает выбранный сервер (или «сервер не выбран»),
  во время индексации — спиннер; клик открывает смену сервера.
- Профили и выбранный PHP-рантайм привязаны к workspace; `bitrix.php.version`
  имеет scope `resource`.
- Горячие клавиши задаются в `bitrix.keybindings.*`; команда
  **Bitrix Assistant: применить горячие клавиши из настроек** обновляет `keybindings.json`,
  сохраняя комментарии и остальные биндинги. Пустое значение — платформенный
  дефолт (Ctrl+Alt+… / Cmd+Alt+… на macOS).
- Дерево сервера: иконки по типам файлов, человекочитаемый размер и дата изменения,
  Markdown-подсказки, `viewsWelcome` при отсутствии подключения.

---

## Индексация

### Что и куда пишется

Индекс — `bitrix-index.db` (SQLite, WAL) в **workspace storage** проекта
(`context.storageUri`), поэтому у каждого проекта своя база классов, методов,
JS-глобалов и `file_hashes`. В мульти-руте активная папка определяет проект
(папка активного редактора, иначе первая видимая), и для каждой папки создаётся
отдельная база `bitrix-index-<hash>.db`. Схема (`src/indexer/schema.ts`):

| Таблица | Содержимое |
| --- | --- |
| `classes` | FQCN, namespace, kind, module, file, line, extends, implements, ORM, deprecated, doc |
| `methods` | сигнатура, параметры (JSON), static/visibility/abstract, file, line |
| `modules` | модули ядра и `local` |
| `components` / `params` | компоненты и объявленные параметры из `.parameters.php` |
| `deprecated` | срез `classes.deprecated` |
| `file_hashes` | путь, sha1, size, mtime — для инкремента |
| `js_extensions` | `name, vendor, path, config_path, config_json, js_files_json, css_json, lang_json, rel_json, skip_core, source` |
| `js_globals` | `name, extension_name, type, source_file, line, signature, return_type, params_json, doc` (включая члены из `@memberOf`) |
| `js_types` | TS-формы `type`/`interface` и JSDoc `@typedef`: `name, keys_json, extends_json, source_file, line` |
| `js_dependencies` | `extension_id → depends_on_name` |

ER-связь JS-части: `js_extensions 1—N js_dependencies`, `js_extensions 1—N js_globals`
(по `extension_name`), `js_extensions.js_files_json` — список файлов расширения.

### Версия индексатора и авто-переиндексация
Кроме версии схемы БД (`SCHEMA_VERSION`) есть `PARSER_VERSION` в `src/indexer/schema.ts`.
Её нужно увеличивать, когда меняется **разбор или состав** индекса (новые каталоги,
`use`-импорты, `@method`, стабы и т.п.): сохранённые строки после такого обновления
устаревают. При старте индексатор сравнивает версию с записанной в `meta.parser_version`
и при несовпадении выполняет полную переиндексацию автоматически.

### Инкремент и автообновление

- Файл пропускается, если `size` и `mtime` совпали.
- Удалённые файлы вычищаются (по `file_hashes`), `deprecated` пересобирается.
- `bitrix.index.rebuild` строит новый индекс в `bitrix-index.db.rebuild` и
  атомарно заменяет файл; прежняя база сохраняется как `.bak` до успешной замены.
  Если замена прервалась, при следующем открытии `.bak` возвращается на место,
  а недособранный `.rebuild` удаляется.
- Индексатор — единственный писатель; PHP LSP открывает БД read-only
  (`PRAGMA query_only = 1`, `busy_timeout = 3000`).

Индекс обновляется автоматически:

- при сохранении файла в редакторе — переиндексируется только этот файл;
- при изменении/создании/удалении `.php`/`.js` под `bitrix/` и `local/`
  извне (git checkout, терминал, синхронизация) — `FileSystemWatcher`
  с задержкой 250 мс; удаление вычищает записи и `deprecated`;
- после `Bitrix Assistant: Скачать с сервера` (файл/каталог) и после `syncAll`,
  если были скачаны файлы, — выполняется инкрементальная сверка индекса;
- при активации расширения — инкрементальная сверка всех путей.

При повреждении файла индекса (`database disk image is malformed`) он удаляется и
создаётся заново автоматически — расширение покажет предупреждение и перестроит индекс
при следующем обновлении; руками чистить ничего не нужно.

Watcher создаётся при активации для каталогов `bitrix` и `local`. Если вы меняете
`bitrix.index.bitrixPath`, перезагрузите окно (`Developer: Reload Window`).

### Ограничения индекса

- Разбор PHP — сканер, а не полноценный парсер: сложные выражения и потоки
  значений не анализируются. Строки, комментарии, PHP-атрибуты `#[...]` и
  замыкания в значениях параметров маскируются/разбираются, поэтому ложных
  классов из текста нет.
- `.min.js` не сканируются; файлы больше `bitrix.index.jsMaxFileSizeKb` — тоже.

---

## LSP: запуск и выбор бинарника

Платформы: `win32-x64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`.
Бинарники лежат в `server/bin/php-<os>-<arch>` (Windows — `php-win32-x64.exe`),
скрипт сервера — `server/bin/bitrix-lsp.phar`. В `.vsix` едет **PHP 8.4**
(static-php-cli по `craft.yml`: `pdo_sqlite`, `sqlite3`, `mbstring`, `tokenizer`,
`ctype`, `phar`, `pcntl`, `posix`); бинарники собирает CI
(`.github/workflows/build-php.yml`) и они не хранятся в git. Локальные
`server/bin/php-*` (PHP 8.1 bulk-сборки, без `pdo_sqlite`) — только для разработки.
Системный PHP не требуется ни на одной из пяти платформ.

Версия PHP и пути к интерпретаторам хранятся в состоянии расширения
(`src/php/projectPhp.ts`, ключ `bitrix.php.projects` в `workspaceState`, по записи на папку
workspace); `bitrix.php.version` / `bitrix.php.paths` читаются только как значение по
умолчанию. Порядок поиска бинарника описан в `src/php/interpreter.ts`
(`candidateCommands`): `paths` → `lintBinary` → скачанный рантайм → встроенный 8.4 →
`php<версия>`/Homebrew. Встроенный рантайм подходит только для 8.4.

`src/lsp/platform.ts` (упрощённо):

```ts
const key = platformKey(process.platform, process.arch);       // 'darwin-arm64' и т.п.
const binary = path.join(extensionPath, 'server/bin', staticBinaryName(key));
const entry = exists(phar) ? phar : path.join(extensionPath, 'server/src/main.php');
const launch = exists(binary)
  ? { command: binary, args: [entry], source: 'static' }
  : { command: 'php', args: [entry], source: 'system' };
```

`src/lsp/lspClient.ts` передаёт серверу окружение:

| Переменная | Значение |
| --- | --- |
| `BITRIX_DB` | путь к `bitrix-index.db` |
| `BITRIX_ROOT` | корень сайта |
| `BITRIX_BITRIX_PATH` | каталог `bitrix` |
| `BITRIX_JS_LIB_CHECK` | `1` / `0` |
| `BITRIX_LSP_LOG` | `1` — логи в stderr |

Переменные `$name` подсказываются по тексту открытого документа: без сохранения
и без индекса, включая `untitled:` и публичные страницы в корне сайта.

`initializationOptions` дублируют эти значения (`dbPath`, `bitrixRoot`, `bitrixPath`,
`jsLibraryCheck`) — сервер берёт `dbPath` оттуда при старте.

`StdioTransport` игнорирует `timed_out` у stdio: PHP по умолчанию ставит 60-секундный
таймаут, из-за которого сервер сам завершался при простое и перезапускался.

Supervisor живёт в `src/lsp/lspClient.ts`: на окно ровно один сервер, `start`/`stop`/
`restart` сериализованы очередью, встроенный автоперезапуск `LanguageClient` отключён
(`ErrorHandler` с `DoNotRestart`), чтобы не поднимать второй процесс. При смене
активной папки сервер перезапускается с её `BITRIX_DB`/`BITRIX_ROOT`. Если процесс уже
остановлен, `workspace/didChangeConfiguration` не отправляется — иначе клиент пишет
в уничтоженный поток (`Cannot call write after a stream was destroyed`).

Переключение
`bitrix.js.enableLibraryCheck` приходит через `workspace/didChangeConfiguration`.

Сервер не пишет в stdout ничего, кроме JSON-RPC (логи — stderr); `display_errors`
принудительно направлен в stderr.

---

## JS-анализ: правила

### Индексация `config.php`

Поддерживаются обе формы:

```php
$arJsConfig = [
    'main.core' => [
        'js' => ['/bitrix/js/main/core/core.js'],
        'rel' => ['main.polyfill.core'],
        'skip_core' => true,
    ],
];
```

```php
return [
    'js' => [__DIR__ . '/script.js'],
    'rel' => ['popup'],
];
```

Во втором случае имя расширения выводится из пути: `.../js/<vendor>/<ext>/config.php`
→ `vendor.ext`. Значения `js`/`css`/`lang` резолвятся: `/bitrix/...` — от корня сайта,
`__DIR__ . '/x'` — от каталога конфига.

### Глобальные объекты

`src/indexer/js/jsScanner.ts` извлекает:
- `BX.namespace('BX.Main')` → `BX.Main` (namespace);
- `BX.Main.Popup = ...` → `BX.Main.Popup` (function/object/property);
- `BX.Main.Popup.prototype.show = function` → `BX.Main.Popup.show` (method);
- ключи объектного литерала `BX.Main.Core = { init() {} }` → `BX.Main.Core.init`;
- `window.X = ...` → `window.X`;
- `export function/class/const`, `export { a as b }` → `export`.

Привязка к расширению — по `js_files_json` из `config.php`.

### Completion

`BX.` → следующий сегмент из `js_globals`; `BX.Main.` → члены `main.*`.
Список не обрезается сотней: в реальном проекте у `BX.` сотни имён (`UI`, `ajax`, …).
Внутри `BX.UI.Button({ … })` предлагаются ключи объекта-параметра: из обращений
`options.key` в теле объявления и из TS-формы параметра (`type ButtonOptions = {…}`,
`interface`, `extends`, JSDoc `@typedef`/`@property`).
Локальные `const/let/var`, параметры, `catch` и импорты подсказываются по тексту
документа — без сохранения и индекса и с учётом текущей функции/метода/стрелки.
Для каждого элемента показывается расширение, `config.php` и `rel`.

### Автодополнение PHP-классов и `use`

Классы подсказывает нативный провайдер расширения (не LSP), поэтому он не зависит
от того, как VS Code определяет «слово» в PHP:

- `\CF` → `CFile`, `CForm`, `CForum`, … (глобальные/легаси-классы);
- `CFile` / `CF` → все классы, включая `Bitrix\...`;
- `Bitrix\Main\Lo…` → `Bitrix\Main\Loader` и т.п.;
- при выборе класса из другого namespace автоматически добавляется
  `use Vendor\Class;` — после последнего `use`, после `namespace` или после `<?php`;
- если короткое имя уже занято другим классом, вставляется `\Vendor\Class` без `use`;
- в namespace легаси-класс без namespace вставляется как `\CFile`.

Переменные `$name` подсказываются по scope: параметры и переменные текущей
функции/метода, `global`/`static`, superglobal; чужие функции не подмешиваются.
`$this` появляется только внутри класса. Работает без сохранения и индекса,
включая `untitled:` и публичные страницы.

### Глобальные функции и константы

Индексируются свободные функции и `const`/`define()` из `bitrix/modules/*/lib`,
`classes`, `tools.php`, `include.php`, `prolog.php`, `start.php`, компонентов и
`php_interface`. Для них работают completion, hover, Ctrl+Click и signature help.
`start.php` даёт, например, `B_PROLOG_INCLUDED`.

В шаблонах компонентов `$arResult` и `$arParams` (в том числе `$this->arResult`
в классе компонента) показывают пояснение с именем компонента.

### Свойства, константы, интерфейсы и traits

Индексируются не только методы: `properties` и `constants` классов, а также `use Trait;`
внутри класса. Поиск членов идёт по всей иерархии: `extends` + `implements` + traits,
поэтому методы/свойства из интерфейсов и трейтов доступны в hover, completion и
переходе по Ctrl+Click.

`bitrix.index.compact` (или пункт «Уплотнить базу» в панели «Индекс») запускает
`VACUUM` для SQLite; временные копии просмотра/сравнения очищаются при старте.

### ES-классы и `.d.ts`

Классы, объявленные как `class Foo {}`, `export class Foo`, `declare class Foo`,
индексируются вместе с методами (`Foo.method`): работает `this.method` внутри класса,
hover/переход по методу и completion после `this.`. `.d.ts`-файлы также сканируются.
Если у файла есть `@namespace {BX.UI}` и класс экспортируется (`export class`,
`export default class`), он дополнительно индексируется как `BX.UI.Button`
(с параметрами конструктора и методами). `@memberOf BX.X` перед классом работает
так же, в том числе когда классов в файле несколько — современные исходники
не уступают старому бандлу.

### `this.method` и DOM-методы

Для легаси-бандлов, где методы объявлены в `BX.X.prototype = {...}` или в
`BX.X = function(...) {...}`, индекс хранит участников объекта с сигнатурами.
Внутри конструктора `this.setSize(...)` резолвится в `BX.UI.Button.setSize`
(подъём по `this.` + текущий `BX.X`-контекст), а если имя метода уникально в файле —
находится и без контекста. Hover и signature help показывают параметры и возвращаемый
тип из JSDoc.

Для нетипизированных DOM-вызовов добавлен небольшой справочник частых методов
(`querySelector`, `querySelectorAll`, `getElementById`, `addEventListener`,
`setAttribute`, `closest`, `getBoundingClientRect` и др.) — он срабатывает как fallback,
когда встроенный TS-сервер не может определить тип получателя.

### Диагностика «библиотека не подключена» (опция)

По умолчанию **выключена**: в шаблонах Битрикса библиотека часто подключается
в другом файле/месте, и предупреждения были шумными. Включается настройкой
`bitrix.js.enableLibraryCheck: true`; тогда работают Warning `bitrix.js.library-not-loaded`
и Quick Fix (`CJSCore::Init` / `Extension::load` / `BX.loadExt`), а также проверка
отсутствующих `rel`-зависимостей.

1. Собирается контекст документа: собственное расширение файла (по индексу),
   явные подключения (`CJSCore::Init`, `Extension::load`, `BX.loadExt`, `BX.require`)
   и транзитивное замыкание по `rel`. `main.core` считается загруженным всегда.
2. Для каждого `BX.<...>` определяется расширение: сначала по самому длинному
   известному глобальному имени, затем эвристики (`BX.SomeLib` → `some.lib` / `some_lib` / `somelib`).
3. Если расширение известно, но не входит в контекст — Warning
   с кодом `bitrix.js.library-not-loaded` и данными для Quick Fix.

Quick Fix:
- PHP: `CJSCore::Init(['lib']);` или `\Bitrix\Main\UI\Extension::load('lib');`
  — после последнего `use`/`declare` (иначе после `<?php`), чтобы не сломать синтаксис;
- JS: `BX.loadExt('lib');` в начало файла.

Дополнительно: если у расширения файла есть `rel`-зависимость, которой нет в индексе,
сервер выдаёт Information `bitrix.js.missing-dependency` — обычно это опечатка
в `config.php` или неполный индекс.

### Сигнатуры и параметры (JSDoc)

Для присваиваний `BX.X = function(...)` / `BX.X = (...) =>` индексируются:

- имена параметров из самого выражения функции;
- типы, флаги `optional`, значения по умолчанию и вложенные свойства из JSDoc
  (`@param {string} action`, `@param {string} [config.method='POST']`);
- `@return` / `@returns`;
- описание из JSDoc.

Это даёт **hover с таблицей параметров** и **signature help** при вводе `(` / `,`.
Пример для реальной функции ядра:

```
BX.ajax.runAction('crm.item.get', {
    method: 'POST',
    data: {},
});
```

Hover показывает сигнатуру `runAction(action: string, config: Object)`, таблицу
`action`/`config`, отдельную таблицу свойств `config.*` (включая `config.method`
со значением по умолчанию `POST`), расширение `main.core` и файл определения.
Заголовки и разделы подсказок помечены цветными бейджами (🟡 JS, 🟣 PHP-метод,
🔵 класс, 🔹 параметры, 📄 определение), а дерево сервера использует цветные иконки
активной темы VS Code.

Сами сигнатуры рендерятся в блоке с языком (`php`/`ts`), поэтому VS Code подсвечивает
их грамматикой темы: namespace-класс, входные параметры (`$id`, `action`), типы
(`int`, `string`, `Object`) и возвращаемый тип (`?Item`, `Promise`) получают разные
цвета. Произвольные CSS-цвета для текста hover API VS Code не поддерживает —
используется подсветка кода и тематические иконки/бейджи.
Signature help показывает те же параметры и подсвечивает активный.

Ограничение: сигнатуры берутся из исходного кода и JSDoc; если бандл минифицирован
или параметры описаны только в `.d.ts`, подсказка может быть неполной.

### Hover / Definition

Hover: сигнатура, параметры и типы, описание, расширение, `rel`, `config.php`,
файл и строка определения.
Definition: переход в JS-файл, где объявлен объект, либо в `config.php` расширения.
Для `this.method` переход ведёт на строку метода в текущем файле (через индекс
`BX.X.method`); для нативных DOM-методов перехода нет — только сигнатура.

### Конструкторы и члены библиотек

Компилированные бандлы почти не содержат прямых присваиваний, поэтому кроме
`BX.namespace(...)` индексатор разбирает JSDoc:

- `@namespace {BX.Main.Popup}` → глобал `BX.Main.Popup`;
- `@memberOf BX.Main.Popup` + следующая декларация (`class Button`, `function create`)
  → `BX.Main.Popup.Button`, `BX.Main.Popup.create`.

В контексте `new BX.` подсказки помечаются как классы (`CompletionItemKind.Class`),
в `detail` — `new BX...`. Полные списки методов экземпляра из минифицированных
бандлов не извлекаются: это ограничение эвристического сканера, а не LSP.

---

## ORM-аннотации

`bitrix.orm.generateAnnotations` для активного `*Table.php`:
- читает `getMap()`, распознаёт `new XxxField('NAME')` и цепочки
  `configurePrimary()`, `configureAutocomplete()`, `setRequired(false)`;
- генерирует `@property int $ID`, `@property string $NAME` и т.п.;
- существующий doc-блок класса дополняется, пользовательские строки сохраняются;
- типы: `Integer → int`, `Boolean → bool`, `Float/Double/Decimal → float`,
  `Date/Datetime → \Bitrix\Main\Type\Date(Time)`, `Enum/String/Text → string`,
  `Json/Array → array`.

---

## Сборка статического PHP

Конфиг — `craft.yml` (расширения: `pdo_sqlite`, `sqlite3`, `mbstring`, `tokenizer`, `ctype`,
`phar`, `pcntl`, `posix`; `json` в PHP 8 встроен и в списке не нужен).

```bash
# 1. static-php-cli
curl -#fSL https://dl.static-php.dev/v3/spc-bin/nightly/spc-linux-x86_64 -o spc
chmod +x spc
./spc doctor --auto-fix

# 2. собрать бинарник (v3 читает craft.yml из текущего каталога)
./spc craft

# v2 static-php-cli: ./spc build --build-cli

# 3. phar + копирование бинарника под имя платформы
cp buildroot/bin/php server/bin/php-linux-x64
bash scripts/build-php.sh          # соберёт phar и, если есть spc, бинарник
# либо: SPC=./spc bash scripts/build-php.sh
```

Для остальных платформ сборка выполняется на соответствующей ОС. Готовый CI-матричный
workflow лежит в `.github/workflows/build-php.yml` (macOS x64/arm64, Linux x64/arm64,
Windows x64): он скачивает `spc`, выполняет `spc craft`, копирует бинарник под именем
`server/bin/php-<os>-<arch>` и загружает артефакт. Итог — пять файлов в `server/bin/`.

Пакетные бинарники собирает CI на PHP 8.4 и они лежат в артефактах
`static-php-*` (в git не попадают из-за `.gitignore`). Локальные
`server/bin/php-*` — прежние bulk-сборки PHP 8.1.31/8.1.34: в них есть `sqlite3`,
`mbstring`, `tokenizer`, `ctype`, `phar`, но `pdo_sqlite` может отсутствовать —
сервер автоматически использует `sqlite3`.

Проверка:

```bash
server/bin/php-linux-x64 -m | grep -E 'pdo_sqlite|sqlite3|mbstring|tokenizer|phar|pcntl'
server/bin/php-linux-x64 server/bin/bitrix-lsp.phar < /dev/null   # сразу завершится
```

Готовые bulk-сборки с [dl.static-php.dev](https://dl.static-php.dev/static-php-cli/bulk/)
могут не содержать `pdo_sqlite` (например, сборка macOS arm64 8.4.14 содержит только
`sqlite3`). Сервер это учитывает: `server/src/Index/Sqlite.php` читает индекс через
`pdo_sqlite`, если драйвер есть, иначе через расширение `sqlite3`. Поэтому подходят
и кастомные сборки по `craft.yml`, и bulk-бинарники. Для единообразия рекомендуется
собирать по `craft.yml` (~8 МБ вместо ~90 МБ bulk).

---

## Публикация в Marketplace

Публикация идёт по платформам: в `.vsix` попадает только бинарник своей платформы,
поэтому версия публикуется пять раз с одним и тем же номером.

- `.github/workflows/build-php.yml` — собирает статические бинарники PHP,
  выгружает их артефактами `static-php-<platform>`. В git они не хранятся
  (`.gitignore`: `server/bin/php-*`, `server/bin/*.phar`).
- `.github/workflows/publish.yml` — берёт бинарники из последнего успешного
  прогона `build-php.yml`, собирает phar, прогоняет тесты и публикует через
  Trusted Publishing (`vsce publish --oidc`), без PAT.

Если публиковать вручную, нужны уже собранные пакеты
(`scripts/package-platforms.sh`) и `vsce publish --packagePath <file>`.
Перед первой публикацией в Marketplace → publisher → Trusted Publishing
создаётся политика: repository owner/repository/workflow `publish.yml`/environment `marketplace`.

## Упаковка .vsix

```bash
npm run compile
npm run package
```

`npm run package` собирает **платформенные** VSIX (`scripts/package-platforms.sh`):
в каждый пакет попадает только его PHP-бинарник. Результат:
`/tmp/bitrix-assistant-<platform>.vsix` (28–33 МБ). Универсальный пакет со всеми
пятью бинарниками (`npm run package:universal`) весит ~124 МБ и нужен только для
локальной раздачи.

`.vscodeignore` исключает `src/**`, `test/**`, `scripts/**`, PHP-исходники `server/src/**`,
`craft.yml`, `*.ts`, `*.map`. В пакет попадают: `out/**`, один `server/bin/php-<platform>`,
`server/bin/bitrix-lsp.phar`, `media/`, `README.md`, `package.json`.

---

## Проверка

```bash
npm test              # tsc + unit: парсеры, IndexWriter, ORM, SSH (in-process SFTP)
npm run test:e2e      # реальный LSP-процесс (сначала compile)
npm run test:host     # Extension Host: активация, команды, мульти-рут, rebuild, hover/definition
# проверить конкретный рантайм/архив:
BITRIX_LSP_PHP=./server/bin/php-darwin-arm64 \
BITRIX_LSP_ENTRY=$PWD/server/bin/bitrix-lsp.phar \
node scripts/e2e-lsp.mjs
```

Unit-тесты SSH (`test/ssh.test.ts`) поднимают настоящий SFTP-сервер ssh2 в процессе
на временном каталоге и проверяют атомарную загрузку, `.bak` в обе стороны,
конфликт одиночного файла и каталога, переподключение после обрыва и отсутствие
автопереподключения после явного `disconnect`.

E2E поднимает временную SQLite-базу, PHP-сервер и проверяет:
диагностику неподключённой библиотеки, её отсутствие после `CJSCore::Init`,
completion `BX.Main.`, hover, definition, тексты вставок Quick Fix и диагностику
отсутствующей `rel`-зависимости.

`php -l` по всем файлам сервера:

```bash
find server/src -name '*.php' -print0 | xargs -0 -n1 php -l
```

---

### Проверено на реальном проекте

`~/work/bitrixkg` (Bitrix, 3.5 ГБ): 111 модулей, 84 518 PHP-файлов,
32 031 JS-файл, 8 435 `config.php`, 6 970 `.parameters.php`.
Полная индексация — около минуты, результат: 30 444 класса, 202 010 методов,
3 005 глобальных функций, 5 867 глобальных констант, 1 613 JS-расширений,
209 310 JS-глобалов, индекс ~270 МБ. Повторный запуск использует `file_hashes`
и не переразбирает файлы.

## Известные ограничения

- Одно SSH-подключение; нет пула соединений и докачки больших файлов.
- `downloadOnOpen`/`uploadOnSave` работают по одному файлу; каталоги — через `syncAll`.
- PHP-парсер и JS-сканер — эвристические (regex + маскирование). Для точного разбора
  PHP в будущем можно подключить `tokenizer` (уже включён в сборку).
- `jscore.php` разбирается как массив конфигов; при нестандартной форме файла
  зависимости ядра могут быть неполными (пишется debug-сообщение).
- `$arParams` диагностика включается только для файлов внутри каталога компонента,
  который найден в индексе, и только если `.parameters.php` дал хотя бы один параметр.
- `$arResult['KEY']` completion строится по литеральным присваиваниям
  (`$this->arResult['KEY']`, `$this->arResult = ['KEY' => ...]`) и по
  `@return array{…}` методов: `$this->arResult = $this->getData()`,
  `$this->arResult = $this->service->getData()`, цепочки свойств
  (`$this->a->b->get()`) и локальные переменные (`$data = $this->get(); $this->arResult = $data`).
- Глобальные PHP-функции/константы индексируются из `lib`, `classes`, `tools.php`,
  `include.php`, `prolog.php`, `start.php`, компонентов и `php_interface`; админка
  и произвольные include-файлы не сканируются.
- ES-классы и `.d.ts` индексируются. Для JS поддерживаются относительные
  `import`/`require`, алиасы, `compilerOptions.paths`/`baseUrl` из ближайшего
  `tsconfig.json`/`jsconfig.json` и декларации из `node_modules/@types`: hover,
  definition и completion импортированных классов/членов. Тип переменной берётся
  из `new Foo()`, JSDoc `@type {Foo}` и `@returns` функции-фабрики
  (`const x = createFoo()`).
- Семантические PHP-диагностики (`bitrix.php.semantic`, по умолчанию выключены):
  неизвестные функции/переменные, число аргументов, простые литеральные типы и
  объявленный тип возврата (включая union `array|false`, `void`, `never`):
  отсутствующий `return`, `return;` в не-void функции, несовпадение литерала.
  Список builtin-функций учитывает выбранную версию PHP. Это консервативные
  предупреждения; сложные типы и потоки значений не анализируются.
- JS: `import * as`, re-export-алиасы, `const x = new Foo()`, `new Foo().method()`
  и JSDoc `@type` для hover/definition/completion.
- Авто-импорт PHP — это Quick Fix по диагностике `bitrix.php.unresolved-class`;
  для функций и констант такого Quick Fix нет.
- Расширение не изменяет файлы само, кроме явных команд (`bitrix.orm.generateAnnotations`)
  и Quick Fix, применяемых пользователем.

## Публикация в Marketplace

Релиз идёт через `.github/workflows/publish.yml` и Trusted Publishing (OIDC, без PAT):
политика в Marketplace — owner `dpesherin`, repo `bitrix-assistant`, workflow `publish.yml`,
environment `marketplace`.

**Одна платформа за прогон.** Marketplace склеивает быстрые загрузки одной и той же версии
в один пакет: прогон с пятью платформами закрепляет только первую, остальные vsce показывает
как «Published», но в галерее их нет. Проверено дважды. Поэтому:

```bash
for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do
  gh workflow run publish.yml -f targets="$t" || \
  curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" \
    https://api.github.com/repos/dpesherin/bitrix-assistant/actions/workflows/publish.yml/dispatches \
    -d "{\"ref\":\"main\",\"inputs\":{\"targets\":\"$t\"}}"
  gh run watch   # дождаться завершения перед следующей платформой
done
```

Проверка, что пакет действительно лёг в галерею (по платформе):

```bash
curl -s -X POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json;api-version=7.2-preview.1' \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"pesherind.bitrix-assistant"},
      {"filterType":11,"value":"linux-x64"}]}],"flags":403}'
```

`filterType: 11` — фильтр по target platform; без него галерея отдаёт только один пакет версии.
