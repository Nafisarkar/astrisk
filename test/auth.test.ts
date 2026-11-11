import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_REDIRECT_URI,
	applyAuth,
	cacheKey,
	type Auth,
	type AuthContext,
	type Token,
} from '../src/auth';

interface Call { url: string; init: any }

function fakeFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fn = (async (url: any, init: any) => {
		calls.push({ url: String(url), init });
		return await handler(String(url), init);
	}) as unknown as typeof fetch;
	return { fn, calls };
}

const json = (data: unknown, status = 200, statusText = 'OK') =>
	new Response(JSON.stringify(data), { status, statusText, headers: { 'content-type': 'application/json' } });

const html = (status = 500, statusText = 'Internal Server Error', body = '<html><body>Internal Server Error</body></html>') =>
	new Response(body, { status, statusText });

const req = (over: { url?: string; headers?: Record<string, string> } = {}) => ({
	url: over.url ?? 'https://api.example.com/users',
	headers: over.headers ?? {},
});

const formOf = (call: Call) => new URLSearchParams(String(call.init.body));
const authHeaders = (headers: Record<string, string>) => Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization');

const cc = (over: Partial<Extract<Auth, { type: 'oauth2-cc' }>> = {}): Auth => ({
	type: 'oauth2-cc',
	tokenUrl: 'https://auth.example.com/token',
	clientId: 'cid',
	clientSecret: 'shh-secret',
	...over,
});

const ac = (over: Partial<Extract<Auth, { type: 'oauth2-ac' }>> = {}): Auth => ({
	type: 'oauth2-ac',
	authUrl: 'https://auth.example.com/authorize',
	tokenUrl: 'https://auth.example.com/token',
	clientId: 'cid',
	clientSecret: 'shh-secret',
	...over,
});

describe('cacheKey', () => {
	test('is stable for the same config', () => {
		expect(cacheKey(cc())).toBe(cacheKey(cc()));
		expect(cacheKey({ type: 'none' })).toBe(cacheKey({ type: 'none' }));
		expect(cacheKey(ac())).toBe(cacheKey(ac()));
	});

	test('two different clients get different keys', () => {
		expect(cacheKey(cc())).not.toBe(cacheKey(cc({ clientId: 'other' })));
		expect(cacheKey(ac())).not.toBe(cacheKey(ac({ clientId: 'other' })));
	});

	test('scope is part of the key', () => {
		expect(cacheKey(cc({ scope: 'a' }))).not.toBe(cacheKey(cc({ scope: 'b' })));
		expect(cacheKey(cc({ scope: 'a' }))).not.toBe(cacheKey(cc()));
	});

	test('token url is part of the key', () => {
		expect(cacheKey(cc())).not.toBe(cacheKey(cc({ tokenUrl: 'https://other.example.com/token' })));
	});

	test('different auth types never collide', () => {
		expect(cacheKey({ type: 'bearer', token: 'x' })).not.toBe(cacheKey({ type: 'basic', username: 'x', password: '' }));
		expect(cacheKey(cc())).not.toBe(cacheKey(ac()));
	});

	test('never leaks the client secret', () => {
		expect(cacheKey(cc())).not.toContain('shh-secret');
		expect(cacheKey(ac())).not.toContain('shh-secret');
	});

	test('a colon inside a field cannot collide with another config', () => {
		expect(cacheKey(cc({ clientId: 'a:b', scope: 'c' }))).not.toBe(cacheKey(cc({ clientId: 'a', scope: 'b:c' })));
		expect(cacheKey({ type: 'basic', username: 'a:b', password: 'c' })).not.toBe(
			cacheKey({ type: 'basic', username: 'a', password: 'b:c' })
		);
	});
});

describe('none', () => {
	test('undefined passes through untouched', async () => {
		const out = await applyAuth(req({ headers: { accept: '*/*' } }), undefined);
		expect(out.error).toBeUndefined();
		expect(out.url).toBe('https://api.example.com/users');
		expect(out.headers).toEqual({ accept: '*/*' });
	});

	test('none passes through untouched, even with vars', async () => {
		const out = await applyAuth(req(), { type: 'none' }, { vars: { token: 'abc' } });
		expect(out.error).toBeUndefined();
		expect(out.headers).toEqual({});
	});
});

