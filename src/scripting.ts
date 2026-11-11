// Pre-request / post-response scripts — no vscode imports so it stays unit-testable under bun.
//
// Everything the script can see is created INSIDE a fresh `node:vm` realm: the data crosses as a
// JSON string, the helpers (`expect`, `console`, `setEnv`) are compiled inside that realm, and the
// result comes back as a JSON string. No host object or function is ever injected, so
// `expect.constructor('return process')()` — the usual vm escape — only reaches the sandbox's own
// realm. `vm` is still a seatbelt rather than a jail: run scripts you trust.
import { createContext, runInContext } from 'node:vm';

export interface ScriptRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

export interface ScriptResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	timeMs: number;
	size: number;
}

export interface AssertionResult {
	name: string;
	passed: boolean;
	message?: string;
}

export interface ScriptContext {
	request: ScriptRequest;
	response?: ScriptResponse;
	vars: Record<string, string>;
}

export interface ScriptOutcome {
	logs: string[];
	/** Syntax error, throw, or timeout. A failed assertion is NOT an error. */
	error?: string;
	assertions: AssertionResult[];
	/** Request after script mutations. Untouched for `phase: 'post'`. */
	request: ScriptRequest;
	/** Vars after script mutations (in-memory only — see `envChanges`). */
	vars: Record<string, string>;
	/** Explicit env writes a script asked for via `setEnv(key, value)`; null deletes. */
	envChanges: Record<string, string | null>;
}

const DEFAULT_TIMEOUT_MS = 2000;

