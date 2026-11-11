import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

suite('Asterisk — sidebar', () => {
	const ext = () => vscode.extensions.getExtension('nafi.asterisk')!;

	test('activity bar container is contributed', () => {
		const containers = ext().packageJSON.contributes.viewsContainers.activitybar;
		const asterisk = containers.find((c: { id: string }) => c.id === 'asterisk');
		assert.ok(asterisk, 'no activitybar container with id "asterisk"');
		assert.strictEqual(asterisk.title, 'Asterisk');
		assert.strictEqual(asterisk.icon, 'media/icon.svg');
	});

	test('icon file exists on disk', () => {
		const icon = vscode.Uri.joinPath(ext().extensionUri, 'media', 'icon.svg');
		assert.ok(fs.existsSync(icon.fsPath), 'media/icon.svg missing');
	});

	test('icon is valid monochrome SVG using currentColor', () => {
		const icon = vscode.Uri.joinPath(ext().extensionUri, 'media', 'icon.svg');
		const svg = fs.readFileSync(icon.fsPath, 'utf8');
		assert.ok(svg.includes('currentColor'), 'icon must use currentColor to follow the theme');
		assert.ok(!/#[0-9a-f]{3,6}/i.test(svg), 'icon must not hardcode hex colors');
		assert.ok(/viewBox="0 0 \d+ \d+"/.test(svg), 'icon must define a square viewBox');
		assert.ok(svg.trimStart().startsWith('<svg'), 'not an svg');
		assert.ok(svg.trimEnd().endsWith('</svg>'), 'unterminated svg');
	});

	test('collections view is contributed under the asterisk container', () => {
		const views = ext().packageJSON.contributes.views.asterisk;
		assert.ok(views, 'contributes.views.asterisk missing');
		assert.strictEqual(views[0].id, 'asterisk.collections');
	});

	test('activationEvents includes onView', () => {
		const events = ext().packageJSON.activationEvents;
		assert.ok(events.includes('onView:asterisk.collections'), 'must activate when the view opens');
	});

	test('view is resolvable via the tree view API', async () => {
		await ext().activate();
		// registerTreeDataProvider means the view has a provider; focusView throws if the view id is unknown.
		await vscode.commands.executeCommand('asterisk.collections.focus');
	});

	test('asterisk.refresh command is registered', async () => {
		await ext().activate();
		const cmds = await vscode.commands.getCommands(true);
		assert.ok(cmds.includes('asterisk.refresh'), 'asterisk.refresh missing');
	});

	test('asterisk.refresh runs without error', async () => {
		await ext().activate();
		await vscode.commands.executeCommand('asterisk.refresh');
	});

	test('every contributed command is registered at runtime', async () => {
		await ext().activate();
		const cmds = await vscode.commands.getCommands(true);
		const contributed = ext().packageJSON.contributes.commands.map((c: { command: string }) => c.command);
		const missing = contributed.filter((c: string) => !cmds.includes(c));
		assert.deepEqual(missing, [], `commands contributed but not registered: ${missing.join(', ')}`);
	});

	test('view title menus reference only real commands', () => {
		const menus = ext().packageJSON.contributes.menus['view/title'];
		const contributed = ext().packageJSON.contributes.commands.map((c: { command: string }) => c.command);
		const orphans = menus
			.map((m: { command: string }) => m.command)
			.filter((c: string) => !contributed.includes(c));
		assert.deepEqual(orphans, [], `menu commands not in contributes.commands: ${orphans.join(', ')}`);
	});
});
