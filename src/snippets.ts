// Code snippets for a saved request in four languages — no vscode, no network, pure string work.
//
// `curl` delegates to curl.ts for quoting. The other three emit runnable code, and anything that
// cannot be inlined (a file body, a multipart upload) becomes a TODO comment rather than a snippet
// that silently sends the wrong thing.
import { toCurl } from './curl';
import type { Field, FileRef, RawFormat, RequestBody } from './http';
import type { SavedRequest } from './store';

export type SnippetLang = 'curl' | 'fetch' | 'python' | 'go';

const RAW_CONTENT_TYPE: Record<RawFormat, string> = {
	json: 'application/json',
	text: 'text/plain',
	xml: 'application/xml',
	html: 'text/html',
};
const URLENCODED_TYPE = 'application/x-www-form-urlencoded';
const BINARY_TYPE = 'application/octet-stream';

const JS = '  ';   // generated JS indents with two spaces
const GO = '\t';   // gofmt uses tabs

// helpers

const str = (value: unknown): string =>
	typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

const isObject = (value: unknown): value is Record<string, any> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

/**
 * One double-quoted literal for JS, Python and Go — all three agree on this escape set, so a single
 * pass serves every language (quadratic concatenation is the classic bug here; this replaces once).
 */
function q(value: unknown): string {
	return `"${str(value).replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
		switch (ch) {
			case '\\': return '\\\\';
			case '"': return '\\"';
			case '\n': return '\\n';
			case '\r': return '\\r';
			case '\t': return '\\t';
			case '\b': return '\\b';
			case '\f': return '\\f';
			default: return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
		}
	})}"`;
}

/** Comment text must stay on one line — a newline in a path would end the comment and break the code. */
const flat = (text: unknown): string => str(text).replace(/[\r\n]+/g, ' ').trim();

function liveFields(fields: Field[] | undefined): Field[] {
	const out: Field[] = [];
	for (const field of Array.isArray(fields) ? fields : []) {
		if (!isObject(field)) {continue;}
		const key = str(field.key);
		if (key.trim()) {out.push({ key, value: str(field.value) });}
	}
	return out;
}

function liveFiles(files: FileRef[] | undefined): FileRef[] {
	const out: FileRef[] = [];
	for (const file of Array.isArray(files) ? files : []) {
		if (!isObject(file)) {continue;}
		const key = str(file.key);
		if (key.trim()) {out.push({ key, path: str(file.path) });}
	}
	return out;
}

function parsedJson(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) {return false;}
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

// the request, flattened into what every generator needs

interface Plan {
	kind: 'none' | 'raw' | 'urlencoded' | 'multipart' | 'binary';
	format: RawFormat;
	content: string;
	fields: Field[];
	files: FileRef[];
	path: string;
}

function planOf(body: RequestBody | undefined): Plan {
	const plan: Plan = { kind: 'none', format: 'text', content: '', fields: [], files: [], path: '' };
	if (!isObject(body)) {return plan;}
	switch ((body as RequestBody).type) {
		case 'raw': {
			const raw = body as Extract<RequestBody, { type: 'raw' }>;
			const format = raw.format;
			plan.kind = 'raw';
			plan.format = format === 'json' || format === 'xml' || format === 'html' ? format : 'text';
			plan.content = str(raw.content);
			return plan;
		}
		case 'urlencoded':
			plan.kind = 'urlencoded';
			plan.fields = liveFields((body as Extract<RequestBody, { type: 'urlencoded' }>).fields);
			return plan;
		case 'multipart': {
			const multi = body as Extract<RequestBody, { type: 'multipart' }>;
			plan.kind = 'multipart';
			plan.fields = liveFields(multi.fields);
			plan.files = liveFiles(multi.files);
			return plan;
		}
		case 'binary':
			plan.kind = 'binary';
			plan.path = str((body as Extract<RequestBody, { type: 'binary' }>).path);
			return plan;
		default:
			return plan;
	}
}

function contentTypeOf(plan: Plan): string {
	if (plan.kind === 'raw') {return RAW_CONTENT_TYPE[plan.format];}
	if (plan.kind === 'urlencoded') {return URLENCODED_TYPE;}
	if (plan.kind === 'binary') {return BINARY_TYPE;}
	return '';
}

