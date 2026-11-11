// Auth — no vscode imports so it stays unit-testable under bun.
//
// One entry point: `applyAuth` takes the request about to be sent and returns it with auth applied.
// User-facing failures come back as `error` strings, never exceptions, matching http.ts.
import { createHash, randomUUID } from 'node:crypto';
import { resolveVars } from './http';

export type Auth =
	| { type: 'none' }
	| { type: 'bearer'; token: string }
	| { type: 'basic'; username: string; password: string }
	| { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }
	| { type: 'oauth2-cc'; tokenUrl: string; clientId: string; clientSecret: string; scope?: string }
	| { type: 'oauth2-ac'; authUrl: string; tokenUrl: string; clientId: string; clientSecret: string; scope?: string; redirectUri?: string };

export interface Token { accessToken: string; refreshToken?: string; tokenType?: string; expiresAt?: number }

export interface AuthContext {
	vars?: Record<string, string>;                     // {{var}} substitution inside every auth field
	fetch?: typeof fetch;                              // injectable, defaults to global fetch
	now?: () => number;                                // injectable clock, defaults Date.now
	cache?: Map<string, Token>;                        // injectable token cache, defaults to a module-level one
	authorize?: (url: string) => Promise<string | null>; // authorization-code only; redirect URL or null
}

export interface AuthedRequest { url: string; headers: Record<string, string>; error?: string }

export const DEFAULT_REDIRECT_URI = 'http://localhost:8765/callback';

// Refetch this close to expiry instead of racing the clock with a token that dies mid-request.
const EXPIRY_SKEW_MS = 30_000;
// Providers that omit expires_in still get a bounded cache lifetime, so a changed secret or a
// revoked token can never be used forever.
const ASSUMED_TTL_MS = 5 * 60_000;
// A hung token endpoint must not hang a send.
const TOKEN_TIMEOUT_MS = 30_000;
const SNIPPET_MAX = 120;

// ponytail: process-wide cache, never evicted. Tokens are small and keyed by client config; if this
// ever matters, cap it at ~50 entries with LRU eviction.
const defaultCache = new Map<string, Token>();

/** Short stable fingerprint, so a cache key can distinguish secrets without storing them. */
const fingerprint = (secret: string): string => createHash('sha256').update(secret).digest('hex').slice(0, 12);

/**
 * Stable, opaque cache key per auth config, built from a JSON array so no field can smuggle a
 * separator into another field's slot. OAuth keys include a *hash* of the client secret, so
 * switching environments immediately invalidates the cached token instead of reusing somebody else's.
 */
export function cacheKey(auth: Auth): string {
	switch (auth.type) {
		case 'none': return JSON.stringify(['none']);
		case 'bearer': return JSON.stringify(['bearer', auth.token]);
		case 'basic': return JSON.stringify(['basic', auth.username, auth.password]);
		case 'apikey': return JSON.stringify(['apikey', auth.in, auth.key, auth.value]);
		case 'oauth2-cc':
			return JSON.stringify(['oauth2-cc', auth.tokenUrl, auth.clientId, auth.scope ?? '', fingerprint(auth.clientSecret)]);
		case 'oauth2-ac':
			return JSON.stringify(['oauth2-ac', auth.authUrl, auth.tokenUrl, auth.clientId, auth.scope ?? '', fingerprint(auth.clientSecret), auth.redirectUri ?? '']);
	}
}

type TokenResult = Token | { error: string };

const isError = (r: TokenResult): r is { error: string } => 'error' in r;

const message = (e: unknown): string => String((e as any)?.message ?? e);

/** {{var}} everywhere a string lives — one loop, so a new field can never forget substitution. */
function substAuth(auth: Auth, vars: Record<string, string>): Auth {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(auth)) {
		out[k] = typeof v === 'string' ? resolveVars(v, vars) : v;
	}
	return out as unknown as Auth;
}

/** Set a header, dropping any existing spelling of the same name first (case-insensitive). */
function withHeader(request: AuthedRequest, name: string, value: string): AuthedRequest {
	const headers: Record<string, string> = {};
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(request.headers)) {
		if (k.toLowerCase() !== lower) {headers[k] = v;}
	}
	headers[name] = value;
	return { url: request.url, headers };
}

/** Append a query param, keeping any `#fragment` last and percent-encoding both parts. */
function addQuery(url: string, key: string, value: string): string {
	const hash = url.indexOf('#');
	const base = hash === -1 ? url : url.slice(0, hash);
	const fragment = hash === -1 ? '' : url.slice(hash);
	const sep = !base.includes('?') ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
	return `${base}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${fragment}`;
}

/** One-line, length-capped echo of a body — enough to debug, too small to leak a whole payload. */
function snippet(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (!flat) {return '';}
	return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat;
}

