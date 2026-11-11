import * as vscode from 'vscode';
import { searchHistory, type HistoryEntry } from './history';

/** Read-only history list. Newest first; clicking an entry replays it into the panel. */
export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryEntry> {
	private _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChange.event;
	private query = '';

	constructor(private readonly entries: () => HistoryEntry[]) {}

	refresh() {
		this._onDidChange.fire();
	}

	setQuery(query: string) {
		this.query = query;
		this.refresh();
	}

	getQuery() {
		return this.query;
	}

	getTreeItem(entry: HistoryEntry): vscode.TreeItem {
		const item = new vscode.TreeItem(`${entry.method} ${entry.url}`, vscode.TreeItemCollapsibleState.None);
		item.id = entry.id;
		item.description = entry.error ? 'error' : `${entry.status} · ${entry.timeMs} ms`;
		item.tooltip = [
			`${entry.method} ${entry.url}`,
			entry.error ? entry.error : `${entry.status} · ${entry.timeMs} ms · ${entry.size} B`,
			new Date(entry.at).toLocaleString(),
		].join('\n');
		item.iconPath = new vscode.ThemeIcon(entry.error ? 'error' : entry.ok ? 'pass' : 'warning');
		item.contextValue = 'history';
		item.command = { command: 'asterisk.history.replay', title: 'Replay', arguments: [entry] };
		return item;
	}

	getChildren(): HistoryEntry[] {
		const all = this.entries();
		return this.query ? searchHistory(all, this.query) : all;
	}
}
