// Recent public creations from the three.ws forge. Click one to preview it in
// the viewer; the inline action imports it into the workspace.

import * as vscode from 'vscode';
import { listCreations } from './gallery.js';

const STATE = { loading: 'loading', error: 'error', ready: 'ready' };

export class GalleryProvider {
	constructor() {
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._emitter.event;
		this._items = [];
		this._state = STATE.ready;
		this._message = '';
	}

	dispose() {
		this._emitter.dispose();
	}

	origin() {
		return vscode.workspace.getConfiguration('threews3d').get('origin', 'https://three.ws');
	}

	async refresh() {
		this._state = STATE.loading;
		this._emitter.fire();
		try {
			this._items = await listCreations(this.origin(), { limit: 40 });
			this._state = STATE.ready;
		} catch (err) {
			this._state = STATE.error;
			this._message = err?.message || String(err);
			this._items = [];
		}
		this._emitter.fire();
	}

	getTreeItem(node) {
		return node;
	}

	getChildren(node) {
		if (node) return [];
		if (this._state === STATE.loading) {
			return [infoNode('Loading recent creations…', 'loading~spin')];
		}
		if (this._state === STATE.error) {
			return [infoNode(`Could not load the gallery: ${this._message}`, 'error')];
		}
		if (!this._items.length) {
			return [infoNode('No public creations right now', 'info')];
		}
		return this._items.map(creationNode);
	}
}

function creationNode(item) {
	const title = item.prompt ? shorten(item.prompt, 60) : item.id.slice(0, 8);
	const node = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
	node.description = [item.category, item.tier].filter(Boolean).join(' · ');
	node.tooltip = new vscode.MarkdownString(
		[
			`**${escapeMd(shorten(item.prompt || 'Untitled creation', 240))}**`,
			'',
			item.category ? `- **Category:** ${item.category}` : '',
			item.tier ? `- **Tier:** ${item.tier}` : '',
			item.backend ? `- **Backend:** ${item.backend}` : '',
			item.createdAt ? `- **Created:** ${item.createdAt}` : '',
		]
			.filter(Boolean)
			.join('\n'),
	);
	node.iconPath = new vscode.ThemeIcon(item.category === 'avatar' ? 'person' : 'symbol-color');
	node.contextValue = 'threews3dGalleryItem';
	node.creation = item;
	node.command = {
		command: 'threews3d.previewCreation',
		title: 'Preview in the 3D viewer',
		arguments: [item],
	};
	return node;
}

function shorten(text, max) {
	const clean = String(text || '').replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function escapeMd(text) {
	return text.replace(/([\\`*_[\]])/g, '\\$1');
}

function infoNode(label, icon) {
	const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	node.iconPath = new vscode.ThemeIcon(icon);
	node.contextValue = 'threews3dInfo';
	return node;
}
