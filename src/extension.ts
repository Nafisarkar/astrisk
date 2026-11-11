import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sendRequest, type HttpResponse } from './http';
import { DEFAULT_REDIRECT_URI, applyAuth } from './auth';
import { collectScopeScripts } from './scopes';
import { createSocketSlot, openSse, openWebSocket, type SseHandle, type WsHandle } from './protocols';
import { applyPathVars, resolveVars } from './http';
import { runScript, type ScriptOutcome } from './scripting';
import { parseCsv, runItems, type RunItem, type RunResult } from './runner';
import { fromCurl, importOpenApi, importPostman, toCurl, type ImportedRequest } from './curl';
import { snippet, type SnippetLang } from './snippets';
import { loopbackAuthorizer } from './oauth';
import { AsteriskTreeProvider } from './tree';
import { HistoryTreeProvider } from './history-tree';
import { REDACTED, appendHistory, clearHistory, makeEntry, readHistory, type HistoryEntry } from './history';
import {
	ENV_FILE,
	addEnv,
	envName,
	setVar,
	readEnvs,
	removeEnv,
	renameEnv,
	requestVars,
	setActive,
	writeEnvs,
	type EnvDocument,
} from './env';
import {
	REQUEST_EXT,
	ROOT_DIR,
	createCollection,
	createFolder,
	deleteNode,
	readRequest,
	readTree,
	renameNode,
	suggestName,
	sanitizeName,
	uniqueName,
	writeRequest,
	type SavedRequest,
	type TreeNode,
} from './store';

let panel: vscode.WebviewPanel | undefined;
let tree: AsteriskTreeProvider;
let historyTree: HistoryTreeProvider;
/** History lives in extension storage, not in the repo, so it is never committed. */
let storageDir: string | undefined;
/** Request file the panel is editing; Save overwrites it instead of asking for a name. */
let currentFile: string | undefined;
/** Mirror of the panel's unsaved-changes flag, so loading another request can ask first. */
let panelDirty = false;
/** Load waiting for the webview to say it is ready (fresh panel only). */
let pendingLoad: { request: SavedRequest } | undefined;
/** At most one live socket per panel; connecting again replaces it and stale callbacks are ignored. */
const socket = createSocketSlot();
/** Escape/Cancel in the panel aborts the request in flight. */
let inFlight: AbortController | undefined;

const NEW_ENV = '__new__';

interface WebviewMessage {
	type: string;
	id?: number;
	request?: SavedRequest;
	name?: string;
	lang?: string;
	text?: string;
	body?: string;
	mode?: string;
	url?: string;
	command?: string;
	kind?: string;
	/** `restorePath`: the file the panel was editing before a reload. */
	path?: string;
	/** `dirty`: whether the panel has unsaved edits. */
	value?: boolean;
}

export function activate(context: vscode.ExtensionContext) {
	tree = new AsteriskTreeProvider(collectionsRoot);
	storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
	historyTree = new HistoryTreeProvider(() => (storageDir ? readHistory(storageDir) : []));

	const view = vscode.window.createTreeView('asterisk.collections', {
		treeDataProvider: tree,
		dragAndDropController: tree,
		showCollapseAll: true,
	});
	const historyView = vscode.window.createTreeView('asterisk.history', {
		treeDataProvider: historyTree,
		showCollapseAll: true,
	});

	context.subscriptions.push(
		view,
		historyView,
		vscode.commands.registerCommand('asterisk.history.replay', (entry: HistoryEntry) => replayHistory(context, entry)),
		vscode.commands.registerCommand('asterisk.history.refresh', () => historyTree.refresh()),
		vscode.commands.registerCommand('asterisk.history.clear', () => clearHistoryCommand()),
		vscode.commands.registerCommand('asterisk.history.search', () => searchHistoryCommand()),
		vscode.commands.registerCommand('asterisk.open', () => openPanel(context)),
		vscode.commands.registerCommand('asterisk.refresh', () => tree.refresh()),
		vscode.commands.registerCommand('asterisk.saveRequest', () => requestSave()),
		vscode.commands.registerCommand('asterisk.newCollection', () => newCollection()),
		vscode.commands.registerCommand('asterisk.newFolder', (node?: TreeNode) => newFolder(node)),
		vscode.commands.registerCommand('asterisk.renameNode', (node?: TreeNode) => rename(node)),
		vscode.commands.registerCommand('asterisk.deleteNode', (node?: TreeNode) => remove(node)),
		vscode.commands.registerCommand('asterisk.openRequest', (node: TreeNode) => openSavedRequest(context, node)),
		vscode.commands.registerCommand('asterisk.envs.edit', () => editEnvs()),
		vscode.commands.registerCommand('asterisk.run.collection', (node?: TreeNode) => runCollection(node)),
		vscode.commands.registerCommand('asterisk.import.curl', () => importCurl(context)),
		vscode.commands.registerCommand('asterisk.import.postman', () => importFromFile(context, 'postman')),
		vscode.commands.registerCommand('asterisk.import.openapi', () => importFromFile(context, 'openapi')),
		vscode.commands.registerCommand('asterisk.export.curl', () => requestCurl()),
		vscode.commands.registerCommand('asterisk.envs.rename', () => renameEnvironment()),
		vscode.commands.registerCommand('asterisk.envs.delete', () => deleteEnvironment()),
		// Window reload restores the panel; the webview's own getState() snapshot comes back with it.
		vscode.window.registerWebviewPanelSerializer('asterisk', {
			deserializeWebviewPanel: async (restored) => {
				openPanel(context, restored);
			},
		})
	);

	// Editing .environments.json by hand must reach the panel's switcher without a reload.
	const watcher = vscode.workspace.createFileSystemWatcher(`**/${ROOT_DIR}/${ENV_FILE}`);
	context.subscriptions.push(watcher, watcher.onDidChange(pushEnvs), watcher.onDidCreate(pushEnvs), watcher.onDidDelete(pushEnvs));
}