function stillValid(token: Token, nowMs: number): boolean {
	if (token.expiresAt === undefined) {return false;}
	return token.expiresAt - nowMs > EXPIRY_SKEW_MS;
}

function expiresAtOf(data: any, nowMs: number): number | undefined {
	const raw = data?.expires_in;
	const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
	if (!Number.isFinite(seconds)) {return undefined;}
	return nowMs + seconds * 1000;
}

function toToken(data: any, nowMs: number): Token {
	const token: Token = { accessToken: data.access_token };
	if (typeof data.refresh_token === 'string' && data.refresh_token) {token.refreshToken = data.refresh_token;}
	if (typeof data.token_type === 'string' && data.token_type) {token.tokenType = data.token_type;}
	// No expires_in: assume a short TTL rather than caching the token forever.
	token.expiresAt = expiresAtOf(data, nowMs) ?? nowMs + ASSUMED_TTL_MS;
	return token;
}

/** POST an x-www-form-urlencoded grant and turn the reply into a Token. Never throws. */
async function postForm(ctx: AuthContext, label: string, url: string, form: URLSearchParams, nowMs: number): Promise<TokenResult> {
	const doFetch = ctx.fetch ?? fetch;
	let res: Response;
	try {
		res = await doFetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
			body: form.toString(),
			signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
		});
	} catch (e: unknown) {
		return { error: `${label}: cannot reach ${url} — ${message(e)}` };
	}

	let text: string;
	try {
		text = await res.text();
	} catch (e: unknown) {
		return { error: `${label}: cannot read the response from ${url} — ${message(e)}` };
	}
	const echo = snippet(text);

	if (!res.ok) {
		return { error: `${label}: ${url} returned ${res.status} ${res.statusText}${echo ? ` — ${echo}` : ''}`.trim() };
	}

	let data: any;
	try {
		data = JSON.parse(text);
	} catch {
		return { error: `${label}: ${url} returned invalid JSON (${res.status})${echo ? ` — ${echo}` : ''}` };
	}
	if (!data || typeof data.access_token !== 'string' || !data.access_token.trim()) {
		return { error: `${label}: ${url} returned no access_token (${res.status})${echo ? ` — ${echo}` : ''}` };
	}
	return toToken(data, nowMs);
}

/** Cached token if still good, otherwise ask `fetchToken` (handed the stale one for refresh). */
async function obtain(key: string, ctx: AuthContext, nowMs: number, fetchToken: (prev?: Token) => Promise<TokenResult>): Promise<TokenResult> {
	const cache = ctx.cache ?? defaultCache;
	const hit = cache.get(key);
	if (hit && stillValid(hit, nowMs)) {return hit;}

	const result = await fetchToken(hit);
	if (isError(result)) {return result;}
	cache.set(key, result);
	return result;
}

function clientCredentialsToken(auth: Extract<Auth, { type: 'oauth2-cc' }>, ctx: AuthContext, nowMs: number): Promise<TokenResult> {
	return obtain(cacheKey(auth), ctx, nowMs, () => {
		const form = new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: auth.clientId,
			client_secret: auth.clientSecret,
		});
		if (auth.scope && auth.scope.trim()) {form.set('scope', auth.scope);}
		return postForm(ctx, 'OAuth2 client credentials', auth.tokenUrl, form, nowMs);
	});
}

async function browserFlow(auth: Extract<Auth, { type: 'oauth2-ac' }>, ctx: AuthContext, nowMs: number): Promise<TokenResult> {
	const label = 'OAuth2 authorization code';
	if (!ctx.authorize) {return { error: `${label}: no browser flow available (no authorize handler)` };}

	const redirectUri = auth.redirectUri ?? DEFAULT_REDIRECT_URI;
	const state = randomUUID();
	let authorizeUrl: string;
	try {
		const u = new URL(auth.authUrl);
		u.searchParams.set('response_type', 'code');
		u.searchParams.set('client_id', auth.clientId);
		u.searchParams.set('redirect_uri', redirectUri);
		u.searchParams.set('state', state);
		if (auth.scope && auth.scope.trim()) {u.searchParams.set('scope', auth.scope);}
		authorizeUrl = u.toString();
	} catch {
		return { error: `${label}: invalid authorize URL "${auth.authUrl}"` };
	}

	let callback: string | null;
	try {
		callback = await ctx.authorize(authorizeUrl);
	} catch (e: unknown) {
		return { error: `${label}: authorization failed — ${message(e)}` };
	}
	if (!callback) {return { error: `${label}: authorization cancelled` };}

	let back: URL;
	try {
		back = new URL(callback);
	} catch {
		return { error: `${label}: the authorize handler returned an invalid redirect URL` };
	}

	const denied = back.searchParams.get('error');
	if (denied) {
		const description = back.searchParams.get('error_description');
		return { error: `${label}: provider returned "${denied}"${description ? ` — ${description}` : ''}` };
	}
	if (back.searchParams.get('state') !== state) {
		return { error: `${label}: state mismatch — the redirect does not belong to this request` };
	}
	const code = back.searchParams.get('code');
	if (!code) {return { error: `${label}: the redirect carried no "code"` };}

	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		client_id: auth.clientId,
		client_secret: auth.clientSecret,
	});
	return postForm(ctx, label, auth.tokenUrl, form, nowMs);
}

