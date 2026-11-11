import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ENV_FILE,
	activeVars,
	addEnv,
	envName,
	readEnvs,
	removeEnv,
	renameEnv,
	requestVars,
	setActive,
	setVar,
	systemVars,
	writeEnvs,
	type EnvDocument,
} from '../src/env';

let work: string;
let root: string;
let file: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'asterisk-env-'));
	root = join(work, '.asterisk');
	file = join(root, ENV_FILE);
});

const doc = (): EnvDocument => ({
	active: 'dev',
	environments: {
		dev: { name: 'dev', vars: { base: 'http://localhost:3000', token: 'dev-token' } },
		prod: { name: 'prod', vars: { base: 'https://api.example.com' } },
	},
});

const snapshot = (d: EnvDocument) => JSON.parse(JSON.stringify(d));

describe('readEnvs', () => {
	test('missing file is an empty document, not an error', () => {
		expect(readEnvs(root)).toEqual({ environments: {} });
	});

	test('read after write round-trips deeply', () => {
		const d = doc();
		writeEnvs(root, d);
		expect(readEnvs(root)).toEqual(d);
	});

	test('unicode keys and values survive the round-trip', () => {
		const d: EnvDocument = {
			active: 'stäging-日本',
			environments: {
				'stäging-日本': { name: 'stäging-日本', vars: { 'ключ': 'значение 🚀', emoji: '✅ ok' } },
			},
		};
		writeEnvs(root, d);
		expect(readEnvs(root)).toEqual(d);
	});

	test('corrupt JSON throws with the file name and "invalid JSON"', () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(file, '{ not json');
		expect(() => readEnvs(root)).toThrow(ENV_FILE);
		expect(() => readEnvs(root)).toThrow(/invalid JSON/);
	});

	test('wrong shape throws a readable error', () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(file, '[]');
		expect(() => readEnvs(root)).toThrow(/expected a JSON object/);

		writeFileSync(file, JSON.stringify({ environments: 'nope' }));
		expect(() => readEnvs(root)).toThrow(/"environments" must be an object/);

		writeFileSync(file, JSON.stringify({ environments: [] }));
		expect(() => readEnvs(root)).toThrow(/"environments" must be an object/);
	});

	test('junk inside is dropped, not thrown', () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				environments: {
					good: { name: 'good', vars: { keep: 'yes', drop: 42, alsoDrop: null, nested: { a: 1 } } },
					bad: 'not an object',
					alsoBad: [1, 2],
					noVars: { name: 'noVars' },
				},
			}),
		);
		expect(readEnvs(root)).toEqual({
			environments: {
				good: { name: 'good', vars: { keep: 'yes' } },
				noVars: { name: 'noVars', vars: {} },
			},
		});
	});

	test('a non-string name falls back to the key', () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(file, JSON.stringify({ environments: { dev: { vars: {} } } }));
		expect(readEnvs(root).environments.dev).toEqual({ name: 'dev', vars: {} });
	});
});

describe('writeEnvs', () => {
	test('creates the root directory', () => {
		expect(existsSync(root)).toBe(false);
		writeEnvs(root, { environments: {} });
		expect(existsSync(root)).toBe(true);
	});

	test('writes pretty JSON with a trailing newline', () => {
		writeEnvs(root, doc());
		const text = readFileSync(file, 'utf8');
		expect(text.endsWith('}\n')).toBe(true);
		expect(text).toContain('\n  "active": "dev",\n');
		expect(text).not.toBe(JSON.stringify(doc()));
	});

	test('does not mutate the document it writes', () => {
		const d = doc();
		const before = snapshot(d);
		writeEnvs(root, d);
		expect(d).toEqual(before);
	});
});

describe('activeVars', () => {
	test('no active environment', () => {
		expect(activeVars({ environments: doc().environments })).toEqual({});
	});

	test('active points nowhere', () => {
		expect(activeVars({ active: 'ghost', environments: doc().environments })).toEqual({});
	});

	test('active environment vars are returned', () => {
		expect(activeVars(doc())).toEqual({ base: 'http://localhost:3000', token: 'dev-token' });
	});

	test('an environment with no vars is an empty map', () => {
		const d = setVar(doc(), 'empty', 'x', '');
		expect(activeVars(setActive(d, 'empty'))).toEqual({});
	});

	test('the result is a copy, not the stored map', () => {
		const d = doc();
		const vars = activeVars(d);
		vars.base = 'mutated';
		expect(d.environments.dev.vars.base).toBe('http://localhost:3000');
	});
});

