// Collection runner — no vscode imports. The caller injects the send function (and the script
// runtime), so the whole loop is testable under bun without a host.
import type { HttpResponse } from './http';
import { runScript, type AssertionResult, type ScriptRequest } from './scripting';
import type { SavedRequest } from './store';

/** One request to run, with the scripts already merged from its collection/folder scopes. */
export interface RunItem {
	name: string;
	request: SavedRequest;
	preRequest?: string;
	test?: string;
}

export interface RunResult {
	/** 1-based iteration when a CSV was supplied. */
	iteration: number;
	name: string;
	status: number;
	ok: boolean;
	/** false when the transport failed or any assertion failed. */
	passed: boolean;
	timeMs: number;
	error?: string;
	assertions: AssertionResult[];
	/** CSV row values for this iteration, when parameterized. */
	data?: Record<string, string>;
}

export interface RunOptions {
	send: (request: SavedRequest, vars: Record<string, string>) => Promise<HttpResponse>;
	vars?: Record<string, string>;
	/** One entry per parameterized iteration. Omit for a single plain run. */
	data?: Record<string, string>[];
	stopOnFailure?: boolean;
	/** Injected for tests; defaults to the real sandbox. */
	script?: typeof runScript;
	/** Called after each row so the UI can stream progress. */
	onRow?: (row: RunResult) => void;
	/** Hard cap on iterations, so a huge CSV cannot run forever. */
	maxIterations?: number;
}

/** RFC4180-lite: quoted fields, doubled quotes, CRLF or LF, leading blank lines skipped, header row required. */
export function parseCsv(text: string): Record<string, string>[] {
	// A BOM before the first header would otherwise make a quoted header parse literally.
	const rows: string[][] = [];
	text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let started = false;

	const endField = () => {
		row.push(field);
		field = '';
		started = false;
	};
	const endRow = () => {
		endField();
		// Only blank lines BEFORE the header are dropped. A blank line in the body is a real record
		// with one empty field, which is exactly how a CSV expresses "this column is empty".
		const blank = row.length === 1 && row[0].trim() === '';
		if (!blank || rows.length) {rows.push(row);}
		row = [];
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
			continue;
		}
		if (ch === '"' && !started) {
			quoted = true;
			started = true;
		} else if (ch === ',') {
			endField();
		} else if (ch === '\n') {
			endRow();
		} else if (ch === '\r') {
			if (text[i + 1] === '\n') {i++;}
			endRow();
		} else {
			field += ch;
			started = true;
		}
	}
	if (field !== '' || row.length) {endRow();}

	if (!rows.length) {return [];}
	const header = rows[0].map((h) => h.trim());
	const out: Record<string, string>[] = [];
	for (const values of rows.slice(1)) {
		const record: Record<string, string> = {};
		header.forEach((key, index) => {
			if (key) {record[key] = values[index] ?? '';}
		});
		out.push(record);
	}
	return out;
}

/**
 * Run items sequentially. Each CSV row turns into a full pass over the items with those vars merged in.
 * `stopOnFailure` ends the whole run (not just the iteration) at the first failed request.
 */
export async function runItems(items: readonly RunItem[], options: RunOptions): Promise<RunResult[]> {
	const script = options.script ?? runScript;
	const iterations = options.data?.length ? options.data.slice(0, options.maxIterations ?? 100) : [undefined];
	const results: RunResult[] = [];

	for (const [index, dataRow] of iterations.entries()) {
		// Fresh per iteration: a pre-request script may rewrite vars for the rest of THIS pass, but
		// the caller's object and the next iteration both stay untouched.
		let vars = { ...(options.vars ?? {}), ...(dataRow ?? {}) };
		for (const item of items) {
			const outcome = await runOne(item, vars, index + 1, script, options.send);
			vars = outcome.vars;
			const result = outcome.result;
			if (dataRow) {result.data = dataRow;}
			results.push(result);
			// A reporting callback is best-effort: a throwing one must not abort the run.
			try {
				options.onRow?.(result);
			} catch {
				/* the UI missed a row, the run continues */
			}
			if (options.stopOnFailure && !result.passed) {return results;}
		}
	}
	return results;
}

async function runOne(
	item: RunItem,
	vars: Record<string, string>,
	iteration: number,
	script: typeof runScript,
	send: RunOptions['send']
): Promise<{ result: RunResult; vars: Record<string, string> }> {
	const base: RunResult = { iteration, name: item.name, status: 0, ok: false, passed: false, timeMs: 0, assertions: [] };
	let request = item.request;
	let state = vars;

	if (item.preRequest) {
		const outcome = script(item.preRequest, { request: toScriptRequest(request), vars }, 'pre');
		if (outcome.error) {return { result: { ...base, error: `Pre-request script: ${outcome.error}` }, vars: state };}
		request = applyMutations(request, outcome.request);
		// The panel path honours these too: a pre-request `vars.token = ...` must reach the send.
		state = { ...outcome.vars };
	}

	let response: HttpResponse;
	try {
		response = await send(request, state);
	} catch (e: any) {
		return { result: { ...base, error: String(e?.message ?? e) }, vars: state };
	}

	const result: RunResult = {
		...base,
		status: response.status,
		ok: response.ok,
		timeMs: response.timeMs,
		error: response.error,
		passed: !response.error && response.ok,
	};

	if (item.test) {
		const outcome = script(
			item.test,
			{
				request: toScriptRequest(request),
				response: {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
					body: response.body,
					timeMs: response.timeMs,
					size: response.size,
				},
				vars: state,
			},
			'post'
		);
		result.assertions = outcome.assertions;
		if (outcome.error) {result.error = outcome.error;}
		if (outcome.assertions.some((a) => !a.passed) || outcome.error) {result.passed = false;}
	}

	return { result, vars: state };
}

function toScriptRequest(request: SavedRequest): ScriptRequest {
	return {
		method: request.method,
		url: request.url,
		headers: { ...(request.headers ?? {}) },
		body: request.body?.type === 'raw' ? request.body.content : undefined,
	};
}

function applyMutations(request: SavedRequest, mutated: ScriptRequest): SavedRequest {
	const next: SavedRequest = { ...request, url: mutated.url, headers: { ...mutated.headers } };
	if (mutated.body !== undefined) {
		let format: 'json' | 'text' = 'text';
		try {
			JSON.parse(mutated.body);
			format = 'json';
		} catch {
			/* plain text */
		}
		next.body = { type: 'raw', format, content: mutated.body };
	}
	return next;
}