// ---------------------------------------------------------------- collections

/** Collections live in `<workspace>/.asterisk/`. First workspace folder wins. */
function collectionsRoot(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder ? join(folder.uri.fsPath, ROOT_DIR) : undefined;
}

function requireRoot(): string | undefined {
	const root = collectionsRoot();
	if (!root) {
		vscode.window.showErrorMessage('Asterisk: open a folder first — collections are stored in .asterisk/.');
	}
	return root;
}

/** `<workspace>/.asterisk/.environments.json` — active env + its vars. */
function readEnvDoc(quiet = false): EnvDocument {
	const root = collectionsRoot();
	if (!root) {return { environments: {} };}
	try {
		return readEnvs(root);
	} catch (e: any) {
		// quiet: a half-saved hand edit must not spam a toast per keystroke-save
		if (!quiet) {vscode.window.showErrorMessage(`Asterisk: ${e?.message ?? e}`);}
		return { environments: {} };
	}
}

function envListMessage(): { type: 'envs'; active?: string; names: string[] } {
	const doc = readEnvDoc(true);
	return { type: 'envs', active: doc.active, names: Object.keys(doc.environments).sort() };
}

function pushEnvs(): void {
	// the watcher can fire after the panel is disposed; a dead webview post must not throw
	try {
		panel?.webview.postMessage(envListMessage());
	} catch {
		/* no panel to update */
	}
}

/** Vars handed to the engine: system vars, then the active environment. */
function sendVars(): Record<string, string> {
	return requestVars(readEnvDoc());
}

async function renameEnvironment(): Promise<void> {
	const root = requireRoot();
	if (!root) {return;}
	const doc = readEnvDoc();
	const names = Object.keys(doc.environments).sort();
	if (!names.length) {
		vscode.window.showInformationMessage('Asterisk: no environments yet — add one from the panel switcher.');
		return;
	}
	const from = await vscode.window.showQuickPick(names, { placeHolder: 'Rename which environment?' });
	if (!from) {return;}
	const to = await vscode.window.showInputBox({ prompt: 'New environment name', value: from });
	if (!to || to === from) {return;}
	writeEnvs(root, renameEnv(doc, from, to));
	pushEnvs();
}

async function deleteEnvironment(): Promise<void> {
	const root = requireRoot();
	if (!root) {return;}
	const doc = readEnvDoc();
	const names = Object.keys(doc.environments).sort();
	if (!names.length) {
		vscode.window.showInformationMessage('Asterisk: no environments yet — add one from the panel switcher.');
		return;
	}
	const name = await vscode.window.showQuickPick(names, { placeHolder: 'Delete which environment?' });
	if (!name) {return;}
	const confirmed = await vscode.window.showWarningMessage(`Delete environment "${name}"?`, { modal: true }, 'Delete');
	if (!confirmed) {return;}
	writeEnvs(root, removeEnv(doc, name));
	pushEnvs();
}

async function editEnvs(): Promise<void> {
	const root = requireRoot();
	if (!root) {return;}
	const file = join(root, ENV_FILE);
	if (!existsSync(file)) {
		writeEnvs(root, { environments: {} });
	}
	await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
}

interface FolderPick extends vscode.QuickPickItem {
	path?: string;
}

function folderChoices(root: string): FolderPick[] {
	const out: FolderPick[] = [];
	const walk = (nodes: TreeNode[]) => {
		for (const node of nodes) {
			if (node.kind === 'request') {continue;}
			out.push({ label: `${node.kind === 'collection' ? '$(library)' : '$(folder)'} ${node.name}`, path: node.path });
			walk(node.children);
		}
	};
	walk(readTree(root));
	return out;
}

async function pickFolder(root: string, placeHolder: string, allowNew: boolean): Promise<string | undefined> {
	const picks: FolderPick[] = allowNew
		? [{ label: '$(add) New collection…', alwaysShow: true }, ...folderChoices(root)]
		: folderChoices(root);
	const choice = await vscode.window.showQuickPick(picks, { placeHolder, ignoreFocusOut: true });
	if (!choice) {return undefined;}
	return choice.path ?? (await newCollection());
}

async function newCollection(): Promise<string | undefined> {
	const root = requireRoot();
	if (!root) {return undefined;}
	const name = await vscode.window.showInputBox({ prompt: 'Collection name', placeHolder: 'My API' });
	if (!name) {return undefined;}
	const path = createCollection(root, name);
	tree.refresh();
	return path;
}

async function newFolder(node?: TreeNode): Promise<string | undefined> {
	const root = requireRoot();
	if (!root) {return undefined;}
	const parent = node && node.kind !== 'request' ? node.path : await pickFolder(root, 'New folder in…', true);
	if (!parent) {return undefined;}
	const name = await vscode.window.showInputBox({ prompt: 'Folder name', placeHolder: 'Users' });
	if (!name) {return undefined;}
	const path = createFolder(parent, name);
	tree.refresh();
	return path;
}

