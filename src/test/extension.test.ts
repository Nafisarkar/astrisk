import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Asterisk M1 — panel', () => {
	const ext = () => vscode.extensions.getExtension('nafi.asterisk');

	test('extension is installed', () => {
		assert.ok(ext(), 'extension not found — check package.json name/publisher');
	});

	test('activates without error', async () => {
		await ext()!.activate();
		assert.ok(ext()!.isActive, 'extension failed to activate');
	});

	test('asterisk.open is registered after activation', async () => {
		await ext()!.activate();
		const cmds = await vscode.commands.getCommands(true);
		assert.ok(cmds.includes('asterisk.open'), 'asterisk.open missing from command registry');
	});

	test('opening panel does not throw', async () => {
		await ext()!.activate();
		await vscode.commands.executeCommand('asterisk.open');
	});

	test('opening panel twice does not throw (reuses existing)', async () => {
		await ext()!.activate();
		await vscode.commands.executeCommand('asterisk.open');
		await vscode.commands.executeCommand('asterisk.open');
	});

	test('webview html file ships in out/', async () => {
		const file = vscode.Uri.joinPath(ext()!.extensionUri, 'out', 'webview', 'main.html');
		const bytes = await vscode.workspace.fs.readFile(file);
		const html = Buffer.from(bytes).toString('utf8');
		assert.ok(html.includes('acquireVsCodeApi'), 'webview HTML missing vscode API bridge');
		assert.ok(html.includes('id="send"'), 'webview HTML missing send button');
		assert.ok(html.includes('id="url"'), 'webview HTML missing url input');
	});
});
