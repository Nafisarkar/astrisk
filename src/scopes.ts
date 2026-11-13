// Where pre-request/test scripts live, beyond the one attached to a single request.
//
// A file-scoped `.scripts.json` next to any collection or folder applies to everything below it:
//   { "preRequest": "…js…", "test": "…js…" }
// Dot-prefixed, so `readTree` never mistakes it for a request.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { SavedRequest } from './store';

export const SCRIPTS_FILE = '.scripts.json';

export interface Scripts {
	preRequest?: string;
	test?: string;
}

/** Where each piece of a merged script came from: `.asterisk/stripe`, or the request itself. */
export interface ScriptOrigin {
	preRequest?: string[];
	test?: string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One directory's scripts. Missing file => {}. Corrupt file => readable error. */
export function readScripts(dir: string): Scripts {
	const file = join(dir, SCRIPTS_FILE);
	if (!existsSync(file)) {return {};}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		throw new Error(`Cannot read ${SCRIPTS_FILE} in ${dir}: invalid JSON`);
	}
	if (!isPlainObject(parsed)) {throw new Error(`Cannot read ${SCRIPTS_FILE} in ${dir}: expected a JSON object`);}
	const out: Scripts = {};
	if (typeof parsed.preRequest === 'string' && parsed.preRequest.trim()) {out.preRequest = parsed.preRequest;}
	if (typeof parsed.test === 'string' && parsed.test.trim()) {out.test = parsed.test;}
	return out;
}

export function writeScripts(dir: string, scripts: Scripts): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, SCRIPTS_FILE), JSON.stringify(scripts, null, 2) + '\n', 'utf8');
}

/** `relative` rather than a string prefix: `.asterisk-old` must not count as inside `.asterisk`. */
function insideRoot(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

/**
 * Scripts that apply to `file`, outermost first: collection, then each nested folder, then the
 * request's own scripts. Stop climbing at `root` (the `.asterisk` directory).
 */
export function collectScopeScripts(root: string, file: string, request?: SavedRequest): Scripts & { origin?: ScriptOrigin } {
	const chain: Scripts[] = [];
	const origin: ScriptOrigin = { preRequest: [], test: [] };
	let dir = dirname(file);
	while (insideRoot(root, dir)) {
		const scripts = readScripts(dir);
		chain.unshift(scripts);
		// attribution: a failing assertion has to name the file it came from
		if (scripts.preRequest) {origin.preRequest!.unshift(join(dir, SCRIPTS_FILE));}
		if (scripts.test) {origin.test!.unshift(join(dir, SCRIPTS_FILE));}
		const parent = dirname(dir);
		if (parent === dir) {break;}
		dir = parent;
	}
	if (request?.preRequest?.trim()) {chain.push({ preRequest: request.preRequest }); origin.preRequest!.push('this request');}
	if (request?.test?.trim()) {chain.push({ test: request.test }); origin.test!.push('this request');}
	const origin2 = origin.preRequest!.length + origin.test!.length > 0 ? origin : undefined;
	return {
		origin: origin2,
		preRequest: chain.map((s) => s.preRequest).filter(Boolean).join('\n;\n') || undefined,
		test: chain.map((s) => s.test).filter(Boolean).join('\n;\n') || undefined,
	};
}