async function rename(node?: TreeNode): Promise<void> {
	if (!node) {
		vscode.window.showInformationMessage('Asterisk: right-click a collection, folder, or request to rename it.');
		return;
	}
	const name = await vscode.window.showInputBox({ prompt: `Rename ${node.kind}`, value: node.name });
	if (!name || name === node.name) {return;}
	const moved = renameNode(node.path, name);
	if (currentFile === node.path) {currentFile = moved;}
	tree.refresh();
}

async function remove(node?: TreeNode): Promise<void> {
	if (!node) {
		vscode.window.showInformationMessage('Asterisk: right-click a collection, folder, or request to delete it.');
		return;
	}
	const label = node.kind === 'request' ? 'Delete' : 'Delete';
	const confirmed = await vscode.window.showWarningMessage(
		`Delete ${node.kind} "${node.name}"?`,
		{ modal: true },
		label
	);
	if (!confirmed) {return;}
	deleteNode(node.path);
	tree.refresh();
}

/** Write a request into a folder. Exported for tests; the Save flow goes through here. */
export function saveRequestTo(request: SavedRequest, folder: string, name: string): string {
	const file = join(folder, uniqueName(folder, name, REQUEST_EXT));
	writeRequest(file, request);
	currentFile = file;
	tree?.refresh();
	return file;
}

/** Title-bar / palette entry point: ask the open panel to hand over its current request. */
function requestSave() {
	if (!panel) {
		vscode.window.showInformationMessage('Asterisk: open the client first, then save the request.');
		return;
	}
	panel.webview.postMessage({ type: 'requestSnapshot' });
}

async function saveRequest(request: SavedRequest): Promise<void> {
	const root = requireRoot();
	if (!root) {return;}
	// A file that was renamed/deleted/moved from the tree no longer exists: ask again instead of
	// resurrecting a ghost path.
	if (currentFile && !existsSync(currentFile)) {currentFile = undefined;}
	// Overwrite when the panel is editing a saved request; otherwise ask where it goes.
	if (currentFile) {
		writeRequest(currentFile, request);
		tree.refresh();
		panelDirty = false;
		syncIdentity();
		panel?.webview.postMessage({ type: 'notice', kind: 'info', text: `Saved to ${basename(currentFile)}` });
		vscode.window.setStatusBarMessage(`Asterisk: saved ${basename(currentFile)}`, 3000);
		return;
	}
	const folder = await pickFolder(root, 'Save request in…', true);
	if (!folder) {return;}
	const name = await vscode.window.showInputBox({ prompt: 'Request name', value: suggestName(request) });
	if (!name) {return;}
	const file = saveRequestTo(request, folder, name);
	panelDirty = false;
	syncIdentity();
	panel?.webview.postMessage({ type: 'notice', kind: 'info', text: `Saved as ${basename(file)}` });
	vscode.window.setStatusBarMessage(`Asterisk: saved ${basename(file)}`, 3000);
}

async function openSavedRequest(context: vscode.ExtensionContext, node: TreeNode): Promise<void> {
	let request: SavedRequest;
	try {
		request = readRequest(node.path);
	} catch (e: any) {
		vscode.window.showErrorMessage(`Asterisk: ${e?.message ?? e}`);
		return;
	}
	// ask first: if the user declines, the panel and Save must keep pointing at the current file
	if (!(await showRequest(context, request))) {return;}
	currentFile = node.path;
	panelDirty = false;
	syncIdentity();
}

/** Load a request into the panel, waiting for its `ready` handshake when it is brand new. */
async function showRequest(context: vscode.ExtensionContext, request: SavedRequest): Promise<boolean> {
	// opening a request replaces everything in the panel: ask when that would throw work away
	if (panel && panelDirty) {
		const answer = await vscode.window.showWarningMessage(
			'Discard unsaved changes to the current request?', { modal: true }, 'Discard'
		);
		if (answer !== 'Discard') {panel?.reveal(); return false;}
	}
	const existed = !!panel;
	const target = openPanel(context);
	if (existed) {
		panelDirty = false;
		target.webview.postMessage({ type: 'load', request });
	} else {
		pendingLoad = { request };
	}
	target.reveal();
	return true;
}

// ------------------------------------------------------------ import / export

/** Write imported requests into a collection, one folder level per `folder` segment. */
export function importRequests(root: string, collection: string, imported: readonly ImportedRequest[]): number {
	let count = 0;
	for (const item of imported) {
		const dirs = [sanitizeName(collection), ...(item.folder ? item.folder.split('/').filter(Boolean).map(sanitizeName) : [])];
		const dir = join(root, ...dirs);
		writeRequest(join(dir, uniqueName(dir, item.name, REQUEST_EXT)), item.request);
		count++;
	}
	return count;
}

async function importCurl(context: vscode.ExtensionContext): Promise<void> {
	const text = await vscode.env.clipboard.readText();
	if (!text.trim()) {
		vscode.window.showInformationMessage('Asterisk: copy a cURL command first, then run Import cURL.');
		return;
	}
	try {
		const request = fromCurl(text);
		if (!(await showRequest(context, request))) {return;}
		currentFile = undefined;
		panelDirty = false;
		syncIdentity();
	} catch (e: any) {
		vscode.window.showErrorMessage(`Asterisk: ${e?.message ?? e}`);
	}
}

