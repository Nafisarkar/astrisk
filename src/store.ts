// Collections on disk — no vscode imports so it stays unit-testable under bun.
//
// Layout mirrors the tree the user sees, so Git diffs stay readable:
//   <root>/<collection>/<folder>/<request>.json
// Directories are collections/folders, `.json` files are requests. No index file to keep in sync.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, sep } from 'node:path';
import type { Auth } from './auth';
import type { HttpMethod, RequestBody } from './http';

export const ROOT_DIR = '.asterisk';
export const REQUEST_EXT = '.json';

export type NodeKind = 'collection' | 'folder' | 'request';

export interface SavedRequest {
	method: HttpMethod;
	url: string;
	headers?: Record<string, string>;
	body?: RequestBody;
	auth?: Auth;
	/** Per-request pre-request script (JavaScript, runs in a sandbox). */
	preRequest?: string;
	/** Per-request test script (assertions). */
	test?: string;
}

export interface TreeNode {
	kind: NodeKind;
	name: string;
	path: string;
	children: TreeNode[];
}

/** Windows device names cannot be used as file names; a trailing underscore keeps them usable. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Strip anything that would escape the collections root or upset a filesystem. */
export function sanitizeName(input: string): string {
	const cleaned = input
		.trim()
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/[\u0000-\u001f]/g, '')
		.replace(/\s+/g, ' ')
		.replace(/^[-.\s]+|[-.\s]+$/g, '')
		.slice(0, 80)
		// the slice can re-introduce a trailing dot/space (Windows silently strips those, so the
		// returned path would differ from the disk name) and can split a surrogate pair
		.replace(/[\uD800-\uDBFF]$/, '')
		.replace(/^[-.\s]+|[-.\s]+$/g, '');
	const safe = cleaned || 'untitled';
	return RESERVED.test(safe) ? `${safe}_` : safe;
}

/** Default file name for a request: `get-users` from a GET to https://api.example.com/users. */
export function suggestName(req: SavedRequest): string {
	const withoutScheme = req.url.replace(/^https?:\/\//i, '').split(/[?#]/)[0];
	const segments = withoutScheme.split('/').filter((s) => s && !s.includes('{{'));
	const tail = segments.length > 1 ? segments[segments.length - 1] : '';
	return sanitizeName([req.method.toLowerCase(), tail].filter(Boolean).join('-'));
}

/** `name`, then `name 2`, `name 3`… until the path is free. */
export function uniqueName(dir: string, base: string, ext = ''): string {
	let candidate = sanitizeName(base) + ext;
	let n = 2;
	while (existsSync(join(dir, candidate))) {
		candidate = `${sanitizeName(base)} ${n++}${ext}`;
	}
	return candidate;
}

const treeOrder = (a: TreeNode, b: TreeNode) =>
	Number(a.kind === 'request') - Number(b.kind === 'request') || a.name.localeCompare(b.name);

function readDir(dir: string, depth: number): TreeNode[] {
	if (!existsSync(dir)) {return [];}
	const nodes: TreeNode[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) {continue;}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			nodes.push({ kind: depth === 0 ? 'collection' : 'folder', name: entry.name, path, children: readDir(path, depth + 1) });
		} else if (entry.isFile() && extname(entry.name) === REQUEST_EXT) {
			nodes.push({ kind: 'request', name: basename(entry.name, REQUEST_EXT), path, children: [] });
		}
	}
	return nodes.sort(treeOrder);
}

/** Everything under the collections root. Missing root is simply "no collections". */
export function readTree(root: string): TreeNode[] {
	return readDir(root, 0);
}

export function createCollection(root: string, name: string): string {
	const path = join(root, uniqueName(root, name));
	mkdirSync(path, { recursive: true });
	return path;
}

export function createFolder(parent: string, name: string): string {
	const path = join(parent, uniqueName(parent, name));
	mkdirSync(path, { recursive: true });
	return path;
}

export function writeRequest(file: string, req: SavedRequest): string {
	try {
		mkdirSync(dirname(file), { recursive: true });
		// ponytail: 2-space pretty JSON — one field per line so collections diff cleanly in Git.
		writeFileSync(file, JSON.stringify(req, null, 2) + '\n', 'utf8');
	} catch (e: any) {
		throw new Error(`Cannot write request "${basename(file)}": ${e?.code ?? e?.message ?? e}`);
	}
	return file;
}

export function readRequest(file: string): SavedRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch (e: any) {
		const reason = e?.code === 'ENOENT' ? 'file not found' : e?.code === 'EISDIR' ? 'that is a directory' : 'invalid JSON';
		throw new Error(`Cannot read request "${basename(file)}": ${reason}`);
	}
	const req = parsed as SavedRequest;
	if (!req || typeof req !== 'object' || typeof req.url !== 'string' || typeof req.method !== 'string') {
		throw new Error(`Cannot read request "${basename(file)}": missing method or url`);
	}
	return req;
}

export function renameNode(path: string, newName: string): string {
	const ext = extname(path) === REQUEST_EXT ? REQUEST_EXT : '';
	const wanted = sanitizeName(newName);
	if (wanted + ext === basename(path)) {return path;}
	// A case-only rename must not become "name 2" just because Windows compares case-insensitively.
	if ((wanted + ext).toLowerCase() === basename(path).toLowerCase()) {
		const same = join(dirname(path), wanted + ext);
		renameSync(path, same);
		return same;
	}
	const target = join(dirname(path), uniqueName(dirname(path), wanted, ext));
	renameSync(path, target);
	return target;
}

export function deleteNode(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

/** Move a request or folder into `destDir`. Refuses to move a folder into itself. */
export function moveNode(path: string, destDir: string): string {
	if (destDir === path || destDir.startsWith(path + sep)) {
		throw new Error(`Cannot move "${basename(path)}" into itself`);
	}
	const ext = extname(path) === REQUEST_EXT ? REQUEST_EXT : '';
	const target = join(destDir, uniqueName(destDir, basename(path, ext), ext));
	renameSync(path, target);
	return target;
}
