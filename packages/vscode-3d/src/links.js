// Remembers where a local model came from.
//
// A generated or imported GLB has a public URL on the three.ws CDN. That URL is
// what the embed snippet and the rigger need, and it cannot be recovered from
// the bytes on disk, so it is recorded when the file is written and looked up
// later by workspace-relative path (absolute paths break when a repo is cloned
// somewhere else or opened over a remote).

import * as vscode from 'vscode';

const KEY = 'threews3d.modelLinks';

export class ModelLinks {
	/** @param {vscode.Memento} memento */
	constructor(memento) {
		this.memento = memento;
	}

	/** @param {vscode.Uri} uri */
	get(uri) {
		const map = this.memento.get(KEY, {});
		return map[keyFor(uri)] || null;
	}

	/** @param {vscode.Uri} uri @param {string} url */
	async set(uri, url) {
		const map = { ...this.memento.get(KEY, {}) };
		map[keyFor(uri)] = url;
		await this.memento.update(KEY, map);
	}
}

function keyFor(uri) {
	const relative = vscode.workspace.asRelativePath(uri, false);
	return relative.replace(/\\/g, '/').toLowerCase();
}