describe('bearer', () => {
	test('sets Authorization', async () => {
		const out = await applyAuth(req(), { type: 'bearer', token: 'tok-1' });
		expect(out.error).toBeUndefined();
		expect(out.headers['Authorization']).toBe('Bearer tok-1');
	});

	test('substitutes {{vars}} in the token', async () => {
		const out = await applyAuth(req(), { type: 'bearer', token: '{{token}}' }, { vars: { token: 'from-env' } });
		expect(out.headers['Authorization']).toBe('Bearer from-env');
	});

	test('leaves an unknown var visible instead of blanking it', async () => {
		const out = await applyAuth(req(), { type: 'bearer', token: '{{missing}}' });
		expect(out.headers['Authorization']).toBe('Bearer {{missing}}');
	});

	test('replaces a user-set lowercase authorization header', async () => {
		const out = await applyAuth(req({ headers: { authorization: 'Bearer stale', accept: 'application/json' } }), { type: 'bearer', token: 'fresh' });
		expect(authHeaders(out.headers)).toEqual(['Authorization']);
		expect(out.headers['Authorization']).toBe('Bearer fresh');
		expect(out.headers['accept']).toBe('application/json');
	});
});

describe('basic', () => {
	test('base64 of UTF-8 bytes for unicode credentials', async () => {
		const out = await applyAuth(req(), { type: 'basic', username: 'usér', password: 'päss:wörd' });
		expect(out.headers['Authorization']).toBe('Basic dXPDqXI6cMOkc3M6d8O2cmQ=');
	});

	test('a colon in the password is preserved', async () => {
		const out = await applyAuth(req(), { type: 'basic', username: 'user', password: 'a:b' });
		const decoded = Buffer.from(out.headers['Authorization'].replace('Basic ', ''), 'base64').toString('utf8');
		expect(decoded).toBe('user:a:b');
	});

	test('empty username and password are allowed', async () => {
		const out = await applyAuth(req(), { type: 'basic', username: '', password: '' });
		expect(out.headers['Authorization']).toBe('Basic Og==');
	});

	test('replaces an existing Authorization header', async () => {
		const out = await applyAuth(req({ headers: { Authorization: 'Bearer old' } }), { type: 'basic', username: 'u', password: 'p' });
		expect(authHeaders(out.headers)).toEqual(['Authorization']);
	});
});

describe('apikey', () => {
	test('header mode sets the header', async () => {
		const out = await applyAuth(req(), { type: 'apikey', key: 'X-API-Key', value: 'k1', in: 'header' });
		expect(out.headers['X-API-Key']).toBe('k1');
		expect(out.url).toBe('https://api.example.com/users');
	});

	test('header mode replaces a differently-cased existing header', async () => {
		const out = await applyAuth(req({ headers: { 'x-api-key': 'old' } }), { type: 'apikey', key: 'X-API-Key', value: 'new', in: 'header' });
		expect(Object.keys(out.headers)).toEqual(['X-API-Key']);
		expect(out.headers['X-API-Key']).toBe('new');
	});

	test('header mode substitutes vars in key and value', async () => {
		const out = await applyAuth(req(), { type: 'apikey', key: '{{k}}', value: '{{v}}', in: 'header' }, { vars: { k: 'X-Token', v: 'abc' } });
		expect(out.headers['X-Token']).toBe('abc');
	});

	test('query mode on a URL with no query string', async () => {
		const out = await applyAuth(req(), { type: 'apikey', key: 'api_key', value: 'v1', in: 'query' });
		expect(out.url).toBe('https://api.example.com/users?api_key=v1');
		expect(out.headers).toEqual({});
	});

	test('query mode on a URL with an existing ?', async () => {
		const out = await applyAuth(req({ url: 'https://api.example.com/users?page=2' }), { type: 'apikey', key: 'api_key', value: 'v1', in: 'query' });
		expect(out.url).toBe('https://api.example.com/users?page=2&api_key=v1');
	});

	test('query mode keeps the fragment last', async () => {
		const out = await applyAuth(req({ url: 'https://api.example.com/users?page=2#section' }), { type: 'apikey', key: 'api_key', value: 'v1', in: 'query' });
		expect(out.url).toBe('https://api.example.com/users?page=2&api_key=v1#section');
	});

	test('query mode on a bare fragment URL', async () => {
		const out = await applyAuth(req({ url: 'https://api.example.com/users#top' }), { type: 'apikey', key: 'k', value: 'v', in: 'query' });
		expect(out.url).toBe('https://api.example.com/users?k=v#top');
	});

	test('query mode percent-encodes key and value', async () => {
		const out = await applyAuth(req(), { type: 'apikey', key: 'a b&c', value: 'x=y/z?', in: 'query' });
		expect(out.url).toBe('https://api.example.com/users?a%20b%26c=x%3Dy%2Fz%3F');
	});

	test('a blank key name is an error, not a broken request', async () => {
		const out = await applyAuth(req(), { type: 'apikey', key: '  ', value: 'v', in: 'header' });
		expect(out.error).toContain('API key');
		expect(out.headers).toEqual({});
	});

	test('a body location is a readable error, not a fake header', async () => {
		// a stored config can arrive with an unknown location (e.g. hand-edited JSON)
		const body = { type: 'apikey', key: 'k', value: 'v', in: 'body' } as unknown as Auth;
		const out = await applyAuth(req(), body);
		expect(out.error).toBe('API key can be added as a header or a query parameter, not in the body');
		expect(out.headers).toEqual({});
		expect(out.url).toBe('https://api.example.com/users');
	});
});

