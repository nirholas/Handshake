// Every model in the workspace, grouped by the folder that holds it.
// Clicking one opens it in the 3D viewer; the tree refreshes itself when models
// are added, generated, or deleted.

import * as vscode from 'vscode';
import { formatBytes } from './naming.js';

const GLOB = '**/*.{glb,gltf}';
const EXCLUDE = '**/{node_modules,.git,dist,dist-lib,build,out}/**';

export class ModelsProvider {
	/** @param {import('./links.js').ModelLinks} links */
	constructor(links) {
		this.links = links;
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._emitter.event;
		this._files = [];
		this._error = '';
		this._watcher = vscode.workspace.createFileSystemWatcher(GLOB);
		const bump = () => this.refresh();
		this._watcher.onDidCreate(bump);
		this._watcher.onDidDelete(bump);
	}

	dispose() {
		this._watcher.dispose();
		this._emitter.dispose();
	}

	async refresh() {
		// The previous list stays on screen while the rescan runs, so the welcome
		// view does not flash in and out every time a model is written.
		try {
			const uris = await vscode.workspace.findFiles(GLOB, EXCLUDE, 2000);
			const stats = await Promise.all(
				uris.map(async (uri) => {
					const size = await vscode.workspace.fs.stat(uri).then(
						(s) => s.size,
						() => 0,
					);
					return { uri, size };
				}),
			);
			stats.sort((a, b) => a.uri.path.localeCompare(b.uri.path));
			this._files = stats;
			this._error = '';
		} catch (err) {
			this._error = err?.message || String(err);
			this._files = [];
		}
		this._emitter.fire();
	}

	getTreeItem(node) {
		return node;
	}

	getChildren(node) {
		if (this._error) return [infoNode(`Could not scan the workspace: ${this._error}`, 'error')];
		if (!node) return this._groups();
		return (node.files || []).map((file) => this._modelNode(file));
	}

	_groups() {
		if (!this._files.length) return [];
		const byFolder = new Map();
		for (const file of this._files) {
			const folder = dirLabel(file.uri);
			if (!byFolder.has(folder)) byFolder.set(folder, []);
			byFolder.get(folder).push(file);
		}
		// A single folder is not worth a level of nesting.
		if (byFolder.size === 1) return this._files.map((file) => this._modelNode(file));
		return [...byFolder.entries()].map(([folder, files]) => {
			const item = new vscode.TreeItem(folder, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = vscode.ThemeIcon.Folder;
			item.description = `${files.length} model${files.length === 1 ? '' : 's'}`;
			item.files = files;
			item.contextValue = 'threews3dFolder';
			return item;
		});
	}

	_modelNode({ uri, size }) {
		const name = uri.path.split('/').pop();
		const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
		item.resourceUri = uri;
		item.description = formatBytes(size);
		const url = this.links.get(uri);
		item.tooltip = new vscode.MarkdownString(
			[
				`**${name}**`,
				'',
				`- **Size:** ${formatBytes(size)}`,
				`- **Path:** \`${vscode.workspace.asRelativePath(uri, false)}\``,
				url ? `- **Source:** ${url}` : '- **Source:** local file',
			].join('\n'),
		);
		item.iconPath = new vscode.ThemeIcon('symbol-color');
		item.contextValue = 'threews3dModel';
		item.command = {
			command: 'vscode.openWith',
			title: 'Open in the 3D viewer',
			arguments: [uri, 'threews3d.modelViewer'],
		};
		return item;
	}
}

function dirLabel(uri) {
	const relative = vscode.workspace.asRelativePath(uri, false);
	const parts = relative.split('/');
	parts.pop();
	return parts.join('/') || '.';
}

function infoNode(label, icon) {
	const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	node.iconPath = new vscode.ThemeIcon(icon);
	node.contextValue = 'threews3dInfo';
	return node;
}
