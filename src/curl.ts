// cURL export/import plus Postman v2.1 / OpenAPI 3.x + 2.0 collection import.
// No vscode, no network, no filesystem — everything here is pure string juggling so it unit-tests
// under bun. User-facing failures are thrown as readable Errors (importers are bulk operations; a
// result object per item buys nobody anything, and callers wrap the whole import anyway).
import type { Auth } from './auth';
import type { Field, FileRef, HttpMethod, RawFormat, RequestBody } from './http';
import type { SavedRequest } from './store';

export interface ImportedRequest {
	name: string;
	folder?: string;
	request: SavedRequest;
}

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_SET = new Set<string>(METHODS);

const OPERATION_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Flags that carry no value: parsed only so the token after them is not mistaken for a URL. */
const IGNORED_FLAGS = new Set([
	'--compressed', '-s', '--silent', '-S', '--show-error', '-k', '--insecure', '-L', '--location',
	'-i', '--include', '-v', '--verbose', '-g', '--globoff', '-N', '--no-buffer', '-f', '--fail',
	'--fail-with-body', '--raw', '--next', '--http1.0', '--http1.1', '--http2', '--http2-prior-knowledge', '--no-progress-meter', '-#', '--progress-bar',
]);

/** Flags whose next token is a value we simply drop. */
const IGNORED_WITH_VALUE = new Set([
	'-o', '--output', '-A', '--user-agent', '-e', '--referer', '-m', '--max-time',
	'--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '-x', '--proxy', '-w',
	'--write-out', '-c', '--cookie-jar', '-D', '--dump-header', '-T', '--upload-file',
	'--cacert', '--capath', '--cert', '--key', '--resolve', '--interface', '--limit-rate',
	// flags that would otherwise swallow the URL (or be mistaken for one)
	'-K', '--config', '-E', '--cert-type', '--key-type', '--proto', '--proto-redir',
]);

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** POSIX single-quoting: `it's` -> `'it'\''s'`. Always quoted, so output is deterministic. */
function quote(value: string): string {
	return `'${value.split("'").join("'\\''")}'`;
}

const isObject = (value: unknown): value is Record<string, any> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNumber = (value: unknown): string =>
	typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** Replace any spelling of `name` (case-insensitive) so auth never duplicates a user header. */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) {delete headers[key];}
	}
	headers[name] = value;
}

function headerKeyOf(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}

