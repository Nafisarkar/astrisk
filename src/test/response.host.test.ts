import * as assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { saveResponseFile } from '../extension';
import { sendRequest } from '../http';

// M9 on the real host: response writing, and the engine fields the panel renders.
suite('Asterisk M9 — response extras on the host runtime', () => {
	test('response bodies are written to the picked file verbatim', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'asterisk-response-'));
		const original = vscode.window.showSaveDialog;
		const target = vscode.Uri.file(join(dir, 'response.json'));
		(vscode.window as any).showSaveDialog = async () => target;
		try {
			const written = await saveResponseFile('{"unicode":"héllo 世界","n":1}', 'response.json');
			assert.equal(written, target.fsPath);
			assert.equal(readFileSync(target.fsPath, 'utf8'), '{"unicode":"héllo 世界","n":1}');
		} finally {
			(vscode.window as any).showSaveDialog = original;
		}
	});

	test('a cancelled save dialog writes nothing and resolves undefined', async () => {
		const original = vscode.window.showSaveDialog;
		(vscode.window as any).showSaveDialog = async () => undefined;
		try {
			assert.equal(await saveResponseFile('body', 'response.txt'), undefined);
		} finally {
			(vscode.window as any).showSaveDialog = original;
		}
	});

	test('the engine reports ttfb and sentUrl the panel renders', async () => {
		const { createServer } = await import('node:http');
		const server = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		try {
			const r = await sendRequest({ method: 'GET', url: `http://127.0.0.1:${port}/thing` });
			assert.equal(r.status, 200);
			assert.equal(r.sentUrl, `http://127.0.0.1:${port}/thing`);
			assert.ok(typeof r.ttfbMs === 'number' && r.ttfbMs >= 0);
			assert.ok(r.ttfbMs <= r.timeMs);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
