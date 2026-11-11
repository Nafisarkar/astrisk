import * as assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendRequest, type RawFormat, type RequestBody } from '../http';

// The webview/engine run in the VS Code extension host (Electron's Node), not Bun.
// These tests prove Blob/FormData/AbortSignal-based bodies actually work there.
suite('Asterisk M2 — bodies on the real extension-host runtime', () => {
	let server: Server;
	let base = '';
	let dir = '';
	let txt = '';
	let bin = '';

	const seen = { method: '', contentType: '', bytes: Buffer.alloc(0), text: '' };
	const raw = (content: string, format: RawFormat = 'text'): RequestBody => ({ type: 'raw', format, content });

	suiteSetup(async () => {
		dir = mkdtempSync(join(tmpdir(), 'asterisk-host-'));
		txt = join(dir, 'note.txt');
		bin = join(dir, 'blob.bin');
		writeFileSync(txt, 'hello file\n');
		writeFileSync(bin, new Uint8Array([0, 1, 2, 254, 255, 13, 10]));

		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				const bytes = Buffer.concat(chunks);
				seen.method = req.method ?? '';
				seen.contentType = String(req.headers['content-type'] ?? '');
				seen.bytes = bytes;
				seen.text = bytes.toString('utf8');
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ method: seen.method, ct: seen.contentType, size: bytes.length }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		base = `http://127.0.0.1:${port}`;
	});

	suiteTeardown(() => new Promise<void>((resolve) => server.close(() => resolve())));

	test('GET round-trips a JSON response and reports size/timing', async () => {
		const r = await sendRequest({ method: 'GET', url: base + '/json' });
		assert.equal(r.error, undefined);
		assert.equal(r.status, 200);
		assert.equal(JSON.parse(r.body).method, 'GET');
		assert.ok(r.timeMs >= 0);
		assert.equal(r.size, Buffer.byteLength(r.body, 'utf8'));
	});

	test('raw JSON body arrives with application/json', async () => {
		const r = await sendRequest({ method: 'POST', url: base + '/echo', body: raw('{"a":1}', 'json') });
		assert.equal(r.status, 200);
		assert.equal(seen.contentType, 'application/json');
		assert.equal(seen.text, '{"a":1}');
	});

	test('urlencoded body is serialized on the wire', async () => {
		await sendRequest({
			method: 'POST',
			url: base + '/echo',
			body: { type: 'urlencoded', fields: [{ key: 'a b', value: '1+1' }, { key: 'u', value: 'héllo' }] },
		});
		assert.equal(seen.contentType, 'application/x-www-form-urlencoded');
		assert.equal(seen.text, 'a+b=1%2B1&u=h%C3%A9llo');
	});

	test('multipart body carries fields, file name, file bytes and a boundary', async () => {
		const r = await sendRequest({
			method: 'POST',
			url: base + '/echo',
			body: { type: 'multipart', fields: [{ key: 'name', value: 'Ada' }], files: [{ key: 'doc', path: txt }] },
		});
		assert.equal(r.status, 200);
		assert.ok(seen.contentType.startsWith('multipart/form-data; boundary='), `bad content-type: ${seen.contentType}`);
		assert.ok(seen.text.includes('name="name"'), 'text field part missing');
		assert.ok(seen.text.includes('Ada'), 'field value missing');
		assert.ok(seen.text.includes('filename="note.txt"'), 'file part filename missing');
		assert.ok(seen.text.includes('hello file'), 'file content missing');
	});

	test('multipart sends binary file bytes intact', async () => {
		await sendRequest({ method: 'POST', url: base + '/echo', body: { type: 'multipart', files: [{ key: 'blob', path: bin }] } });
		assert.ok(seen.contentType.startsWith('multipart/form-data; boundary='));
		// raw body must contain the exact byte sequence [0,1,2,254,255,13,10]
		const needle = Buffer.from([0, 1, 2, 254, 255, 13, 10]);
		assert.ok(seen.bytes.includes(needle), 'binary file bytes were altered in transit');
	});

	test('binary body arrives byte-exact as application/octet-stream', async () => {
		await sendRequest({ method: 'POST', url: base + '/echo', body: { type: 'binary', path: bin } });
		assert.equal(seen.contentType, 'application/octet-stream');
		assert.deepEqual([...seen.bytes], [0, 1, 2, 254, 255, 13, 10]);
	});

	test('missing file surfaces as an error, not a crash', async () => {
		const r = await sendRequest({ method: 'POST', url: base + '/echo', body: { type: 'binary', path: join(dir, 'nope.bin') } });
		assert.equal(r.status, 0);
		assert.ok(r.error && r.error.includes('Cannot read file'), `unexpected error: ${r.error}`);
	});

	test('timeout fires on the host runtime', async () => {
		const slow = createServer(() => {
			/* never responds */
		});
		await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
		const addr = slow.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		try {
			const r = await sendRequest({ method: 'GET', url: `http://127.0.0.1:${port}/`, timeoutMs: 100 });
			assert.equal(r.status, 0);
			assert.ok(r.error && r.error.includes('timed out'), `unexpected error: ${r.error}`);
		} finally {
			await new Promise<void>((resolve) => slow.close(() => resolve()));
		}
	});

	test('an aborted request reports cancellation, not a timeout', async () => {
		const slow = createServer(() => {
			/* never responds */
		});
		await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
		const addr = slow.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		try {
			const controller = new AbortController();
			const pending = sendRequest({ method: 'GET', url: `http://127.0.0.1:${port}/`, signal: controller.signal });
			setTimeout(() => controller.abort(), 40);
			const r = await pending;
			assert.equal(r.status, 0);
			assert.equal(r.error, 'Request cancelled');
		} finally {
			await new Promise<void>((resolve) => slow.close(() => resolve()));
		}
	});

	test('a dead port surfaces the transport cause, not just "fetch failed"', async () => {
		// grab a port, then close it: nothing is listening there
		const probe = createServer(() => { /* nothing */ });
		await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
		const addr = probe.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		const r = await sendRequest({ method: 'GET', url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 });
		assert.equal(r.status, 0);
		assert.ok(/ECONNREFUSED|fetch failed|socket hang up|ECONNRESET/i.test(r.error || ''), `unexpected error: ${r.error}`);
	});
});
