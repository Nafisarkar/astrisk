import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
	REQUEST_EXT,
	ROOT_DIR,
	createCollection,
	createFolder,
	deleteNode,
	moveNode,
	readRequest,
	readTree,
	renameNode,
	sanitizeName,
	suggestName,
	uniqueName,
	writeRequest,
	type SavedRequest,
	type TreeNode,
} from '../src/store';

let work: string;
let root: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'asterisk-store-'));
	root = join(work, ROOT_DIR);
});

const request: SavedRequest = {
	method: 'POST',
	url: 'https://api.example.com/users/{{id}}',
	headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{token}}' },
	body: { type: 'raw', format: 'json', content: '{"name":"Ada"}' },
};

const names = (nodes: TreeNode[]) => nodes.map((n) => `${n.kind}:${n.name}`);

describe('sanitizeName', () => {
	test.each([
		['My API', 'My API'],
		['users/v1', 'users-v1'],
		['a\\b:c*d?e"f<g>h|i', 'a-b-c-d-e-f-g-h-i'],
		['  padded  ', 'padded'],
		['../escape', 'escape'],
		['...', 'untitled'],
		['', 'untitled'],
		['   ', 'untitled'],
		['multi    space', 'multi space'],
		['trailing.', 'trailing'],
		['-leading', 'leading'],
	])('%p -> %p', (input, expected) => {
		expect(sanitizeName(input)).toBe(expected);
	});

	test('caps very long names', () => {
		expect(sanitizeName('x'.repeat(200)).length).toBe(80);
	});

	test('never returns a path separator or traversal segment', () => {
		for (const evil of ['..', '../..', 'a/../../b', 'C:\\Windows', 'nul\u0000byte']) {
			const out = sanitizeName(evil);
			expect(out).not.toContain('/');
			expect(out).not.toContain('\\');
			expect(out.startsWith('.')).toBe(false);
			expect(join(work, out).startsWith(work)).toBe(true);
		}
	});
});

describe('suggestName', () => {
	test('method + last meaningful path segment', () => {
		expect(suggestName({ method: 'GET', url: 'https://api.example.com/users' })).toBe('get-users');
		expect(suggestName({ method: 'DELETE', url: 'https://api.example.com/users/42?x=1#y' })).toBe('delete-42');
	});

	test('skips {{var}} segments', () => {
		expect(suggestName({ method: 'POST', url: 'https://{{host}}/v1/orders' })).toBe('post-orders');
	});

	test('falls back to the method alone', () => {
		expect(suggestName({ method: 'GET', url: 'https://api.example.com/' })).toBe('get');
		expect(suggestName({ method: 'POST', url: '{{base}}' })).toBe('post');
	});
});

describe('uniqueName', () => {
	test('appends a counter instead of clobbering', () => {
		mkdirSync(root, { recursive: true });
		expect(uniqueName(root, 'Users')).toBe('Users');
		mkdirSync(join(root, 'Users'));
		expect(uniqueName(root, 'Users')).toBe('Users 2');
		mkdirSync(join(root, 'Users 2'));
		expect(uniqueName(root, 'Users')).toBe('Users 3');
	});

	test('keeps the extension when uniquifying files', () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, 'req.json'), '{}');
		expect(uniqueName(root, 'req', REQUEST_EXT)).toBe('req 2.json');
	});
});

describe('collections on disk', () => {
	test('missing root reads as no collections', () => {
		expect(readTree(root)).toEqual([]);
	});

	test('createCollection creates a directory and the tree sees it', () => {
		const path = createCollection(root, 'My API');
		expect(existsSync(path)).toBe(true);
		expect(basename(path)).toBe('My API');
		expect(names(readTree(root))).toEqual(['collection:My API']);
	});

	test('duplicate collection names get a counter', () => {
		createCollection(root, 'My API');
		const second = createCollection(root, 'My API');
		expect(basename(second)).toBe('My API 2');
	});

	test('folders nest and appear as folders, not collections', () => {
		const collection = createCollection(root, 'My API');
		const folder = createFolder(collection, 'Users');
		createFolder(folder, 'Admin');
		const tree = readTree(root);
		expect(names(tree)).toEqual(['collection:My API']);
		expect(names(tree[0].children)).toEqual(['folder:Users']);
		expect(names(tree[0].children[0].children)).toEqual(['folder:Admin']);
	});

	test('folders sort before requests, each alphabetically', () => {
		const collection = createCollection(root, 'C');
		createFolder(collection, 'zeta');
		createFolder(collection, 'alpha');
		writeRequest(join(collection, 'b.json'), request);
		writeRequest(join(collection, 'a.json'), request);
		expect(names(readTree(root)[0].children)).toEqual(['folder:alpha', 'folder:zeta', 'request:a', 'request:b']);
	});

	test('hidden entries and non-json files are ignored', () => {
		const collection = createCollection(root, 'C');
		writeFileSync(join(collection, 'notes.md'), '# not a request');
		mkdirSync(join(collection, '.git'));
		writeFileSync(join(collection, 'broken.json.bak'), '{}');
		expect(names(readTree(root)[0].children)).toEqual([]);
	});
});

