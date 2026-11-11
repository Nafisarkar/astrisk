import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { applyPathVars, resolveVars, sendRequest, type HttpRequest, type RequestBody } from '../src/http';

const raw = (content: string, format: 'json' | 'text' | 'xml' | 'html' = 'text'): RequestBody => ({ type: 'raw', format, content });

let server: ReturnType<typeof Bun.serve>;
let base: string;
const seen: Record<string, { method: string; headers: Record<string, string>; body: string; url: string }> = {};

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = await req.text();
			seen[url.pathname] = {
				method: req.method,
				headers: Object.fromEntries(req.headers),
				body,
				url: url.toString(),
			};

			switch (url.pathname) {
				case '/json':
					return Response.json({ hello: 'world', n: 42 }, { headers: { 'x-custom': 'yes' } });
				case '/text':
					return new Response('plain body', { headers: { 'content-type': 'text/plain' } });
				case '/echo':
					return Response.json({ method: req.method, body, headers: Object.fromEntries(req.headers) });
				case '/404':
					return new Response('not found', { status: 404, statusText: 'Not Found' });
				case '/500':
					return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
				case '/302':
					return Response.redirect(base + '/json', 302);
				case '/slow':
					await Bun.sleep(400);
					return new Response('late');
				case '/empty':
					return new Response(null, { status: 204, statusText: 'No Content' });
				case '/utf8':
					return new Response('héllo — 世界', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
				default:
					return new Response('?', { status: 400 });
			}
		},
	});
	base = `http://localhost:${server.port}`;
});

afterAll(() => server?.stop(true));

const get = (path: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
	method: 'GET',
	url: base + path,
	...extra,
});

describe('resolveVars', () => {
	test('substitutes known vars', () => {
		expect(resolveVars('{{a}}/x/{{b}}', { a: '1', b: '2' })).toBe('1/x/2');
	});

	test('tolerates whitespace inside braces', () => {
		expect(resolveVars('{{ a }}', { a: 'v' })).toBe('v');
	});

	test('leaves unknown vars literal', () => {
		expect(resolveVars('{{missing}}', {})).toBe('{{missing}}');
	});

	test('substitutes every occurrence', () => {
		expect(resolveVars('{{a}}{{a}}{{a}}', { a: 'z' })).toBe('zzz');
	});

	test('no vars, string untouched', () => {
		expect(resolveVars('plain/url?q=1')).toBe('plain/url?q=1');
	});

	test('does not blow up on regex-special values', () => {
		expect(resolveVars('{{a}}', { a: '$&$1\\' })).toBe('$&$1\\');
	});
});

describe('sendRequest — success paths', () => {
	test('200 JSON: status, statusText, body, headers', async () => {
		const r = await sendRequest(get('/json'));
		expect(r.error).toBeUndefined();
		expect(r.ok).toBe(true);
		expect(r.status).toBe(200);
		expect(r.statusText).toBe('OK');
		expect(JSON.parse(r.body)).toEqual({ hello: 'world', n: 42 });
		expect(r.headers['x-custom']).toBe('yes');
		expect(r.headers['content-type']).toContain('application/json');
	});

	test('reports positive timing', async () => {
		const r = await sendRequest(get('/json'));
		expect(r.timeMs).toBeGreaterThanOrEqual(0);
		expect(r.timeMs).toBeLessThan(5000);
	});

	test('reports byte size matching the body', async () => {
		const r = await sendRequest(get('/text'));
		expect(r.body).toBe('plain body');
		expect(r.size).toBe(Buffer.byteLength('plain body', 'utf8'));
	});

	test('size counts UTF-8 bytes, not characters', async () => {
		const r = await sendRequest(get('/utf8'));
		expect(r.body).toBe('héllo — 世界');
		expect(r.size).toBe(Buffer.byteLength('héllo — 世界', 'utf8'));
		expect(r.size).toBeGreaterThan(r.body.length);
	});

	test('204 empty body is ok, zero size', async () => {
		const r = await sendRequest(get('/empty'));
		expect(r.status).toBe(204);
		expect(r.ok).toBe(true);
		expect(r.body).toBe('');
		expect(r.size).toBe(0);
	});

	test('follows redirects', async () => {
		const r = await sendRequest(get('/302'));
		expect(r.status).toBe(200);
		expect(JSON.parse(r.body).hello).toBe('world');
	});
});

