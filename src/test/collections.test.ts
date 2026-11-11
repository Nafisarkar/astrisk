import * as assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { AsteriskTreeProvider } from '../tree';
import { createCollection, createFolder, readRequest, readTree, writeRequest, type SavedRequest, type TreeNode } from '../store';
import { collectRunItems, importRequests, saveRequestTo } from '../extension';
import { writeScripts } from '../scopes';

const MIME = 'application/vnd.code.tree.asterisk.collections';

const request: SavedRequest = {
	method: 'POST',
	url: 'https://api.example.com/users',
	headers: { 'Content-Type': 'application/json' },
	body: { type: 'raw', format: 'json', content: '{"name":"Ada"}' },
};

suite('Asterisk M3 — collections', () => {
	let dir = '';
	let collection = '';
	let folder = '';
	let file = '';

	suiteSetup(() => {
		dir = mkdtempSync(join(tmpdir(), 'asterisk-collections-'));
		collection = createCollection(dir, 'My API');
		folder = createFolder(collection, 'Users');
		file = writeRequest(join(folder, 'create-user.json'), request);
	});

	test('commands are registered', async () => {
		const ext = vscode.extensions.getExtension('nafi.asterisk')!;
		await ext.activate();
		const cmds = await vscode.commands.getCommands(true);
		for (const id of [
			'asterisk.saveRequest',
			'asterisk.newCollection',
			'asterisk.newFolder',
			'asterisk.renameNode',
			'asterisk.deleteNode',
			'asterisk.openRequest',
		]) {
			assert.ok(cmds.includes(id), `${id} missing`);
		}
	});

	test('menus only reference contributed commands', () => {
		const ext = vscode.extensions.getExtension('nafi.asterisk')!;
		const contributed: string[] = ext.packageJSON.contributes.commands.map((c: { command: string }) => c.command);
		for (const [menu, items] of Object.entries(ext.packageJSON.contributes.menus)) {
			for (const item of items as { command: string }[]) {
				assert.ok(contributed.includes(item.command), `${menu} references unregistered command ${item.command}`);
			}
		}
	});

	test('tree provider renders collections, folders and requests from disk', () => {
		const provider = new AsteriskTreeProvider(() => dir);
		const collections = provider.getChildren();
		assert.equal(collections.length, 1);
		assert.equal(collections[0].kind, 'collection');
		assert.equal(collections[0].name, 'My API');

		const collectionItem = provider.getTreeItem(collections[0]);
		assert.equal(collectionItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.equal(collectionItem.contextValue, 'collection');

		const children = provider.getChildren(collections[0]);
		assert.deepEqual(children.map((n) => `${n.kind}:${n.name}`), ['folder:Users']);

		const requestNode = provider.getChildren(children[0]).find((n) => n.kind === 'request')!;
		assert.equal(requestNode.name, 'create-user');
		const item = provider.getTreeItem(requestNode) as vscode.TreeItem & { command?: vscode.Command };
		assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.equal(item.contextValue, 'request');
		assert.equal(item.command?.command, 'asterisk.openRequest');
		assert.deepEqual((item.command?.arguments ?? [])[0], requestNode);
	});

	test('tree provider is empty (not broken) without a workspace root', () => {
		const provider = new AsteriskTreeProvider(() => undefined);
		assert.deepEqual(provider.getChildren(), []);
	});

	test('drag and drop moves a request into another folder on disk', async () => {
		const provider = new AsteriskTreeProvider(() => dir);
		const source = writeRequest(join(folder, 'drag-me.json'), request);
		const node: TreeNode = { kind: 'request', name: 'drag-me', path: source, children: [] };
		provider.getTreeItem(node);

		const target = createFolder(collection, 'Archive');
		const data = new vscode.DataTransfer();
		provider.handleDrag([node], data);
		assert.deepEqual(data.get(MIME)?.value, [source]);

		await provider.handleDrop({ kind: 'folder', name: 'Archive', path: target, children: [] }, data);

		const moved = join(target, 'drag-me.json');
		assert.ok(existsSync(moved), 'file was not moved');
		assert.ok(!existsSync(source), 'old file still present');
		const archive = readTree(dir)[0].children.find((n) => n.name === 'Archive')!;
		assert.deepEqual(archive.children.map((n) => n.name), ['drag-me']);
	});

	test('dropping a folder into itself is refused without touching disk', async () => {
		const provider = new AsteriskTreeProvider(() => dir);
		const self = readTree(dir)[0].children.find((n) => n.name === 'Users')!;
		assert.ok(self, 'Users folder fixture missing');
		const data = new vscode.DataTransfer();
		provider.handleDrag([self], data);
		await provider.handleDrop(self, data);
		assert.ok(existsSync(self.path));
	});

	test('saveRequestTo writes a request the tree can read back', () => {
		const target = createFolder(collection, 'Saved');
		const saved = saveRequestTo(request, target, 'round-trip');
		assert.equal(basename(saved), 'round-trip.json');
		const onDisk = JSON.parse(readFileSync(saved, 'utf8')) as SavedRequest;
		assert.deepEqual(onDisk, request);
		const node: TreeNode | undefined = readTree(dir)[0].children.find((n) => n.name === 'Saved')?.children[0];
		assert.equal(node?.name, 'round-trip');
	});

	test('opening a saved request does not throw', async () => {
		await vscode.commands.executeCommand('asterisk.openRequest', {
			kind: 'request',
			name: 'create-user',
			path: file,
			children: [],
		} as TreeNode);
	});

	test('opening a corrupt request file reports instead of throwing', async () => {
		const broken = join(dir, 'broken.json');
		writeFileSync(broken, '{ not json');
		await vscode.commands.executeCommand('asterisk.openRequest', { kind: 'request', name: 'broken', path: broken, children: [] } as TreeNode);
	});

	test('refresh command still works with the tree wired to the workspace', async () => {
		await vscode.commands.executeCommand('asterisk.refresh');
	});

	suiteTeardown(() => {
		// the fixtures live in the OS temp dir; leave them out of the repo entirely
		assert.ok(dir.includes('asterisk-collections-'));
	});
});

suite('Asterisk M7 — import / export', () => {
	let dir = '';

	suiteSetup(() => {
		dir = mkdtempSync(join(tmpdir(), 'asterisk-import-'));
	});

	test('importing a Postman-shaped list writes requests into folders', () => {
		const count = importRequests(dir, 'Imported API', [
			{ name: 'get-users', request: { method: 'GET', url: 'https://api.test/users' } },
			{ name: 'create-user', folder: 'Users', request: { method: 'POST', url: 'https://api.test/users' } },
			{ name: 'deep', folder: 'Users/Admin', request: { method: 'DELETE', url: 'https://api.test/users/1' } },
		]);
		assert.equal(count, 3);
		const tree = readTree(dir);
		assert.equal(tree.length, 1);
		const collection = tree[0];
		assert.equal(collection.name, 'Imported API');
		assert.deepEqual(collection.children.map((c) => `${c.kind}:${c.name}`), ['folder:Users', 'request:get-users']);
		const users = collection.children.find((c) => c.name === 'Users')!;
		assert.deepEqual(users.children.map((c) => `${c.kind}:${c.name}`), ['folder:Admin', 'request:create-user']);
		assert.equal(readRequest(join(users.path, 'create-user.json')).method, 'POST');
	});

	test('importing twice does not clobber the first import', () => {
		importRequests(dir, 'Imported API', [{ name: 'get-users', request: { method: 'GET', url: 'https://api.test/x' } }]);
		const files = walk(dir).filter((f) => f.endsWith('.json'));
		assert.ok(files.some((f) => f.endsWith('get-users 2.json')), files.join(', '));
	});

	test('every import command is registered', async () => {
		const ext = vscode.extensions.getExtension('nafi.asterisk')!;
		await ext.activate();
		const cmds = await vscode.commands.getCommands(true);
		for (const id of ['asterisk.import.curl', 'asterisk.import.postman', 'asterisk.import.openapi', 'asterisk.export.curl']) {
			assert.ok(cmds.includes(id), `${id} missing`);
		}
	});

	suiteTeardown(() => {
		assert.ok(dir.includes('asterisk-import-'));
	});
});

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {out.push(...walk(path));} else {out.push(path);}
	}
	return out;
}

