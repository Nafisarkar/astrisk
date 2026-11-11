// Wire-level form coverage: urlencoded + multipart bodies as the SERVER sees them.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendRequest, type FileRef, type Field, type HttpRequest, type RequestBody } from '../src/http';

type Entry = { key: string; kind: 'text' | 'file'; value?: string; filename?: string; size?: number; data?: string };

let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
let emptyFile: string;
let unicodeFile: string;
let nestedFile: string;
let trickyFile: string;

const files: Record<string, string> = {};

const TRICKY = 'head\r\n--\r\n--abc\r\n------WebKitFormBoundary7MA4YWxkTrZu0gW\r\ntail\r\n';

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'asterisk-forms-'));
	emptyFile = join(dir, 'empty.txt');
	unicodeFile = join(dir, 'spaced name ünï.txt');
	nestedFile = join(dir, 'sub', 'deep', 'nested.txt');
	trickyFile = join(dir, 'tricky.txt');

	writeFileSync(emptyFile, '');
	writeFileSync(unicodeFile, 'unicode payload\n');
	mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });
	writeFileSync(nestedFile, 'nested payload\n');
	writeFileSync(trickyFile, TRICKY);

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const contentType = req.headers.get('content-type') ?? '';
			// Keep a copy for the wire-format assertions; req.formData() consumes the original.
			const raw = Buffer.from(await req.clone().arrayBuffer()).toString('utf8');
			const entries: Entry[] = [];

			if (contentType.startsWith('multipart/form-data')) {
				const parsed = await req.formData();
				for (const [key, value] of parsed) {
					if (typeof value === 'string') {
						entries.push({ key, kind: 'text', value });
					} else {
						const bytes = new Uint8Array(await value.arrayBuffer());
						entries.push({
							key,
							kind: 'file',
							filename: value.name,
							size: bytes.byteLength,
							data: Buffer.from(bytes).toString('base64'),
						});
					}
				}
			} else {
				for (const [key, value] of new URLSearchParams(raw)) {
					entries.push({ key, kind: 'text', value });
				}
			}

			return Response.json({ contentType, raw, entries });
		},
	});
	base = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));

const post = (body: RequestBody, headers?: Record<string, string>): HttpRequest => ({
	method: 'POST',
	url: `${base}/echo`,
	body,
	headers,
});

const enc = (fields: Field[], vars?: Record<string, string>) =>
	sendRequest(post({ type: 'urlencoded', fields }), vars);

const mp = (fields: Field[] = [], fileRefs: FileRef[] = [], vars?: Record<string, string>) =>
	sendRequest(post({ type: 'multipart', fields, files: fileRefs }), vars);

const decode = (raw: string) => [...new URLSearchParams(raw)].map(([k, v]) => [k, v]);

describe('urlencoded encoding edges', () => {
	test('every reserved char is percent-encoded and decodes back exactly', async () => {
		const cases: [string, string][] = [
			['and', 'a&b=c'],
			['plus', '1+1'],
			['space', 'a b'],
			['pct', '100%'],
			['hash', 'a#b'],
			['query', 'a?b'],
			['slash', 'a/b'],
			['semi', 'a;b'],
			['colon', 'a:b'],
			['tilde', 'a~b'],
			['quote', 'a"b'],
			['squote', "a'b"],
		];
		const fields = cases.map(([key, value]) => ({ key, value }));
		const r = await enc(fields);
		expect(r.status).toBe(200);

		const body = (JSON.parse(r.body) as { raw: string }).raw;
		expect(body).toBe(
			'and=a%26b%3Dc&plus=1%2B1&space=a+b&pct=100%25&hash=a%23b&query=a%3Fb&slash=a%2Fb&semi=a%3Bb&colon=a%3Ab&tilde=a%7Eb&quote=a%22b&squote=a%27b'
		);
		// Server-side decode must return the original bytes.
		expect(decode(body)).toEqual(cases.map(([key, value]) => [key, value]));
	});

	test('unicode keys and values round-trip through percent-encoding', async () => {
		const key = 'ñame 世界';
		const value = 'héllo 世界 — ünïcode ✓';
		const r = await enc([{ key, value }]);
		const body = (JSON.parse(r.body) as { raw: string }).raw;
		expect(body).toContain('%C3%B1');
		expect(body).not.toContain('世');
		expect(decode(body)).toEqual([[key, value]]);
	});

	test('empty values survive as key= (not dropped)', async () => {
		const r = await enc([{ key: 'empty', value: '' }, { key: 'after', value: 'v' }]);
		const body = (JSON.parse(r.body) as { raw: string }).raw;
		expect(body).toBe('empty=&after=v');
		expect(decode(body)).toEqual([['empty', ''], ['after', 'v']]);
	});

	test('duplicate keys are preserved in declaration order', async () => {
		const r = await enc([
			{ key: 'tag', value: 'one' },
			{ key: 'other', value: 'x' },
			{ key: 'tag', value: 'two' },
			{ key: 'tag', value: 'three' },
		]);
		const body = (JSON.parse(r.body) as { raw: string }).raw;
		expect(body).toBe('tag=one&other=x&tag=two&tag=three');
		const parsed = new URLSearchParams(body);
		expect(parsed.getAll('tag')).toEqual(['one', 'two', 'three']);
	});

	test('key-only row (blank value) is sent, whitespace-only key is dropped', async () => {
		const r = await enc([{ key: 'flag', value: '' }, { key: '   ', value: 'ghost' }, { key: '\t', value: '' }]);
		const body = (JSON.parse(r.body) as { raw: string }).raw;
		expect(body).toBe('flag=');
		expect(body).not.toContain('ghost');
	});

	test('unresolved {{var}} stays literal and is still encoded safely', async () => {
		const r = await enc([{ key: 'v', value: 'x{{missingVar}}y' }, { key: 'k{{nope}}', value: '1' }], { other: 'z' });
		const body = (JSON.parse(r.body) as { raw: string }).raw;
		expect(decode(body)).toEqual([
			['v', 'x{{missingVar}}y'],
			['k{{nope}}', '1'],
		]);
		expect(body).toBe('v=x%7B%7BmissingVar%7D%7Dy&k%7B%7Bnope%7D%7D=1');
	});

	test('variable values that themselves look like encoding are encoded once', async () => {
		const r = await enc([{ key: '{{k}}', value: '{{v}}' }], { k: 'a&b', v: 'c=d' });
		const body = (JSON.parse(r.body) as { raw: string }).raw;
		expect(body).toBe('a%26b=c%3Dd');
		expect(decode(body)).toEqual([['a&b', 'c=d']]);
	});
});