/** Saved headers, plus the Content-Type http.ts would have sent anyway (mirrors it so snippets run). */
function headersFor(request: SavedRequest, plan: Plan): Record<string, string> {
	const headers: Record<string, string> = {};
	const input = isObject(request.headers) ? request.headers : {};
	for (const [name, value] of Object.entries(input)) {
		if (name.trim()) {headers[name.trim()] = str(value);}
	}
	const type = contentTypeOf(plan);
	if (type && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
		headers['Content-Type'] = type;
	}
	return headers;
}

/** Auth is applied to the wire by auth.ts, not expressible here — say so instead of dropping it. */
function authNote(request: SavedRequest, marker: string): string[] {
	const auth = request.auth;
	if (!isObject(auth) || auth.type === 'none') {return [];}
	return [`${marker} Authentication: "${flat(auth.type)}" is configured on this request but not applied here — add the credentials yourself.`];
}

const filesTodo = (files: FileRef[]): string[] =>
	files.map((file) => `TODO: attach ${flat(file.path) || '(no path set)'} manually`);

// fetch

function fetchBody(plan: Plan): string {
	if (plan.kind === 'raw') {return q(plan.content);}
	if (plan.kind === 'urlencoded') {
		const rows = plan.fields.map((field) => `${q(field.key)}: ${q(field.value)}`);
		return `new URLSearchParams({ ${rows.join(', ')} }).toString()`;
	}
	return '';
}

function fetchTodos(plan: Plan): string[] {
	if (plan.kind === 'binary') {return filesTodo([{ key: '', path: plan.path }]);}
	if (plan.kind === 'multipart') {
		if (plan.files.length > 0) {return filesTodo(plan.files);}
		return ['TODO: send these fields as multipart FormData — a file-less multipart body cannot be inlined'];
	}
	return [];
}

function fetchSnippet(request: SavedRequest): string {
	const plan = planOf(request.body);
	const headers = headersFor(request, plan);

	const entries: string[] = [`${JS}method: ${q(request.method)}`];
	const names = Object.keys(headers);
	if (names.length > 0) {
		const rows = names.map((name) => `${JS}${JS}${q(name)}: ${q(headers[name])}`);
		entries.push(`${JS}headers: {\n${rows.join(',\n')}\n${JS}}`);
	}
	const body = fetchBody(plan);
	if (body) {entries.push(`${JS}body: ${body}`);}

	let object = entries.join(',\n');
	const todos = fetchTodos(plan);
	if (todos.length > 0) {object += ',\n' + todos.map((todo) => `${JS}// ${todo}`).join('\n');}

	return [
		...authNote(request, '//'),
		`const res = await fetch(${q(request.url)}, {`,
		object,
		'});',
		'const text = await res.text();',
	].join('\n') + '\n';
}

// python

const pyDict = (fields: Field[]): string =>
	`{${fields.map((field) => `${q(field.key)}: ${q(field.value)}`).join(', ')}}`;

// JSON's literals are not Python's, so `json={"active":true}` would be a NameError.
const PY_LITERALS: Record<string, string> = { true: 'True', false: 'False', null: 'None' };