suite('Asterisk M11 — collection runner', () => {
	let dir = '';

	suiteSetup(() => {
		dir = mkdtempSync(join(tmpdir(), 'asterisk-runner-'));
	});

	test('collectRunItems flattens folders and merges scoped scripts', async () => {
		const collection = createCollection(dir, 'R');
		const folder = createFolder(collection, 'Nested');
		writeRequest(join(collection, 'a.json'), { method: 'GET', url: 'https://api.test/a' });
		writeRequest(join(folder, 'b.json'), { method: 'POST', url: 'https://api.test/b', test: 'expect(response.status).to.equal(200);' });
		writeScripts(collection, { preRequest: 'request.headers["X-Col"] = "1";' });

		const items = collectRunItems(readTree(dir)[0], dir);
		// display order: folders before requests, each alphabetical
		assert.deepEqual(items.map((i) => i.name), ['b', 'a']);
		for (const item of items) {
			assert.equal(item.preRequest, 'request.headers["X-Col"] = "1";');
		}
		assert.equal(items.find((i) => i.name === 'b')!.test, 'expect(response.status).to.equal(200);');
	});

	test('a broken request file is skipped instead of aborting the run', async () => {
		const collection = createCollection(dir, 'Broken');
		writeRequest(join(collection, 'good.json'), { method: 'GET', url: 'https://api.test/x' });
		writeFileSync(join(collection, 'bad.json'), '{ not json');
		const node = readTree(dir).find((n) => n.name === 'Broken')!;
		assert.deepEqual(collectRunItems(node, dir).map((i) => i.name), ['good']);
	});

	test('the run command is registered and refuses a request node politely', async () => {
		await vscode.extensions.getExtension('nafi.asterisk')!.activate();
		const cmds = await vscode.commands.getCommands(true);
		assert.ok(cmds.includes('asterisk.run.collection'));
		await vscode.commands.executeCommand('asterisk.run.collection', undefined);
	});
});

