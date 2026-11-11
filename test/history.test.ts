import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	HISTORY_FILE,
	REDACTED,
	appendHistory,
	clearHistory,
	makeEntry,
	readHistory,
	redactBody,
	redactHeaders,
	redactUrl,
	searchHistory,
	type HistoryEntry,
} from '../src/history';

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'asterisk-history-'));
	file = join(dir, HISTORY_FILE);
});

const ENC = encodeURIComponent(REDACTED);

let seq = 0;
const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: `id-${++seq}`,
	at: 1_700_000_000_000 + seq,
	method: 'GET',
	url: 'https://api.example.com/users',
	status: 200,
	ok: true,
	timeMs: 12,
	size: 34,
	headers: {},
	...over,
});

const writeRaw = (text: string) => writeFileSync(file, text, 'utf8');
const disk = () => readFileSync(file, 'utf8');
const tmpFile = () => file + '.tmp';

describe('readHistory', () => {
	test('missing dir is an empty history', () => {
		expect(readHistory(join(dir, 'nope'))).toEqual([]);
	});

	test('missing file is an empty history', () => {
		expect(readHistory(dir)).toEqual([]);
	});

	test('corrupt JSON is an empty history, not a throw', () => {
		writeRaw('{ this is not json');
		expect(readHistory(dir)).toEqual([]);
	});

	test('empty file is an empty history', () => {
		writeRaw('');
		expect(readHistory(dir)).toEqual([]);
	});

	test('a JSON object instead of an array is an empty history', () => {
		writeRaw('{"a":1}');
		expect(readHistory(dir)).toEqual([]);
	});

	test('non-object rows are dropped', () => {
		writeRaw(JSON.stringify([null, 'text', 42, true, [], { id: 'x' }]));
		expect(readHistory(dir)).toEqual([]);
	});

	test('rows missing id, method or url are dropped', () => {
		writeRaw(JSON.stringify([
			{ method: 'GET', url: '/a' },
			{ id: '1', url: '/a' },
			{ id: '1', method: 'GET' },
		]));
		expect(readHistory(dir)).toEqual([]);
	});

	test('a minimal valid row gets safe defaults', () => {
		writeRaw(JSON.stringify([{ id: '1', method: 'GET', url: '/a' }]));
		expect(readHistory(dir)).toEqual([
			{ id: '1', at: 0, method: 'GET', url: '/a', status: 0, ok: false, timeMs: 0, size: 0, headers: {} },
		]);
	});

	test('optional body and error survive the round trip', () => {
		const e = entry({ body: '{"a":1}', error: 'boom' });
		writeRaw(JSON.stringify([e]));
		expect(readHistory(dir)[0]).toEqual(e);
	});

	test('non-string header values are dropped', () => {
		writeRaw(JSON.stringify([{ id: '1', method: 'GET', url: '/a', headers: { ok: 'yes', bad: 5 } }]));
		expect(readHistory(dir)[0].headers).toEqual({ ok: 'yes' });
	});

	test('a huge file is clamped to 2000 entries', () => {
		const rows = Array.from({ length: 2500 }, (_, i) => entry({ id: `c-${i}` }));
		writeRaw(JSON.stringify(rows));
		const out = readHistory(dir);
		expect(out).toHaveLength(2000);
		expect(out[0].id).toBe('c-0');
	});

	test('returns newest-first as stored', () => {
		const older = entry({ id: 'older', at: 1 });
		const newer = entry({ id: 'newer', at: 2 });
		writeRaw(JSON.stringify([newer, older]));
		expect(readHistory(dir).map((e) => e.id)).toEqual(['newer', 'older']);
	});
});

