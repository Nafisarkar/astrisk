import * as vscode from 'vscode';
import { dirname } from 'node:path';
import { moveNode, readTree, type TreeNode } from './store';

const MIME = 'application/vnd.code.tree.asterisk.collections';

/** Disk-backed collections tree: one directory per collection/folder, one .json per request. */
export class AsteriskTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
	private _onDidChange = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChange.event;
	readonly dragMimeTypes = [MIME];
	readonly dropMimeTypes = [MIME];

	constructor(private readonly root: () => string | undefined) {}

	refresh() {
		this._onDidChange.fire(undefined);
	}

	getTreeItem(node: TreeNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.name,
			node.kind === 'request' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
		);
		item.id = node.path;
		item.contextValue = node.kind;
		item.tooltip = node.kind === 'request' ? node.path : `${node.kind}: ${node.name}`;
		item.iconPath = new vscode.ThemeIcon(node.kind === 'collection' ? 'library' : node.kind === 'folder' ? 'folder' : 'globe');
		if (node.kind === 'request') {
			item.command = { command: 'asterisk.openRequest', title: 'Open Request', arguments: [node] };
		}
		return item;
	}

	getChildren(node?: TreeNode): TreeNode[] {
		if (node) {return node.children;}
		const root = this.root();
		return root ? readTree(root) : [];
	}

	handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer) {
		data.set(MIME, new vscode.DataTransferItem(source.map((n) => n.path)));
	}

	async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
		const paths = data.get(MIME)?.value as string[] | undefined;
		if (!paths?.length) {return;}
		// dropping onto a request means "its folder"; dropping onto the item's own folder is a no-op
		const destDir = target ? (target.kind === 'request' ? dirname(target.path) : target.path) : this.root();
		if (!destDir) {return;}
		let moved = 0;
		for (const path of paths) {
			if (dirname(path) === destDir) {continue;}
			try {
				moveNode(path, destDir);
				moved++;
			} catch (e: any) {
				vscode.window.showErrorMessage(`Asterisk: ${e?.message ?? e}`);
			}
		}
		if (moved) {this.refresh();}
	}
}