describe('request files', () => {
	test('create -> save -> reload -> identical payload', () => {
		const collection = createCollection(root, 'My API');
		const file = writeRequest(join(collection, 'create-user.json'), request);

		const reloaded = readRequest(file);
		expect(reloaded).toEqual(request);
		// and again through the tree, so nothing is lost in path resolution
		const node = readTree(root)[0].children[0];
		expect(node.kind).toBe('request');
		expect(readRequest(node.path)).toEqual(request);
	});

	test('file is pretty-printed with a trailing newline (git-diff friendly)', () => {
		const collection = createCollection(root, 'C');
		const file = writeRequest(join(collection, 'r.json'), request);
		const text = readFileSync(file, 'utf8');
		expect(text.endsWith('\n')).toBe(true);
		expect(text.startsWith('{\n  "method": "POST"')).toBe(true);
		expect(JSON.parse(text)).toEqual(request);
	});

	test('every body type round-trips untouched', () => {
		const collection = createCollection(root, 'C');
		const bodies = [
			{ type: 'none' },
			{ type: 'raw', format: 'xml', content: '<a>1</a>' },
			{ type: 'urlencoded', fields: [{ key: 'a b', value: '1+1' }] },
			{ type: 'multipart', fields: [{ key: 'n', value: 'v' }], files: [{ key: 'doc', path: '/tmp/hello.txt' }] },
			{ type: 'binary', path: '/tmp/blob.bin' },
		] as SavedRequest['body'][];
		for (const [i, body] of bodies.entries()) {
			const req: SavedRequest = { ...request, body };
			const file = writeRequest(join(collection, `r${i}.json`), req);
			expect(readRequest(file).body).toEqual(body);
		}
	});

	test('writing over an existing file replaces it', () => {
		const collection = createCollection(root, 'C');
		const file = join(collection, 'r.json');
		writeRequest(file, request);
		const updated: SavedRequest = { ...request, method: 'PUT' };
		writeRequest(file, updated);
		expect(readRequest(file).method).toBe('PUT');
	});

	test('missing file reports a readable error', () => {
		expect(() => readRequest(join(root, 'nope.json'))).toThrow(/file not found/);
	});

	test('invalid JSON reports a readable error', () => {
		mkdirSync(root, { recursive: true });
		const file = join(root, 'bad.json');
		writeFileSync(file, '{ nope');
		expect(() => readRequest(file)).toThrow(/invalid JSON/);
	});

	test('json without method/url is rejected, not silently accepted', () => {
		mkdirSync(root, { recursive: true });
		const file = join(root, 'half.json');
		writeFileSync(file, JSON.stringify({ method: 'GET' }));
		expect(() => readRequest(file)).toThrow(/missing method or url/);
	});

	test('unicode and spaced names survive the filesystem', () => {
		const collection = createCollection(root, 'Añadir 世界');
		const file = writeRequest(join(collection, 'crëate üser.json'), request);
		expect(readTree(root)[0].name).toBe('Añadir 世界');
		expect(readTree(root)[0].children[0].name).toBe('crëate üser');
		expect(readRequest(file)).toEqual(request);
	});
});

