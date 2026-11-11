import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendRequest, type HttpRequest, type RawFormat, type RequestBody } from '../src/http';

interface Seen {
	method: string;
	contentType: string;
	hasContentType: boolean;
	text: string;
	bytes: string; // base64
	size: number;
}

interface MultipartSeen {
	fields: Record<string, string>;
	files: { field: string; name: string; data: string; size: number }[];
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
let emptyFile: string;
let unicodeFile: string;
let subDir: string;

// Reset on every request so each test reads only its own traffic.
let seen: Seen;
let multipart: MultipartSeen | undefined;
let hits = 0;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'asterisk-edges-'));
	emptyFile = join(dir, 'empty.bin');
	unicodeFile = join(dir, 'unicode.txt');
	subDir = join(dir, 'a-directory');
	writeFileSync(emptyFile, '');
	writeFileSync(unicodeFile, Buffer.from('héllo 世界\r\nline2\r\n\x00tail\r\n', 'utf8'));
	mkdirSync(subDir);

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			hits++;
			const url = new URL(req.url);
			const raw = new Uint8Array(await req.arrayBuffer());
			const contentType = req.headers.get('content-type') ?? '';
			seen = {
				method: req.method,
				contentType,
				hasContentType: req.headers.has('content-type'),
				text: Buffer.from(raw).toString('utf8'),
				bytes: Buffer.from(raw).toString('base64'),
				size: raw.byteLength,
			};
			multipart = undefined;

			if (url.pathname === '/slow') {
				await Bun.sleep(1500);
				return new Response('slow ok');
			}

			if (contentType.startsWith('multipart/form-data')) {
				const parsed = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
				const fields: Record<string, string> = {};
				const files: MultipartSeen['files'] = [];
				for (const [k, v] of parsed) {
					if (typeof v === 'string') {
						fields[k] = v;
					} else {
						const buf = Buffer.from(await v.arrayBuffer());
						files.push({ field: k, name: v.name, data: buf.toString('base64'), size: buf.byteLength });
					}
				}
				multipart = { fields, files };
				return Response.json(multipart);
			}

			return Response.json({ ok: true, method: req.method, contentType });
		},
	});
	base = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));

const req = (method: HttpRequest['method'], body?: RequestBody, extra: Partial<HttpRequest> = {}): HttpRequest => ({
	method,
	url: base + '/echo',
	body,
	...extra,
});

const raw = (content: string, format: RawFormat = 'text'): RequestBody => ({ type: 'raw', format, content });

const RAW_MATRIX: readonly [RawFormat, string][] = [
	['json', 'application/json'],
	['text', 'text/plain'],
	['xml', 'application/xml'],
	['html', 'text/html'],
];

const ALL_METHODS = ['GET', 'HEAD', 'DELETE', 'OPTIONS'] as const;

// Every body type the UI can produce, including a path that cannot be read.
// Built lazily: `dir` only exists once beforeAll has run.
const allBodies = (): readonly [string, RequestBody][] => {
	const ghost = join(dir, 'ghost.bin');
	return [
		['none', { type: 'none' }],
		['raw', raw('{"a":1}', 'json')],
		['urlencoded', { type: 'urlencoded', fields: [{ key: 'a', value: '1' }] }],
		['multipart', { type: 'multipart', fields: [{ key: 'a', value: '1' }] }],
		['multipart-missing-file', { type: 'multipart', files: [{ key: 'f', path: ghost }] }],
		['binary-missing-file', { type: 'binary', path: ghost }],
	];
};

describe('Content-Type negotiation', () => {
	test.each(RAW_MATRIX)('raw %s defaults to %s', async (format, expected) => {
		const r = await sendRequest(req('POST', raw('payload', format)));
		expect(r.status).toBe(200);
		expect(seen.contentType).toBe(expected);
	});

	test.each(RAW_MATRIX)('user override wins for raw %s', async (format) => {
		const r = await sendRequest(req('POST', raw('payload', format), { headers: { 'Content-Type': 'application/x-custom' } }));
		expect(r.status).toBe(200);
		expect(seen.contentType).toBe('application/x-custom');
	});

	test.each(RAW_MATRIX)('mixed-case content-TYPE header wins for raw %s', async (format) => {
		const r = await sendRequest(req('POST', raw('payload', format), { headers: { 'content-TYPE': 'application/vnd.test+json' } }));
		expect(r.status).toBe(200);
		expect(seen.contentType).toBe('application/vnd.test+json');
	});

	test('a blank Content-Type is treated as unset and the auto value is used', async () => {
		const r = await sendRequest(req('POST', raw('{"a":1}', 'json'), { headers: { 'Content-Type': '  ' } }));
		expect(r.status).toBe(200);
		// An empty header row means "I didn't mean to set this" — a valueless Content-Type
		// tells the server nothing and some reject it, so the auto value takes over.
		expect(seen.hasContentType).toBe(true);
		expect(seen.contentType).toBe('application/json');
	});

	test('urlencoded user Content-Type wins', async () => {
		const r = await sendRequest(
			req('POST', { type: 'urlencoded', fields: [{ key: 'a', value: '1' }] }, { headers: { 'content-type': 'text/plain' } })
		);
		expect(r.status).toBe(200);
		expect(seen.contentType).toBe('text/plain');
		expect(seen.text).toBe('a=1');
	});

	test('binary user Content-Type wins', async () => {
		const r = await sendRequest(req('POST', { type: 'binary', path: unicodeFile }, { headers: { 'Content-Type': 'application/x-thing' } }));
		expect(r.status).toBe(200);
		expect(seen.contentType).toBe('application/x-thing');
		expect(seen.bytes).toBe(readFileSync(unicodeFile).toString('base64'));
	});

	test('binary auto Content-Type is application/octet-stream', async () => {
		await sendRequest(req('POST', { type: 'binary', path: emptyFile }));
		expect(seen.contentType).toBe('application/octet-stream');
	});

	test('multipart drops a hand-set Content-Type in any casing', async () => {
		const r = await sendRequest(
			req('POST', { type: 'multipart', fields: [{ key: 'a', value: '1' }] }, { headers: { 'CONTENT-type': 'text/plain' } })
		);
		expect(r.status).toBe(200);
		expect(seen.contentType).toStartWith('multipart/form-data; boundary=');
		expect(multipart?.fields).toEqual({ a: '1' });
	});
});