describe('addEnv', () => {
	test('adds a new environment with empty vars', () => {
		const d = doc();
		const next = addEnv(d, 'staging');
		expect(next.environments.staging).toEqual({ name: 'staging', vars: {} });
		expect(next.active).toBe('dev');
	});

	test('adding an existing environment keeps its variables (no silent data loss)', () => {
		const d = doc();
		const before = d.environments.dev.vars;
		const next = addEnv(d, 'dev');
		expect(next.environments.dev.vars).toEqual(before);
		expect(next.environments.dev.vars.base).toBe('http://localhost:3000');
	});

	test('adding a new environment starts empty', () => {
		expect(addEnv(doc(), 'fresh').environments.fresh).toEqual({ name: 'fresh', vars: {} });
	});

	test('does not mutate the input document', () => {
		const d = doc();
		const before = snapshot(d);
		addEnv(d, 'staging');
		expect(d).toEqual(before);
	});

	test('an empty name becomes "untitled" instead of throwing', () => {
		expect(addEnv({ environments: {} }, '  ').environments.untitled).toEqual({ name: 'untitled', vars: {} });
	});
});

describe('removeEnv', () => {
	test('removes an inactive environment and keeps active', () => {
		const next = removeEnv(doc(), 'prod');
		expect(Object.keys(next.environments)).toEqual(['dev']);
		expect(next.active).toBe('dev');
	});

	test('removing the active environment clears active', () => {
		const next = removeEnv(doc(), 'dev');
		expect(Object.keys(next.environments)).toEqual(['prod']);
		expect(next.active).toBeUndefined();
	});

	test('removing an unknown name is a no-op', () => {
		const d = doc();
		expect(removeEnv(d, 'ghost')).toEqual(d);
	});

	test('does not mutate the input document', () => {
		const d = doc();
		const before = snapshot(d);
		removeEnv(d, 'dev');
		expect(d).toEqual(before);
	});
});

describe('renameEnv', () => {
	test('preserves vars and moves active along', () => {
		const next = renameEnv(doc(), 'dev', 'local');
		expect(next.environments.local).toEqual({ name: 'local', vars: { base: 'http://localhost:3000', token: 'dev-token' } });
		expect(next.environments.dev).toBeUndefined();
		expect(next.active).toBe('local');
	});

	test('missing source is a no-op', () => {
		const d = doc();
		expect(renameEnv(d, 'ghost', 'other')).toEqual(d);
	});

	test('colliding target is a no-op', () => {
		const d = doc();
		expect(renameEnv(d, 'dev', 'prod')).toEqual(d);
	});

	test('renaming to itself is a no-op', () => {
		const d = doc();
		expect(renameEnv(d, 'dev', 'dev')).toEqual(d);
	});

	test('does not mutate the input document', () => {
		const d = doc();
		const before = snapshot(d);
		renameEnv(d, 'dev', 'local');
		expect(d).toEqual(before);
	});
});

describe('setVar', () => {
	test('creates the environment when absent', () => {
		const next = setVar(doc(), 'staging', 'token', 'abc');
		expect(next.environments.staging).toEqual({ name: 'staging', vars: { token: 'abc' } });
	});

	test('adds a new key', () => {
		const next = setVar(doc(), 'dev', 'extra', 'value');
		expect(next.environments.dev.vars.extra).toBe('value');
		expect(next.environments.dev.vars.token).toBe('dev-token');
	});

	test('replaces an existing key', () => {
		const next = setVar(doc(), 'dev', 'token', 'new-token');
		expect(next.environments.dev.vars.token).toBe('new-token');
	});

	test('an empty value deletes the key', () => {
		const next = setVar(doc(), 'dev', 'token', '');
		expect(next.environments.dev.vars).toEqual({ base: 'http://localhost:3000' });
	});

	test('deleting from a missing environment creates it empty', () => {
		const next = setVar(doc(), 'staging', 'ghost', '');
		expect(next.environments.staging).toEqual({ name: 'staging', vars: {} });
	});

	test('does not mutate the input document', () => {
		const d = doc();
		const before = snapshot(d);
		setVar(d, 'dev', 'token', 'x');
		setVar(d, 'dev', 'base', '');
		expect(d).toEqual(before);
	});
});

describe('setActive', () => {
	test('switches to a known environment', () => {
		expect(setActive(doc(), 'prod').active).toBe('prod');
	});

	test('unknown name clears active', () => {
		expect(setActive(doc(), 'ghost').active).toBeUndefined();
	});

	test('undefined clears active', () => {
		expect(setActive(doc(), undefined).active).toBeUndefined();
	});

	test('does not mutate the input document', () => {
		const d = doc();
		const before = snapshot(d);
		setActive(d, 'prod');
		expect(d).toEqual(before);
	});
});

