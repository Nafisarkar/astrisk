import * as assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { HistoryTreeProvider } from '../history-tree';
import { REDACTED, appendHistory, makeEntry, readHistory, searchHistory } from '../history';
import { entryToRequest } from '../extension';

// M6 on the real host: history file, redaction, tree rendering, replay mapping.
suite('Asterisk M6 — history on the host runtime', () => {
	let dir = '';
	let server: Server;
	let base = '';

	suiteSetup(async () => {
		dir = mkdtempSync(join(tmpdir(), 'asterisk-host-history-'));
		server = createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		base = `http://127.0.0.1:${port}`;
	});

	suiteTeardown(() => new Promise<void>((resolve) => server.close(() => resolve())));

	test('history entries round-trip through the file and never keep secrets', () => {
		const entry = makeEntry({
			method: 'POST',
			url: base + '/users?token=s3cr3t',
			headers: { Authorization: 'Bearer s3cr3t', 'X-Trace': 'keep-me' },
			body: '{"password":"s3cr3t"}',
			status: 201,
			ok: true,
			timeMs: 12,
			size: 34,
		});
		appendHistory(dir, entry);
		const back = readHistory(dir);
		assert.equal(back.length, 1);
		assert.equal(back[0].headers.Authorization, REDACTED);
		assert.equal(back[0].headers['X-Trace'], 'keep-me');
		// headers, the URL and secret-looking body fields are all redacted before they touch disk
		assert.ok(!JSON.stringify(back[0].headers).includes('s3cr3t'), 'secret leaked into history headers');
		assert.ok(!back[0].url.includes('s3cr3t'), 'secret leaked into the history url');
		assert.ok(!(back[0].body ?? '').includes('s3cr3t'), 'secret leaked into the history body');
		assert.ok((back[0].body ?? '').includes(REDACTED), 'body should show the redaction marker');
		assert.ok(!JSON.stringify(back[0].headers).includes('s3cr3t'));
	});

	test('search filters by method, url and status', () => {
		const entries = readHistory(dir);
		assert.equal(searchHistory(entries, 'post').length, 1);
		assert.equal(searchHistory(entries, 'nope').length, 0);
		assert.equal(searchHistory(entries, '201').length, 1);
	});

	test('tree provider renders entries and a filtered list', () => {
		const provider = new HistoryTreeProvider(() => readHistory(dir));
		const children = provider.getChildren();
		assert.equal(children.length, 1);
		const item = provider.getTreeItem(children[0]) as vscode.TreeItem;
		assert.ok(String(item.label).startsWith('POST '));
		assert.equal(item.command?.command, 'asterisk.history.replay');
		provider.setQuery('status-will-not-match');
		assert.equal(provider.getChildren().length, 0);
		provider.setQuery('');
		assert.equal(provider.getChildren().length, 1);
	});

	test('replay drops redacted headers so no bogus Authorization is sent', () => {
		const request = entryToRequest(readHistory(dir)[0]);
		assert.equal(request.headers?.Authorization, undefined);
		assert.equal(request.headers?.['X-Trace'], 'keep-me');
		assert.equal(request.url.includes('token='), false, 'redacted query param must be dropped on replay');
		assert.ok(request.url.startsWith(base + '/users'));
		assert.deepEqual(request.body, { type: 'raw', format: 'json', content: JSON.stringify({ password: REDACTED }) });
	});

	test('replay command exists and does not throw', async () => {
		await vscode.extensions.getExtension('nafi.asterisk')!.activate();
		const cmds = await vscode.commands.getCommands(true);
		assert.ok(cmds.includes('asterisk.history.replay'));
		await vscode.commands.executeCommand('asterisk.history.replay', readHistory(dir)[0]);
	});
});

suite('Asterisk M6 — replay safety', () => {
	test('replay drops redacted query parameters instead of sending bullets', async () => {
		const { entryToRequest } = await import('../extension.js');
		const dir2 = mkdtempSync(join(tmpdir(), 'asterisk-replay-'));
		const entry = makeEntry({
			method: 'GET',
			url: 'https://h.test/path?token=abc&keep=1',
			headers: { Authorization: 'Bearer abc' },
			status: 200,
			ok: true,
			timeMs: 1,
			size: 1,
		});
		appendHistory(dir2, entry);
		const req = entryToRequest(readHistory(dir2)[0]);
		assert.ok(!req.url.includes(encodeURIComponent(REDACTED)), req.url);
		assert.ok(req.url.includes('keep=1'), req.url);
		assert.equal(req.headers?.Authorization, undefined);
	});
});