describe('appendHistory', () => {
	test('creates the directory when missing', () => {
		const nested = join(dir, '.asterisk');
		appendHistory(nested, entry());
		expect(readHistory(nested)).toHaveLength(1);
	});

	test('prepends, so the newest entry is first', () => {
		appendHistory(dir, entry({ id: 'first' }));
		const list = appendHistory(dir, entry({ id: 'second' }));
		expect(list.map((e) => e.id)).toEqual(['second', 'first']);
		expect(readHistory(dir).map((e) => e.id)).toEqual(['second', 'first']);
	});

	test('returns the new list', () => {
		const e = entry();
		expect(appendHistory(dir, e)).toEqual([e]);
	});

	test('enforces a custom cap, dropping the oldest', () => {
		for (const id of ['a', 'b', 'c', 'd']) {
			appendHistory(dir, entry({ id }), 3);
		}
		expect(readHistory(dir).map((e) => e.id)).toEqual(['d', 'c', 'b']);
	});

	test('enforces the default cap of 200', () => {
		for (let i = 0; i < 205; i++) {
			appendHistory(dir, entry({ id: `e-${i}` }));
		}
		const out = readHistory(dir);
		expect(out).toHaveLength(200);
		expect(out[0].id).toBe('e-204');
	});

	test('writes pretty JSON with a trailing newline', () => {
		appendHistory(dir, entry());
		expect(disk().endsWith(']\n')).toBe(true);
		expect(disk().startsWith('[\n  {')).toBe(true);
	});

	test('leaves no .tmp file behind (atomic write)', () => {
		appendHistory(dir, entry());
		appendHistory(dir, entry());
		expect(readdirSync(dir)).toEqual([HISTORY_FILE]);
	});

	test('a corrupt file does not stop the next append', () => {
		writeRaw('garbage');
		appendHistory(dir, entry({ id: 'fresh' }));
		expect(readHistory(dir).map((e) => e.id)).toEqual(['fresh']);
	});

	test('unicode urls and bodies round-trip', () => {
		const e = entry({ url: 'https://例え.jp/путь?ключ=значение', body: '{"emoji":"🚀","txt":"é"}' });
		appendHistory(dir, e);
		expect(readHistory(dir)[0]).toEqual(e);
	});

	test('a non-positive max still keeps one entry', () => {
		appendHistory(dir, entry({ id: 'a' }), 0);
		expect(readHistory(dir)).toHaveLength(1);
	});
});

