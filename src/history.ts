// Request history — no vscode imports so it stays unit-testable under bun.
//
// One file next to the collections: `.asterisk/history.json` — a flat array, newest first.
// Secrets are stripped on the way in, so a shared/synced `.asterisk` never leaks a token.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HISTORY_FILE = 'history.json';

/** What a redacted value becomes. Fixed, so the entry still shows the header/param existed. */
export const REDACTED = '••••';

// ponytail: 2000 is a safety valve for a hand-edited or huge file, not a feature.
const READ_CAP = 2000;
// ponytail: 8 KB of *characters*, not bytes — cheap and close enough; a multi-byte body
// may land ~24 KB on disk. Switch to a byte-accurate slice only if disk size ever matters.
const BODY_CAP = 8 * 1024;
const TRUNCATED = '…';
const DEFAULT_MAX = 200;

export interface HistoryEntry {
	id: string; // unique per entry
	at: number; // epoch ms
	method: string;
	url: string; // as sent, after variable resolution
	status: number;
	ok: boolean;
	timeMs: number;
	size: number;
	/** Request snapshot for replay. Sensitive values are ALREADY redacted when written. */
	headers: Record<string, string>;
	body?: string; // request body text for raw bodies; undefined otherwise
	error?: string;
}

/** Header names whose values must never be persisted. */
const SECRET_HEADER = /token|secret|password|api[-_]?key|(^|[-_.])sig(nature)?($|[-_.])/i;
const SECRET_HEADER_EXACT = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);

/** Query param names whose values must never be persisted. */
// Word-ish boundaries, not anchors: presigned URLs carry `X-Amz-Signature`, not just `sig`,
// while `design=` / `signal=` must stay readable.
const SECRET_PARAM = /token|secret|password|api[-_]?key|(^|[-_.])sig(nature)?($|[-_.])/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const isSecretHeader = (name: string) => SECRET_HEADER_EXACT.has(name.toLowerCase()) || SECRET_HEADER.test(name);

const safeDecode = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

/** Copy of `headers` with secret values replaced by `REDACTED`. Never throws. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		out[k] = isSecretHeader(k) ? REDACTED : v;
	}
	return out;
}

/** Redact secret-looking query values. Keys, host and fragment are untouched; relative and
 * malformed URLs pass through the same manual split, so nothing here can throw. */
export function redactUrl(url: string): string {
	const hash = url.indexOf('#');
	const beforeHash = hash === -1 ? url : url.slice(0, hash);
	const fragment = hash === -1 ? '' : url.slice(hash);

	// userinfo: `https://user:password@host` must not keep the password
	const schemeEnd = beforeHash.indexOf('//');
	let credentials = '';
	if (schemeEnd !== -1) {
		const authorityStart = schemeEnd + 2;
		const authorityEnd = beforeHash.indexOf('/', authorityStart);
		const authority = authorityEnd === -1 ? beforeHash.slice(authorityStart) : beforeHash.slice(authorityStart, authorityEnd);
		const at = authority.lastIndexOf('@');
		if (at !== -1) {
			const userinfo = authority.slice(0, at);
			const colon = userinfo.indexOf(':');
			if (colon !== -1) {
				credentials = `${userinfo.slice(0, colon)}:${encodeURIComponent(REDACTED)}@`;
			}
		}
	}

	const mark = beforeHash.indexOf('?');
	const rest = mark === -1 ? beforeHash : redactQueryPairs(beforeHash.slice(0, mark), beforeHash.slice(mark + 1));
	const withCredentials = credentials ? rest.replace(/^(\w+:\/\/)[^/]*@/, `$1${credentials}`) : rest;

	// fragment: `#access_token=…` is just as sensitive as a query param
	const safeFragment = fragment.includes('=') ? redactFragment(fragment) : fragment;
	return withCredentials + safeFragment;
}

function redactQueryPairs(head: string, query: string): string {
	const pairs = query.split('&').map((pair) => {
		const eq = pair.indexOf('=');
		if (eq === -1) {return pair;}
		const key = pair.slice(0, eq);
		if (!SECRET_PARAM.test(safeDecode(key))) {return pair;}
		// Encoded so the URL stays ASCII and still parses as a URL.
		return `${key}=${encodeURIComponent(REDACTED)}`;
	});
	return `${head}?${pairs.join('&')}`;
}

function redactFragment(fragment: string): string {
	const body = fragment.slice(1);
	const eq = body.indexOf('=');
	if (eq === -1) {return fragment;}
	const key = body.slice(0, eq);
	if (!SECRET_PARAM.test(safeDecode(key))) {return fragment;}
	return `#${key}=${encodeURIComponent(REDACTED)}`;
}

/** Replace values of secret-looking keys inside a JSON body, or key:value pairs in plain text. */
export function redactBody(text: string): string {
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) {return value.map(walk);}
		if (!isPlainObject(value)) {return value;}
		// null prototype: a `__proto__` key in the body must survive as data, not set a prototype
		const out: Record<string, unknown> = Object.create(null);
		for (const [key, inner] of Object.entries(value)) {
			if (isPlainObject(inner) || Array.isArray(inner)) {out[key] = walk(inner);} else if (SECRET_PARAM.test(key)) {out[key] = REDACTED;} else {out[key] = inner;}
		}
		return out;
	};

	try {
		return JSON.stringify(walk(JSON.parse(text)));
	} catch {
		return redactPlainPairs(text);
	}
}

/**
 * Redact `key: value` / `key=value` pairs in non-JSON text in ONE linear pass.
 * A regex with unbounded `\w*` around the keyword backtracks quadratically on a 1 MB blob
 * (a base64 body with no `=` is enough to hang the extension host), so scan by hand.
 */