suite('Asterisk M3 — drag and drop edge cases (bug hunt)', () => {
	let dir = '';

	suiteSetup(() => {
		dir = mkdtempSync(join(tmpdir(), 'asterisk-dnd-'));
	});

	test('dropping onto a request lands in that request folder', async () => {
		const collection = createCollection(dir, 'C');
		const folder = createFolder(collection, 'Target');
		writeRequest(join(folder, 'anchor.json'), { method: 'GET', url: 'https://api.test/anchor' });
		const moving = writeRequest(join(collection, 'moving.json'), { method: 'GET', url: 'https://api.test/m' });

		const provider = new AsteriskTreeProvider(() => dir);
		const data = new vscode.DataTransfer();
		provider.handleDrag([{ kind: 'request', name: 'moving', path: moving, children: [] }], data);
		await provider.handleDrop({ kind: 'request', name: 'anchor', path: join(folder, 'anchor.json'), children: [] }, data);

		assert.ok(existsSync(join(folder, 'moving.json')), 'file should land next to the anchor request');
		assert.ok(!existsSync(moving));
	});

	test('dropping onto the folder a request already lives in is a no-op', async () => {
		const collection = createCollection(dir, 'Same');
		const file = writeRequest(join(collection, 'stay.json'), { method: 'GET', url: 'https://api.test/s' });

		const provider = new AsteriskTreeProvider(() => dir);
		const data = new vscode.DataTransfer();
		provider.handleDrag([{ kind: 'request', name: 'stay', path: file, children: [] }], data);
		await provider.handleDrop({ kind: 'collection', name: 'Same', path: collection, children: [] }, data);

		assert.ok(existsSync(file), 'original file kept');
		assert.ok(!existsSync(join(collection, 'stay 2.json')), 'must not clone the request');
	});
});