describe('clearHistory', () => {
	test('removes the file', () => {
		appendHistory(dir, entry());
		clearHistory(dir);
		expect(readHistory(dir)).toEqual([]);
	});

	test('missing dir or file does not throw', () => {
		expect(() => clearHistory(join(dir, 'nope'))).not.toThrow();
		expect(() => clearHistory(dir)).not.toThrow();
	});

	test('a stray .tmp is cleaned too', () => {
		appendHistory(dir, entry());
		writeFileSync(tmpFile(), 'half', 'utf8');
		clearHistory(dir);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe('searchHistory', () => {
	const list = [
		entry({ id: '1', method: 'GET', url: 'https://api.example.com/users', status: 200 }),
		entry({ id: '2', method: 'POST', url: 'https://api.example.com/orders', status: 404, ok: false, body: '{"sku":"ABC-1"}' }),
		entry({ id: '3', method: 'GET', url: 'https://api.example.com/boom', status: 0, ok: false, error: 'Request timed out' }),
	];

	test('an empty query returns the list unchanged', () => {
		expect(searchHistory(list, '')).toEqual(list);
	});

	test('a whitespace-only query returns the list unchanged', () => {
		expect(searchHistory(list, '   ')).toEqual(list);
	});

	test('matches method case-insensitively', () => {
		expect(searchHistory(list, 'post').map((e) => e.id)).toEqual(['2']);
	});

	test('matches url case-insensitively', () => {
		expect(searchHistory(list, 'ORDERS').map((e) => e.id)).toEqual(['2']);
	});

	test('matches a status code', () => {
		expect(searchHistory(list, '404').map((e) => e.id)).toEqual(['2']);
	});

	test('matches body text', () => {
		expect(searchHistory(list, 'sku').map((e) => e.id)).toEqual(['2']);
	});

	test('matches error text', () => {
		expect(searchHistory(list, 'TIMED OUT').map((e) => e.id)).toEqual(['3']);
	});

	test('preserves the input order of matches', () => {
		expect(searchHistory(list, 'example.com').map((e) => e.id)).toEqual(['1', '2', '3']);
	});

	test('no match is an empty list', () => {
		expect(searchHistory(list, 'zzzz')).toEqual([]);
	});

	test('does not mutate the input', () => {
		const before = JSON.stringify(list);
		searchHistory(list, 'get');
		expect(JSON.stringify(list)).toBe(before);
	});
});

describe('redactHeaders', () => {
	test('redacts authorization', () => {
		expect(redactHeaders({ Authorization: 'Bearer s3cr3t' })).toEqual({ Authorization: REDACTED });
	});

	test('redacts cookie, set-cookie, proxy-authorization and x-api-key', () => {
		expect(redactHeaders({
			Cookie: 'sid=1',
			'Set-Cookie': 'sid=1',
			'Proxy-Authorization': 'Basic x',
			'X-Api-Key': 'k-1',
		})).toEqual({ Cookie: REDACTED, 'Set-Cookie': REDACTED, 'Proxy-Authorization': REDACTED, 'X-Api-Key': REDACTED });
	});

	test('redacts names containing token, secret, password, apikey or api-key', () => {
		const out = redactHeaders({
			'X-Auth-Token': 't',
			'X-Secret': 's',
			'X-Password': 'p',
			Apikey: 'a',
			'API-KEY': 'b',
			'x-refresh-TOKEN': 'c',
		});
		expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED, REDACTED, REDACTED]);
	});

	test('leaves ordinary headers and their casing alone', () => {
		expect(redactHeaders({ Accept: 'application/json', 'X-Trace': 'ok' })).toEqual({
			Accept: 'application/json',
			'X-Trace': 'ok',
		});
	});

	test('does not mutate the input', () => {
		const input = { Authorization: 'Bearer s3cr3t' };
		redactHeaders(input);
		expect(input.Authorization).toBe('Bearer s3cr3t');
	});

	test('empty input is an empty object', () => {
		expect(redactHeaders({})).toEqual({});
	});
});

describe('redactUrl', () => {
	test('redacts a token param and keeps the url parseable', () => {
		const out = redactUrl('https://api.example.com/x?token=abc123');
		expect(out).toBe(`https://api.example.com/x?token=${ENC}`);
		expect(() => new URL(out)).not.toThrow();
	});

	test('redacts api_key, access_token, password, sig and signature', () => {
		const out = redactUrl('https://h/p?api_key=1&access_token=2&password=3&sig=4&signature=5');
		expect(out).toBe(`https://h/p?api_key=${ENC}&access_token=${ENC}&password=${ENC}&sig=${ENC}&signature=${ENC}`);
	});

	test('leaves non-secret params untouched', () => {
		expect(redactUrl('https://h/p?page=2&limit=10')).toBe('https://h/p?page=2&limit=10');
	});

	test('never touches keys or the host', () => {
		const out = redactUrl('https://token.example.com/token?token=abc');
		expect(out).toBe(`https://token.example.com/token?token=${ENC}`);
	});

	test('preserves the fragment', () => {
		expect(redactUrl('https://h/p?token=abc#section-2')).toBe(`https://h/p?token=${ENC}#section-2`);
	});

	test('a url without a query is unchanged', () => {
		expect(redactUrl('https://h/p#frag')).toBe('https://h/p#frag');
	});

	test('a bare value-less param is left alone', () => {
		expect(redactUrl('https://h/p?token')).toBe('https://h/p?token');
	});

	test('relative urls are redacted, not thrown at', () => {
		expect(() => redactUrl('/users?token=abc')).not.toThrow();
		expect(redactUrl('/users?token=abc')).toBe(`/users?token=${ENC}`);
	});

	test('a malformed url does not throw', () => {
		expect(() => redactUrl('%%%?a=%&token=%E0%A4%A')).not.toThrow();
		expect(redactUrl('%%%?a=%&token=%E0%A4%A')).toBe(`%%%?a=%&token=${ENC}`);
	});

	test('an empty string is returned as-is', () => {
		expect(redactUrl('')).toBe('');
	});

	test('signature params are redacted, look-alike keys are not', () => {
		expect(redactUrl(`https://h?x-sig=1`)).toBe(`https://h?x-sig=${ENC}`);
		expect(redactUrl(`https://bucket?sig=abc`)).toBe(`https://bucket?sig=${ENC}`);
		expect(redactUrl(`https://bucket?X-Amz-Signature=abc&X-Amz-Date=1`)).toBe(`https://bucket?X-Amz-Signature=${ENC}&X-Amz-Date=1`);
		expect(redactUrl('https://h?design=1&signal=2&sigv4=3')).toBe('https://h?design=1&signal=2&sigv4=3');
	});

	test('multiple occurrences are all redacted', () => {
		expect(redactUrl('https://h?token=a&token=b')).toBe(`https://h?token=${ENC}&token=${ENC}`);
	});
});

describe('makeEntry', () => {
	test('uses the injected clock and id', () => {
		const e = makeEntry({ method: 'GET', url: '/a', status: 200, ok: true, timeMs: 5, size: 6, now: 42, id: () => 'fixed' });
		expect(e.id).toBe('fixed');
		expect(e.at).toBe(42);
	});

	test('defaults to Date.now() and a generated id', () => {
		const before = Date.now();
		const e = makeEntry({ method: 'GET', url: '/a', status: 200, ok: true, timeMs: 5, size: 6 });
		expect(e.at).toBeGreaterThanOrEqual(before);
		expect(typeof e.id).toBe('string');
		expect(e.id.length).toBeGreaterThan(0);
	});

	test('ids are unique across entries', () => {
		const a = makeEntry({ method: 'GET', url: '/a', status: 200, ok: true, timeMs: 1, size: 1 });
		const b = makeEntry({ method: 'GET', url: '/a', status: 200, ok: true, timeMs: 1, size: 1 });
		expect(a.id).not.toBe(b.id);
	});

	test('redacts headers and the url itself', () => {
		const e = makeEntry({
			method: 'POST',
			url: 'https://api.example.com/login?access_token=abc',
			headers: { Authorization: 'Bearer s3cr3t', 'X-Trace': 'ok' },
			status: 201,
			ok: true,
			timeMs: 8,
			size: 9,
		});
		expect(e.headers).toEqual({ Authorization: REDACTED, 'X-Trace': 'ok' });
		expect(e.url).toBe(`https://api.example.com/login?access_token=${ENC}`);
	});

	test('omits body and error when not given', () => {
		const e = makeEntry({ method: 'GET', url: '/a', status: 200, ok: true, timeMs: 1, size: 0 });
		expect('body' in e).toBe(false);
		expect('error' in e).toBe(false);
		expect(e.headers).toEqual({});
	});

	test('keeps a short body as-is and a short error', () => {
		const e = makeEntry({ method: 'POST', url: '/a', body: '{"a":1}', status: 0, ok: false, timeMs: 1, size: 0, error: 'boom' });
		expect(e.body).toBe('{"a":1}');
		expect(e.error).toBe('boom');
	});

	test('truncates a body over 8 KB and marks it', () => {
		const big = 'x'.repeat(9000);
		const e = makeEntry({ method: 'POST', url: '/a', body: big, status: 200, ok: true, timeMs: 1, size: 0 });
		expect(e.body!.length).toBe(8 * 1024 + 1);
		expect(e.body!.endsWith('…')).toBe(true);
		expect(e.body!.startsWith('xxxx')).toBe(true);
	});

	test('leaves a body of exactly 8 KB intact', () => {
		const exact = 'y'.repeat(8 * 1024);
		const e = makeEntry({ method: 'POST', url: '/a', body: exact, status: 200, ok: true, timeMs: 1, size: 0 });
		expect(e.body).toBe(exact);
	});

	test('no secret reaches disk after append', () => {
		const e = makeEntry({
			method: 'POST',
			url: 'https://api.example.com/x?token=topsecret&page=1',
			headers: { Authorization: 'Bearer s3cr3t', Cookie: 'sid=s3cr3t', 'X-Trace': 'ok' },
			status: 200,
			ok: true,
			timeMs: 1,
			size: 2,
		});
		appendHistory(dir, e);
		const text = disk();
		expect(text).not.toContain('s3cr3t');
		expect(text).not.toContain('topsecret');
		expect(text).not.toContain('Bearer');
		expect(text).toContain(REDACTED);
		expect(text).toContain('page=1');
		expect(text).toContain('X-Trace');
	});

	test('query secrets are redacted even for a relative target', () => {
		const e = makeEntry({ method: 'GET', url: '/local?api_key=abc', status: 200, ok: true, timeMs: 1, size: 0 });
		appendHistory(dir, e);
		expect(disk()).not.toContain('abc');
	});
});

describe('redactBody', () => {
	test('JSON bodies lose secret values, other fields survive', () => {
		const out = redactBody('{"user":"ada","password":"s3cr3t","nested":{"access_token":"abc","ok":1}}');
		expect(out).not.toContain('s3cr3t');
		expect(out).not.toContain('abc');
		expect(JSON.parse(out)).toEqual({ user: 'ada', password: REDACTED, nested: { access_token: REDACTED, ok: 1 } });
	});

	test('arrays of objects are walked', () => {
		const out = redactBody('[{"client_secret":"x"},{"keep":"y"}]');
		expect(out).not.toContain('"x"');
		expect(JSON.parse(out)).toEqual([{ client_secret: REDACTED }, { keep: 'y' }]);
	});

	test('non-JSON text loses key:value secrets', () => {
		const out = redactBody('user=ada&password=hunter2&sig=deadbeef');
		expect(out).not.toContain('hunter2');
		expect(out).not.toContain('deadbeef');
		expect(out).toContain('user=ada');
	});

	test('plain text without secrets is untouched', () => {
		expect(redactBody('hello world')).toBe('hello world');
	});

	test('makeEntry redacts the body it stores', () => {
		const entry = makeEntry({ method: 'POST', url: 'https://h', body: '{"password":"s3cr3t"}', status: 200, ok: true, timeMs: 1, size: 1 });
		expect(entry.body).not.toContain('s3cr3t');
	});
});

describe('redaction gaps found by bug hunt', () => {
	test('userinfo passwords are redacted', () => {
		expect(redactUrl('https://user:password123@h.test/x')).toBe(`https://user:${ENC}@h.test/x`);
	});

	test('fragment secrets are redacted', () => {
		expect(redactUrl('https://h.test/cb#access_token=tok123')).toBe(`https://h.test/cb#access_token=${ENC}`);
		expect(redactUrl('https://h.test/x#section')).toBe('https://h.test/x#section');
	});

	test('a __proto__ key in a JSON body survives as data', () => {
		expect(JSON.parse(redactBody('{"__proto__":1,"password":"x"}'))).toEqual({ ['__proto__']: 1, password: REDACTED });
	});

	test('non-JSON redaction is linear, not quadratic', () => {
		const started = Date.now();
		redactBody('a'.repeat(1_000_000));
		redactBody(':'.repeat(1_000_000));
		redactBody('password=x&'.repeat(50_000));
		expect(Date.now() - started).toBeLessThan(1500);
	});
});