function redactPlainPairs(text: string): string {
	const DELIM = /[\s,&"'}{[\]]/;
	// key characters never start right after one of these, so a run of separators stays O(1) each
	const NO_KEY_BEFORE = /[\s,&"'}{[\]:=]/;
	const KEY_WINDOW = 64;
	let out = '';
	let i = 0;

	while (i < text.length) {
		const ch = text[i];
		if (ch !== ':' && ch !== '=') {
			out += ch;
			i++;
			continue;
		}

		// `:::` / `==` runs have no key; bail out before the walk-back so a separator flood stays linear
		if (i > 0 && NO_KEY_BEFORE.test(text[i - 1])) {
			out += ch;
			i++;
			continue;
		}

		// the key is the run of characters before the separator, capped so a huge token stays O(1)
		let start = i;
		const floor = Math.max(0, i - KEY_WINDOW);
		while (start > floor && !DELIM.test(text[start - 1])) {start--;}
		const key = text.slice(start, i).replace(/["']/g, '');

		if (!key || !SECRET_PARAM.test(key)) {
			out += ch;
			i++;
			continue;
		}

		out += ch;
		i++;
		while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {out += text[i++];}

		if (text[i] === '"' || text[i] === "'") {
			const quote = text[i];
			i++;
			while (i < text.length && text[i] !== quote) {i += text[i] === '\\' ? 2 : 1;}
			if (i < text.length) {i++;}
		} else {
			while (i < text.length && !DELIM.test(text[i])) {i++;}
		}
		out += REDACTED;
	}

	return out;
}

/** Build the entry to store from what actually went out. Bodies are redacted, clamped to 8 KB + `…`. */
export function makeEntry(input: {
	method: string; url: string; headers?: Record<string, string>; body?: string;
	status: number; ok: boolean; timeMs: number; size: number; error?: string;
	now?: number; id?: () => string;
}): HistoryEntry {
	const entry: HistoryEntry = {
		id: (input.id ?? randomUUID)(),
		at: input.now ?? Date.now(),
		method: input.method,
		url: redactUrl(input.url),
		status: input.status,
		ok: input.ok,
		timeMs: input.timeMs,
		size: input.size,
		headers: redactHeaders(input.headers ?? {}),
	};
	if (input.body !== undefined) {
		const safe = redactBody(input.body);
		entry.body = safe.length > BODY_CAP ? safe.slice(0, BODY_CAP) + TRUNCATED : safe;
	}
	if (input.error !== undefined) {entry.error = input.error;}
	return entry;
}

/** Coerce one stored row, dropping anything unrecognisable. */
function asEntry(row: unknown): HistoryEntry | undefined {
	if (!isPlainObject(row)) {return undefined;}
	if (typeof row.id !== 'string' || typeof row.method !== 'string' || typeof row.url !== 'string') {return undefined;}

	const headers: Record<string, string> = {};
	if (isPlainObject(row.headers)) {
		for (const [k, v] of Object.entries(row.headers)) {
			if (typeof v === 'string') {headers[k] = v;}
		}
	}

	const entry: HistoryEntry = {
		id: row.id,
		at: typeof row.at === 'number' ? row.at : 0,
		method: row.method,
		url: row.url,
		status: typeof row.status === 'number' ? row.status : 0,
		ok: row.ok === true,
		timeMs: typeof row.timeMs === 'number' ? row.timeMs : 0,
		size: typeof row.size === 'number' ? row.size : 0,
		headers,
	};
	if (typeof row.body === 'string') {entry.body = row.body;}
	if (typeof row.error === 'string') {entry.error = row.error;}
	return entry;
}

/** Newest first. Missing/corrupt file => []. Never throws. */
export function readHistory(dir: string): HistoryEntry[] {
	const file = join(dir, HISTORY_FILE);
	if (!existsSync(file)) {return [];}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {return [];}

	const out: HistoryEntry[] = [];
	for (const row of parsed) {
		if (out.length >= READ_CAP) {break;}
		const entry = asEntry(row);
		if (entry) {out.push(entry);}
	}
	return out;
}

/** Write `<file>.tmp` then rename, so a crash mid-write cannot truncate the real file. */
function writeHistory(dir: string, list: readonly HistoryEntry[]): void {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, HISTORY_FILE);
	const tmp = `${file}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
		renameSync(tmp, file);
	} catch (e: any) {
		rmSync(tmp, { force: true });
		throw new Error(`Cannot write ${HISTORY_FILE}: ${e?.code ?? String(e?.message ?? e)}`);
	}
}

/** Prepend and write, keeping at most `max` entries. No locking: last writer wins. */
export function appendHistory(dir: string, entry: HistoryEntry, max = DEFAULT_MAX): HistoryEntry[] {
	const list = [entry, ...readHistory(dir)].slice(0, Math.max(1, Math.floor(max) || DEFAULT_MAX));
	writeHistory(dir, list);
	return list;
}

export function clearHistory(dir: string): void {
	rmSync(join(dir, HISTORY_FILE), { force: true });
	rmSync(join(dir, `${HISTORY_FILE}.tmp`), { force: true });
}

/** Case-insensitive substring match on method, url, status and body/error text. */
export function searchHistory(entries: readonly HistoryEntry[], query: string): HistoryEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) {return entries.slice();}
	return entries.filter((e) =>
		e.method.toLowerCase().includes(q) ||
		e.url.toLowerCase().includes(q) ||
		String(e.status).includes(q) ||
		(e.body?.toLowerCase().includes(q) ?? false) ||
		(e.error?.toLowerCase().includes(q) ?? false)
	);
}
