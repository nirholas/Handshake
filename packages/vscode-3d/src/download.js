// Download a model into the workspace.
//
// Writes through vscode.workspace.fs (not node:fs) so this works the same in a
// remote, WSL, or virtual workspace as it does on a local disk.

import * as vscode from 'vscode';
import { slugFromPrompt, slugFromUrl, uniqueName } from './naming.js';

/** The configured download folder as a Uri, created if it does not exist yet. */
export async function ensureDownloadFolder() {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		throw new Error('open a folder in VS Code first; models are saved into the workspace');
	}
	const rel = vscode.workspace.getConfiguration('threews3d').get('downloadFolder', 'models');
	const dir = vscode.Uri.joinPath(folders[0].uri, ...String(rel || 'models').split('/').filter(Boolean));
	await vscode.workspace.fs.createDirectory(dir);
	return dir;
}

/** Names already present in a directory, as a lookup for uniqueName(). */
async function namesIn(dir) {
	try {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		return new Set(entries.map(([name]) => name.toLowerCase()));
	} catch {
		return new Set();
	}
}

/**
 * Fetch a GLB and write it into the download folder.
 *
 * @param {string} url
 * @param {{ prompt?: string, token?: vscode.CancellationToken, progress?: vscode.Progress<{ message?: string }> }} [opts]
 * @returns {Promise<{ uri: vscode.Uri, bytes: number }>}
 */
export async function downloadModel(url, { prompt, token, progress } = {}) {
	const dir = await ensureDownloadFolder();
	const taken = await namesIn(dir);
	const stem = prompt ? slugFromPrompt(prompt) : slugFromUrl(url);
	const ext = /\.gltf(\?|$)/i.test(url) ? '.gltf' : '.glb';
	const name = uniqueName(stem, ext, (candidate) => taken.has(candidate.toLowerCase()));
	const target = vscode.Uri.joinPath(dir, name);

	const controller = new AbortController();
	const sub = token?.onCancellationRequested(() => controller.abort());
	let res;
	try {
		res = await fetch(url, { signal: controller.signal });
	} catch (err) {
		if (controller.signal.aborted) throw new Error('download cancelled');
		throw new Error(`could not download the model: ${err?.message || err}`);
	} finally {
		sub?.dispose();
	}
	if (!res.ok) throw new Error(`the model URL returned HTTP ${res.status}`);
	progress?.report({ message: 'downloading the model…' });
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (!bytes.byteLength) throw new Error('the model URL returned an empty file');
	await vscode.workspace.fs.writeFile(target, bytes);
	return { uri: target, bytes: bytes.byteLength };
}