async function importFromFile(context: vscode.ExtensionContext, kind: 'postman' | 'openapi'): Promise<void> {
	const root = requireRoot();
	if (!root) {return;}
	const picked = (
		await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Import',
			filters: { [kind === 'postman' ? 'Postman collection' : 'OpenAPI']: ['json'] },
		})
	)?.[0];
	if (!picked) {return;}

	let json: unknown;
	try {
		json = JSON.parse(require('node:fs').readFileSync(picked.fsPath, 'utf8'));
	} catch (e: any) {
		vscode.window.showErrorMessage(`Asterisk: ${picked.fsPath} is not valid JSON.`);
		return;
	}

	try {
		const imported = kind === 'postman' ? importPostman(json) : importOpenApi(json);
		const collection = basename(picked.fsPath, '.json');
		const count = importRequests(root, collection, imported);
		vscode.window.setStatusBarMessage(`Asterisk: imported ${count} request(s) into ${collection}`, 4000);
		if (!panel) {await showRequest(context, imported[0]?.request ?? { method: 'GET', url: '' });}
	} catch (e: any) {
		vscode.window.showErrorMessage(`Asterisk: ${e?.message ?? e}`);
	} finally {
		// whatever landed on disk is real: show it even if the import died half-way
		tree.refresh();
	}
}

/** Title-bar / palette: ask the panel for its request, then put the cURL on the clipboard. */
function requestCurl(): void {
	if (!panel) {
		vscode.window.showInformationMessage('Asterisk: open the client first.');
		return;
	}
	panel.webview.postMessage({ type: 'exportCurl' });
}

/** Write a response body to a user-picked path. Exported so host tests can exercise the write. */
export async function saveResponseFile(body: string, name: string): Promise<string | undefined> {
	const picked = await vscode.window.showSaveDialog({
		saveLabel: 'Save response',
		defaultUri: vscode.Uri.file(join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', name)),
		filters: { Response: [name.split('.').pop() ?? 'txt'], 'All files': ['*'] },
	});
	if (!picked) {return undefined;}
	await vscode.workspace.fs.writeFile(picked, Buffer.from(body, 'utf8'));
	vscode.window.setStatusBarMessage(`Asterisk: saved ${basename(picked.fsPath)}`, 3000);
	return picked.fsPath;
}

// -------------------------------------------------------------------- history

function logHistory(request: SavedRequest, response: HttpResponse): void {
	if (!storageDir) {return;}
	try {
		appendHistory(
			storageDir,
			makeEntry({
				method: request.method,
				url: response.sentUrl || request.url,
				headers: request.headers ?? {},
				body: request.body?.type === 'raw' ? request.body.content : undefined,
				status: response.status,
				ok: response.ok,
				timeMs: response.timeMs,
				size: response.size,
				error: response.error,
			})
		);
		historyTree?.refresh();
	} catch {
		// history is a convenience; a broken file must never break a send
	}
}

/** Rebuild a sendable request from a history row. Redacted secrets stay out (re-auth instead). */
export function entryToRequest(entry: HistoryEntry): SavedRequest {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(entry.headers ?? {})) {
		if (value !== REDACTED) {headers[key] = value;}
	}
	const url = dropRedactedQuery(entry.url);
	let body: SavedRequest['body'];
	if (entry.body) {
		try {
			JSON.parse(entry.body);
			body = { type: 'raw', format: 'json', content: entry.body };
		} catch {
			body = { type: 'raw', format: 'text', content: entry.body };
		}
	}
	return { method: entry.method as SavedRequest['method'], url, headers, body, auth: { type: 'none' } };
}

/** Replay must not send a literal `••••` credential, so redacted query params are dropped. */
function dropRedactedQuery(url: string): string {
	const marker = encodeURIComponent(REDACTED);
	const [base, ...rest] = url.split('#');
	const fragment = rest.length ? '#' + rest.join('#') : '';
	const cut = base.indexOf('?');
	if (cut === -1) {return url;}
	const kept = base
		.slice(cut + 1)
		.split('&')
		.filter((pair) => !pair.endsWith('=' + marker));
	return base.slice(0, cut) + (kept.length ? '?' + kept.join('&') : '') + fragment;
}

async function replayHistory(context: vscode.ExtensionContext, entry: HistoryEntry): Promise<void> {
	if (!(await showRequest(context, entryToRequest(entry)))) {return;}
	currentFile = undefined;
	panelDirty = false;
	syncIdentity();
}

async function clearHistoryCommand(): Promise<void> {
	if (!storageDir) {return;}
	const confirmed = await vscode.window.showWarningMessage('Clear request history?', { modal: true }, 'Clear');
	if (!confirmed) {return;}
	clearHistory(storageDir);
	historyTree.refresh();
}

async function searchHistoryCommand(): Promise<void> {
	const query = await vscode.window.showInputBox({
		prompt: 'Filter history (method, url, status, body) — empty clears the filter',
		value: historyTree.getQuery(),
	});
	if (query === undefined) {return;}
	historyTree.setQuery(query.trim());
}

type ScriptSummary = Pick<ScriptOutcome, 'logs' | 'assertions' | 'error'> & {
	/** Where the merged pre-request/test scripts came from, so a failure can name its file. */
	origin?: { preRequest?: string[]; test?: string[] };
};

const summaryOf = (outcome: ScriptOutcome | undefined): ScriptSummary | undefined =>
	outcome ? { logs: outcome.logs, assertions: outcome.assertions, error: outcome.error } : undefined;

