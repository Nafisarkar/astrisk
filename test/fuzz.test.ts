// Property / fuzz tests: seeded pseudo-random inputs checked against invariants.
// These are the tests that catch "works for the example, breaks for the input".
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fromCurl, toCurl } from '../src/curl';
import { applyPathVars, resolveVars } from '../src/http';
import { makeEntry, readHistory, redactUrl, appendHistory } from '../src/history';
import { parseSseChunk } from '../src/protocols';
import { parseCsv } from '../src/runner';
import { runScript } from '../src/scripting';
import { createCollection, deleteNode, moveNode, readTree, renameNode, sanitizeName, writeRequest } from '../src/store';
import type { SavedRequest } from '../src/store';

/** Deterministic PRNG (mulberry32) so a failure is always reproducible. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABET = [
	'a', 'Z', '0', ' ', '"', "'", '\\', '/', ':', '?', '#', '&', '=', '+', '%', '.', '-', '_', '~', '$', '@', '!',
	'é', 'ü', '世', '🚀', '\t', '\n',
];

function randomText(next: () => number, max: number): string {
	const length = Math.floor(next() * max);
	let out = '';
	for (let i = 0; i < length; i++) {out += ALPHABET[Math.floor(next() * ALPHABET.length)];}
	return out;
}

function randomName(next: () => number): string {
	const pool = ['users', 'my api', 'con', '..', 'a/b', 'a\\b', '  padded  ', 'ünïcode', '世界', 'x'.repeat(120), '', '.hidden', 'nul', 'a-b'];
	return next() < 0.6 ? pool[Math.floor(next() * pool.length)] : randomText(next, 30);
}

describe('SSE parsing is chunk-split invariant', () => {
	test('any split of a stream yields the same events', () => {
		const next = rng(1234);
		for (let round = 0; round < 120; round++) {
			const count = 1 + Math.floor(next() * 4);
			let stream = '';
			const expected: any[] = [];
			for (let i = 0; i < count; i++) {
				const data = randomText(next, 12).replace(/\n/g, ' ');
				const named = next() < 0.4;
				const useCrlf = next() < 0.3;
				const nl = useCrlf ? '\r\n' : '\n';
				if (named) {stream += `event: e${i}${nl}`;}
				stream += `data: ${data}${nl}${nl}`;
				expected.push({ event: named ? `e${i}` : 'message', data });
			}

			let events: any[] = [];
			let rest = '';
			let at = 0;
			while (at < stream.length) {
				const take = 1 + Math.floor(next() * 6);
				const chunk = rest + stream.slice(at, at + take);
				at += take;
				const parsed = parseSseChunk(chunk);
				events = events.concat(parsed.events);
				rest = parsed.rest;
			}
			// the last chunk may leave a fully terminated tail in `rest`
			events = events.concat(parseSseChunk(rest).events);
			expect(events, `stream=${JSON.stringify(stream)}`).toEqual(expected);
		}
	});

	test('random bytes never throw', () => {
		const next = rng(99);
		for (let i = 0; i < 300; i++) {
			const input = randomText(next, 40);
			const parsed = parseSseChunk(input);
			expect(Array.isArray(parsed.events)).toBe(true);
			expect(typeof parsed.rest).toBe('string');
		}
	});
});

describe('curl round-trip', () => {
	const cases: SavedRequest[] = [
		{ method: 'GET', url: 'https://api.test/users?page=1#top' },
		{ method: 'POST', url: 'https://api.test/users', headers: { 'X-Test': 'a b' }, body: { type: 'raw', format: 'json', content: '{"a":1}' } },
		{ method: 'PUT', url: 'https://api.test/x', headers: { 'X-Quote': `it's "quoted"` }, body: { type: 'raw', format: 'text', content: 'line1\nline2' } },
		{ method: 'PATCH', url: 'https://api.test/ünïcode/世界', body: { type: 'urlencoded', fields: [{ key: 'a b', value: '1+1' }] } },
		{ method: 'DELETE', url: 'https://api.test/x', headers: { 'X-Back': 'a\\b' } },
		// basic auth is the one auth form that survives as auth (bearer/apikey become headers/query).
		{ method: 'POST', url: 'https://api.test/x', auth: { type: 'basic', username: 'üser', password: 'päss' }, body: { type: 'raw', format: 'text', content: 'x' } },
	];

	test('bearer and apikey become headers on the way back (documented lossiness)', () => {
		const bearer = fromCurl(toCurl({ method: 'GET', url: 'https://api.test/x', auth: { type: 'bearer', token: 'abc def' } }));
		expect(bearer.auth ?? { type: 'none' }).toEqual({ type: 'none' });
		expect(bearer.headers?.Authorization).toBe('Bearer abc def');
		const keyed = fromCurl(toCurl({ method: 'GET', url: 'https://api.test/x', auth: { type: 'apikey', key: 'api_key', value: 'v', in: 'header' } }));
		expect(keyed.headers?.api_key).toBe('v');
	});

	test.each(cases.map((c) => [c.method + ' ' + c.url, c] as const))('%s survives toCurl -> fromCurl', (_label, request) => {
		expect(fromCurl(toCurl(request))).toEqual(request);
	});

	test('random requests keep method, url and headers', () => {
		const next = rng(4242);
		const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
		for (let i = 0; i < 120; i++) {
			const method = methods[Math.floor(next() * methods.length)];
			const safeUrl = `https://api.test/${randomText(next, 8).replace(/[^A-Za-z0-9_-]/g, 'x')}?q=${encodeURIComponent(randomText(next, 6))}`;
			const headers: Record<string, string> = {};
			const headerCount = Math.floor(next() * 3);
			for (let h = 0; h < headerCount; h++) {
				headers[`X-H${h}`] = randomText(next, 10).replace(/[\r\n]/g, '').trim() || 'v';
			}
			const request: SavedRequest = { method, url: safeUrl, headers };
			if (method !== 'GET' && method !== 'HEAD' && next() < 0.5) {
				request.body = { type: 'raw', format: 'text', content: randomText(next, 20).replace(/\r/g, '') };
			}
			const back = fromCurl(toCurl(request));
			expect(back.method, JSON.stringify(request)).toBe(request.method);
			expect(back.url, JSON.stringify(request)).toBe(request.url);
			expect(back.headers ?? {}, JSON.stringify(request)).toEqual(request.headers ?? {});
			if (request.body) {expect(back.body, JSON.stringify(request)).toEqual(request.body);}
		}
	});
});

describe('CSV round-trip through a reference writer', () => {
	const writeCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
	const write = (rows: string[][]) => rows.map((row) => row.map(writeCell).join(',')).join('\r\n');

	test('random tables parse back exactly', () => {
		const next = rng(777);
		for (let round = 0; round < 120; round++) {
			const headers = ['id', 'name', 'note'];
			const rowCount = 1 + Math.floor(next() * 4);
			const body: string[][] = [];
			for (let r = 0; r < rowCount; r++) {
				body.push([String(r), randomText(next, 8), randomText(next, 12)]);
			}
			const parsed = parseCsv(write([headers, ...body]));
			expect(parsed.length, write([headers, ...body])).toBe(rowCount);
			body.forEach((row, index) => {
				expect(parsed[index]).toEqual({ id: row[0], name: row[1], note: row[2] });
			});
		}
	});
});

describe('storage invariants', () => {
	test('sanitizeName never produces a separator, a dot-prefix or an empty name', () => {
		const next = rng(555);
		for (let i = 0; i < 400; i++) {
			const name = randomName(next);
			const safe = sanitizeName(name);
			const label = `${JSON.stringify(name)} -> ${JSON.stringify(safe)}`;
			expect(safe.length, label).toBeGreaterThan(0);
			expect(/[\\/]/.test(safe), label).toBe(false);
			expect(safe.startsWith('.'), label).toBe(false);
			expect(safe.trim(), label).toBe(safe);
			expect(safe.length, label).toBeLessThanOrEqual(80);
			expect(/\u0000/.test(safe), label).toBe(false);
		}
	});

	test('the disk tree always mirrors the in-memory tree and stays inside the root', () => {
		const next = rng(888);
		const root = join(mkdtempSync(join(tmpdir(), 'asterisk-fuzz-')), '.asterisk');
		const request: SavedRequest = { method: 'GET', url: 'https://api.test/x' };

		const collection = createCollection(root, randomName(next));
		const folder = createCollection(collection, randomName(next));
		const created: string[] = [];
		for (let i = 0; i < 8; i++) {
			const dir = next() < 0.5 ? collection : folder;
			created.push(writeRequest(join(dir, `${sanitizeName(randomName(next))}.json`), { ...request, url: `https://api.test/${i}` }));
		}

		// nothing escaped the root
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const path = join(dir, entry.name);
				return entry.isDirectory() ? walk(path) : [path];
			});
		for (const file of walk(root)) {
			const rel = relative(resolve(root), resolve(file));
			expect(rel.startsWith('..'), file).toBe(false);
			expect(rel.includes(sep + '..' + sep), file).toBe(false);
		}

		// every file appears in the tree
		const flatten = (nodes: ReturnType<typeof readTree>): string[] =>
			nodes.flatMap((node) => (node.kind === 'request' ? [node.path] : flatten(node.children)));
		const inTree = new Set(flatten(readTree(root)));
		for (const file of created) {expect(inTree.has(file), file).toBe(true);}

		// rename + move keep the file readable and unique
		const renamed = renameNode(created[0], randomName(next));
		expect(readTree(root).length).toBe(1);
		const moved = moveNode(renamed, folder);
		expect(inTree.size).toBe(8);
		expect(typeof moved).toBe('string');

		deleteNode(collection);
		expect(readTree(root)).toEqual([]);
	});
});

describe('history redaction property', () => {
	test('no secret value survives entry creation', () => {
		const secrets = ['tok-A1', 'cookie-B2', 'amz-C3', 'pw-D4', 'refresh-E5'];
		const entry = makeEntry({
			method: 'POST',
			url: `https://api.test/x?access_token=${secrets[0]}&api_key=${secrets[1]}&X-Amz-Signature=${secrets[2]}&keep=1`,
			headers: {
				Authorization: `Bearer ${secrets[0]}`,
				Cookie: `sid=${secrets[1]}`,
				'X-Amz-Signature': secrets[2],
				'X-Keep': 'visible',
			},
			body: JSON.stringify({ password: secrets[3], nested: { refresh_token: secrets[4] }, keep: 'visible' }),
			status: 200,
			ok: true,
			timeMs: 1,
			size: 1,
		});
		const dumped = JSON.stringify(entry);
		for (const secret of secrets) {expect(dumped, secret).not.toContain(secret);}
		expect(dumped).toContain('visible');
	});

	test('random urls never keep a redacted param value', () => {
		const next = rng(31337);
		const keyPool = ['token', 'access_token', 'api_key', 'password', 'sig', 'X-Amz-Signature', 'keep'];
		for (let i = 0; i < 150; i++) {
			const pairs: string[] = [];
			const secrets: string[] = [];
			for (let p = 0; p < 4; p++) {
				const key = keyPool[Math.floor(next() * keyPool.length)];
				const value = `secret${i}_${p}`;
				pairs.push(`${key}=${value}`);
				if (key !== 'keep') {secrets.push(value);}
			}
			const url = `https://api.test/x?${pairs.join('&')}`;
			const redacted = redactUrl(url);
			for (const secret of secrets) {expect(redacted, url).not.toContain(secret);}
		}
	});
});

describe('scripting determinism', () => {
	test('the same script and input always give the same outcome', () => {
		const ctx = {
			request: { method: 'POST', url: 'https://api.test/x', headers: { A: '1' }, body: '{"a":1}' },
			response: { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json' }, body: '{"id":7}', timeMs: 3, size: 8 },
			vars: { base: 'v' },
		};
		const code = 'expect(response.status).to.equal(201); expect(JSON.parse(response.body).id).to.be.above(0); vars.touched = "1"; setEnv("k", "v"); console.log("x");';
		const first = runScript(code, ctx, 'post');
		for (let i = 0; i < 50; i++) {
			const again = runScript(code, ctx, 'post');
			expect(again.assertions).toEqual(first.assertions);
			expect(again.logs).toEqual(first.logs);
			expect(again.envChanges).toEqual(first.envChanges);
			expect(again.vars).toEqual(first.vars);
			expect(again.request).toEqual(first.request);
		}
	});

	test('random values never crash the assertion helpers', () => {
		const next = rng(2024);
		for (let i = 0; i < 100; i++) {
			const value = next() < 0.5 ? randomText(next, 10) : String(Math.floor(next() * 1000));
			const code = `expect(${JSON.stringify(value)}).to.be.a("string"); expect(${JSON.stringify(value)}).to.have.length(${value.length});`;
			const outcome = runScript(code, { request: { method: 'GET', url: 'u', headers: {} }, vars: {} }, 'pre');
			expect(outcome.assertions.length, code).toBeGreaterThan(0);
		}
	});
});

describe('variable resolution', () => {
	test('resolved values are inserted once, never re-scanned', () => {
		expect(resolveVars('{{a}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}');
	});

	test('path vars only fire on real segments', () => {
		const next = rng(8080);
		for (let i = 0; i < 200; i++) {
			const noVars = `https://api.test/${Math.floor(next() * 1000)}/x?q=${Math.floor(next() * 100)}`;
			expect(applyPathVars(noVars, { anything: '1' }), noVars).toBe(noVars);
		}
		const vars = { id: '42' };
		expect(applyPathVars('https://api.test/users/:id', vars)).toBe('https://api.test/users/42');
		expect(applyPathVars('http://localhost:3000/:id', vars)).toBe('http://localhost:3000/42');
		expect(applyPathVars('https://u:p@h.test/:id', vars)).toBe('https://u:p@h.test/42');
		expect(applyPathVars('http://[::1]:8080/:id', vars)).toBe('http://[::1]:8080/42');
	});
});

describe('history file round-trip', () => {
	test('appended entries read back identically', () => {
		const dir = mkdtempSync(join(tmpdir(), 'asterisk-fuzz-history-'));
		const next = rng(606);
		const written = [];
		for (let i = 0; i < 12; i++) {
			const entry = makeEntry({
				method: 'GET',
				url: `https://api.test/${randomText(next, 6)}`,
				status: 200,
				ok: true,
				timeMs: i,
				size: i * 10,
			});
			appendHistory(dir, entry);
			written.unshift(entry);
		}
		expect(readHistory(dir)).toEqual(written);
	});
});