/** Append a query param, keeping any `#fragment` last (mirrors auth.ts so URLs look the same). */
function appendQuery(url: string, key: string, value: string): string {
	const hash = url.indexOf('#');
	const base = hash === -1 ? url : url.slice(0, hash);
	const fragment = hash === -1 ? '' : url.slice(hash);
	const sep = !base.includes('?') ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
	return `${base}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${fragment}`;
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || !/^[[{"\d-]/.test(trimmed) && !/^(true|false|null)$/.test(trimmed)) {return false;}
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

/** Guess the raw format from the payload itself — a cURL command carries no format flag we trust. */
function sniffFormat(content: string): RawFormat {
	const trimmed = content.trim();
	if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {return 'html';}
	if (/^<\?xml/i.test(trimmed) || /^<[A-Za-z][\w:.-]*(\s[^>]*)?>/.test(trimmed)) {return 'xml';}
	return looksLikeJson(trimmed) ? 'json' : 'text';
}

// ---------------------------------------------------------------------------------------------
// export: SavedRequest -> cURL
// ---------------------------------------------------------------------------------------------

function bodyArgs(body: RequestBody | undefined): string[] {
	const out: string[] = [];
	if (!body) {return out;}
	switch (body.type) {
		case 'raw':
			out.push('--data-raw', quote(body.content));
			break;

		case 'urlencoded':
			for (const field of body.fields ?? []) {
				out.push('--data-urlencode', quote(`${field.key}=${field.value}`));
			}
			break;

		case 'multipart':
			// ponytail: `-F 'k=@path'` for files, not `--data-binary @path` — the latter would import
			// back as a binary body and break the round trip (and would be wrong curl for multipart).
			// Fields go out as `--form-string`, which curl never interprets: a value like `@home`
			// would otherwise be uploaded as a file.
			for (const field of body.fields ?? []) {
				out.push('--form-string', quote(`${field.key}=${field.value}`));
			}
			for (const file of body.files ?? []) {
				out.push('-F', quote(`${file.key}=@${file.path}`));
			}
			break;

		case 'binary':
			out.push('--data-binary', quote(`@${body.path}`));
			break;
	}
	return out;
}

/** Deterministic single-line cURL command (backslash-free). */
export function toCurl(request: SavedRequest): string {
	let url = request.url;
	const headers: Record<string, string> = { ...(request.headers ?? {}) };
	const auth = request.auth;

	if (auth?.type === 'bearer') {setHeader(headers, 'Authorization', `Bearer ${auth.token}`);}
	if (auth?.type === 'apikey') {
		if (auth.in === 'query') {
			url = appendQuery(url, auth.key, auth.value);
		} else if (auth.key.trim()) {
			setHeader(headers, auth.key, auth.value);
		}
	}

	const args: string[] = ['curl', '-X', request.method];
	for (const [name, value] of Object.entries(headers)) {
		args.push('-H', quote(`${name}: ${value}`));
	}
	args.push(...bodyArgs(request.body));
	if (auth?.type === 'basic') {args.push('-u', quote(`${auth.username}:${auth.password}`));}
	args.push(quote(url));
	return args.join(' ');
}

// ---------------------------------------------------------------------------------------------
// import: cURL -> SavedRequest
// ---------------------------------------------------------------------------------------------

/** ANSI-C quoting (`$'…'`) escapes, minimally: everything else stays verbatim. */
const ANSI_C: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };

/**
 * Shell-ish tokenizer: single quotes verbatim, double quotes with `\"`/`\\`, `\` escapes outside,
 * `$'…'` as an ANSI-C string. Line continuations (`\`, `^`, backtick + newline) are joined *here*,
 * where the quote state is known — flattening the text first would corrupt a multi-line quoted value.
 */
function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let started = false;
	let quoteChar: '"' | "'" | '' = '';

	const flush = () => {
		if (started) {tokens.push(current);}
		current = '';
		started = false;
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoteChar === "'") {
			if (ch === "'") {quoteChar = '';} else {current += ch;}
			continue;
		}
		if (quoteChar === '"') {
			if (ch === '"') {quoteChar = '';}
			else if (ch === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {current += text[++i];}
			else {current += ch;}
			continue;
		}
		// Outside quotes: `\`+newline, `^`+newline, backtick+newline end the line, so they become
		// the separator the flatten-it-first approach used to insert.
		if ((ch === '\\' || ch === '^' || ch === '`') && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
			i += text[i + 1] === '\r' ? 2 : 1;
			flush();
			continue;
		}
		// `$'A: b\nc: d'`: strip the `$` and unescape the ANSI-C body, so the header name stays `A`.
		if (ch === '$' && (text[i + 1] === "'" || text[i + 1] === '"')) {
			const close = text[i + 1];
			started = true;
			for (i += 2; i < text.length && text[i] !== close; i++) {
				if (close === "'" && text[i] === '\\' && i + 1 < text.length) {
					const escaped = text[i + 1];
					current += ANSI_C[escaped] ?? `\\${escaped}`;
					i++;
				} else {current += text[i];}
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quoteChar = ch;
			started = true;
			continue;
		}
		if (ch === '\\' && i + 1 < text.length) {
			current += text[++i];
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		current += ch;
		started = true;
	}
	flush();
	return tokens;
}

/** `;type=…`, `;filename=…`, `;headers=…` — curl part parameters, never part of the value. */
const PART_DIRECTIVE = /^;(?:type|filename|headers|charset)=/i;

/** Drop curl `-F` part directives; a bare `;` (`a;b`) is data and stays. */
function stripPartDirectives(rest: string): string {
	let out = '';
	for (let i = 0; i < rest.length; i++) {
		const directive = rest[i] === ';' ? PART_DIRECTIVE.exec(rest.slice(i)) : null;
		if (!directive) {
			out += rest[i];
			continue;
		}
		i += directive[0].length - 1;
		if (rest[i + 1] === '"') {
			// Quoted directive value: `;headers="X-A: 1;X-B: 2"` keeps its semicolons.
			for (i += 2; i < rest.length && rest[i] !== '"'; i++) {
				if (rest[i] === '\\') {i++;}
			}
		} else {
			while (i + 1 < rest.length && rest[i + 1] !== ';') {i++;}
		}
	}
	return out;
}

const looksLikeUrl = (token: string): boolean =>
	/^https?:\/\//i.test(token) || /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || token.startsWith('{{');

/**
 * Parse a cURL command, with or without line continuations (`\`, `^`, backtick), single or double
 * quotes.
 */
export function fromCurl(text: string): SavedRequest {
	if (typeof text !== 'string' || !text.trim()) {
		throw new Error('Not a cURL command: input is empty');
	}
	const tokens = tokenize(text);
	const start = tokens.findIndex((token) => /^curl(\.exe)?$/i.test(token));
	if (start === -1 && !tokens.some(looksLikeUrl)) {
		throw new Error('Not a cURL command: no "curl" and no URL found in the input');
	}

	let method = '';
	let url = '';
	const headers: Record<string, string> = {};
	const dataParts: string[] = [];
	const urlencoded: Field[] = [];
	const multipartFields: Field[] = [];
	const multipartFiles: FileRef[] = [];
	let binaryPath: string | undefined;
	let basic: { username: string; password: string } | undefined;

	const addHeader = (name: string, value: string) => {
		const existing = headerKeyOf(headers, name);
		headers[existing ?? name] = value;
	};

	for (let i = start + 1; i < tokens.length; i++) {
		let token = tokens[i];
		let inline: string | undefined;
		if (token.startsWith('--')) {
			const eq = token.indexOf('=');
			if (eq > 2) {
				inline = token.slice(eq + 1);
				token = token.slice(0, eq);
			}
		}
		const take = (): string | undefined => (inline !== undefined ? inline : tokens[++i]);

		switch (token) {
			case '-X':
			case '--request': {
				method = (take() ?? '').trim().toUpperCase();
				break;
			}

			case '-H':
			case '--header': {
				const raw = take();
				if (raw === undefined) {break;}
				const colon = raw.indexOf(':');
				if (colon === -1) {
					// curl's empty-value form: `-H 'X;'` sends `X:` with no value.
					if (raw.endsWith(';')) {
						const name = raw.slice(0, -1).trim();
						if (name) {addHeader(name, '');}
					}
					break;
				}
				const name = raw.slice(0, colon).trim();
				if (name) {addHeader(name, raw.slice(colon + 1).trim());}
				break;
			}

			case '-d':
			case '--data':
			case '--data-raw':
			case '--data-ascii':
			case '--json': {
				const raw = take();
				if (raw !== undefined) {dataParts.push(raw);}
				break;
			}

			case '--data-binary': {
				const raw = take();
				if (raw === undefined) {break;}
				if (raw.startsWith('@')) {binaryPath = raw.slice(1);} else {dataParts.push(raw);}
				break;
			}

			case '--data-urlencode': {
				const raw = take();
				if (raw === undefined) {break;}
				const eq = raw.indexOf('=');
				urlencoded.push(eq === -1 ? { key: raw, value: '' } : { key: raw.slice(0, eq), value: raw.slice(eq + 1) });
				break;
			}

			case '-F':
			case '--form':
			case '--form-string': {
				const raw = take();
				if (raw === undefined) {break;}
				const eq = raw.indexOf('=');
				const key = eq === -1 ? raw : raw.slice(0, eq);
				const rest = stripPartDirectives(eq === -1 ? '' : raw.slice(eq + 1));
				if (rest.startsWith('@') && token !== '--form-string') {
					multipartFiles.push({ key, path: rest.slice(1) });
				} else {
					multipartFields.push({ key, value: rest });
				}
				break;
			}

			case '-u':
			case '--user': {
				const raw = take();
				if (raw === undefined) {break;}
				const colon = raw.indexOf(':');
				basic = colon === -1
					? { username: raw, password: '' }
					: { username: raw.slice(0, colon), password: raw.slice(colon + 1) };
				break;
			}

			case '-b':
			case '--cookie': {
				const raw = take();
				if (raw === undefined) {break;}
				const existing = headerKeyOf(headers, 'cookie');
				headers[existing ?? 'Cookie'] = existing ? `${headers[existing]}; ${raw}` : raw;
				break;
			}

			case '--url': {
				const raw = take();
				if (raw !== undefined && !url) {url = raw;}
				break;
			}

			default: {
				if (IGNORED_FLAGS.has(token)) {break;}
				if (IGNORED_WITH_VALUE.has(token)) {
					take();
					break;
				}
				if (!token.startsWith('-') && !url) {url = token;}
				break;
			}
		}
	}

	const resolvedUrl = url.trim();
	if (!resolvedUrl) {
		throw new Error('Not a cURL command: no URL found in the input');
	}

	const hasBody = dataParts.length > 0 || urlencoded.length > 0
		|| multipartFields.length > 0 || multipartFiles.length > 0 || binaryPath !== undefined;
	const resolvedMethod = method || (hasBody ? 'POST' : 'GET');
	if (!METHOD_SET.has(resolvedMethod)) {
		throw new Error(`Unsupported HTTP method "${resolvedMethod}" in cURL command`);
	}

	const request: SavedRequest = { method: resolvedMethod as HttpMethod, url: resolvedUrl };
	if (Object.keys(headers).length > 0) {request.headers = headers;}

	// ponytail: empty `fields`/`files` arrays are dropped, so a hand-written `{fields: []}` comes back
	// without the key. Add a presence marker if exact-shape fidelity ever matters.
	if (multipartFiles.length > 0 || multipartFields.length > 0) {
		const multipart: RequestBody = { type: 'multipart' };
		if (multipartFields.length > 0) {multipart.fields = multipartFields;}
		if (multipartFiles.length > 0) {multipart.files = multipartFiles;}
		request.body = multipart;
	} else if (binaryPath !== undefined) {
		request.body = { type: 'binary', path: binaryPath };
	} else if (urlencoded.length > 0) {
		request.body = { type: 'urlencoded', fields: urlencoded };
	} else if (dataParts.length > 0) {
		const content = dataParts.join('&');
		request.body = { type: 'raw', format: sniffFormat(content), content };
	}

	if (basic) {request.auth = { type: 'basic', username: basic.username, password: basic.password };}
	return request;
}

// ---------------------------------------------------------------------------------------------
// import: Postman v2.1
// ---------------------------------------------------------------------------------------------

function postmanBody(body: unknown): RequestBody | undefined {
	if (!isObject(body)) {return undefined;}
	const mode = str(body.mode);

	if (mode === 'raw') {
		const content = str(body.raw);
		if (!content) {return undefined;}
		const language = str((body.options as any)?.raw?.language).toLowerCase();
		if (language === 'json' || language === 'xml' || language === 'html' || language === 'text') {
			return { type: 'raw', format: language as RawFormat, content };
		}
		return { type: 'raw', format: sniffFormat(content), content };
	}

	if (mode === 'urlencoded') {
		const fields: Field[] = [];
		for (const entry of Array.isArray(body.urlencoded) ? body.urlencoded : []) {
			if (!isObject(entry) || entry.disabled === true) {continue;}
			const key = str(entry.key);
			if (!key) {continue;}
			fields.push({ key, value: strOrNumber(entry.value) });
		}
		return fields.length > 0 ? { type: 'urlencoded', fields } : undefined;
	}

	if (mode === 'formdata') {
		const fields: Field[] = [];
		const files: FileRef[] = [];
		for (const entry of Array.isArray(body.formdata) ? body.formdata : []) {
			if (!isObject(entry) || entry.disabled === true) {continue;}
			const key = str(entry.key);
			if (!key) {continue;}
			const source = str(entry.src);
			if (entry.type === 'file' || source) {
				files.push({ key, path: source });
			} else {
				fields.push({ key, value: strOrNumber(entry.value) });
			}
		}
		if (fields.length === 0 && files.length === 0) {return undefined;}
		const multipart: RequestBody = { type: 'multipart' };
		if (fields.length > 0) {multipart.fields = fields;}
		if (files.length > 0) {multipart.files = files;}
		return multipart;
	}

	if (mode === 'file') {
		const path = str((body.file as any)?.src);
		return path ? { type: 'binary', path } : undefined;
	}

	return undefined;
}

function postmanHeaders(input: unknown): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const entry of Array.isArray(input) ? input : []) {
		if (!isObject(entry) || entry.disabled === true) {continue;}
		const name = str(entry.key).trim();
		if (!name) {continue;}
		headers[name] = strOrNumber(entry.value);
	}
	return headers;
}

function postmanUrl(input: unknown): string {
	if (typeof input === 'string') {return input.trim();}
	if (!isObject(input)) {return '';}

	const raw = str(input.raw).trim();
	// Postman's `raw` already carries the query string; re-appending would duplicate it.
	if (raw) {return raw;}

	const protocol = str(input.protocol) || 'https';
	const host = Array.isArray(input.host) ? input.host.map(str).filter(Boolean).join('.') : str(input.host);
	const port = strOrNumber(input.port);
	const path = Array.isArray(input.path)
		? input.path.map(str).filter(Boolean).join('/')
		: str(input.path).replace(/^\/+/, '');

	let url = host ? `${protocol}://${host}${port ? `:${port}` : ''}` : '';
	if (path) {url += `/${path}`;}
	for (const entry of Array.isArray(input.query) ? input.query : []) {
		if (!isObject(entry) || entry.disabled === true) {continue;}
		const key = str(entry.key);
		if (!key) {continue;}
		url = appendQuery(url, key, strOrNumber(entry.value));
	}
	return url;
}

/** `auth.bearer[0].value` style lookup; `key` names are matched case-insensitively. */
function postmanAuthParam(group: unknown, name: string): string | undefined {
	for (const entry of Array.isArray(group) ? group : []) {
		if (!isObject(entry) || str(entry.key).toLowerCase() !== name) {continue;}
		return strOrNumber(entry.value);
	}
	return undefined;
}

function postmanAuth(input: unknown): Auth | undefined {
	if (!isObject(input)) {return undefined;}
	const type = str(input.type).toLowerCase();

	if (type === 'bearer') {
		const token = postmanAuthParam(input.bearer, 'token');
		return token ? { type: 'bearer', token } : undefined;
	}
	if (type === 'basic') {
		return {
			type: 'basic',
			username: postmanAuthParam(input.basic, 'username') ?? '',
			password: postmanAuthParam(input.basic, 'password') ?? '',
		};
	}
	if (type === 'apikey') {
		const key = postmanAuthParam(input.apikey, 'key');
		if (!key) {return undefined;}
		const where = (postmanAuthParam(input.apikey, 'in') ?? 'header').toLowerCase();
		return {
			type: 'apikey',
			key,
			value: postmanAuthParam(input.apikey, 'value') ?? '',
			in: where === 'query' ? 'query' : 'header',
		};
	}
	return undefined;
}

function postmanRequest(input: unknown): SavedRequest {
	if (typeof input === 'string') {
		return { method: 'GET', url: input.trim() };
	}
	if (!isObject(input)) {throw new Error('request is not an object');}

	const method = (str(input.method).trim() || 'GET').toUpperCase();
	if (!METHOD_SET.has(method)) {throw new Error(`unsupported method "${method}"`);}

	const url = postmanUrl(input.url);
	if (!url) {throw new Error('request has no url');}

	const request: SavedRequest = { method: method as HttpMethod, url };
	const headers = postmanHeaders(input.header);
	if (Object.keys(headers).length > 0) {request.headers = headers;}
	const body = postmanBody(input.body);
	if (body) {request.body = body;}
	const auth = postmanAuth(input.auth);
	if (auth) {request.auth = auth;}
	return request;
}

function walkPostman(items: unknown, folders: string[], out: ImportedRequest[]): void {
	for (const item of Array.isArray(items) ? items : []) {
		if (!isObject(item)) {continue;}
		const name = str(item.name).trim();

		if (Array.isArray(item.item)) {
			walkPostman(item.item, name ? [...folders, name] : folders, out);
			continue;
		}
		if (!('request' in item)) {continue;}

		try {
			const request = postmanRequest(item.request);
			const entry: ImportedRequest = { name: name || request.url || 'Untitled', request };
			if (folders.length > 0) {entry.folder = folders.join('/');}
			out.push(entry);
		} catch {
			// Malformed item: skip it, keep the rest of the collection.
			continue;
		}
	}
}

export function importPostman(json: unknown): ImportedRequest[] {
	if (!isObject(json)) {
		throw new Error('Not a Postman collection: expected a JSON object');
	}
	if (!Array.isArray(json.item)) {
		throw new Error('Not a Postman collection: missing the "item" array (v2.1 format expected)');
	}
	const out: ImportedRequest[] = [];
	walkPostman(json.item, [], out);
	return out;
}

// ---------------------------------------------------------------------------------------------
// import: OpenAPI 3.x / Swagger 2.0
// ---------------------------------------------------------------------------------------------

function openApiServer(root: Record<string, any>): string {
	const servers = Array.isArray(root.servers) ? root.servers : [];
	const first = servers[0];
	if (isObject(first) && str(first.url).trim()) {return str(first.url).trim();}

	const host = str(root.host).trim();
	if (host) {
		const schemes = Array.isArray(root.schemes) ? root.schemes : [];
		const scheme = str(schemes[0]).trim() || 'https';
		const base = str(root.basePath).trim();
		return `${scheme}://${host}${base}`;
	}
	return '';
}

function paramValue(param: Record<string, any>): string {
	const example = param.example ?? param.schema?.example ?? param.schema?.default;
	return strOrNumber(example);
}

function openApiBody(op: Record<string, any>, params: Record<string, any>[]): RequestBody | undefined {
	const content = op.requestBody?.content;
	if (isObject(content)) {
		const media = content['application/json'];
		if (isObject(media)) {
			const example = media.example ?? media.schema?.example;
			if (example !== undefined) {
				const text = typeof example === 'string' ? example : JSON.stringify(example, null, 2);
				return { type: 'raw', format: 'json', content: text };
			}
		}
	}

	// Swagger 2.0: the body lives in a parameter with `in: body`.
	const bodyParam = params.find((param) => param?.in === 'body');
	if (bodyParam) {
		const example = bodyParam.example ?? bodyParam.schema?.example;
		if (example !== undefined) {
			const text = typeof example === 'string' ? example : JSON.stringify(example, null, 2);
			return { type: 'raw', format: 'json', content: text };
		}
	}
	return undefined;
}

function openApiOperation(server: string, method: string, path: string, op: Record<string, any>, params: Record<string, any>[]): ImportedRequest {
	const tags = Array.isArray(op.tags) ? op.tags.filter((tag: unknown) => typeof tag === 'string' && tag.trim()) : [];

	const base = server.endsWith('/') ? server.slice(0, -1) : server;
	let url = `${base}${path}`.replace(/\{([^}]+)\}/g, ':$1');

	const headers: Record<string, string> = {};
	const requiredQuery: string[] = [];
	for (const param of params) {
		if (!isObject(param) || typeof param.name !== 'string' || !param.name) {continue;}
		if (param.in === 'header') {headers[param.name] = paramValue(param);}
		if (param.in === 'query' && param.required === true) {requiredQuery.push(param.name);}
	}
	// Built raw, not through appendQuery: `{{var}}` must survive unencoded so the client can resolve it.
	if (requiredQuery.length > 0) {
		url += `${url.includes('?') ? '&' : '?'}${requiredQuery.map((name) => `${name}={{${name}}}`).join('&')}`;
	}

	// ponytail: only the first tag becomes the folder — deeper nesting has no source in OpenAPI.
	const entry: ImportedRequest = { name: `${method} ${path}`, request: { method: method as HttpMethod, url } };
	if (tags.length > 0) {entry.folder = str(tags[0]);}
	if (Object.keys(headers).length > 0) {entry.request.headers = headers;}
	const body = openApiBody(op, params);
	if (body) {entry.request.body = body;}
	return entry;
}

export function importOpenApi(json: unknown): ImportedRequest[] {
	if (!isObject(json)) {
		throw new Error('Not an OpenAPI document: expected a JSON object');
	}
	const paths = json.paths;
	if (!isObject(paths)) {
		throw new Error('Not an OpenAPI document: missing the "paths" object');
	}

	const server = openApiServer(json);
	const out: ImportedRequest[] = [];

	for (const [path, item] of Object.entries(paths)) {
		if (!path.startsWith('/') || !isObject(item)) {continue;}
		const shared = Array.isArray(item.parameters) ? item.parameters : [];
		for (const method of OPERATION_METHODS) {
			const op = item[method];
			if (!isObject(op) || op.deprecated === true) {continue;}
			const own = Array.isArray(op.parameters) ? op.parameters : [];
			try {
				out.push(openApiOperation(server, method.toUpperCase(), path, op, [...shared, ...own]));
			} catch {
				// Malformed operation: skip it, keep the rest of the document.
				continue;
			}
		}
	}
	return out;
}