/** Rewrite `true`/`false`/`null` outside string literals; anything inside quotes is left alone. */
function pythonJson(text: string): string {
	let out = '';
	for (let i = 0; i < text.length;) {
		const ch = text[i];
		if (ch === '"') {
			const start = i++;
			while (i < text.length && text[i] !== '"') {i += text[i] === '\\' ? 2 : 1;}
			i++;
			out += text.slice(start, i);
			continue;
		}
		const literal = (ch === 't' || ch === 'f' || ch === 'n') ? /^(?:true|false|null)/.exec(text.slice(i)) : null;
		if (literal && !/[\w$]/.test(text[i - 1] ?? '') && !/[\w$]/.test(text[i + literal[0].length] ?? '')) {
			out += PY_LITERALS[literal[0]];
			i += literal[0].length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function pythonBody(plan: Plan): string[] {
	switch (plan.kind) {
		case 'raw':
			// The JSON literal is inlined verbatim apart from its literals, so the body stays readable —
			// `true`/`false`/`null` are the only tokens Python would choke on.
			// JSON's `\/` escape is not valid Python, so unescape it before inlining.
			return [plan.format === 'json' && parsedJson(plan.content)
				? `json=${pythonJson(plan.content.trim().split('\\/').join('/'))}`
				: `data=${q(plan.content)}`];

		case 'urlencoded':
			return [`data=${pyDict(plan.fields)}`];

		case 'multipart': {
			const out: string[] = [];
			if (plan.fields.length > 0) {out.push(`data=${pyDict(plan.fields)}`);}
			if (plan.files.length > 0) {
				const rows = plan.files.map((file) => `${q(file.key)}: open(${q(file.path)}, "rb")`);
				out.push(`files={${rows.join(', ')}}`);
			}
			return out;
		}

		case 'binary':
			return [`data=open(${q(plan.path)}, "rb")`];

		default:
			return [];
	}
}

function pythonNotes(request: SavedRequest, plan: Plan): string[] {
	const notes = authNote(request, '#');
	if (plan.kind === 'multipart' && plan.files.length === 0) {
		notes.push('# TODO: send these fields as multipart — data=... below would go out urlencoded');
	}
	return notes;
}

function pythonSnippet(request: SavedRequest): string {
	const plan = planOf(request.body);
	const headers = headersFor(request, plan);

	const args: string[] = [];
	const names = Object.keys(headers);
	if (names.length > 0) {
		args.push(`headers=${pyDict(names.map((name) => ({ key: name, value: headers[name] })))}`);
	}
	args.push(...pythonBody(plan));

	const call = request.method === 'POST'
		? `requests.post(${[q(request.url), ...args].join(', ')})`
		: `requests.request(${[q(request.method), q(request.url), ...args].join(', ')})`;

	return [
		'import requests',
		'',
		...pythonNotes(request, plan),
		`response = ${call}`,
		'print(response.status_code)',
		'print(response.text)',
	].join('\n') + '\n';
}

// go

/** Same encoding the wire uses for a urlencoded body, computed here so Go needs no extra import. */
const encodedFields = (fields: Field[]): string =>
	new URLSearchParams(fields.map((field): [string, string] => [field.key, field.value])).toString();

function goSnippet(request: SavedRequest): string {
	const plan = planOf(request.body);
	const headers = headersFor(request, plan);
	const imports = new Set(['fmt', 'io', 'net/http']);

	const statements: string[] = authNote(request, '//').map((line) => GO + line);
	let bodyExpr = 'nil';

	if (plan.kind === 'raw') {
		imports.add('strings');
		bodyExpr = `strings.NewReader(${q(plan.content)})`;
	} else if (plan.kind === 'urlencoded') {
		imports.add('strings');
		bodyExpr = `strings.NewReader(${q(encodedFields(plan.fields))})`;
	} else if (plan.kind === 'binary') {
		imports.add('bytes');
		imports.add('os');
		statements.push(
			`${GO}data, err := os.ReadFile(${q(plan.path)})`,
			`${GO}if err != nil {`,
			`${GO}${GO}panic(err)`,
			`${GO}}`,
		);
		bodyExpr = 'bytes.NewReader(data)';
	} else if (plan.kind === 'multipart') {
		statements.push(...filesTodo(plan.files.length > 0 ? plan.files : []).map((todo) => `${GO}// ${todo}`));
		statements.push(`${GO}// TODO: build the multipart body with mime/multipart — it cannot be inlined`);
	}

	statements.push(
		`${GO}req, err := http.NewRequest(${q(request.method)}, ${q(request.url)}, ${bodyExpr})`,
		`${GO}if err != nil {`,
		`${GO}${GO}panic(err)`,
		`${GO}}`,
	);
	for (const [name, value] of Object.entries(headers)) {
		statements.push(`${GO}req.Header.Set(${q(name)}, ${q(value)})`);
	}
	statements.push(
		`${GO}res, err := http.DefaultClient.Do(req)`,
		`${GO}if err != nil {`,
		`${GO}${GO}panic(err)`,
		`${GO}}`,
		`${GO}defer res.Body.Close()`,
		`${GO}body, err := io.ReadAll(res.Body)`,
		`${GO}if err != nil {`,
		`${GO}${GO}panic(err)`,
		`${GO}}`,
		`${GO}fmt.Println(string(body))`,
	);

	return [
		'package main',
		'',
		'import (',
		...[...imports].sort().map((name) => `${GO}${q(name)}`),
		')',
		'',
		'func main() {',
		...statements,
		'}',
	].join('\n') + '\n';
}

// entry point

/** A ready-to-run snippet. `curl` delegates to `toCurl` — never duplicate that logic. */
export function snippet(lang: SnippetLang, request: SavedRequest): string {
	if (lang !== 'curl' && lang !== 'fetch' && lang !== 'python' && lang !== 'go') {
		return `// Unsupported snippet language: ${String(lang)}
`;
	}
	switch (lang) {
		case 'curl': return toCurl(request);
		case 'fetch': return fetchSnippet(request);
		case 'python': return pythonSnippet(request);
		case 'go': return goSnippet(request);
	}
}