describe('systemVars', () => {
	test('$uuid is a v4 uuid', () => {
		const { $uuid } = systemVars(0, () => 0);
		expect($uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	test('$timestamp is the injected clock in epoch seconds', () => {
		expect(systemVars(1_700_000_000_000, () => 0).$timestamp).toBe('1700000000');
		expect(systemVars(1_700_000_000_999, () => 0).$timestamp).toBe('1700000000');
	});

	test('$randomInt is "0" at the low extreme', () => {
		expect(systemVars(0, () => 0).$randomInt).toBe('0');
	});

	test('$randomInt is "1000" at the high extreme', () => {
		expect(systemVars(0, () => 0.9999).$randomInt).toBe('1000');
	});

	test('$randomInt stays within 0..1000 for arbitrary input', () => {
		for (const r of [0, 0.5, 0.9999999, 1]) {
			const n = Number(systemVars(0, () => r).$randomInt);
			expect(Number.isInteger(n)).toBe(true);
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThanOrEqual(1000);
		}
	});

	test('every system var is a string', () => {
		for (const v of Object.values(systemVars(123_456, () => 0.5))) {
			expect(typeof v).toBe('string');
		}
	});
});

describe('requestVars', () => {
	test('layers system, then env, then extra', () => {
		const d: EnvDocument = { active: 'dev', environments: { dev: { name: 'dev', vars: { $timestamp: 'env-wins', token: 'env-token', $uuid: 'env-uuid' } } } };
		const vars = requestVars(d, { $uuid: 'extra-uuid' });
		expect(vars.$uuid).toBe('extra-uuid');
		expect(vars.$timestamp).toBe('env-wins');
		expect(vars.token).toBe('env-token');
		expect(vars.$randomInt).toBeDefined();
	});

	test('system vars are present with no environment and no extra', () => {
		const vars = requestVars({ environments: {} });
		expect(vars.$uuid).toBeDefined();
		expect(vars.$timestamp).toBeDefined();
		expect(vars.$randomInt).toBeDefined();
	});

	test('extra still wins when there is no active environment', () => {
		const vars = requestVars({ environments: {} }, { only: 'extra' });
		expect(vars.only).toBe('extra');
		expect(vars.$uuid).toBeDefined();
	});

	test('unicode variable names survive as literal keys', () => {
		const vars = requestVars({ active: 'e', environments: { e: { name: 'e', vars: { 'héader-日本': 'ok' } } } });
		expect(vars['héader-日本']).toBe('ok');
	});
});

describe('persistence of mutations', () => {
	test('a mutated document survives the disk round-trip', () => {
		let d = addEnv({ environments: {} }, 'local');
		d = setVar(d, 'local', 'token', 'капture 🔑');
		d = setActive(d, 'local');
		writeEnvs(root, d);
		expect(readEnvs(root)).toEqual(d);
		expect(activeVars(readEnvs(root))).toEqual({ token: 'капture 🔑' });
	});
});

describe('regressions found in audit', () => {
	test('envName is exported so callers can normalize names before setActive', () => {
		expect(envName('dev ')).toBe('dev');
		expect(envName('my/api')).toBe('my-api');
	});

	test('a dangling active environment is dropped on read', () => {
		const dir = mkdtempSync(join(tmpdir(), 'asterisk-env-audit-'));
		writeFileSync(join(dir, ENV_FILE), JSON.stringify({ active: 'gone', environments: { dev: { name: 'dev', vars: {} } } }));
		expect(readEnvs(dir).active).toBeUndefined();
	});

	test('removing by an unsanitized name still removes the sanitized key', () => {
		const d = setVar({ environments: {} }, 'my api', 'a', '1');
		expect(Object.keys(removeEnv(d, 'my api ').environments)).toEqual([]);
	});
});

describe('prototype-safe env handling (bug hunt)', () => {
	test('an env literally named __proto__ is ignored on read instead of vanishing silently', () => {
		const dir = mkdtempSync(join(tmpdir(), 'asterisk-env-proto-'));
		writeFileSync(
			join(dir, ENV_FILE),
			'{"active":"__proto__","environments":{"__proto__":{"name":"__proto__","vars":{"a":"1"}},"dev":{"name":"dev","vars":{}}}}'
		);
		const doc = readEnvs(dir);
		expect(Object.keys(doc.environments)).toEqual(['dev']);
		expect(doc.active).toBeUndefined();
	});

	test('envName reserves prototype keys', () => {
		expect(envName('__proto__')).toBe('__proto___');
		expect(envName('constructor')).toBe('constructor_');
		expect(envName('prototype')).toBe('prototype_');
		expect(envName('prod')).toBe('prod');
	});

	test('setActive refuses an inherited name', () => {
		expect(setActive({ environments: {} }, 'toString').active).toBeUndefined();
	});

	test('setVar on an inherited name creates a real env', () => {
		const doc = setVar({ environments: {} }, 'constructor', 'a', '1');
		expect(Object.keys(doc.environments)).toEqual(['constructor_']);
		expect(doc.environments['constructor_'].vars).toEqual({ a: '1' });
	});
});