describe('urlencoded Content-Type handling', () => {
	test('a manually set Content-Type differing in case wins', async () => {
		const r = await sendRequest(
			post({ type: 'urlencoded', fields: [{ key: 'a', value: '1' }] }, { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' })
		);
		expect(r.status).toBe(200);
		const seen = JSON.parse(r.body) as { contentType: string; raw: string };
		expect(seen.contentType).toBe('application/x-www-form-urlencoded; charset=utf-8');
		expect(seen.raw).toBe('a=1');
	});

	test('oddly cased user header is still recognised as a user override', async () => {
		const r = await sendRequest(post({ type: 'urlencoded', fields: [{ key: 'a', value: '1' }] }, { 'cOnTeNt-TyPe': 'text/plain' }));
		const seen = JSON.parse(r.body) as { contentType: string; raw: string };
		expect(seen.contentType).toBe('text/plain');
		expect(seen.raw).toBe('a=1');
	});

	test('user Content-Type: application/json wins but the body stays form-encoded', async () => {
		const r = await sendRequest(
			post({ type: 'urlencoded', fields: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] }, { 'Content-Type': 'application/json' })
		);
		expect(r.status).toBe(200);
		const seen = JSON.parse(r.body) as { contentType: string; raw: string };
		expect(seen.contentType).toBe('application/json');
		expect(seen.raw).toBe('a=1&b=2');
	});
});

describe('urlencoded 100KB round-trip', () => {
	test('large payload arrives intact and is echoed intact', async () => {
		const fields: Field[] = [];
		for (let i = 0; i < 200; i++) {
			fields.push({ key: `k${i}`, value: `${i}:` + 'x y&z=+/%#'.repeat(40) });
		}
		const r = await enc(fields);
		expect(r.status).toBe(200);
		const seen = JSON.parse(r.body) as { raw: string; contentType: string };

		expect(seen.contentType).toBe('application/x-www-form-urlencoded');
		expect(seen.raw.length).toBeGreaterThan(100_000);
		// Response side: size is the UTF-8 byte length of the response that came back.
		expect(r.size).toBe(Buffer.byteLength(r.body, 'utf8'));
		expect(r.ok).toBe(true);
		const back = decode(seen.raw);
		expect(back).toHaveLength(200);
		expect(back).toEqual(fields.map((f) => [f.key, f.value]));
	});
});

describe('multipart files', () => {
	test('0-byte file is still a file part with its name', async () => {
		const r = await mp([{ key: 'note', value: 'no content' }], [{ key: 'blob', path: emptyFile }]);
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		const file = entries.find((e) => e.kind === 'file')!;
		expect(file.key).toBe('blob');
		expect(file.filename).toBe('empty.txt');
		expect(file.size).toBe(0);
		expect(file.data).toBe('');
	});

	test('filename with spaces and unicode survives', async () => {
		const r = await mp([], [{ key: 'doc', path: unicodeFile }]);
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		const file = entries.find((e) => e.kind === 'file')!;
		expect(file.filename).toBe('spaced name ünï.txt');
		expect(Buffer.from(file.data!, 'base64').toString()).toBe('unicode payload\n');
	});

	test('nested path is sent as basename only', async () => {
		const r = await mp([], [{ key: 'doc', path: nestedFile }]);
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		const file = entries.find((e) => e.kind === 'file')!;
		expect(file.filename).toBe('nested.txt');
		expect(file.filename).not.toContain('sub');
		expect(file.filename).not.toContain('/');
		expect(file.filename).not.toContain('\\');
	});

	test('file content with CRLF and boundary-lookalikes is not corrupted', async () => {
		const r = await mp([], [{ key: 'wire', path: trickyFile }]);
		const { entries, raw } = JSON.parse(r.body) as { entries: Entry[]; raw: string };
		const file = entries.find((e) => e.kind === 'file')!;
		expect(Buffer.from(file.data!, 'base64').toString('utf8')).toBe(TRICKY);
		expect(file.size).toBe(Buffer.byteLength(TRICKY));
		// The literal bytes were on the wire, not re-encoded.
		expect(raw).toContain('head\r\n--\r\n--abc\r\n');
	});

	test('empty file plus tricky file plus missing-field-key file ref are all handled', async () => {
		const r = await mp([], [{ key: 'a', path: emptyFile }, { key: 'b', path: trickyFile }, { key: '  ', path: unicodeFile }]);
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		const fileEntries = entries.filter((e) => e.kind === 'file');
		expect(fileEntries.map((e) => e.filename)).toEqual(['empty.txt', 'tricky.txt']);
	});
});

describe('multipart composition and ordering', () => {
	test('fields only, files only, and both all parse', async () => {
		const onlyFields = await mp([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
		expect((JSON.parse(onlyFields.body) as { entries: Entry[] }).entries).toEqual([
			{ key: 'a', kind: 'text', value: '1' },
			{ key: 'b', kind: 'text', value: '2' },
		]);

		const onlyFiles = await mp([], [{ key: 'f', path: nestedFile }]);
		expect((JSON.parse(onlyFiles.body) as { entries: Entry[] }).entries.map((e) => e.key)).toEqual(['f']);

		const both = await mp([{ key: 'a', value: '1' }], [{ key: 'f', path: nestedFile }]);
		expect((JSON.parse(both.body) as { entries: Entry[] }).entries.map((e) => e.kind)).toEqual(['text', 'file']);
	});

	test('declaration order is preserved within fields and within files', async () => {
		const r = await mp(
			[
				{ key: 'z', value: '1' },
				{ key: 'a', value: '2' },
				{ key: 'm', value: '3' },
			],
			[
				{ key: 'f2', path: nestedFile },
				{ key: 'f1', path: emptyFile },
			]
		);
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		expect(entries.map((e) => e.key)).toEqual(['z', 'a', 'm', 'f2', 'f1']);
	});

	test('duplicate field names are kept, in order', async () => {
		const r = await mp([
			{ key: 'row', value: 'one' },
			{ key: 'row', value: 'two' },
		]);
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		expect(entries.filter((e) => e.key === 'row').map((e) => e.value)).toEqual(['one', 'two']);
	});

	test('empty multipart body is still a parseable request with a boundary', async () => {
		const r = await mp([], []);
		expect(r.status).toBe(200);
		const { contentType, entries } = JSON.parse(r.body) as { contentType: string; entries: Entry[] };
		expect(contentType).toStartWith('multipart/form-data; boundary=');
		expect(contentType.split('boundary=')[1]!.length).toBeGreaterThan(0);
		expect(entries).toEqual([]);
	});
});

describe('multipart variable substitution', () => {
	test('vars resolve in field keys as well as values', async () => {
		const r = await mp([{ key: '{{k}}', value: '{{v}}' }], [], { k: 'user_name', v: 'ada' });
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		expect(entries).toEqual([{ key: 'user_name', kind: 'text', value: 'ada' }]);
	});

	test('vars resolve in file keys', async () => {
		const r = await mp([], [{ key: '{{slot}}', path: nestedFile }], { slot: 'attachment' });
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		expect(entries[0].key).toBe('attachment');
	});

	test('a var value containing quotes and newlines is neither corrupted nor truncated', async () => {
		const nasty = 'line1\nline2\r\n"quoted" \\back\\slash -- \t tab ünï';
		const r = await mp(
			[
				{ key: 'msg', value: '{{nasty}}' },
				{ key: 'after', value: 'still here' },
			],
			[{ key: 'f', path: nestedFile }],
			{ nasty }
		);
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		// Multipart serialization normalizes newlines to CRLF (HTML form-data algorithm), so a
		// lone \n arrives as \r\n. Everything else must be byte-identical.
		const got = entries[0] as { key: string; kind: string; value: string };
		expect(got.key).toBe('msg');
		expect(got.value.replace(/\r\n/g, '\n')).toBe(nasty.replace(/\r\n/g, '\n'));
		expect(got.value).toContain('"quoted"');
		expect(got.value).toContain('\\back\\slash');
		expect(got.value).toContain('-- \t tab ünï');
		expect(got.value.endsWith('ünï')).toBe(true);
		expect(entries[1]).toEqual({ key: 'after', kind: 'text', value: 'still here' });
		expect(entries[2]).toMatchObject({ key: 'f', kind: 'file', filename: 'nested.txt' });
	});

	test('unresolved var in a multipart field is literal, not an empty string', async () => {
		const r = await mp([{ key: 'x', value: 'before{{missing}}after' }]);
		const { entries } = JSON.parse(r.body) as { entries: Entry[] };
		expect(entries[0].value).toBe('before{{missing}}after');
	});
});