describe('bodyless methods', () => {
	for (const method of ALL_METHODS) {
		test(`${method} never sends a body and never reads files`, async () => {
			for (const [label, body] of allBodies()) {
				const r = await sendRequest({ method, url: base + '/echo', body });
				expect(r.status, `${method}/${label} status`).toBe(200);
				expect(r.error, `${method}/${label} error`).toBeUndefined();
				expect(seen.size, `${method}/${label} body bytes`).toBe(0);
				expect(seen.hasContentType, `${method}/${label} content-type`).toBe(false);
			}
		});
	}
});

describe('empty bodies on body-capable methods', () => {
	for (const method of ['POST', 'PUT', 'PATCH'] as const) {
		test(`${method} with {type:'none'} and with a body omitted sends nothing`, async () => {
			for (const body of [{ type: 'none' } as RequestBody, undefined]) {
				const r = await sendRequest({ method, url: base + '/echo', body });
				expect(r.status).toBe(200);
				expect(seen.size).toBe(0);
				expect(seen.hasContentType).toBe(false);
			}
		});
	}

	test('raw body with empty content sends zero bytes but keeps its Content-Type', async () => {
		const r = await sendRequest(req('POST', raw('', 'text')));
		expect(r.status).toBe(200);
		// ACTUAL behavior: fetch is given '' so nothing goes on the wire, yet the
		// Content-Type header is still added. Reasonable — the request declares a body type
		// and simply has an empty payload.
		expect(seen.size).toBe(0);
		expect(seen.contentType).toBe('text/plain');
	});
});

describe('file edge cases', () => {
	test('missing file is an error result, not a throw', async () => {
		const missing = join(dir, 'does-not-exist.bin');
		const before = hits;
		const r = await sendRequest(req('POST', { type: 'binary', path: missing }));
		expect(r.status).toBe(0);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('Cannot read file');
		expect(r.error).toContain('does-not-exist.bin');
		expect(r.error).toContain('not found');
		expect(hits, 'request never reached the server').toBe(before);
	});

	test('a directory used as a file is an error result, not a crash', async () => {
		const r = await sendRequest(req('POST', { type: 'multipart', files: [{ key: 'f', path: subDir }] }));
		expect(r.status).toBe(0);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('Cannot read file');
		expect(r.error).toContain('a-directory');
		expect(r.error).not.toContain('not found');
	});

	test('binary directory path also errors cleanly', async () => {
		const r = await sendRequest(req('POST', { type: 'binary', path: subDir }));
		expect(r.status).toBe(0);
		expect(r.error).toContain('a-directory');
	});

	test('0-byte file over multipart still sends with its filename', async () => {
		const r = await sendRequest(req('POST', { type: 'multipart', fields: [{ key: 'a', value: '1' }], files: [{ key: 'f', path: emptyFile }] }));
		expect(r.status).toBe(200);
		expect(multipart?.files).toHaveLength(1);
		expect(multipart?.files[0].name).toBe('empty.bin');
		expect(multipart?.files[0].size).toBe(0);
		expect(multipart?.fields).toEqual({ a: '1' });
	});

	test('0-byte file over binary sends an empty application/octet-stream body', async () => {
		const r = await sendRequest(req('POST', { type: 'binary', path: emptyFile }));
		expect(r.status).toBe(200);
		expect(seen.size).toBe(0);
		expect(seen.contentType).toBe('application/octet-stream');
	});

	test('unicode + CRLF + NUL bytes round-trip byte-exactly for binary', async () => {
		const expected = readFileSync(unicodeFile).toString('base64');
		const r = await sendRequest(req('POST', { type: 'binary', path: unicodeFile }));
		expect(r.status).toBe(200);
		expect(seen.bytes).toBe(expected);
		expect(seen.size).toBe(readFileSync(unicodeFile).byteLength);
	});
});

describe('timeout with a body', () => {
	test('a slow server with a body times out and reports it', async () => {
		const r = await sendRequest({
			method: 'POST',
			url: base + '/slow',
			body: raw('{"slow":true}', 'json'),
			timeoutMs: 200,
		});
		expect(r.status).toBe(0);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('timed out');
		expect(r.timeMs).toBeLessThan(1500);
	});
});
