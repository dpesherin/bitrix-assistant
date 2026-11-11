import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../util/glob';
import { Database } from './db';
import { JsExtensionConfig, parseJsConfig } from './js/jsConfigParser';
import { scanJsGlobals, scanJsTypeShapes } from './js/jsScanner';
import { componentLocation, parseParametersPhp } from './php/componentParser';
import { parsePhpFile } from './php/phpParser';

/**
 * Запись индекса в SQLite. Никаких зависимостей от VS Code API — этот модуль
 * используется и расширением, и юнит-тестами (проверка схемы/запросов).
 */
export class IndexWriter {
	constructor(
		private readonly db: Database,
		private readonly onError: (message: string) => void = () => undefined,
	) {}

	static jsFileKey(file: string): string {
		const normalized = toPosix(path.normalize(file));
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	}

	indexModules(bitrixDir: string, localDir: string): void {
		const roots: { dir: string; kind: string }[] = [
			{ dir: path.join(bitrixDir, 'modules'), kind: 'core' },
			{ dir: path.join(localDir, 'modules'), kind: 'local' },
		];
		for (const root of roots) {
			for (const dir of listDirectories(root.dir)) {
				this.db.run(
					'INSERT OR REPLACE INTO modules (name, path, kind) VALUES (?, ?, ?)',
					path.basename(dir),
					dir,
					root.kind,
				);
			}
		}
	}

	/** Разбор `config.php` и запись расширения + `rel`-зависимостей. */
	writeConfigFile(file: string): void {
		let configs: JsExtensionConfig[] = [];
		try {
			configs = parseJsConfig(fs.readFileSync(file, 'utf8'), file);
		} catch (err) {
			this.onError(`config ${file}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.applyConfigs(file, configs);
	}

	applyConfigs(file: string, configs: JsExtensionConfig[]): void {
		const names = new Set(configs.map((config) => config.name));
		// Файлы затронутых расширений пересканируются: могла измениться привязка
		// глобалов к расширению и rel-зависимости.
		const toReindex = new Set<string>();
		this.db.transaction(() => {
			for (const row of this.db.all<{ id: number; name: string; js_files_json: string }>(
				'SELECT id, name, js_files_json FROM js_extensions WHERE config_path = ?',
				file,
			)) {
				this.collectJsFiles(row.js_files_json, toReindex);
				if (!names.has(row.name)) {
					this.db.run('DELETE FROM js_dependencies WHERE extension_id = ?', row.id);
					this.db.run('DELETE FROM js_globals WHERE extension_name = ?', row.name);
					this.db.run('DELETE FROM js_extensions WHERE id = ?', row.id);
				}
			}
			for (const config of configs) {
				for (const jsFile of config.js) {
					toReindex.add(jsFile);
				}
			}
			for (const jsFile of toReindex) {
				this.db.run('DELETE FROM file_hashes WHERE path = ?', jsFile);
			}
			for (const config of configs) {
				this.db.run(
					`INSERT INTO js_extensions (name, vendor, path, config_path, config_json, js_files_json, css_json, lang_json, rel_json, skip_core, source)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'config')
					 ON CONFLICT(name) DO UPDATE SET
						vendor = excluded.vendor,
						path = excluded.path,
						config_path = excluded.config_path,
						config_json = excluded.config_json,
						js_files_json = excluded.js_files_json,
						css_json = excluded.css_json,
						lang_json = excluded.lang_json,
						rel_json = excluded.rel_json,
						skip_core = excluded.skip_core,
						source = 'config'`,
					config.name,
					config.vendor,
					path.dirname(file),
					file,
					JSON.stringify({
						js: config.js,
						css: config.css,
						lang: config.lang,
						rel: config.rel,
						skip_core: config.skipCore,
					}),
					JSON.stringify(config.js),
					JSON.stringify(config.css),
					JSON.stringify(config.lang),
					JSON.stringify(config.rel),
					config.skipCore ? 1 : 0,
				);
				const id = this.db.get<{ id: number }>('SELECT id FROM js_extensions WHERE name = ?', config.name)?.id;
				if (id === undefined) {
					continue;
				}
				this.db.run('DELETE FROM js_dependencies WHERE extension_id = ?', id);
				for (const dep of config.rel) {
					this.db.run(
						'INSERT OR IGNORE INTO js_dependencies (extension_id, depends_on_name) VALUES (?, ?)',
						id,
						dep,
					);
				}
			}
		});
	}

	/** `jscore.php` — карта встроенных расширений ядра. */
	writeJscore(file: string): void {
		try {
			const configs = parseJsConfig(fs.readFileSync(file, 'utf8'), file);
			if (configs.length === 0) {
				this.onError('jscore.php: конфигурации не распознаны (не критично)');
			}
			this.applyConfigs(file, configs);
		} catch (err) {
			this.onError(`jscore ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	writeJsFile(file: string, extensionName?: string): void {
		let content: string;
		try {
			content = fs.readFileSync(file, 'utf8');
		} catch (err) {
			this.onError(`js ${file}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const globals = scanJsGlobals(content);
		const shapes = scanJsTypeShapes(content);
		this.db.transaction(() => {
			this.db.run('DELETE FROM js_globals WHERE source_file = ?', file);
			this.db.run('DELETE FROM js_types WHERE source_file = ?', file);
			for (const shape of shapes) {
				this.db.run(
					'INSERT INTO js_types (name, keys_json, extends_json, source_file, line) VALUES (?, ?, ?, ?, ?)',
					shape.name,
					JSON.stringify(shape.keys),
					JSON.stringify(shape.extends),
					file,
					shape.line,
				);
			}
			for (const global of globals) {
				this.db.run(
					`INSERT INTO js_globals
						(name, extension_name, type, source_file, line, signature, return_type, params_json, doc)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					global.name,
					extensionName ?? null,
					global.type,
					file,
					global.line,
					global.signature ?? null,
					global.returnType ?? null,
					global.params ? JSON.stringify(global.params) : null,
					global.doc ?? null,
				);
			}
		});
	}