describe('oauth2 client credentials', () => {
	test('exchanges credentials and sets Authorization', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 }));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });

		expect(out.error).toBeUndefined();
		expect(out.headers['Authorization']).toBe('Bearer at-1');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://auth.example.com/token');
		expect(calls[0].init.method).toBe('POST');
		expect(String(calls[0].init.headers['content-type'])).toBe('application/x-www-form-urlencoded');
		const form = formOf(calls[0]);
		expect(form.get('grant_type')).toBe('client_credentials');
		expect(form.get('client_id')).toBe('cid');
		expect(form.get('client_secret')).toBe('shh-secret');
		expect(form.get('scope')).toBeNull();
	});

	test('sends scope only when non-empty', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at' }));
		await applyAuth(req(), cc({ scope: 'read write' }), { fetch: fn, cache: new Map() });
		expect(formOf(calls[0]).get('scope')).toBe('read write');

		const blank = fakeFetch(() => json({ access_token: 'at' }));
		await applyAuth(req(), cc({ scope: '' }), { fetch: blank.fn, cache: new Map() });
		expect(formOf(blank.calls[0]).get('scope')).toBeNull();
	});

	test('substitutes vars in every oauth field', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at' }));
		const vars = { url: 'https://vars.example.com/token', id: 'v-id', secret: 'v-secret', scope: 's1' };
		await applyAuth(req(), cc({ tokenUrl: '{{url}}', clientId: '{{id}}', clientSecret: '{{secret}}', scope: '{{scope}}' }), { fetch: fn, cache: new Map(), vars });
		expect(calls[0].url).toBe('https://vars.example.com/token');
		expect(formOf(calls[0]).get('client_id')).toBe('v-id');
		expect(formOf(calls[0]).get('scope')).toBe('s1');
	});

	test('reuses a still-valid cached token without calling fetch again', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at', expires_in: 3600 }));
		let clock = 1_000_000;
		const ctx: AuthContext = { fetch: fn, cache: new Map(), now: () => clock };

		await applyAuth(req(), cc(), ctx);
		clock += 60_000;
		const second = await applyAuth(req(), cc(), ctx);

		expect(calls).toHaveLength(1);
		expect(second.headers['Authorization']).toBe('Bearer at');
	});

	test('refetches once the token is expired', async () => {
		let n = 0;
		const { fn, calls } = fakeFetch(() => json({ access_token: `at-${++n}`, expires_in: 3600 }));
		let clock = 1_000_000;
		const ctx: AuthContext = { fetch: fn, cache: new Map(), now: () => clock };

		expect((await applyAuth(req(), cc(), ctx)).headers['Authorization']).toBe('Bearer at-1');
		clock += 3_700_000;
		expect((await applyAuth(req(), cc(), ctx)).headers['Authorization']).toBe('Bearer at-2');
		expect(calls).toHaveLength(2);
	});

	test('refetches within 30s of expiry', async () => {
		let n = 0;
		const { fn, calls } = fakeFetch(() => json({ access_token: `at-${++n}`, expires_in: 60 }));
		let clock = 0;
		const ctx: AuthContext = { fetch: fn, cache: new Map(), now: () => clock };

		await applyAuth(req(), cc(), ctx);
		clock += 20_000; // 40s left: still fine
		await applyAuth(req(), cc(), ctx);
		expect(calls).toHaveLength(1);

		clock += 20_000; // 20s left: inside the skew window
		await applyAuth(req(), cc(), ctx);
		expect(calls).toHaveLength(2);
	});

	test('accepts expires_in as a numeric string', async () => {
		const cache = new Map<string, Token>();
		const { fn } = fakeFetch(() => json({ access_token: 'at', expires_in: '3600' }));
		await applyAuth(req(), cc(), { fetch: fn, cache, now: () => 5_000 });
		expect(cache.get(cacheKey(cc()))?.expiresAt).toBe(5_000 + 3_600_000);
	});

	test('no expires_in gets a bounded TTL instead of caching forever', async () => {
		const cache = new Map<string, Token>();
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at' }));
		let clock = 0;
		const ctx: AuthContext = { fetch: fn, cache, now: () => clock };
		await applyAuth(req(), cc(), ctx);
		// reused while inside the assumed TTL
		await applyAuth(req(), cc(), ctx);
		expect(calls).toHaveLength(1);
		expect(cache.get(cacheKey(cc()))?.expiresAt).toBe(5 * 60_000);
		// after the TTL the token is refetched, so a revoked/rotated secret cannot be used forever
		clock = 6 * 60_000;
		await applyAuth(req(), cc(), ctx);
		expect(calls).toHaveLength(2);
	});

	test('a changed client secret invalidates the cached token immediately', async () => {
		const cache = new Map<string, Token>();
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at', expires_in: 3600 }));
		await applyAuth(req(), cc(), { fetch: fn, cache });
		await applyAuth(req(), { ...cc(), clientSecret: 'different' }, { fetch: fn, cache });
		expect(calls).toHaveLength(2);
	});

	test('caches under cacheKey', async () => {
		const cache = new Map<string, Token>();
		const { fn } = fakeFetch(() => json({ access_token: 'at', refresh_token: 'rt', token_type: 'bearer' }));
		await applyAuth(req(), cc(), { fetch: fn, cache });
		expect(cache.get(cacheKey(cc()))).toMatchObject({ accessToken: 'at', refreshToken: 'rt', tokenType: 'bearer' });
	});

	test('uses the token_type the provider returned instead of always Bearer', async () => {
		const mac = fakeFetch(() => json({ access_token: 'mac-token', token_type: 'mac', expires_in: 3600 }));
		const macOut = await applyAuth(req(), cc(), { fetch: mac.fn, cache: new Map() });
		expect(macOut.headers['Authorization']).toBe('mac mac-token');

		const bearer = fakeFetch(() => json({ access_token: 'at-1', token_type: 'bearer', expires_in: 3600 }));
		const bearerOut = await applyAuth(req(), cc(), { fetch: bearer.fn, cache: new Map() });
		expect(bearerOut.headers['Authorization']).toBe('bearer at-1');
	});

	test('falls back to Bearer when the response names no token_type', async () => {
		const { fn } = fakeFetch(() => json({ access_token: 'at-1', expires_in: 3600 }));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(out.headers['Authorization']).toBe('Bearer at-1');
	});

	test('two different clients do not share a token', async () => {
		const cache = new Map<string, Token>();
		const { fn, calls } = fakeFetch((_url, init) => {
			const id = new URLSearchParams(String(init.body)).get('client_id');
			return json({ access_token: `at-${id}` });
		});
		const a = await applyAuth(req(), cc({ clientId: 'a' }), { fetch: fn, cache });
		const b = await applyAuth(req(), cc({ clientId: 'b' }), { fetch: fn, cache });
		expect(a.headers['Authorization']).toBe('Bearer at-a');
		expect(b.headers['Authorization']).toBe('Bearer at-b');
		expect(calls).toHaveLength(2);
	});

	test('500 with an HTML body becomes an error with status and snippet', async () => {
		const { fn } = fakeFetch(() => html(500, 'Internal Server Error', '<html><body>kaboom</body></html>'));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(out.error).toContain('500');
		expect(out.error).toContain('kaboom');
		expect(out.headers).toEqual({});
		expect(out.url).toBe('https://api.example.com/users');
	});

	test('invalid JSON becomes an error', async () => {
		const { fn } = fakeFetch(() => new Response('not json at all', { status: 200, statusText: 'OK' }));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(out.error).toContain('invalid JSON');
		expect(out.error).toContain('not json at all');
	});

	test('a missing access_token becomes an error', async () => {
		const { fn } = fakeFetch(() => json({ token_type: 'bearer' }));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(out.error).toContain('access_token');
	});

	test('an empty access_token becomes an error', async () => {
		const { fn } = fakeFetch(() => json({ access_token: '   ' }));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(out.error).toContain('access_token');
	});

	test('a non-string access_token becomes an error', async () => {
		const { fn } = fakeFetch(() => json({ access_token: 42 }));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(out.error).toContain('access_token');
	});

	test('a rejected fetch becomes an error, never a throw', async () => {
		const { fn } = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(out.error).toContain('ECONNREFUSED');
		expect(out.headers).toEqual({});
	});

	test('a non-Error rejection still becomes a string error', async () => {
		const { fn } = fakeFetch(() => Promise.reject('nope'));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(typeof out.error).toBe('string');
		expect(out.error).toContain('nope');
	});

	test('a failing token request does not poison the cache', async () => {
		const cache = new Map<string, Token>();
		const { fn } = fakeFetch(() => html(401, 'Unauthorized', 'bad client'));
		await applyAuth(req(), cc(), { fetch: fn, cache });
		expect(cache.size).toBe(0);
	});

	test('the client secret never shows up in an error', async () => {
		const { fn } = fakeFetch(() => html(500, 'Internal Server Error', '<html>leaked shh-secret</html>'));
		const out = await applyAuth(req(), cc(), { fetch: fn, cache: new Map() });
		expect(out.error).toBeDefined();
		expect(out.error).not.toContain('shh-secret');
		expect(out.error).toContain('***');
	});
});