describe('sendRequest — error status surfaced, not thrown', () => {
	test('404 returns response, no error field', async () => {
		const r = await sendRequest(get('/404'));
		expect(r.error).toBeUndefined();
		expect(r.ok).toBe(false);
		expect(r.status).toBe(404);
		expect(r.statusText).toBe('Not Found');
		expect(r.body).toBe('not found');
	});

	test('500 returns response, no error field', async () => {
		const r = await sendRequest(get('/500'));
		expect(r.error).toBeUndefined();
		expect(r.ok).toBe(false);
		expect(r.status).toBe(500);
		expect(r.body).toBe('boom');
	});
});

describe('sendRequest — input validation', () => {
	test('rejects empty URL', async () => {
		const r = await sendRequest({ method: 'GET', url: '' });
		expect(r.status).toBe(0);
		expect(r.error).toContain('Invalid URL');
	});

	test('rejects schemeless URL', async () => {
		const r = await sendRequest({ method: 'GET', url: 'example.com/x' });
		expect(r.error).toContain('Invalid URL');
	});

	test('rejects non-http scheme', async () => {
		const r = await sendRequest({ method: 'GET', url: 'ftp://example.com' });
		expect(r.error).toContain('Invalid URL');
	});

	test('trims surrounding whitespace in URL', async () => {
		const r = await sendRequest({ method: 'GET', url: `  ${base}/json  ` });
		expect(r.status).toBe(200);
	});
});

describe('sendRequest — network failures', () => {
	test('unreachable host returns error, does not throw', async () => {
		const r = await sendRequest({ method: 'GET', url: 'http://localhost:1/nope', timeoutMs: 3000 });
		expect(r.status).toBe(0);
		expect(r.error).toBeTruthy();
		expect(r.body).toBe('');
	});

	test('timeout produces a timeout message', async () => {
		const r = await sendRequest({ method: 'GET', url: base + '/slow', timeoutMs: 80 });
		expect(r.status).toBe(0);
		expect(r.error).toContain('timed out');
	});

	test('request within timeout succeeds', async () => {
		const r = await sendRequest({ method: 'GET', url: base + '/slow', timeoutMs: 3000 });
		expect(r.status).toBe(200);
		expect(r.body).toBe('late');
	});
});

describe('sendRequest — methods and bodies', () => {
	test.each(['GET', 'HEAD', 'DELETE', 'OPTIONS'] as const)('%s sends no body', async (method) => {
		await sendRequest({ method, url: base + '/echo', body: raw('should-be-dropped') });
		expect(seen['/echo'].body).toBe('');
	});

	test.each(['POST', 'PUT', 'PATCH'] as const)('%s sends the body', async (method) => {
		const payload = `{"m":"${method}"}`;
		await sendRequest({ method, url: base + '/echo', body: raw(payload) });
		expect(seen['/echo'].body).toBe(payload);
		expect(seen['/echo'].method).toBe(method);
	});

	test('sends custom headers', async () => {
		await sendRequest(get('/echo', { headers: { 'X-Test': 'abc', Authorization: 'Bearer tok' } }));
		expect(seen['/echo'].headers['x-test']).toBe('abc');
		expect(seen['/echo'].headers['authorization']).toBe('Bearer tok');
	});

	test('skips blank header names', async () => {
		const r = await sendRequest(get('/echo', { headers: { '  ': 'ghost', 'X-Real': '1' } }));
		expect(r.status).toBe(200);
		expect(seen['/echo'].headers['x-real']).toBe('1');
	});

	test('trims header names', async () => {
		await sendRequest(get('/echo', { headers: { '  X-Spaced  ': 'v' } }));
		expect(seen['/echo'].headers['x-spaced']).toBe('v');
	});
});