	writePhpFile(file: string): void {
		let content: string;
		try {
			content = fs.readFileSync(file, 'utf8');
		} catch (err) {
			this.onError(`php ${file}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const parsed = parsePhpFile(content);
		const module = moduleFromPath(file);
		this.db.transaction(() => {
			this.db.run('DELETE FROM php_functions WHERE file = ?', file);
			this.db.run('DELETE FROM php_constants WHERE file = ?', file);
			for (const row of this.db.all<{ fqcn: string }>('SELECT fqcn FROM classes WHERE file = ?', file)) {
				this.db.run('DELETE FROM methods WHERE class_fqcn = ?', row.fqcn);
				this.db.run('DELETE FROM properties WHERE class_fqcn = ?', row.fqcn);
				this.db.run('DELETE FROM constants WHERE class_fqcn = ?', row.fqcn);
			}
			this.db.run('DELETE FROM classes WHERE file = ?', file);
			for (const fn of parsed.functions) {
				this.db.run(
					`INSERT INTO php_functions
						(name, namespace, fqcn, signature, return_type, params_json, doc, deprecated, file, line)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					fn.name,
					parsed.namespace || null,
					fn.fqcn,
					fn.signature,
					fn.returnType ?? null,
					JSON.stringify(fn.params),
					fn.doc ? fn.doc.slice(0, 4000) : null,
					fn.deprecated ? 1 : 0,
					file,
					fn.line,
				);
			}
			for (const constant of parsed.constants) {
				this.db.run(
					`INSERT INTO php_constants (name, value, doc, file, line)
					 VALUES (?, ?, ?, ?, ?)`,
					constant.name,
					constant.value ?? null,
					constant.doc ? constant.doc.slice(0, 4000) : null,
					file,
					constant.line,
				);
			}
			for (const cls of parsed.classes) {
				this.db.run(
					`INSERT OR REPLACE INTO classes
						(fqcn, name, namespace, kind, module, file, line, extends, implements, traits_json, is_abstract, is_final, is_orm, deprecated, doc)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					cls.fqcn,
					cls.name,
					cls.namespace,
					cls.kind,
					module ?? null,
					file,
					cls.line,
					cls.extends ?? null,
					JSON.stringify(cls.implements),
					JSON.stringify(cls.traits ?? []),
					cls.isAbstract ? 1 : 0,
					cls.isFinal ? 1 : 0,
					cls.isOrm ? 1 : 0,
					cls.deprecated ? 1 : 0,
					cls.doc ? cls.doc.slice(0, 4000) : null,
				);
				for (const property of cls.properties ?? []) {
					this.db.run(
						`INSERT INTO properties
							(class_fqcn, name, type, visibility, is_static, default_value, doc, file, line)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						cls.fqcn,
						property.name,
						property.type ?? null,
						property.visibility,
						property.isStatic ? 1 : 0,
						property.defaultValue ?? null,
						property.doc ? property.doc.slice(0, 4000) : null,
						file,
						property.line,
					);
				}
				for (const constant of cls.constants ?? []) {
					this.db.run(
						`INSERT INTO constants (class_fqcn, name, type, value, doc, file, line)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
						cls.fqcn,
						constant.name,
						constant.type ?? null,
						constant.value ?? null,
						constant.doc ? constant.doc.slice(0, 4000) : null,
						file,
						constant.line,
					);
				}
				for (const method of cls.methods) {
					this.db.run(
						`INSERT INTO methods
							(class_fqcn, name, signature, return_type, params_json, is_static, visibility, is_abstract, deprecated, doc, file, line)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						cls.fqcn,
						method.name,
						method.signature,
						method.returnType ?? null,
						JSON.stringify(method.params),
						method.isStatic ? 1 : 0,
						method.visibility,
						method.isAbstract ? 1 : 0,
						method.deprecated ? 1 : 0,
						method.doc ? method.doc.slice(0, 4000) : null,
						file,
						method.line,
					);
				}
			}
		});

		if (file.endsWith('.parameters.php')) {
			const location = componentLocation(file);
			if (location) {
				const params = parseParametersPhp(content);
				this.db.transaction(() => {
					this.db.run('DELETE FROM params WHERE component = ?', location.name);
					this.db.run('DELETE FROM components WHERE path = ?', location.path);
					this.db.run(
						'INSERT INTO components (name, namespace, module, path, parameters_file) VALUES (?, ?, ?, ?, ?)',
						location.name,
						location.namespace,
						location.module ?? module ?? null,
						location.path,
						file,
					);
					for (const param of params) {
						this.db.run(
							`INSERT OR REPLACE INTO params (component, name, code, type, default_value, is_required)
							 VALUES (?, ?, ?, ?, ?, ?)`,
							location.name,
							param.name,
							null,
							param.type ?? null,
							param.defaultValue ?? null,
							param.required ? 1 : 0,
						);
					}
				});
			}
		}
	}

	deleteFile(file: string): void {
		this.db.transaction(() => {
			this.db.run('DELETE FROM php_functions WHERE file = ?', file);
			this.db.run('DELETE FROM php_constants WHERE file = ?', file);
			for (const row of this.db.all<{ fqcn: string }>('SELECT fqcn FROM classes WHERE file = ?', file)) {
				this.db.run('DELETE FROM methods WHERE class_fqcn = ?', row.fqcn);
				this.db.run('DELETE FROM properties WHERE class_fqcn = ?', row.fqcn);
				this.db.run('DELETE FROM constants WHERE class_fqcn = ?', row.fqcn);
			}
			this.db.run('DELETE FROM classes WHERE file = ?', file);
			this.db.run('DELETE FROM js_globals WHERE source_file = ?', file);
			this.db.run('DELETE FROM js_types WHERE source_file = ?', file);
			this.db.run('DELETE FROM components WHERE parameters_file = ?', file);
			for (const row of this.db.all<{ id: number; name: string }>(
				'SELECT id, name FROM js_extensions WHERE config_path = ?',
				file,
			)) {
				this.db.run('DELETE FROM js_dependencies WHERE extension_id = ?', row.id);
				this.db.run('DELETE FROM js_globals WHERE extension_name = ?', row.name);
				this.db.run('DELETE FROM js_extensions WHERE id = ?', row.id);
			}
			this.db.run('DELETE FROM file_hashes WHERE path = ?', file);
		});
	}

	/** @param array<string, string> $target */
	private collectJsFiles(jsFilesJson: string, target: Set<string>): void {
		try {
			const files = JSON.parse(jsFilesJson) as unknown;
			if (!Array.isArray(files)) {
				return;
			}
			for (const file of files) {
				if (typeof file === 'string' && file !== '') {
					target.add(file);
				}
			}
		} catch {
			// повреждённая запись — пропускаем
		}
	}

	refreshDeprecated(): void {
		this.db.exec(`
			DELETE FROM deprecated;
			INSERT INTO deprecated (subject, replaced_by, since, note)
				SELECT DISTINCT fqcn, NULL, NULL, NULL FROM classes WHERE deprecated = 1;
		`);
	}

	/** Карта «js-файл → расширение» по уже записанным конфигам. */
	loadExtensionFileMap(): Map<string, string> {
		const map = new Map<string, string>();
		for (const row of this.db.all<{ name: string; js_files_json: string }>(
			'SELECT name, js_files_json FROM js_extensions',
		)) {
			try {
				const files = JSON.parse(row.js_files_json) as string[];
				for (const file of files) {
					map.set(IndexWriter.jsFileKey(file), row.name);
				}
			} catch {
				// повреждённая запись — пропускаем
			}
		}
		return map;
	}
}

function listDirectories(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

function moduleFromPath(file: string): string | undefined {
	const posix = toPosix(file);
	const m = /\/modules\/([^/]+)\//.exec(posix);
	return m ? m[1] : undefined;
}
