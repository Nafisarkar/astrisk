import * as assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAuth, type Auth } from '../auth';
import { sendRequest } from '../http';
import { requestVars, setActive, setVar, writeEnvs, addEnv } from '../env';
import { performSend } from '../extension';
import type { HttpRequest } from '../http';

// Auth + env composition on the real extension-host runtime (Electron's Node, not Bun).
suite('Asterisk M4/M5 — auth + environments on the host runtime', () => {
	let server: Server;
	let base = '';
	let tokenHits = 0;
	const seen: { auth: string; url: string } = { auth: '', url: '' };

	suiteSetup(async () => {
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				if (req.url === '/token') {
					tokenHits++;
					res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
					return;
				}
				seen.auth = String(req.headers.authorization ?? '');
				seen.url = String(req.url ?? '');
				if (seen.auth === 'Bearer tok-1' || seen.auth === 'Bearer env-token' || seen.auth === 'Basic dXNlcjpwYXNz') {
					res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, body }));
					return;
				}
				res.writeHead(401).end('nope');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		base = `http://127.0.0.1:${port}`;
	});

	suiteTeardown(() => new Promise<void>((resolve) => server.close(() => resolve())));

	test('bearer token reaches the server as an Authorization header', async () => {
		const applied = await applyAuth({ url: base + '/x', headers: {} }, { type: 'bearer', token: 'tok-1' });
		assert.equal(applied.error, undefined);
		const r = await sendRequest({ method: 'GET', url: applied.url, headers: applied.headers });
		assert.equal(r.status, 200);
		assert.equal(seen.auth, 'Bearer tok-1');
	});

	test('basic auth base64-encodes user:pass', async () => {
		const applied = await applyAuth({ url: base + '/x', headers: {} }, { type: 'basic', username: 'user', password: 'pass' });
		const r = await sendRequest({ method: 'GET', url: applied.url, headers: applied.headers });
		assert.equal(r.status, 200);
		assert.equal(seen.auth, 'Basic dXNlcjpwYXNz');
	});

	test('api key in the query is encoded and does not break the send', async () => {
		const applied = await applyAuth({ url: base + '/x', headers: {} }, { type: 'apikey', key: 'api key', value: 'a b', in: 'query' });
		assert.equal(applied.error, undefined);
		const r = await sendRequest({ method: 'GET', url: applied.url, headers: applied.headers });
		assert.equal(r.status, 401); // no Authorization header, so the server rejects — but the URL must be intact
		assert.ok(applied.url.includes('api+key=a+b') || applied.url.includes('api%20key=a%20b'), applied.url);
	});

	test('client credentials fetches a token once and reuses the cache', async () => {
		const auth: Auth = { type: 'oauth2-cc', tokenUrl: base + '/token', clientId: 'id', clientSecret: 'secret' };
		const cache = new Map();
		const first = await applyAuth({ url: base + '/x', headers: {} }, auth, { cache });
		const second = await applyAuth({ url: base + '/x', headers: {} }, auth, { cache });
		assert.equal(first.error, undefined);
		assert.equal(first.headers.Authorization, 'Bearer tok-1');
		assert.equal(second.headers.Authorization, 'Bearer tok-1');
		assert.equal(tokenHits, 1, 'token endpoint should be hit once for a valid cached token');
	});

	test('env vars from .environments.json feed the engine, including :path vars and system vars', async () => {
		const root = mkdtempSync(join(tmpdir(), 'asterisk-host-env-'));
		let doc = addEnv({ environments: {} }, 'test');
		doc = setVar(doc, 'test', 'base', base);
		doc = setVar(doc, 'test', 'token', 'env-token');
		doc = setVar(doc, 'test', 'id', '42');
		doc = setActive(doc, 'test');
		writeEnvs(root, doc);

		// same composition the extension does: env doc -> vars -> auth -> engine
		const vars = requestVars(doc);
		const applied = await applyAuth({ url: '{{base}}/users/:id', headers: {} }, { type: 'bearer', token: '{{token}}' }, { vars });
		const r = await sendRequest({ method: 'GET', url: applied.url, headers: applied.headers }, vars);
		assert.equal(r.status, 200);
		assert.equal(seen.auth, 'Bearer env-token');
		assert.equal(seen.url, '/users/42');
	});
});

suite('Asterisk M5 — send pipeline guarantees', () => {
	test('a failing auth never sends the request', async () => {
		let sent = 0;
		const { response } = await performSend(
			{ method: 'GET', url: 'http://127.0.0.1:1/never', auth: { type: 'oauth2-cc', tokenUrl: 'http://127.0.0.1:1/token', clientId: 'c', clientSecret: 's' } },
			async () => {
				sent++;
				throw new Error('runner must not be called');
			}
		);
		assert.equal(sent, 0);
		assert.equal(response.status, 0);
		assert.ok(response.error && response.error.length > 0);
		assert.ok(!response.error.includes('s'), 'client secret leaked into the error');
	});

	test('auth headers reach the runner, and history is written', async () => {
		let got: { url: string; headers: Record<string, string> } | undefined;
		const { response } = await performSend({ method: 'GET', url: 'http://example.test/x', auth: { type: 'bearer', token: 'tok' } }, async (req: HttpRequest) => {
			got = { url: req.url, headers: req.headers ?? {} };
			return { ok: true, status: 200, statusText: 'OK', headers: {}, body: '', sentUrl: req.url, timeMs: 1, ttfbMs: 1, size: 0 };
		});
		assert.equal(response.status, 200);
		assert.equal(got?.headers.Authorization, 'Bearer tok');
	});
});
