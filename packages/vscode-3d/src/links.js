// Remembers where a local model came from, and what it is.
//
// A generated or imported GLB has a public URL on the three.ws CDN. That URL is
// what the embed snippet, the rigger, and the refiner need, and it cannot be
// recovered from the bytes on disk, so it is recorded when the file is written
// and looked up later by workspace-relative path (absolute paths break when a
// repo is cloned somewhere else or opened over a remote). Refinement also
// records the prompt that made the model and the version lineage, so the next
// refinement extends the same history instead of starting a new one.

import * as vscode from 'vscode';

const KEY = 'threews3d.modelLinks';

/**
 * @typedef {object} ModelMeta
 * @property {string} url public URL of the model
 * @property {string|null} prompt the prompt that produced it, when known
 * @property {import('./refine.js').LineageVersion[]|null} lineage refinement history
 */

export class ModelLinks {
	/** @param {vscode.Memento} memento */
	constructor(memento) {
		this.memento = memento;
	}

	/** The public URL for a local model, or null. @param {vscode.Uri} uri */
	get(uri) {
		return this.meta(uri)?.url || null;
	}

	/** Everything recorded about a local model, or null. @param {vscode.Uri} uri @returns {ModelMeta|null} */
	meta(uri) {
		const raw = this.memento.get(KEY, {})[keyFor(uri)];
		if (!raw) return null;
		// Entries written by 0.1.0 are bare URL strings.
		if (typeof raw === 'string') return { url: raw, prompt: null, lineage: null };
		return { url: raw.url, prompt: raw.prompt || null, lineage: Array.isArray(raw.lineage) ? raw.lineage : null };
	}

	/**
	 * @param {vscode.Uri} uri
	 * @param {string} url
	 * @param {{ prompt?: string|null, lineage?: import('./refine.js').LineageVersion[]|null }} [extra]
	 */
	async set(uri, url, extra = {}) {
		const map = { ...this.memento.get(KEY, {}) };
		const previous = this.meta(uri);
		map[keyFor(uri)] = {
			url,
			prompt: extra.prompt ?? previous?.prompt ?? null,
			lineage: extra.lineage ?? previous?.lineage ?? null,
		};
		await this.memento.update(KEY, map);
	}
}

function keyFor(uri) {
	const relative = vscode.workspace.asRelativePath(uri, false);
	return relative.replace(/\\/g, '/').toLowerCase();
}
