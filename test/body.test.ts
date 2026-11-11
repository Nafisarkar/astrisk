import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendRequest, type HttpRequest, type RawFormat, type RequestBody } from '../src/http';

interface Seen {
	method: string;
	contentType: string;
	body: string;
	bytes: string; // base64
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
let textFile: string;
let binaryFile: string;
const seen: Record<string, Seen> = {};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'asterisk-body-'));
	textFile = join(dir, 'hello.txt');
	binaryFile = join(dir, 'blob.bin');
	writeFileSync(textFile, 'hello file\n');
	writeFileSync(binaryFile, new Uint8Array([0, 1, 2, 255, 254, 10, 13]));

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const raw = new Uint8Array(await req.arrayBuffer());
			const contentType = req.headers.get('content-type') ?? '';
			const record: Seen = { method: req.method, contentType, body: '', bytes: Buffer.from(raw).toString('base64') };

			if (contentType.startsWith('multipart/form-data')) {
				const form = new FormData();
				const parsed = await new Response(raw, { headers: { 'content-type': contentType } }).formData();
				const fields: Record<string, string> = {};
				const files: { name: string; field: string; data: string }[] = [];
				for (const [k, v] of parsed) {
					if (typeof v === 'string') {
						fields[k] = v;
					} else {
						files.push({ field: k, name: v.name, data: Buffer.from(await v.arrayBuffer()).toString('base64') });
					}
				}
				void form;
				seen[url.pathname] = { ...record, body: JSON.stringify({ fields, files }) };
				return Response.json({ fields, files });
			}

			seen[url.pathname] = { ...record, body: Buffer.from(raw).toString('utf8') };
			return Response.json({ method: req.method, contentType, body: Buffer.from(raw).toString('utf8') });
		},
	});
	base = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));

const post = (path: string, body?: RequestBody, extra: Partial<HttpRequest> = {}): HttpRequest => ({
	method: 'POST',
	url: base + path,
	body,
	...extra,
});

const raw = (content: string, format: RawFormat = 'text'): RequestBody => ({ type: 'raw', format, content });

describe('raw bodies', () => {
	test.each([
		['json', 'application/json', '{"a":1}'],
		['text', 'text/plain', 'plain text'],
		['xml', 'application/xml', '<a>1</a>'],
		['html', 'text/html', '<p>hi</p>'],
	] as const)('%s sends the content with %s', async (format, contentType, content) => {
		const r = await sendRequest(post('/wire', raw(content, format)));
		expect(r.status).toBe(200);
		expect(seen['/wire'].body).toBe(content);
		expect(seen['/wire'].contentType).toBe(contentType);
	});

	test('JSON is sent verbatim, not re-encoded', async () => {
		const content = '{ "spaced" : 1,\n\t"nested":{"x":[1,2]} }';
		await sendRequest(post('/wire', raw(content, 'json')));
		expect(seen['/wire'].body).toBe(content);
	});

	test('user Content-Type wins over the auto one', async () => {
		await sendRequest(post('/wire', raw('{"a":1}', 'json'), { headers: { 'Content-Type': 'application/vnd.api+json' } }));
		expect(seen['/wire'].contentType).toBe('application/vnd.api+json');
	});

	test('user content-type header is matched case-insensitively', async () => {
		await sendRequest(post('/wire', raw('<a/>', 'xml'), { headers: { 'CONTENT-TYPE': 'text/xml; charset=utf-8' } }));
		expect(seen['/wire'].contentType).toBe('text/xml; charset=utf-8');
	});

	test('vars resolve inside raw content but Content-Type stays typed', async () => {
		await sendRequest(post('/wire', raw('{"id":"{{id}}"}', 'json')), { id: '7' });
		expect(seen['/wire'].body).toBe('{"id":"7"}');
		expect(seen['/wire'].contentType).toBe('application/json');
	});
});

describe('urlencoded bodies', () => {
	test('serializes fields and sets Content-Type', async () => {
		const r = await sendRequest(post('/wire', { type: 'urlencoded', fields: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] }));
		expect(r.status).toBe(200);
		expect(seen['/wire'].body).toBe('a=1&b=2');
		expect(seen['/wire'].contentType).toBe('application/x-www-form-urlencoded');
	});

	test('encodes reserved characters', async () => {
		const fields = [
			{ key: 'sp ace', value: 'a b' },
			{ key: 'amp', value: 'x&y=z' },
			{ key: 'plus', value: '1+1' },
			{ key: 'uni', value: 'héllo 世界' },
		];
		await sendRequest(post('/wire', { type: 'urlencoded', fields }));
		expect(seen['/wire'].body).toBe('sp+ace=a+b&amp=x%26y%3Dz&plus=1%2B1&uni=h%C3%A9llo+%E4%B8%96%E7%95%8C');
	});

	test('drops blank keys, keeps blank values', async () => {
		const fields = [{ key: '  ', value: 'ghost' }, { key: 'empty', value: '' }, { key: 'ok', value: 'v' }];
		await sendRequest(post('/wire', { type: 'urlencoded', fields }));
		expect(seen['/wire'].body).toBe('empty=&ok=v');
	});

	test('empty field list sends an empty body, not undefined', async () => {
		await sendRequest(post('/wire', { type: 'urlencoded', fields: [] }));
		expect(seen['/wire'].body).toBe('');
		expect(seen['/wire'].contentType).toBe('application/x-www-form-urlencoded');
	});

	test('vars resolve in keys and values', async () => {
		await sendRequest(post('/wire', { type: 'urlencoded', fields: [{ key: '{{k}}', value: '{{v}}' }] }), { k: 'user', v: 'ada' });
		expect(seen['/wire'].body).toBe('user=ada');
	});
});

