// HTTP engine — no vscode imports so it stays unit-testable under bun.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RawFormat = 'json' | 'text' | 'xml' | 'html';

/** One key/value row. Blank keys are dropped; values may contain {{vars}}. */
export interface Field {
	key: string;
	value: string;
}

/** A file attached to a multipart body. Read from disk at send time. */
export interface FileRef {
	key: string;
	path: string;
}

export type RequestBody =
	| { type: 'none' }
	| { type: 'raw'; format: RawFormat; content: string }
	| { type: 'urlencoded'; fields?: Field[] }
	| { type: 'multipart'; fields?: Field[]; files?: FileRef[] }
	| { type: 'binary'; path: string };

export interface HttpRequest {
	method: HttpMethod;
	url: string;
	headers?: Record<string, string>;
	body?: RequestBody;
	timeoutMs?: number;
	/** Cancels the request from the UI (Escape / Cancel). */
	signal?: AbortSignal;
}

export interface HttpResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	/** URL actually requested, after `{{vars}}` and `:path` resolution. */
	sentUrl: string;
	timeMs: number;
	/** Time until response headers arrived (first byte), for the timing breakdown. */
	ttfbMs: number;
	size: number;
	error?: string;
}

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

const RAW_CONTENT_TYPE: Record<RawFormat, string> = {
	json: 'application/json',
	text: 'text/plain',
	xml: 'application/xml',
	html: 'text/html',
};

/** Resolve {{var}} placeholders. `$` is allowed so system vars like {{$uuid}} work, and the
 * character class is unicode so `{{ключ}}` / `{{héader}}` resolve too.
 * ponytail: flat map only, no nesting — add when vars reference vars. */
export function resolveVars(input: string, vars: Record<string, string> = {}): string {
	return input.replace(/\{\{\s*([\p{L}\p{N}_.$-]+)\s*\}\}/gu, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));
}

/** `/users/:id` -> `/users/42` when `id` is a known var. Ports (`:3000`) and schemes are left alone. */
export function applyPathVars(url: string, vars: Record<string, string> = {}): string {
	return url.replace(/(^|[/?#&=]):([A-Za-z_][\w-]*)/g, (match, lead: string, name: string) =>
		Object.hasOwn(vars, name) ? lead + vars[name] : match
	);
}

/** Turn a body spec into what fetch sends. Multipart gets no Content-Type: fetch must add the boundary. */
function buildBody(body: RequestBody, vars: Record<string, string>): { send?: string | Blob | FormData; contentType?: string } {
	switch (body.type) {
		case 'raw':
			return { send: resolveVars(body.content, vars), contentType: RAW_CONTENT_TYPE[body.format] };

		case 'urlencoded': {
			const params = new URLSearchParams();
			for (const f of body.fields ?? []) {
				if (f.key.trim()) {params.append(resolveVars(f.key, vars), resolveVars(f.value, vars));}
			}
			return { send: params.toString(), contentType: 'application/x-www-form-urlencoded' };
		}

		case 'multipart': {
			const form = new FormData();
			for (const f of body.fields ?? []) {
				if (f.key.trim()) {form.append(resolveVars(f.key, vars), resolveVars(f.value, vars));}
			}
			for (const f of body.files ?? []) {
				if (f.key.trim()) {form.append(resolveVars(f.key, vars), readBlob(f.path), basename(f.path));}
			}
			return { send: form };
		}

		case 'binary':
			return { send: readBlob(body.path), contentType: 'application/octet-stream' };

		default:
			return {};
	}
}

function readBlob(path: string): Blob {
	// ponytail: whole-file sync read in the extension host. Fine up to a few hundred MB;
	// if multi-GB uploads matter, stream with fs.createReadStream + fetch duplex instead.
	try {
		return new Blob([readFileSync(path)]);
	} catch (e: any) {
		throw new Error(`Cannot read file "${path}": ${e?.code === 'ENOENT' ? 'not found' : String(e?.message ?? e)}`);
	}
}

/** Find a header key by case-insensitive name. */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
	return Object.keys(headers).find((k) => k.toLowerCase() === name);
}

export async function sendRequest(req: HttpRequest, vars: Record<string, string> = {}): Promise<HttpResponse> {
	const started = Date.now();
	// Path vars first: a `:id` segment comes from the URL itself. Running it after {{}} substitution
	// would re-scan inserted values and mangle a var whose value happens to contain `/:x`.
	const url = resolveVars(applyPathVars(req.url.trim(), vars), vars);

	if (!/^https?:\/\//i.test(url)) {
		return fail(started, `Invalid URL: "${url}" — must start with http:// or https://`);
	}

	try {
		// Everything that can throw on user input (file reads) stays inside the try.
		const built = BODYLESS.has(req.method) || !req.body ? undefined : buildBody(req.body, vars);

		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers ?? {})) {
			if (k.trim()) {headers[k.trim()] = resolveVars(v, vars);}
		}
		// Auto Content-Type per body type, unless the user set a non-blank one themselves.
		// A blank value (empty header row) counts as unset — a valueless Content-Type helps nobody.
		const userCt = findHeader(headers, 'content-type');
		if (built?.contentType && (userCt === undefined || !headers[userCt].trim())) {
			if (userCt !== undefined) {delete headers[userCt];}
			headers['content-type'] = built.contentType;
		}
		// Multipart: the boundary is generated by fetch, so a hand-set Content-Type would be a lie. Drop it.
		if (built?.send instanceof FormData) {
			for (const k of Object.keys(headers)) {
				if (k.toLowerCase() === 'content-type') {delete headers[k];}
			}
		}

		const res = await fetch(url, {
			method: req.method,
			headers,
			body: built?.send,
			redirect: 'follow',
			signal: req.signal
				? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs ?? 30_000)])
				: AbortSignal.timeout(req.timeoutMs ?? 30_000),
		});

		const ttfbMs = Date.now() - started;
		const text = await res.text();
		const resHeaders: Record<string, string> = {};
		res.headers.forEach((v, k) => (resHeaders[k] = v));

		return {
			ok: res.ok,
			status: res.status,
			statusText: res.statusText,
			headers: resHeaders,
			body: text,
			sentUrl: url,
			timeMs: Date.now() - started,
			ttfbMs,
			size: Buffer.byteLength(text, 'utf8'),
		};
	} catch (e: any) {
		if (req.signal?.aborted) {return fail(started, 'Request cancelled');}
		const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
		if (timedOut) {return fail(started, `Request timed out after ${req.timeoutMs ?? 30_000} ms`);}
		// undici hides the useful part in `cause`: "fetch failed" alone cannot tell a typo'd host
		// (ENOTFOUND) from a dead port (ECONNREFUSED) from a bad certificate
		const cause = e?.cause?.code || e?.cause?.errno || e?.code;
		const detail = String(e?.message ?? e);
		return fail(started, cause && !detail.includes(String(cause)) ? `${detail} (${cause})` : detail);
	}
}

function fail(started: number, error: string): HttpResponse {
	const timeMs = Date.now() - started;
	return { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs, ttfbMs: timeMs, size: 0, error };
}