// Compiled inside the sandbox realm. Keep it ES5-ish and free of template literals so it can live
// in this string safely. `__INPUT__` is replaced with a JSON string literal below.
const PRELUDE = `
'use strict';
var __in = JSON.parse(__INPUT__);
var __state = { logs: [], assertions: [], envChanges: Object.create(null) };

function __fail(message) {
	var error = new Error(message);
	error.__assertion = true;
	throw error;
}

function __log() {
	var parts = [];
	for (var i = 0; i < arguments.length; i++) { parts.push(String(arguments[i])); }
	__state.logs.push(parts.join(' '));
}

var console = { log: __log, info: __log, warn: __log, error: __log };

function __fmt(value) {
	var text;
	if (typeof value === 'string') { text = JSON.stringify(value); }
	else if (typeof value === 'function') { text = '[function]'; }
	else
		try { text = JSON.stringify(value); } catch (e) { text = String(value); }
	if (text === undefined) { text = String(value); }
	return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

function __tag(value) {
	return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

function __deepEqual(a, b) {
	if (a === b) { return true; }
	if (typeof a === 'number' && typeof b === 'number') { return a !== a && b !== b; }
	if (!a || !b || typeof a !== 'object' || typeof b !== 'object') { return false; }
	var tag = __tag(a);
	if (tag !== __tag(b)) { return false; }
	if (tag === 'array') {
		if (a.length !== b.length) { return false; }
		for (var i = 0; i < a.length; i++) { if (!__deepEqual(a[i], b[i])) { return false; } }
		return true;
	}
	if (tag === 'date') { return a.getTime() === b.getTime(); }
	if (tag === 'regexp') { return String(a) === String(b); }
	if (tag !== 'object') { return false; }
	var ka = Object.keys(a);
	var kb = Object.keys(b);
	if (ka.length !== kb.length) { return false; }
	for (var j = 0; j < ka.length; j++) {
		if (!(ka[j] in b) || !__deepEqual(a[ka[j]], b[ka[j]])) { return false; }
	}
	return true;
}

function __typeOf(value) {
	if (value === null) { return 'null'; }
	if (Array.isArray(value)) { return 'array'; }
	return typeof value;
}

function __includes(actual, needle) {
	if (typeof actual === 'string') { return actual.indexOf(String(needle)) !== -1; }
	if (Array.isArray(actual)) {
		for (var i = 0; i < actual.length; i++) { if (__deepEqual(actual[i], needle)) { return true; } }
	}
	return false;
}

function __lengthOf(value) {
	return value !== null && value !== undefined && typeof value.length === 'number' ? value.length : undefined;
}

function makeExpect(actual) {
	function build(negate, path) {
		function label(word, args) {
			var text = 'expect(' + __fmt(actual) + ')';
			var parts = path.concat([word]);
			for (var i = 0; i < parts.length; i++) { text += '.' + parts[i]; }
			if (args && args.length) { text += '(' + args.join(', ') + ')'; }
			return text;
		}

		function check(word, ok, description, argText) {
			var name = label(word, argText === undefined ? [] : [argText]);
			if (negate ? !ok : ok) {
				__state.assertions.push({ name: name, passed: true });
				return;
			}
			var message = 'expected ' + __fmt(actual) + ' ' + (negate ? 'not ' : '') + description;
			__state.assertions.push({ name: name, passed: false, message: message });
			__fail(message);
		}

		function numberCheck(word, expected, compare, description) {
			var a = Number(actual);
			var b = Number(expected);
			check(word, compare(a, b), description, __fmt(expected));
		}

		var chain = {
			equal: function (v) { check('equal', __deepEqual(actual, v), 'to equal ' + __fmt(v), __fmt(v)); },
			eql: function (v) { check('eql', __deepEqual(actual, v), 'to deeply equal ' + __fmt(v), __fmt(v)); },
			above: function (n) { numberCheck('above', n, function (a, b) { return a > b; }, 'to be above ' + __fmt(n)); },
			below: function (n) { numberCheck('below', n, function (a, b) { return a < b; }, 'to be below ' + __fmt(n)); },
			least: function (n) { numberCheck('least', n, function (a, b) { return a >= b; }, 'to be at least ' + __fmt(n)); },
			most: function (n) { numberCheck('most', n, function (a, b) { return a <= b; }, 'to be at most ' + __fmt(n)); },
			include: function (v) { check('include', __includes(actual, v), 'to include ' + __fmt(v), __fmt(v)); },
			match: function (re) {
				var rx = __tag(re) === 'regexp' ? re : new RegExp(String(re));
				check('match', rx.test(String(actual)), 'to match ' + __fmt(String(re)), __fmt(String(re)));
			},
			a: function (t) {
				var wanted = String(t).toLowerCase();
				check('a', __typeOf(actual) === wanted, 'to be a ' + wanted, __fmt(wanted));
			},
			length: function (n) { check('length', __lengthOf(actual) === Number(n), 'to have length ' + __fmt(n), __fmt(n)); }
		};

		['to', 'be', 'at', 'have'].forEach(function (word) {
			Object.defineProperty(chain, word, { get: function () { return build(negate, path.concat([word])); } });
		});
		Object.defineProperty(chain, 'not', { get: function () { return build(!negate, path.concat(['not'])); } });
		Object.defineProperty(chain, 'true', { get: function () { return check('true', actual === true, 'to be true'); } });
		Object.defineProperty(chain, 'false', { get: function () { return check('false', actual === false, 'to be false'); } });
		Object.defineProperty(chain, 'null', { get: function () { return check('null', actual === null, 'to be null'); } });
		Object.defineProperty(chain, 'undefined', { get: function () { return check('undefined', actual === undefined, 'to be undefined'); } });
		return chain;
	}
	return build(false, []);
}

function expect(value) { return makeExpect(value); }

var request = __in.request;
var vars = __in.vars;
// Only define response when there is one, so a pre-request script fails loudly
// ("response is not defined") instead of tripping over undefined.
if (__in.response !== undefined) { globalThis.response = __in.response; }

/** Explicit, auditable env write. Nothing is persisted unless the script calls this. */
function setEnv(key, value) {
	var name = String(key);
	// Reserved keys would land on Object.prototype (or be dropped by the host record), so an env
	// write that silently does nothing is worse than a readable failure.
	if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
		throw new Error('setEnv cannot write the reserved key "' + name + '"');
	}
	__state.envChanges[name] = value === null || value === undefined ? null : String(value);
}

function __snapshot() {
	return JSON.stringify({
		logs: __state.logs,
		assertions: __state.assertions,
		envChanges: __state.envChanges,
		request: request,
		vars: vars
	});
}

// A const binding, not a var: user code cannot replace the reader the host calls.
const __read = __snapshot;
`;

const stringLiteral = (text: string): string =>
	JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** One readable line for a failure — never a stack dump. */
function describe(e: unknown, timeoutMs: number): string {
	const err = e as { code?: unknown; message?: unknown } | null | undefined;
	if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {return `Script timed out after ${timeoutMs}ms`;}
	const raw = typeof err?.message === 'string' ? err.message : String(e);
	const line = raw
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return line ?? 'Script failed';
}