function authorizationCodeToken(auth: Extract<Auth, { type: 'oauth2-ac' }>, ctx: AuthContext, nowMs: number): Promise<TokenResult> {
	return obtain(cacheKey(auth), ctx, nowMs, async (prev) => {
		// A refresh token means no browser popup on the second run.
		if (!prev?.refreshToken) {return browserFlow(auth, ctx, nowMs);}
		const form = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: prev.refreshToken,
			client_id: auth.clientId,
			client_secret: auth.clientSecret,
		});
		const result = await postForm(ctx, 'OAuth2 refresh', auth.tokenUrl, form, nowMs);
		if (isError(result)) {
			// some providers echo the presented refresh token back in an error payload
			return { error: scrub(result.error, auth, { accessToken: prev.accessToken, refreshToken: prev.refreshToken }) };
		}
		// Providers that rotate refresh tokens send a new one; the ones that don't must keep the old.
		if (!isError(result) && !result.refreshToken) {result.refreshToken = prev.refreshToken;}
		return result;
	});
}

/** Last line of defence: no error string ever carries the client secret or a token. */
function scrub(text: string, auth: Auth | undefined, token?: Token): string {
	const secrets: string[] = [];
	if (auth && 'clientSecret' in auth && auth.clientSecret) {secrets.push(auth.clientSecret);}
	if (token?.accessToken) {secrets.push(token.accessToken);}
	if (token?.refreshToken) {secrets.push(token.refreshToken);}
	let out = text;
	for (const s of secrets) {out = out.split(s).join('***');}
	return out;
}

/** Apply auth to a request. Never throws; on failure returns the input untouched plus `error`. */
export async function applyAuth(
	request: { url: string; headers: Record<string, string> },
	auth: Auth | undefined,
	ctx: AuthContext = {}
): Promise<AuthedRequest> {
	const untouched: AuthedRequest = { url: request.url, headers: { ...request.headers } };
	if (!auth || auth.type === 'none') {return untouched;}

	const vars = ctx.vars ?? {};
	const nowMs = (ctx.now ?? Date.now)();
	const resolved = substAuth(auth, vars);

	try {
		switch (resolved.type) {
			case 'bearer':
				return withHeader(untouched, 'Authorization', `Bearer ${resolved.token}`);

			case 'basic': {
				// base64 over UTF-8 bytes, so unicode usernames/passwords survive; ':' in the password is fine.
				const pair = Buffer.from(`${resolved.username}:${resolved.password}`, 'utf8').toString('base64');
				return withHeader(untouched, 'Authorization', `Basic ${pair}`);
			}

			case 'apikey': {
				if (!resolved.key.trim()) {return { ...untouched, error: 'API key: the key name is empty' };}
				// A stored config loaded from JSON can carry `in: "body"`; say so instead of faking a header.
				const where: string = resolved.in;
				if (where !== 'header' && where !== 'query') {
					return { ...untouched, error: 'API key can be added as a header or a query parameter, not in the body' };
				}
				if (where === 'query') {return { url: addQuery(untouched.url, resolved.key, resolved.value), headers: untouched.headers };}
				return withHeader(untouched, resolved.key, resolved.value);
			}

			case 'oauth2-cc':
			case 'oauth2-ac': {
				const result = resolved.type === 'oauth2-cc'
					? await clientCredentialsToken(resolved, ctx, nowMs)
					: await authorizationCodeToken(resolved, ctx, nowMs);
				if (isError(result)) {return { ...untouched, error: scrub(result.error, resolved) };}
				// The provider picks the scheme (`Bearer`, `mac`, …); never stamp Bearer onto a mac token.
				return withHeader(untouched, 'Authorization', `${result.tokenType?.trim() || 'Bearer'} ${result.accessToken}`);
			}

			default:
				return { ...untouched, error: `Unsupported auth type "${String((resolved as any).type)}"` };
		}
	} catch (e: unknown) {
		// Nothing above should throw — this keeps the "never throws" promise even for surprises.
		return { ...untouched, error: scrub(`Auth failed: ${message(e)}`, resolved) };
	}
}