describe('multipart bodies', () => {
	test('round-trips fields and a file with its filename', async () => {
		const r = await sendRequest(
			post('/wire', {
				type: 'multipart',
				fields: [{ key: 'name', value: 'Ada Lovelace' }],
				files: [{ key: 'doc', path: textFile }],
			})
		);
		expect(r.status).toBe(200);
		expect(seen['/wire'].contentType).toStartWith('multipart/form-data; boundary=');

		const parsed = JSON.parse(r.body);
		expect(parsed.fields).toEqual({ name: 'Ada Lovelace' });
		expect(parsed.files).toHaveLength(1);
		expect(parsed.files[0].field).toBe('doc');
		expect(parsed.files[0].name).toBe('hello.txt');
		expect(Buffer.from(parsed.files[0].data, 'base64').toString()).toBe('hello file\n');
	});

	test('file bytes survive intact (0x00 and non-UTF8 bytes)', async () => {
		const r = await sendRequest(post('/wire', { type: 'multipart', files: [{ key: 'blob', path: binaryFile }] }));
		const parsed = JSON.parse(r.body);
		const bytes = Uint8Array.from(Buffer.from(parsed.files[0].data, 'base64'));
		expect(Array.from(bytes)).toEqual([0, 1, 2, 255, 254, 10, 13]);
		expect(parsed.files[0].name).toBe('blob.bin');
	});

	test('multiple files under the same field name', async () => {
		const r = await sendRequest(
			post('/wire', { type: 'multipart', files: [{ key: 'f', path: textFile }, { key: 'f', path: binaryFile }] })
		);
		const parsed = JSON.parse(r.body);
		expect(parsed.files.map((f: { name: string }) => f.name)).toEqual(['hello.txt', 'blob.bin']);
	});

	test('vars resolve in multipart field values', async () => {
		const r = await sendRequest(post('/wire', { type: 'multipart', fields: [{ key: 'tag', value: '{{tag}}' }] }), { tag: 'v1' });
		expect(JSON.parse(r.body).fields).toEqual({ tag: 'v1' });
	});

	test('multipart with only fields is still valid', async () => {
		const r = await sendRequest(post('/wire', { type: 'multipart', fields: [{ key: 'a', value: '1' }] }));
		expect(r.status).toBe(200);
		expect(JSON.parse(r.body).fields).toEqual({ a: '1' });
	});

	test('manual Content-Type is dropped so fetch can add its boundary', async () => {
		const r = await sendRequest(
			post('/wire', { type: 'multipart', fields: [{ key: 'a', value: '1' }] }, { headers: { 'Content-Type': 'multipart/form-data' } })
		);
		expect(r.status).toBe(200);
		expect(seen['/wire'].contentType).toStartWith('multipart/form-data; boundary=');
		expect(JSON.parse(r.body).fields).toEqual({ a: '1' });
	});
});

describe('binary bodies', () => {
	test('sends exact bytes with application/octet-stream', async () => {
		const r = await sendRequest(post('/wire', { type: 'binary', path: binaryFile }));
		expect(r.status).toBe(200);
		expect(seen['/wire'].contentType).toBe('application/octet-stream');
		expect(Array.from(Uint8Array.from(Buffer.from(seen['/wire'].bytes, 'base64')))).toEqual([0, 1, 2, 255, 254, 10, 13]);
	});
});

describe('body edge cases', () => {
	test('none sends no body at all', async () => {
		await sendRequest(post('/wire', { type: 'none' }));
		expect(seen['/wire'].body).toBe('');
		expect(seen['/wire'].contentType).toBe('');
	});

	test('omitted body sends no body', async () => {
		await sendRequest(post('/wire'));
		expect(seen['/wire'].body).toBe('');
		expect(seen['/wire'].contentType).toBe('');
	});

	test('missing file returns an error, does not throw', async () => {
		const r = await sendRequest(post('/wire', { type: 'binary', path: join(dir, 'nope.bin') }));
		expect(r.status).toBe(0);
		expect(r.error).toContain('Cannot read file');
		expect(r.error).toContain('not found');
	});

	test('missing multipart file returns an error naming the path', async () => {
		const r = await sendRequest(post('/wire', { type: 'multipart', files: [{ key: 'f', path: join(dir, 'nope.bin') }] }));
		expect(r.status).toBe(0);
		expect(r.error).toContain('nope.bin');
	});

	test('bodyless methods never touch the filesystem', async () => {
		for (const method of ['GET', 'HEAD', 'DELETE', 'OPTIONS'] as const) {
			const r = await sendRequest({ method, url: base + '/wire', body: { type: 'binary', path: join(dir, 'nope.bin') } });
			expect(r.status).toBe(200);
			expect(r.error).toBeUndefined();
			expect(seen['/wire'].body).toBe('');
		}
	});
});