describe('oauth2 authorization code', () => {
	const redirect = (state: string, extra = '') => `http://localhost:8765/callback?code=the-code&state=${state}${extra}`;
	const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';

	test('refuses without an authorize handler', async () => {
		const { fn } = fakeFetch(() => json({ access_token: 'at' }));
		const out = await applyAuth(req(), ac(), { fetch: fn, cache: new Map() });
		expect(out.error).toContain('authorize');
	});

	test('a cancelled authorize returns an error', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at' }));
		const out = await applyAuth(req(), ac(), { fetch: fn, cache: new Map(), authorize: async () => null });
		expect(out.error).toContain('cancelled');
		expect(calls).toHaveLength(0);
	});

	test('builds the authorize URL and exchanges the code', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }));
		const cache = new Map<string, Token>();
		let seen = '';
		const out = await applyAuth(req(), ac({ scope: 'read' }), {
			fetch: fn,
			cache,
			authorize: async (url) => { seen = url; return redirect(stateOf(url)); },
		});

		const authorize = new URL(seen);
		expect(authorize.origin + authorize.pathname).toBe('https://auth.example.com/authorize');
		expect(authorize.searchParams.get('response_type')).toBe('code');
		expect(authorize.searchParams.get('client_id')).toBe('cid');
		expect(authorize.searchParams.get('redirect_uri')).toBe(DEFAULT_REDIRECT_URI);
		expect(authorize.searchParams.get('scope')).toBe('read');
		expect(authorize.searchParams.get('state')).toBeTruthy();

		expect(calls).toHaveLength(1);
		const form = formOf(calls[0]);
		expect(form.get('grant_type')).toBe('authorization_code');
		expect(form.get('code')).toBe('the-code');
		expect(form.get('redirect_uri')).toBe(DEFAULT_REDIRECT_URI);
		expect(form.get('client_id')).toBe('cid');
		expect(form.get('client_secret')).toBe('shh-secret');

		expect(out.error).toBeUndefined();
		expect(out.headers['Authorization']).toBe('Bearer at-1');
		expect(cache.get(cacheKey(ac({ scope: 'read' })))?.refreshToken).toBe('rt-1');
	});

	test('honours a custom redirectUri', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at' }));
		let seen = '';
		await applyAuth(req(), ac({ redirectUri: 'http://127.0.0.1:9999/cb' }), {
			fetch: fn,
			cache: new Map(),
			authorize: async (url) => { seen = url; return `http://127.0.0.1:9999/cb?code=c&state=${stateOf(url)}`; },
		});
		expect(new URL(seen).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9999/cb');
		expect(formOf(calls[0]).get('redirect_uri')).toBe('http://127.0.0.1:9999/cb');
	});

	test('rejects a state mismatch', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at' }));
		const out = await applyAuth(req(), ac(), { fetch: fn, cache: new Map(), authorize: async () => redirect('not-the-state') });
		expect(out.error).toContain('state mismatch');
		expect(calls).toHaveLength(0);
	});

	test('surfaces error=access_denied', async () => {
		const { fn, calls } = fakeFetch(() => json({ access_token: 'at' }));
		const out = await applyAuth(req(), ac(), {
			fetch: fn,
			cache: new Map(),
			authorize: async (url) => `http://localhost:8765/callback?error=access_denied&state=${stateOf(url)}`,
		});
		expect(out.error).toContain('access_denied');
		expect(calls).toHaveLength(0);
	});

	test('a redirect with no code is an error', async () => {
		const { fn } = fakeFetch(() => json({ access_token: 'at' }));
		const out = await applyAuth(req(), ac(), {
			fetch: fn,
			cache: new Map(),
			authorize: async (url) => `http://localhost:8765/callback?state=${stateOf(url)}`,
		});
		expect(out.error).toContain('code');
	});

	test('a throwing authorize becomes an error', async () => {
		const { fn } = fakeFetch(() => json({ access_token: 'at' }));
		const out = await applyAuth(req(), ac(), { fetch: fn, cache: new Map(), authorize: async () => { throw new Error('no browser'); } });
		expect(out.error).toContain('no browser');
	});

	test('an invalid authUrl becomes an error', async () => {
		const { fn } = fakeFetch(() => json({ access_token: 'at' }));
		const out = await applyAuth(req(), ac({ authUrl: 'not a url' }), { fetch: fn, cache: new Map(), authorize: async () => redirect('x') });
		expect(out.error).toContain('invalid authorize URL');
	});

	test('refreshes instead of re-running the browser flow', async () => {
		let n = 0;
		const { fn, calls } = fakeFetch(() => json({ access_token: `at-${++n}`, refresh_token: 'rt-1', expires_in: 3600 }));
		let clock = 1_000_000;
		let authorizeCalls = 0;
		const ctx: AuthContext = {
			fetch: fn,
			cache: new Map(),
			now: () => clock,
			authorize: async (url) => { authorizeCalls++; return redirect(stateOf(url)); },
		};

		expect((await applyAuth(req(), ac(), ctx)).headers['Authorization']).toBe('Bearer at-1');
		clock += 3_700_000;
		const second = await applyAuth(req(), ac(), ctx);

		expect(authorizeCalls).toBe(1);
		expect(second.headers['Authorization']).toBe('Bearer at-2');
		expect(calls).toHaveLength(2);
		const form = formOf(calls[1]);
		expect(form.get('grant_type')).toBe('refresh_token');
		expect(form.get('refresh_token')).toBe('rt-1');
		expect(form.get('code')).toBeNull();
	});

	test('a refresh without a new refresh_token keeps the old one', async () => {
		let n = 0;
		const { fn } = fakeFetch(() => json(n++ === 0 ? { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } : { access_token: 'at-2', expires_in: 3600 }));
		let clock = 0;
		const cache = new Map<string, Token>();
		const ctx: AuthContext = { fetch: fn, cache, now: () => clock, authorize: async (url) => redirect(stateOf(url)) };

		await applyAuth(req(), ac(), ctx);
		clock += 3_700_000;
		await applyAuth(req(), ac(), ctx);

		const stored = cache.get(cacheKey(ac()));
		expect(stored?.accessToken).toBe('at-2');
		expect(stored?.refreshToken).toBe('rt-1');
	});

	test('a failing refresh becomes an error without touching the request', async () => {
		const { fn } = fakeFetch(() => json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }));
		let clock = 0;
		const ctx: AuthContext = { fetch: fn, cache: new Map(), now: () => clock, authorize: async (url) => redirect(stateOf(url)) };
		await applyAuth(req(), ac(), ctx);

		const broken = fakeFetch(() => html(400, 'Bad Request', 'invalid_grant'));
		clock += 3_700_000;
		const out = await applyAuth(req({ headers: { accept: 'text/plain' } }), ac(), { ...ctx, fetch: broken.fn });
		expect(out.error).toContain('invalid_grant');
		expect(out.headers).toEqual({ accept: 'text/plain' });
	});

	test('the access token never appears in an error string', async () => {
		const { fn } = fakeFetch(() => json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }));
		let clock = 0;
		const cache = new Map<string, Token>();
		const ctx: AuthContext = { fetch: fn, cache, now: () => clock, authorize: async (url) => redirect(stateOf(url)) };
		await applyAuth(req(), ac(), ctx);

		const broken = fakeFetch(() => new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
		clock += 3_700_000;
		const out = await applyAuth(req(), ac(), { ...ctx, fetch: broken.fn });
		expect(out.error).toBeDefined();
		expect(out.error).not.toContain('at-1');
		expect(out.error).not.toContain('rt-1');
	});
});