describe('rename', () => {
	test('request rename keeps the extension and content', () => {
		const collection = createCollection(root, 'C');
		const file = writeRequest(join(collection, 'old.json'), request);
		const renamed = renameNode(file, 'new name');
		expect(basename(renamed)).toBe('new name.json');
		expect(existsSync(file)).toBe(false);
		expect(readRequest(renamed)).toEqual(request);
	});

	test('renaming to the same name is a no-op, not a duplicate', () => {
		const collection = createCollection(root, 'C');
		const file = writeRequest(join(collection, 'same.json'), request);
		expect(renameNode(file, 'same')).toBe(file);
		expect(readTree(root)[0].children.map((n) => n.name)).toEqual(['same']);
	});

	test('collection rename keeps its contents', () => {
		const collection = createCollection(root, 'Old');
		writeRequest(join(collection, 'r.json'), request);
		const renamed = renameNode(collection, 'New');
		expect(basename(renamed)).toBe('New');
		expect(readTree(root)[0].name).toBe('New');
		expect(readTree(root)[0].children[0].name).toBe('r');
	});

	test('folder rename keeps nested content', () => {
		const collection = createCollection(root, 'C');
		const folder = createFolder(collection, 'before');
		createFolder(folder, 'inner');
		const renamed = renameNode(folder, 'after');
		expect(names(readTree(root)[0].children)).toEqual(['folder:after']);
		expect(names(readTree(root)[0].children[0].children)).toEqual(['folder:inner']);
		expect(renamed).toBe(join(collection, 'after'));
	});

	test('rename collision gets a counter instead of overwriting', () => {
		const collection = createCollection(root, 'C');
		writeRequest(join(collection, 'a.json'), request);
		const b = writeRequest(join(collection, 'b.json'), { ...request, method: 'PUT' });
		const renamed = renameNode(b, 'a');
		expect(basename(renamed)).toBe('a 2.json');
		expect(readRequest(join(collection, 'a.json')).method).toBe('POST');
		expect(readRequest(renamed).method).toBe('PUT');
	});
});

describe('delete', () => {
	test('deleting a collection removes everything under it', () => {
		const collection = createCollection(root, 'C');
		const folder = createFolder(collection, 'F');
		writeRequest(join(folder, 'r.json'), request);
		deleteNode(collection);
		expect(existsSync(collection)).toBe(false);
		expect(readTree(root)).toEqual([]);
	});

	test('deleting a request leaves siblings alone', () => {
		const collection = createCollection(root, 'C');
		writeRequest(join(collection, 'keep.json'), request);
		const doomed = writeRequest(join(collection, 'doomed.json'), request);
		deleteNode(doomed);
		expect(readTree(root)[0].children.map((n) => n.name)).toEqual(['keep']);
	});

	test('deleting a missing path is not an error', () => {
		expect(() => deleteNode(join(root, 'ghost'))).not.toThrow();
	});
});

describe('drag and drop (moveNode)', () => {
	test('request moves between folders', () => {
		const collection = createCollection(root, 'C');
		const from = createFolder(collection, 'from');
		const to = createFolder(collection, 'to');
		const file = writeRequest(join(from, 'r.json'), request);
		const moved = moveNode(file, to);
		expect(moved).toBe(join(to, 'r.json'));
		expect(readRequest(moved)).toEqual(request);
		expect(readTree(root)[0].children.find((n) => n.name === 'from')!.children).toEqual([]);
	});

	test('folder moves into another collection and keeps nesting', () => {
		const a = createCollection(root, 'A');
		const b = createCollection(root, 'B');
		const folder = createFolder(a, 'nested');
		writeRequest(join(folder, 'r.json'), request);
		const moved = moveNode(folder, b);
		expect(moved).toBe(join(b, 'nested'));
		expect(names(readTree(root).find((n) => n.name === 'B')!.children)).toEqual(['folder:nested']);
		expect(names(readTree(root).find((n) => n.name === 'A')!.children)).toEqual([]);
	});

	test('moving into a folder that already has that name gets a counter', () => {
		const collection = createCollection(root, 'C');
		const dest = createFolder(collection, 'dest');
		writeRequest(join(dest, 'r.json'), { ...request, method: 'PUT' });
		const file = writeRequest(join(collection, 'r.json'), request);
		const moved = moveNode(file, dest);
		expect(basename(moved)).toBe('r 2.json');
	});

	test('refuses to move a folder into itself or a descendant', () => {
		const collection = createCollection(root, 'C');
		const parent = createFolder(collection, 'parent');
		const child = createFolder(parent, 'child');
		expect(() => moveNode(parent, parent)).toThrow(/into itself/);
		expect(() => moveNode(parent, child)).toThrow(/into itself/);
		expect(existsSync(join(parent, 'child'))).toBe(true);
	});
});

describe('windows device names', () => {
	test.each(['con', 'aux', 'nul', 'com1', 'lpt9', 'CON'])('%p is made writable', (name) => {
		const safe = sanitizeName(name);
		expect(safe).not.toBe(name.toLowerCase());
		expect(safe.endsWith('_')).toBe(true);
	});

	test('reserved-looking names that are fine stay untouched', () => {
		expect(sanitizeName('console')).toBe('console');
		expect(sanitizeName('com10')).toBe('com10');
	});
});