function scriptRequest(request: SavedRequest) {
	return {
		method: request.method,
		url: request.url,
		headers: { ...(request.headers ?? {}) },
		body: request.body?.type === 'raw' ? request.body.content : undefined,
	};
}

/** Fold a script's mutations back into the request that will actually be sent. */
function applyScriptRequest(request: SavedRequest, outcome: ScriptOutcome): SavedRequest {
	const next: SavedRequest = { ...request, url: outcome.request.url, headers: { ...outcome.request.headers } };
	if (outcome.request.body !== undefined && outcome.request.body !== (request.body?.type === 'raw' ? request.body.content : undefined)) {
		let format: 'json' | 'text' = 'text';
		try {
			JSON.parse(outcome.request.body);
			format = 'json';
		} catch {
			/* keep text */
		}
		next.body = { type: 'raw', format, content: outcome.request.body };
	}
	return next;
}

/**
 * Only variables a script asked for explicitly with `setEnv(key, value)` are written, and only into
 * the active environment. Rewriting `vars` in memory never touches `.environments.json`.
 */
function persistScriptVars(changes: Record<string, string | null>): void {
	const root = collectionsRoot();
	if (!root) {return;}
	const entries = Object.entries(changes);
	if (!entries.length) {return;}
	const doc = readEnvDoc(true);
	if (!doc.active) {return;}
	let next = doc;
	for (const [key, value] of entries) {next = setVar(next, doc.active, key, value ?? '');}
	writeEnvs(root, next);
	pushEnvs();
}

/** protocol+host+port, after var substitution — used to spot a script rewriting the target host. */
function originOf(url: string, vars: Record<string, string>): string | undefined {
	try {
		return new URL(resolveVars(applyPathVars(url.trim(), vars), vars)).origin;
	} catch {
		return undefined;
	}
}

/** What the panel is editing, with enough context to tell two same-named requests apart. */
function identityOf(): { name: string; path?: string } {
	if (!currentFile) {return { name: 'Untitled request' };}
	const root = collectionsRoot();
	const parts = root && currentFile.startsWith(root) ? currentFile.slice(root.length + 1).split(/[\\/]/) : [];
	const name = parts.length ? parts.join(' / ').replace(/\.json$/, '') : basename(currentFile, '.json');
	return { name, path: currentFile };
}

/** User-configurable request timeout (ms). */
function requestTimeout(): number {
	const value = vscode.workspace.getConfiguration('asterisk').get<number>('timeoutMs');
	return typeof value === 'number' && value > 0 ? value : 30_000;
}

function syncIdentity(): void {
	if (!panel) {return;}
	const identity = identityOf();
	panel.title = currentFile ? `Asterisk — ${identity.name}` : 'Asterisk';
	// `dirty` lets the panel keep the unsaved marker a restore put there; a save sends false
	panel.webview.postMessage({ type: 'identity', ...identity, dirty: panelDirty });
}

function errorResponse(error: string): HttpResponse {
	return { ok: false, status: 0, statusText: '', headers: {}, body: '', sentUrl: '', timeMs: 0, ttfbMs: 0, size: 0, error };
}

/** Port the OAuth callback listener must bind: whichever the user's redirect URI names. */
function authPort(auth: SavedRequest['auth']): number {
	const redirect = auth?.type === 'oauth2-ac' && auth.redirectUri ? auth.redirectUri : DEFAULT_REDIRECT_URI;
	try {
		const url = new URL(redirect);
		return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
	} catch {
		return 8765;
	}
}

