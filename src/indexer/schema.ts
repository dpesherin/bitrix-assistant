/**
 * Схема локального индекса (SQLite).
 *
 * Один писатель — расширение (индексатор). PHP LSP открывает базу только на чтение
 * (`PRAGMA query_only = ON`), поэтому WAL достаточно для конкурентного доступа.
 */
export const SCHEMA_VERSION = 16;

/**
 * Версия разбора/наполнения индекса. Отличается от схемы БД: схема может не
 * меняться, а сохранённые данные устаревать (например научились разбирать
 * групповые `use` или `@method`). При несовпадении сохранённой версии с этой
 * выполняется полная переиндексация.
 */
export const PARSER_VERSION = 1;

/** Индекс — кеш: при несовпадении версии проще пересоздать таблицы. */
export const DROP_SQL = `
DROP TABLE IF EXISTS php_functions;
DROP TABLE IF EXISTS php_constants;
DROP TABLE IF EXISTS properties;
DROP TABLE IF EXISTS constants;
DROP TABLE IF EXISTS methods;
DROP TABLE IF EXISTS classes;
DROP TABLE IF EXISTS components;
DROP TABLE IF EXISTS params;
DROP TABLE IF EXISTS deprecated;
DROP TABLE IF EXISTS file_hashes;
DROP TABLE IF EXISTS modules;
DROP TABLE IF EXISTS js_types;
DROP TABLE IF EXISTS js_globals;
DROP TABLE IF EXISTS js_dependencies;
DROP TABLE IF EXISTS js_extensions;
DROP TABLE IF EXISTS meta;
`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT
);

CREATE TABLE IF NOT EXISTS modules (
	id   INTEGER PRIMARY KEY,
	name TEXT UNIQUE NOT NULL,
	path TEXT NOT NULL,
	kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
	id          INTEGER PRIMARY KEY,
	fqcn        TEXT NOT NULL,
	name        TEXT NOT NULL,
	namespace   TEXT,
	kind        TEXT NOT NULL,
	module      TEXT,
	file        TEXT NOT NULL,
	line        INTEGER NOT NULL,
	extends     TEXT,
	implements  TEXT,
	is_abstract INTEGER NOT NULL DEFAULT 0,
	is_final    INTEGER NOT NULL DEFAULT 0,
	is_orm      INTEGER NOT NULL DEFAULT 0,
	deprecated  INTEGER NOT NULL DEFAULT 0,
	traits_json TEXT NOT NULL DEFAULT '[]',
	doc         TEXT,
	UNIQUE (file, fqcn)
);
CREATE INDEX IF NOT EXISTS idx_classes_fqcn ON classes (fqcn);
CREATE INDEX IF NOT EXISTS idx_classes_name ON classes (name);
CREATE INDEX IF NOT EXISTS idx_classes_file ON classes (file);