const toStringRecord = (value: unknown): Record<string, string> => {
	const out: Record<string, string> = {};
	if (!value || typeof value !== 'object') {return out;}
	for (const [k, v] of Object.entries(value)) {
		if (v !== undefined && v !== null) {out[String(k)] = String(v);}
	}
	return out;
};

const toRequest = (value: unknown, fallback: ScriptRequest): ScriptRequest => {
	const src = (value && typeof value === 'object' ? value : fallback) as Partial<ScriptRequest>;
	const out: ScriptRequest = { method: String(src.method ?? ''), url: String(src.url ?? ''), headers: toStringRecord(src.headers) };
	if (src.body !== undefined && src.body !== null) {out.body = String(src.body);}
	return out;
};

const cloneRequest = (req: ScriptRequest): ScriptRequest => toRequest(req, { method: '', url: '', headers: {} });

const cloneResponse = (res: ScriptResponse): ScriptResponse => ({
	status: Number(res.status) || 0,
	statusText: String(res.statusText ?? ''),
	headers: toStringRecord(res.headers),
	body: String(res.body ?? ''),
	timeMs: Number(res.timeMs) || 0,
	size: Number(res.size) || 0,
});

/**
 * Run `code` against a copy of `ctx`. Never throws: every failure lands in `error` (or in a
 * failed `AssertionResult`). `phase: 'pre'` hides `response`; `phase: 'post'` keeps the request
 * read-only from the caller's point of view (mutations are dropped).
 */
export function runScript(code: string, ctx: ScriptContext, phase: 'pre' | 'post', opts?: { timeoutMs?: number }): ScriptOutcome {
	const request = cloneRequest(ctx.request);
	const vars = toStringRecord(ctx.vars);
	const timeoutMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;

	const failure = (error: string): ScriptOutcome => ({
		logs: [],
		error,
		assertions: [],
		request: cloneRequest(ctx.request),
		vars: { ...vars },
		envChanges: {},
	});

	if (phase !== 'pre' && phase !== 'post') {return failure(`Unknown script phase "${String(phase)}" — expected "pre" or "post"`);}
	if (phase === 'post' && !ctx.response) {return failure('A post-response script needs a response, but none was provided');}

	// Only primitives cross into the sandbox: the payload is a JSON *string* parsed inside the realm.
	const input = {
		request,
		vars,
		response: phase === 'post' && ctx.response ? cloneResponse(ctx.response) : undefined,
	};
	// A replacer function, not a string: `$&`, `$$`, `` $` `` and `$'` in the payload would otherwise
	// be expanded by String.replace and silently corrupt the input.
	const prelude = PRELUDE.replace('__INPUT__', () => stringLiteral(JSON.stringify(input)));

	const context = createContext(Object.create(null));
	let error: string | undefined;
	try {
		runInContext(prelude, context, { timeout: timeoutMs, filename: 'asterisk-prelude.js' });
		runInContext(typeof code === 'string' ? code : String(code ?? ''), context, {
			timeout: timeoutMs,
			filename: 'script.js',
			displayErrors: false,
		});
	} catch (e: any) {
		// A failed assertion is a result, not an error.
		if (e?.__assertion !== true) {error = describe(e, timeoutMs);}
	}

	let snapshot: any;
	try {
		snapshot = JSON.parse(runInContext('__read()', context, { timeout: 500 }) as string);
	} catch (e) {
		return {
			logs: [],
			error: error ?? `Script result could not be read: ${describe(e, timeoutMs)}`,
			assertions: [],
			request: cloneRequest(ctx.request),
			vars: { ...vars },
			envChanges: {},
		};
	}

	const envChanges: Record<string, string | null> = {};
	if (snapshot.envChanges && typeof snapshot.envChanges === 'object') {
		for (const [key, value] of Object.entries(snapshot.envChanges)) {
			envChanges[String(key)] = value === null || value === undefined ? null : String(value);
		}
	}

	return {
		logs: Array.isArray(snapshot.logs) ? snapshot.logs.map((l: unknown) => String(l)) : [],
		error,
		assertions: Array.isArray(snapshot.assertions)
			? snapshot.assertions.map((a: any) => ({ name: String(a?.name ?? ''), passed: a?.passed === true, ...(a?.message ? { message: String(a.message) } : {}) }))
			: [],
		request: phase === 'post' ? cloneRequest(ctx.request) : toRequest(snapshot.request, request),
		vars: toStringRecord(snapshot.vars ?? vars),
		envChanges,
	};
}
