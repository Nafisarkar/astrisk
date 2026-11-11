import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRIPTS_FILE, collectScopeScripts, readScripts, writeScripts } from '../src/scopes';
import { createCollection, createFolder, readTree, writeRequest } from '../src/store';

let work: string;
let root: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'asterisk-scopes-'));
	root = join(work, '.asterisk');
});

const request = { method: 'GET' as const, url: 'https://api.test/x' };

describe('readScripts / writeScripts', () => {
	test('missing file is empty, not an error', () => {
		expect(readScripts(root)).toEqual({});
	});

	test('round-trips both phases', () => {
		writeScripts(root, { preRequest: 'vars.a = "1";', test: 'expect(1).to.equal(1);' });
		expect(readScripts(root)).toEqual({ preRequest: 'vars.a = "1";', test: 'expect(1).to.equal(1);' });
	});

	test('blank scripts are dropped', () => {
		writeScripts(root, { preRequest: '   ', test: '' });
		expect(readScripts(root)).toEqual({});
	});

	test('corrupt json is a readable error', () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, SCRIPTS_FILE), '{ nope');
		expect(() => readScripts(root)).toThrow(/invalid JSON/);
	});

	test('the scripts file never shows up as a request in the tree', () => {
		const collection = createCollection(root, 'C');
		writeRequest(join(collection, 'r.json'), request);
		writeScripts(collection, { test: 'expect(true).to.be.true;' });
		expect(readTree(root)[0].children.map((n) => `${n.kind}:${n.name}`)).toEqual(['request:r']);
	});
});

describe('collectScopeScripts', () => {
	test('orders collection -> folder -> request', () => {
		const collection = createCollection(root, 'C');
		const folder = createFolder(collection, 'F');
		writeScripts(collection, { preRequest: 'A', test: 'TA' });
		writeScripts(folder, { preRequest: 'B', test: 'TB' });
		const saved = { ...request, preRequest: 'C', test: 'TC' };
		const file = writeRequest(join(folder, 'r.json'), saved);
		const scripts = collectScopeScripts(root, file, saved);
		expect(scripts.preRequest).toBe('A\n;\nB\n;\nC');
		expect(scripts.test).toBe('TA\n;\nTB\n;\nTC');
	});

	test('request-level scripts are appended last', () => {
		const collection = createCollection(root, 'C');
		writeScripts(collection, { test: 'TA' });
		const file = writeRequest(join(collection, 'r.json'), { ...request, test: 'TR' });
		expect(collectScopeScripts(root, file, { ...request, test: 'TR' }).test).toBe('TA\n;\nTR');
	});

	test('a nested folder inherits its ancestors but not siblings', () => {
		const a = createCollection(root, 'A');
		const b = createCollection(root, 'B');
		const deep = createFolder(createFolder(a, 'one'), 'two');
		writeScripts(a, { preRequest: 'A' });
		writeScripts(b, { preRequest: 'B' });
		writeScripts(deep, { preRequest: 'DEEP' });
		const file = writeRequest(join(deep, 'r.json'), request);
		expect(collectScopeScripts(root, file).preRequest).toBe('A\n;\nDEEP');
	});

	test('no scripts anywhere means undefined, not empty strings', () => {
		const collection = createCollection(root, 'C');
		const file = writeRequest(join(collection, 'r.json'), request);
		expect(collectScopeScripts(root, file)).toEqual({ preRequest: undefined, test: undefined });
	});
});

describe('script origin', () => {
	test('collectScopeScripts names every file that contributed', () => {
		const root = mkdtempSync(join(tmpdir(), 'asterisk-scope-'));
		try {
			mkdirSync(join(root, 'stripe', 'customers'), { recursive: true });
			writeScripts(join(root, 'stripe'), { test: 'expect(1).to.equal(1);' });
			writeScripts(join(root, 'stripe', 'customers'), { preRequest: 'vars.a = "1";' });
			const file = join(root, 'stripe', 'customers', 'list.json');
			const merged = collectScopeScripts(root, file, { method: 'GET', url: 'https://x.test', test: 'expect(2).to.equal(2);' });
			expect(merged.origin!.test).toEqual([join(root, 'stripe', SCRIPTS_FILE), 'this request']);
			expect(merged.origin!.preRequest).toEqual([join(root, 'stripe', 'customers', SCRIPTS_FILE)]);
			expect(merged.test).toContain('expect(1)');
			expect(merged.test).toContain('expect(2)');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a request with no scripts and no scoped files reports no origin', () => {
		const root = mkdtempSync(join(tmpdir(), 'asterisk-scope-'));
		try {
			mkdirSync(join(root, 'plain'), { recursive: true });
			const merged = collectScopeScripts(root, join(root, 'plain', 'r.json'));
			expect(merged.origin).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