CREATE TABLE IF NOT EXISTS methods (
	id          INTEGER PRIMARY KEY,
	class_fqcn  TEXT NOT NULL,
	name        TEXT NOT NULL,
	signature   TEXT,
	return_type TEXT,
	params_json TEXT,
	is_static   INTEGER NOT NULL DEFAULT 0,
	visibility  TEXT NOT NULL DEFAULT 'public',
	is_abstract INTEGER NOT NULL DEFAULT 0,
	deprecated  INTEGER NOT NULL DEFAULT 0,
	doc         TEXT,
	file        TEXT NOT NULL,
	line        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_methods_class ON methods (class_fqcn);
CREATE INDEX IF NOT EXISTS idx_methods_name ON methods (name);
CREATE INDEX IF NOT EXISTS idx_methods_file ON methods (file);

CREATE TABLE IF NOT EXISTS properties (
	id            INTEGER PRIMARY KEY,
	class_fqcn    TEXT NOT NULL,
	name          TEXT NOT NULL,
	type          TEXT,
	visibility    TEXT NOT NULL DEFAULT 'public',
	is_static     INTEGER NOT NULL DEFAULT 0,
	default_value TEXT,
	doc           TEXT,
	file          TEXT NOT NULL,
	line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_properties_class ON properties (class_fqcn);
CREATE INDEX IF NOT EXISTS idx_properties_name ON properties (name);

CREATE TABLE IF NOT EXISTS constants (
	id          INTEGER PRIMARY KEY,
	class_fqcn  TEXT NOT NULL,
	name        TEXT NOT NULL,
	type        TEXT,
	value       TEXT,
	doc         TEXT,
	file        TEXT NOT NULL,
	line        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_constants_class ON constants (class_fqcn);
CREATE INDEX IF NOT EXISTS idx_constants_name ON constants (name);

CREATE TABLE IF NOT EXISTS php_functions (
	id          INTEGER PRIMARY KEY,
	name        TEXT NOT NULL,
	namespace   TEXT,
	fqcn        TEXT NOT NULL,
	signature   TEXT,
	return_type TEXT,
	params_json TEXT,
	doc         TEXT,
	deprecated  INTEGER NOT NULL DEFAULT 0,
	file        TEXT NOT NULL,
	line        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_php_functions_name ON php_functions (name);
CREATE INDEX IF NOT EXISTS idx_php_functions_fqcn ON php_functions (fqcn);
CREATE INDEX IF NOT EXISTS idx_php_functions_file ON php_functions (file);

CREATE TABLE IF NOT EXISTS php_constants (
	id    INTEGER PRIMARY KEY,
	name  TEXT NOT NULL,
	value TEXT,
	doc   TEXT,
	file  TEXT NOT NULL,
	line  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_php_constants_name ON php_constants (name);
CREATE INDEX IF NOT EXISTS idx_php_constants_file ON php_constants (file);

CREATE TABLE IF NOT EXISTS components (
	id          INTEGER PRIMARY KEY,
	name        TEXT NOT NULL,
	namespace   TEXT,
	module      TEXT,
	path        TEXT NOT NULL,
	parameters_file TEXT,
	UNIQUE (name, path)
);

CREATE TABLE IF NOT EXISTS params (
	component    TEXT NOT NULL,
	name         TEXT NOT NULL,
	code         TEXT,
	type         TEXT,
	default_value TEXT,
	is_required  INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (component, name)
);

CREATE TABLE IF NOT EXISTS deprecated (
	subject      TEXT NOT NULL,
	replaced_by  TEXT,
	since        TEXT,
	note         TEXT,
	PRIMARY KEY (subject)
);

CREATE TABLE IF NOT EXISTS file_hashes (
	path TEXT PRIMARY KEY,
	hash TEXT NOT NULL,
	size INTEGER NOT NULL,
	mtime INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS js_extensions (
	id            INTEGER PRIMARY KEY,
	name          TEXT UNIQUE NOT NULL,
	vendor        TEXT,
	path          TEXT,
	config_path   TEXT,
	config_json   TEXT,
	js_files_json TEXT NOT NULL DEFAULT '[]',
	css_json      TEXT NOT NULL DEFAULT '[]',
	lang_json     TEXT NOT NULL DEFAULT '[]',
	rel_json      TEXT NOT NULL DEFAULT '[]',
	skip_core     INTEGER NOT NULL DEFAULT 0,
	source        TEXT NOT NULL DEFAULT 'config'
);

CREATE TABLE IF NOT EXISTS js_globals (
	id             INTEGER PRIMARY KEY,
	name           TEXT NOT NULL,
	extension_name TEXT,
	type           TEXT NOT NULL,
	source_file    TEXT NOT NULL,
	line           INTEGER NOT NULL,
	signature      TEXT,
	return_type    TEXT,
	params_json    TEXT,
	doc            TEXT
);
CREATE INDEX IF NOT EXISTS idx_js_globals_name ON js_globals (name);
CREATE INDEX IF NOT EXISTS idx_js_globals_ext ON js_globals (extension_name);
CREATE INDEX IF NOT EXISTS idx_js_globals_file ON js_globals (source_file);

CREATE TABLE IF NOT EXISTS js_types (
	name        TEXT NOT NULL,
	keys_json   TEXT NOT NULL,
	extends_json TEXT NOT NULL,
	source_file TEXT NOT NULL,
	line        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_js_types_name ON js_types(name);
CREATE INDEX IF NOT EXISTS idx_js_types_file ON js_types(source_file);

CREATE TABLE IF NOT EXISTS js_dependencies (
	extension_id     INTEGER NOT NULL,
	depends_on_name  TEXT NOT NULL,
	PRIMARY KEY (extension_id, depends_on_name)
);
CREATE INDEX IF NOT EXISTS idx_js_deps_name ON js_dependencies (depends_on_name);
`;