describe('sendRequest — variable substitution end to end', () => {
	test('substitutes in URL', async () => {
		const r = await sendRequest({ method: 'GET', url: '{{host}}/json' }, { host: base });
		expect(r.status).toBe(200);
		expect(JSON.parse(r.body).hello).toBe('world');
	});

	test('substitutes in headers', async () => {
		await sendRequest(get('/echo', { headers: { 'X-V': '{{val}}' } }), { val: 'resolved' });
		expect(seen['/echo'].headers['x-v']).toBe('resolved');
	});

	test('substitutes in body', async () => {
		await sendRequest({ method: 'POST', url: base + '/echo', body: raw('{"id":"{{id}}"}', 'json') }, { id: '99' });
		expect(seen['/echo'].body).toBe('{"id":"99"}');
	});

	test('unknown var stays literal', async () => {
		await sendRequest(get('/echo', { headers: { 'X-U': '{{nope}}' } }), {});
		expect(seen['/echo'].headers['x-u']).toBe('{{nope}}');
	});
});

describe('applyPathVars', () => {
	test('replaces :name in the path from vars', () => {
		expect(applyPathVars('https://api.test/users/:id', { id: '42' })).toBe('https://api.test/users/42');
	});

	test('leaves unknown path vars literal', () => {
		expect(applyPathVars('https://api.test/users/:id', {})).toBe('https://api.test/users/:id');
	});

	test('never eats the scheme', () => {
		expect(applyPathVars('https://api.test/x', { https: 'nope' })).toBe('https://api.test/x');
	});

	test('never eats a port', () => {
		expect(applyPathVars('http://localhost:3000/x', { '3000': 'nope' })).toBe('http://localhost:3000/x');
	});

	test('handles several vars and a query value', () => {
		expect(applyPathVars('https://h.test/:a/:b?filter=:c', { a: '1', b: 'two', c: 'x y' })).toBe('https://h.test/1/two?filter=x y');
	});

	test('does not touch colons inside values it just inserted', () => {
		expect(applyPathVars('https://h.test/:a', { a: ':b', b: 'zzz' })).toBe('https://h.test/:b');
	});

	test('url-encodes nothing — the var value is inserted verbatim', () => {
		expect(applyPathVars('https://h.test/:slug', { slug: 'a b' })).toBe('https://h.test/a b');
	});
});

describe('system variables', () => {
	test('$uuid / $timestamp / $randomInt resolve when supplied as vars', () => {
		const vars = { $uuid: '11111111-1111-4111-8111-111111111111', $timestamp: '1700000000', $randomInt: '7' };
		expect(resolveVars('{{$uuid}}|{{$timestamp}}|{{$randomInt}}', vars)).toBe(
			'11111111-1111-4111-8111-111111111111|1700000000|7'
		);
	});

	test('path vars and {{}} vars compose in one live URL', async () => {
		await sendRequest({ method: 'GET', url: '{{host}}/echo/:id' }, { host: base, id: '42' });
		expect(seen['/echo/42']).toBeTruthy();
		expect(seen['/echo/42'].url.endsWith('/echo/42')).toBe(true);
	});
});

describe('unicode variable names', () => {
	test('cyrillic and accented keys resolve', () => {
		expect(resolveVars('{{ключ}}/{{héader}}', { 'ключ': 'a', 'héader': 'b' })).toBe('a/b');
	});

	test('digits and dashes still work', () => {
		expect(resolveVars('{{v1}}-{{a-b}}', { v1: '1', 'a-b': '2' })).toBe('1-2');
	});

	test('unknown unicode var stays literal', () => {
		expect(resolveVars('{{нет}}', {})).toBe('{{нет}}');
	});
});

describe('timing breakdown', () => {
	test('ttfb is reported and never exceeds total time', async () => {
		const r = await sendRequest(get('/slow'));
		expect(r.ttfbMs).toBeGreaterThan(300);
		expect(r.ttfbMs).toBeLessThanOrEqual(r.timeMs);
	});

	test('error responses carry a ttfb too', async () => {
		const r = await sendRequest({ method: 'GET', url: 'http://localhost:1/x', timeoutMs: 2000 });
		expect(r.status).toBe(0);
		expect(typeof r.ttfbMs).toBe('number');
	});
});

describe('sentUrl', () => {
	test('reports the resolved URL, not the template', async () => {
		const r = await sendRequest({ method: 'GET', url: '{{host}}/json' }, { host: base });
		expect(r.sentUrl).toBe(base + '/json');
	});

	test('path vars are visible in sentUrl', async () => {
		const r = await sendRequest({ method: 'GET', url: base + '/json/:id' }, { id: '42' });
		expect(r.sentUrl).toBe(base + '/json/42');
	});
});