/** One send pipeline: pre-request script -> auth -> send -> test script. */
async function execute(
	request: SavedRequest,
	vars: Record<string, string>,
	scripts: { preRequest?: string; test?: string; origin?: { preRequest?: string[]; test?: string[] } },
	run: typeof sendRequest,
	persistVars: boolean
): Promise<{ response: HttpResponse; script?: ScriptSummary }> {
	let state = { ...vars };
	let working: SavedRequest = { ...request, headers: { ...(request.headers ?? {}) } };
	let script: ScriptSummary | undefined;
	const originBefore = originOf(working.url, state);

	if (scripts.preRequest) {
		const outcome = runScript(scripts.preRequest, { request: scriptRequest(working), vars: state }, 'pre');
		script = summaryOf(outcome);
		if (script) {script.origin = scripts.origin;}
		if (persistVars) {persistScriptVars(outcome.envChanges);}
		if (outcome.error) {return { response: errorResponse(`Pre-request script: ${outcome.error}`), script };}
		working = applyScriptRequest(working, outcome);
		state = { ...outcome.vars };

		// A script must not be able to redirect credentials: if auth is configured and the origin
		// moved, refuse instead of shipping the token to whatever host the script picked.
		const originAfter = originOf(working.url, state);
		if (working.auth && working.auth.type !== 'none' && originBefore && originAfter && originBefore !== originAfter) {
			return {
				response: errorResponse(
					`Pre-request script changed the request origin (${originBefore} -> ${originAfter}); refusing to send credentials there.`
				),
				script,
			};
		}
	}

	const authorizer = loopbackAuthorizer({
		port: authPort(working.auth),
		open: async (url) => {
			await vscode.env.openExternal(vscode.Uri.parse(url));
		},
		onError: (message) => vscode.window.showErrorMessage(message),
	});
	try {
		const prepared = await applyAuth(
			{ url: working.url, headers: { ...(working.headers ?? {}) } },
			working.auth,
			{ vars: state, authorize: (url) => authorizer.authorize(url) }
		);
		if (prepared.error) {return { response: errorResponse(prepared.error), script };}
		const response = await run({ ...working, url: prepared.url, headers: prepared.headers, timeoutMs: requestTimeout() }, state);
		logHistory({ ...working, headers: prepared.headers }, response);

		if (scripts.test) {
			const outcome = runScript(
				scripts.test,
				{
					request: scriptRequest(working),
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
			const post = summaryOf(outcome);
			if (post) {
				post.origin = scripts.origin;
				// a pre-request failure can coexist with post assertions: keep both
				script = script ? { ...post, error: script.error ?? post.error, logs: [...script.logs, ...post.logs] } : post;
			}
			if (persistVars) {persistScriptVars(outcome.envChanges);}
		}
		return { response, script };
	} finally {
		authorizer.dispose();
	}
}

/** Panel send: scoped scripts from where the request sits, vars from the active environment. */
export async function performSend(
	request: SavedRequest,
	run: typeof sendRequest = sendRequest
): Promise<{ response: HttpResponse; script?: ScriptSummary }> {
	const vars = sendVars();
	const root = collectionsRoot();
	const scripts = root && currentFile ? collectScopeScripts(root, currentFile, request) : { preRequest: request.preRequest, test: request.test };
	return execute(request, vars, scripts, run, true);
}

// ------------------------------------------------------------------- sockets

function closeSocket(): void {
	socket.close();
}

function resolveSocketUrl(raw: string): string {
	const vars = sendVars();
	return resolveVars(applyPathVars(raw.trim(), vars), vars);
}

function connectSocket(current: vscode.WebviewPanel, mode: string, rawUrl: string): void {
	socket.close();
	const url = resolveSocketUrl(rawUrl);
	if (!/^(wss?|https?):\/\//i.test(url)) {
		current.webview.postMessage({ type: 'socketState', state: 'closed', error: `Invalid URL: "${url}"` });
		return;
	}

	// Every callback is bound to its own handle: a socket that has already been replaced
	// (Disconnect -> Connect) must not post state or clear the handle that replaced it.
	let handle: WsHandle | SseHandle | undefined;
	const post = (message: any) => {
		if (socket.isLive(handle) && panel === current) {current.webview.postMessage(message);}
	};

	// ponytail: one socket at a time; a real multiplexer would need correlation ids per channel.
	if (mode === 'sse') {
		// openSse fires onError and then onClose: one cause, one line
		let errored = false;
		const opened = openSse(url, {
			onEvent: (event) => post({ type: 'socketMessage', direction: 'in', text: event.event === 'message' ? event.data : `${event.event}: ${event.data}` }),
			onError: (error) => {errored = true; post({ type: 'socketState', state: 'closed', error });},
			onClose: () => {
				if (!errored) {post({ type: 'socketState', state: 'closed', text: '— stream ended' });}
				socket.release(handle);
			},
		});
		handle = opened;
		socket.open({ kind: 'sse', handle: opened });
		post({ type: 'socketState', state: 'open' });
		return;
	}

	// a failed connect fires onError *and* onClose(1006): report the cause once, not twice
	let reportedError = false;
	const opened = openWebSocket(url, {
		onOpen: () => {reportedError = false; post({ type: 'socketState', state: 'open' });},
		onMessage: (data) => post({ type: 'socketMessage', direction: 'in', text: data }),
		onClose: (code, reason) => {
			if (!reportedError) {
				post({ type: 'socketState', state: 'closed', text: `— closed (${code}${reason ? ': ' + reason : ''})` });
			}
			socket.release(handle);
		},
		onError: (error) => {
			reportedError = true;
			post({ type: 'socketState', state: 'closed', error });
		},
	});
	handle = opened;
	socket.open({ kind: 'ws', handle: opened });
}

// ------------------------------------------------------------------- runner

/** Flatten a collection/folder node into runnable items, each with its scoped scripts merged. */
export function collectRunItems(node: TreeNode, collectionsDir: string | undefined = collectionsRoot()): RunItem[] {
	const root = collectionsDir;
	const items: RunItem[] = [];
	const walk = (current: TreeNode) => {
		if (current.kind === 'request') {
			try {
				const request = readRequest(current.path);
				const scripts = root ? collectScopeScripts(root, current.path, request) : { preRequest: request.preRequest, test: request.test };
				items.push({ name: current.name, request, preRequest: scripts.preRequest, test: scripts.test });
			} catch {
				// a broken file must not abort the run; it simply does not appear
			}
			return;
		}
		current.children.forEach(walk);
	};
	walk(node);
	return items;
}

async function runCollection(node?: TreeNode): Promise<void> {
	if (!node || node.kind === 'request') {
		vscode.window.showInformationMessage('Asterisk: right-click a collection or folder to run it.');
		return;
	}
	const mode = await vscode.window.showQuickPick(
		[
			{ label: '$(play) Run all requests', stop: false, csv: false },
			{ label: '$(debug-stop) Run, stop on first failure', stop: true, csv: false },
			{ label: '$(file) Run all requests with a CSV…', stop: false, csv: true },
			{ label: '$(file) Run with a CSV, stop on first failure…', stop: true, csv: true },
		],
		{ placeHolder: `Run "${node.name}"` }
	);
	if (!mode) {return;}

	let data: Record<string, string>[] | undefined;
	if (mode.csv) {
		const picked = (
			await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use CSV', filters: { CSV: ['csv'] } })
		)?.[0];
		if (!picked) {return;}
		try {
			data = parseCsv(require('node:fs').readFileSync(picked.fsPath, 'utf8'));
		} catch (e: any) {
			// a locked or undecodable file must not reject the message listener
			vscode.window.showErrorMessage(`Asterisk: cannot read ${basename(picked.fsPath)} — ${e?.message ?? e}`);
			return;
		}
		if (!data.length) {
			vscode.window.showErrorMessage('Asterisk: that CSV has no data rows.');
			return;
		}
	}

	let items: RunItem[];
	try {
		items = collectRunItems(node);
	} catch (e: any) {
		// a corrupt .scripts.json must be visible, not silently eat the whole collection
		vscode.window.showErrorMessage(`Asterisk: ${e?.message ?? e}`);
		return;
	}
	if (!items.length) {
		vscode.window.showInformationMessage('Asterisk: nothing to run in there.');
		return;
	}

	const results = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Asterisk: running ${node.name}`, cancellable: false },
		() =>
			runItems(items, {
				vars: sendVars(),
				data,
				maxIterations: data ? data.length : 1,
				stopOnFailure: mode.stop,
				send: async (request, vars) => (await execute(request, vars, {}, sendRequest, false)).response,
			})
	);
	historyTree?.refresh();
	showRunResults(node.name, results);
}

/** The run report is a single reusable panel; a second run replaces its contents. */
let runPanel: vscode.WebviewPanel | undefined;

const escapeHtml = (value: unknown): string =>
	String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Static results table. No scripts, no state: it is a report, not an app. */
function showRunResults(title: string, results: RunResult[]): void {
	const passed = results.filter((r) => r.passed).length;
	const rows = results
		.map((r) => {
			const status = r.status ? `${r.status}` : '—';
			const asserts = r.assertions.length ? `${r.assertions.filter((a) => a.passed).length}/${r.assertions.length}` : '';
			const data = r.data && Object.keys(r.data).length
				? Object.entries(r.data).map(([k, v]) => `${k}=${v}`).join(', ')
				: '';
			return `<tr class="${r.passed ? 'ok' : 'bad'}">
				<td>${r.iteration}</td>
				<td>${escapeHtml(r.name)}${data ? `<br><span class="data">${escapeHtml(data)}</span>` : ''}</td>
				<td>${escapeHtml(status)}</td>
				<td>${r.passed ? 'PASS' : 'FAIL'}</td>
				<td>${r.timeMs} ms</td>
				<td>${escapeHtml(asserts)}</td>
				<td>${escapeHtml(r.error ?? r.assertions.find((a) => !a.passed)?.message ?? '')}</td>
			</tr>`;
		})
		.join('');

	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
		table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
		th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
		tr.ok td:nth-child(4) { color: var(--vscode-testing-iconPassed, #3fb950); font-weight: 700; }
		tr.bad td:nth-child(4) { color: var(--vscode-errorForeground, #f85149); font-weight: 700; }
		h2 { margin: 0 0 8px; font-size: 1em; }
		.data { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
	</style></head><body>
		<h2>${escapeHtml(title)} — ${passed}/${results.length} passed</h2>
		<table><thead><tr><th>#</th><th>Request</th><th>Status</th><th>Result</th><th>Time</th><th>Assertions</th><th>Error</th></tr></thead>
		<tbody>${rows}</tbody></table>
	</body></html>`;

	if (runPanel) {
		runPanel.title = `Run: ${title}`;
		runPanel.webview.html = html;
		runPanel.reveal(vscode.ViewColumn.Beside, true);
		return;
	}
	runPanel = vscode.window.createWebviewPanel('asterisk.run', `Run: ${title}`, vscode.ViewColumn.Beside, {});
	runPanel.webview.html = html;
	runPanel.onDidDispose(() => {runPanel = undefined;});
}

// --------------------------------------------------------------------- panel

function panelOptions(context: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
	return {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
	};
}

function openPanel(context: vscode.ExtensionContext, restored?: vscode.WebviewPanel): vscode.WebviewPanel {
	if (!restored && panel) {
		panel.reveal();
		return panel;
	}

	const current =
		restored ??
		vscode.window.createWebviewPanel('asterisk', 'Asterisk', vscode.ViewColumn.One, panelOptions(context));

	panel = current;
	current.webview.options = panelOptions(context);
	current.webview.html = getHtml(context.extensionUri);

	current.webview.onDidReceiveMessage(
		async (msg: WebviewMessage) => {
			if (msg.type === 'ready') {
				current.webview.postMessage(envListMessage());
				syncIdentity();
				if (pendingLoad) {
					current.webview.postMessage({ type: 'load', request: pendingLoad.request });
					pendingLoad = undefined;
				}
				return;
			}

			if (msg.type === 'restorePath' && typeof msg.path === 'string') {
				// the module-level currentFile does not survive a reload; take the panel's word for it
				// only when the file still exists, so a deleted request does not become a save target
				if (msg.path && msg.path.endsWith('.json') && existsSync(msg.path)) {
					currentFile = msg.path;
					syncIdentity();
				}
				return;
			}

			if (msg.type === 'dirty') {panelDirty = msg.value === true; return;}

			if (msg.type === 'command' && typeof msg.command === 'string') {
				// the panel's overflow menu turns into real VS Code commands, one source of truth
				const allowed = new Set([
					'asterisk.newCollection',
					'asterisk.import.curl',
					'asterisk.import.postman',
					'asterisk.import.openapi',
					'asterisk.envs.edit',
				]);
				if (allowed.has(msg.command)) {await vscode.commands.executeCommand(msg.command);}
				return;
			}

			if (msg.type === 'reload') {
				if (currentFile) {
					// same guard as every other load path: reloading throws away what is in the panel
					if (panelDirty) {
						const answer = await vscode.window.showWarningMessage(
							'Discard unsaved changes and reload from disk?', { modal: true }, 'Reload'
						);
						if (answer !== 'Reload') {return;}
						panelDirty = false;
					}
					try {
						current.webview.postMessage({ type: 'load', request: readRequest(currentFile) });
					} catch (e: any) {
						current.webview.postMessage({ type: 'notice', kind: 'error', text: String(e?.message ?? e) });
					}
				} else {
					current.webview.postMessage({ type: 'notice', kind: 'info', text: 'This request is not saved yet.' });
				}
				return;
			}

			if (msg.type === 'socketConnect' && msg.url) {
				connectSocket(current, msg.mode ?? 'ws', msg.url);
				return;
			}

			if (msg.type === 'socketSend' && typeof msg.text === 'string') {
				// message text gets {{vars}} only — path vars would mangle payloads like ":7"
				const text = resolveVars(msg.text, sendVars());
				const live = socket.get();
				if (live?.kind === 'ws' && !live.handle.send(text)) {
					current.webview.postMessage({ type: 'socketState', state: 'closed', error: 'WebSocket is not open' });
				}
				return;
			}

			if (msg.type === 'socketClose') {
				closeSocket();
				return;
			}

			if (msg.type === 'snippet' && msg.request) {
				let text = '';
				try {
					text = snippet((msg.lang ?? 'curl') as SnippetLang, msg.request);
				} catch (e: any) {
					text = `// Cannot generate snippet: ${e?.message ?? e}`;
				}
				current.webview.postMessage({ type: 'snippet', text });
				return;
			}

			if (msg.type === 'saveResponse' && typeof msg.body === 'string') {
				await saveResponseFile(msg.body, msg.name || 'response.txt');
				return;
			}

			if (msg.type === 'copy' && typeof msg.text === 'string') {
				await vscode.env.clipboard.writeText(msg.text);
				vscode.window.setStatusBarMessage('Asterisk: copied to the clipboard', 2000);
				return;
			}

			if (msg.type === 'curl' && msg.request) {
				await vscode.env.clipboard.writeText(toCurl(msg.request));
				vscode.window.setStatusBarMessage('Asterisk: cURL copied to the clipboard', 3000);
				return;
			}

			if (msg.type === 'setEnv') {
				// say why instead of dropping the message: the panel has already snapped the select back
				const root = requireRoot();
				if (!root) {return;}
				let doc = readEnvDoc();
				if (msg.name === NEW_ENV) {
					const name = await vscode.window.showInputBox({ prompt: 'New environment name', placeHolder: 'dev' });
					if (!name) {return;}
					doc = setActive(addEnv(doc, name), envName(name));
				} else {
					doc = setActive(doc, msg.name || undefined);
				}
				writeEnvs(root, doc);
				pushEnvs();
				return;
			}

			if (msg.type === 'cancel') {
				inFlight?.abort();
				inFlight = undefined;
				return;
			}

			if (msg.type === 'send' && msg.request) {
				let response: HttpResponse;
				let script: ScriptSummary | undefined;
				inFlight?.abort();
				// capture our own controller: another send replaces `inFlight`, and that newer
				// request must stay cancellable after this one returns
				const controller = new AbortController();
				inFlight = controller;
				try {
					({ response, script } = await performSend(msg.request, (request, vars) =>
						sendRequest({ ...request, signal: controller.signal }, vars)
					));
				} catch (e: any) {
					// never leave the Send button disabled because something unexpected threw
					response = errorResponse(String(e?.message ?? e));
				}
				if (inFlight === controller) {inFlight = undefined;}
				// Drop the result if the panel was closed, replaced, or the request was superseded.
				if (panel === current && !controller.signal.aborted) {
					current.webview.postMessage({ type: 'response', response, script });
				}
				return;
			}

			if (msg.type === 'save' && msg.request) {
				await saveRequest(msg.request);
				return;
			}

			if (msg.type === 'pickFile') {
				// ponytail: native open dialog, extension-side read. No base64 round-trip through the webview.
				let reply: WebviewMessage & { path?: string; name?: string } = { type: 'filePicked', id: msg.id };
				try {
					const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Attach' }))?.[0];
					if (uri) {reply = { ...reply, path: uri.fsPath, name: basename(uri.fsPath) };}
				} catch {
					// dialog failed: reply anyway so the webview does not wait forever
				}
				if (panel === current) {current.webview.postMessage(reply);}
			}
		},
		undefined,
		context.subscriptions
	);

	current.onDidDispose(
		() => {
			if (panel === current) {
				panel = undefined;
				currentFile = undefined;
				pendingLoad = undefined;
				closeSocket();
			}
		},
		undefined,
		context.subscriptions
	);

	return current;
}

function getHtml(extensionUri: vscode.Uri): string {
	// ponytail: read from out/ so the packaged .vsix works. HTML is copied at build time.
	const file = vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.html').fsPath;
	return require('node:fs').readFileSync(file, 'utf8');
}

export function deactivate() {}
