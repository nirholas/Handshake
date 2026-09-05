// The 3D viewer: a custom editor for .glb/.gltf files in the workspace, and a
// panel for models that live on a URL.
//
// The host owns the file: it reads the bytes, runs the inspector, and streams
// the report to the webview. The webview owns the picture, and sends back what
// only a running scene can produce: a retargeted clip to bake, a turntable, a
// render for the quality check.

import * as vscode from 'vscode';
import { reportFor } from './inspect.js';
import { notify, trackPanel } from './active-panel.js';
import { uniqueName } from './naming.js';
import { writeClipIntoGlb } from './bake-clip.js';
import { clipSlug } from './animations.js';

export const VIEW_TYPE = 'threews3d.modelViewer';

/** Models larger than this are rendered but not inspected; the report would stall. */
const MAX_INSPECT_BYTES = 96 * 1024 * 1024;

/** Custom editor for model files. One webview per open document. */
export class ModelViewerProvider {
	/** @param {vscode.ExtensionContext} context @param {import('./links.js').ModelLinks} links */
	constructor(context, links, output) {
		this.context = context;
		this.links = links;
		this.output = output;
	}

	static register(context, links, output) {
		return vscode.window.registerCustomEditorProvider(
			VIEW_TYPE,
			new ModelViewerProvider(context, links, output),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	async openCustomDocument(uri) {
		return { uri, dispose: () => {} };
	}

	async resolveCustomEditor(document, panel) {
		const dir = vscode.Uri.joinPath(document.uri, '..');
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), dir],
		};
		panel.webview.html = viewerHtml(panel.webview, this.context.extensionUri);

		const src = panel.webview.asWebviewUri(document.uri).toString();
		const wire = attachViewer(this.context, panel, {
			src,
			resource: document.uri,
			links: this.links,
			output: this.output,
			readBytes: () => vscode.workspace.fs.readFile(document.uri),
		});
		trackPanel(panel);

		// Regenerate the model on disk and the open viewer catches up on its own.
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(dir, path(document.uri)),
		);
		watcher.onDidChange(() => wire.reload());
		panel.onDidDispose(() => {
			watcher.dispose();
			wire.dispose();
		});
	}
}

/** Open a model that lives on an http(s) URL in its own panel. */
export function openRemoteModel(context, links, output, url, title, column = vscode.ViewColumn.Active) {
	const panel = vscode.window.createWebviewPanel(
		VIEW_TYPE,
		title || 'three.ws 3D',
		column,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
		},
	);
	panel.webview.html = viewerHtml(panel.webview, context.extensionUri);
	const wire = attachViewer(context, panel, {
		src: url,
		remoteUrl: url,
		links,
		output,
		readBytes: async () => {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const declared = Number(res.headers.get('content-length') || 0);
			if (declared > MAX_INSPECT_BYTES) {
				res.body?.cancel();
				throw new Error(`model is ${declared} bytes, too large to inspect`);
			}
			return new Uint8Array(await res.arrayBuffer());
		},
	});
	trackPanel(panel);
	panel.onDidDispose(() => wire.dispose());
	return panel;
}

/**
 * Open a model that lives outside the workspace (a committed version pulled
 * from git) beside the current editor.
 */
export function openLocalModel(context, links, output, uri, title, column = vscode.ViewColumn.Beside) {
	const dir = vscode.Uri.joinPath(uri, '..');
	const panel = vscode.window.createWebviewPanel(VIEW_TYPE, title, column, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), dir],
	});
	panel.webview.html = viewerHtml(panel.webview, context.extensionUri);
	const wire = attachViewer(context, panel, {
		src: panel.webview.asWebviewUri(uri).toString(),
		resource: uri,
		links,
		output,
		readBytes: () => vscode.workspace.fs.readFile(uri),
	});
	trackPanel(panel);
	panel.onDidDispose(() => wire.dispose());
	return panel;
}

/**
 * Wire one webview: hand it the model, run the report, and route its actions
 * back into the extension's commands.
 */
function attachViewer(context, panel, { src, resource, remoteUrl, links, output, readBytes }) {
	let disposed = false;

	const post = (message) => {
		if (!disposed) panel.webview.postMessage(message);
	};

	// What the commands need to know about this viewer.
	panel.threews = { resource, remoteUrl, readBytes, stats: null, fileSize: 0, post, pending: new Map() };

	const sendReport = async () => {
		try {
			const bytes = await readBytes();
			panel.threews.fileSize = bytes.byteLength;
			if (bytes.byteLength > MAX_INSPECT_BYTES) return;
			const { rows, suggestions } = await reportFor(bytes);
			post({ type: 'report', rows, suggestions });
		} catch (err) {
			output.appendLine(`report failed for ${resource?.fsPath || remoteUrl}: ${err?.message || err}`);
		}
	};

	const sub = panel.webview.onDidReceiveMessage(async (msg) => {
		if (msg?.type === 'ready') {
			post({ type: 'load', src });
			sendReport();
		} else if (msg?.type === 'loaded') {
			panel.threews.stats = msg.stats || null;
			notify();
		} else if (msg?.type === 'error') {
			output.appendLine(`viewer: ${msg.message}`);
		} else if (msg?.type === 'snapshot') {
			await saveBeside(msg.dataUrl, { resource, output, ext: '.png', suffix: '', what: 'Snapshot' });
		} else if (msg?.type === 'turntable') {
			await saveBeside(msg.dataUrl, { resource, output, ext: '.gif', suffix: '-turntable', what: 'Turntable' });
		} else if (msg?.type === 'bake-clip') {
			await bakeClip(msg, { resource, readBytes, links, output });
		} else if (msg?.type === 'clip-result') {
			const waiter = panel.threews.pending.get(msg.requestId);
			if (waiter) {
				panel.threews.pending.delete(msg.requestId);
				waiter(msg);
			}
		} else if (msg?.type === 'action') {
			await runAction(msg.action, { resource, remoteUrl });
		}
	});

	return {
		reload: () => {
			post({ type: 'load', src: `${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}` });
			sendReport();
		},
		dispose: () => {
			disposed = true;
			sub.dispose();
		},
	};
}

async function runAction(action, { resource, remoteUrl }) {
	const target = resource || (remoteUrl ? vscode.Uri.parse(remoteUrl) : undefined);
	const commands = {
		openInBrowser: 'threews3d.openInBrowser',
		embed: 'threews3d.insertEmbed',
		rig: 'threews3d.rigModel',
		animate: 'threews3d.animate',
		refine: 'threews3d.refineModel',
		quality: 'threews3d.checkQuality',
		optimize: 'threews3d.optimizeModel',
		compare: 'threews3d.compareWithHead',
	};
	if (commands[action]) await vscode.commands.executeCommand(commands[action], target);
}

/**
 * Ask the webview for something only the running scene can produce and wait
 * for its answer (a `clip-result` message carrying the same requestId).
 *
 * @param {vscode.WebviewPanel} panel
 * @param {object} message
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export function request(panel, message, timeoutMs = 30_000) {
	const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return new Promise((resolve) => {
		panel.threews.pending.set(requestId, resolve);
		panel.threews.post({ ...message, requestId });
		setTimeout(() => {
			if (panel.threews.pending.delete(requestId)) {
				resolve({ ok: false, coverage: 0, matched: 0, total: 0, message: 'the viewer did not answer' });
			}
		}, timeoutMs);
	});
}

/**
 * Send a clip to the webview and wait for it to say whether the rig took it.
 * @param {vscode.WebviewPanel} panel
 * @param {{ clip: object, label: string, loop: boolean }} payload
 * @returns {Promise<{ ok: boolean, coverage: number, matched: number, total: number, message?: string }>}
 */
export function playClipIn(panel, payload) {
	return request(panel, { type: 'play-clip', ...payload });
}

/** Write the retargeted clip into a copy of the model, next to it. */
async function bakeClip(msg, { resource, readBytes, links, output }) {
	const label = String(msg.label || msg.clip?.name || 'clip');
	try {
		const bytes = await readBytes();
		const result = await writeClipIntoGlb(bytes, msg.clip, { name: label });
		const folder = resource ? vscode.Uri.joinPath(resource, '..') : await defaultFolder();
		const stem = `${resource ? path(resource).replace(/\.(glb|gltf)$/i, '') : 'model'}-${clipSlug(label)}`;
		const target = await freeName(folder, stem, '.glb');
		await vscode.workspace.fs.writeFile(target, result.bytes);
		if (resource) {
			const meta = links.meta(resource);
			if (meta) await links.set(target, meta.url, { prompt: meta.prompt });
		}
		output.appendLine(`baked "${label}" into ${target.fsPath} (${result.channels} channels${result.dropped.length ? `, ${result.dropped.length} tracks had no node` : ''})`);
		const open = await vscode.window.showInformationMessage(
			`Saved ${path(target)} with the "${label}" clip baked in.`,
			'Open',
		);
		if (open === 'Open') await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
	} catch (err) {
		output.appendLine(`bake failed: ${err?.message || err}`);
		vscode.window.showErrorMessage(`three.ws 3D: baking the clip failed. ${err?.message || err}`);
	}
}

/** Write a data: URL image next to the model (or into the workspace root). */
async function saveBeside(dataUrl, { resource, output, ext, suffix, what }) {
	const match = /^data:image\/(png|gif);base64,(.+)$/.exec(String(dataUrl || ''));
	if (!match) {
		vscode.window.showErrorMessage(`three.ws 3D: the ${what.toLowerCase()} came back empty.`);
		return;
	}
	const bytes = Buffer.from(match[2], 'base64');
	let folder;
	try {
		folder = resource ? vscode.Uri.joinPath(resource, '..') : await defaultFolder();
	} catch (err) {
		vscode.window.showErrorMessage(`three.ws 3D: ${err.message}`);
		return;
	}
	const stem = `${resource ? path(resource).replace(/\.(glb|gltf)$/i, '') : 'model'}${suffix}`;
	const target = await freeName(folder, stem, ext);
	await vscode.workspace.fs.writeFile(target, bytes);
	output.appendLine(`${what.toLowerCase()} written to ${target.fsPath}`);
	const open = await vscode.window.showInformationMessage(`${what} saved as ${path(target)}`, 'Open');
	if (open === 'Open') await vscode.commands.executeCommand('vscode.open', target);
}

async function defaultFolder() {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) throw new Error('open a folder to save into.');
	return folder;
}

async function freeName(folder, stem, ext) {
	const taken = await vscode.workspace.fs.readDirectory(folder).then(
		(entries) => new Set(entries.map(([name]) => name.toLowerCase())),
		() => new Set(),
	);
	return vscode.Uri.joinPath(folder, uniqueName(stem, ext, (name) => taken.has(name.toLowerCase())));
}

function path(uri) {
	return uri.path.split('/').pop() || '';
}

/** The webview document. Scripts are nonce-gated; nothing loads from a CDN. */
export function viewerHtml(webview, extensionUri) {
	const nonce = randomNonce();
	const asset = (...parts) =>
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...parts)).toString();
	const config = {
		dracoPath: `${asset('vendor', 'draco')}/`,
		basisPath: `${asset('vendor', 'basis')}/`,
		environment: setting('environment', 'studio'),
		showGrid: setting('showGrid', true),
		autoRotate: setting('autoRotate', false),
		turntableFrames: setting('turntableFrames', 36),
		turntableSize: setting('turntableSize', 480),
	};
	// wasm-unsafe-eval: the meshopt, Draco, and Basis decoders are WebAssembly.
	// blob: workers: Draco and KTX2 build their worker from a blob at runtime.
	const csp = [
		"default-src 'none'",
		`img-src ${webview.cspSource} data: blob:`,
		`style-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}' 'wasm-unsafe-eval' blob:`,
		`connect-src ${webview.cspSource} https: data: blob:`,
		'worker-src blob:',
		'child-src blob:',
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('viewer.css')}">
<title>three.ws 3D</title>
</head>
<body>
<div id="stage"></div>

<div id="loading">
	<div class="spinner" aria-hidden="true"></div>
	<p id="loading-label">Loading model…</p>
</div>

<div id="error" hidden role="alert">
	<h2>This model could not be rendered</h2>
	<p id="error-text"></p>
	<p>Check that the file is a valid glTF 2.0 asset. A .gltf that points at
	external buffers needs those files next to it in the workspace.</p>
</div>

<div id="busy" hidden role="status" aria-live="polite">
	<div class="spinner" aria-hidden="true"></div>
	<span id="busy-label"></span>
</div>

<aside id="report" hidden aria-label="Model report">
	<h2>Model report</h2>
	<dl id="report-body"></dl>
	<ul id="stats"></ul>
</aside>

<div id="toolbar" role="toolbar" aria-label="Viewer controls">
	<span id="playback" hidden>
		<button id="play" data-action="play" aria-pressed="true" title="Play or pause the animation">Pause</button>
		<input id="scrub" type="range" min="0" max="1" step="0.001" value="0" aria-label="Animation time">
		<select id="clips" hidden aria-label="Animation clip"></select>
		<button id="bake" data-action="bake" hidden title="Write this library clip into a copy of the model so it plays in any engine">Bake clip</button>
	</span>
	<button data-toggle="grid" aria-pressed="${config.showGrid ? 'true' : 'false'}" title="Show the ground grid">Grid</button>
	<button data-toggle="wireframe" aria-pressed="false" title="Draw the mesh as a wireframe">Wireframe</button>
	<button data-toggle="skeleton" aria-pressed="false" title="Overlay the skeleton">Skeleton</button>
	<button data-toggle="rotate" aria-pressed="${config.autoRotate ? 'true' : 'false'}" title="Orbit the camera automatically">Rotate</button>
	<button data-action="reset" title="Frame the model again">Reset view</button>
	<button data-toggle="report" aria-pressed="false" title="Triangles, materials, textures, rig, and optimization notes">Report</button>
	<span class="sep" aria-hidden="true"></span>
	<button data-action="animate" title="Try any of 2,800 library animations on this rig, or describe a motion in words">Animate</button>
	<button data-action="refine" title="Describe a change and generate a new version anchored to this model">Refine</button>
	<button data-action="quality" title="Ask a vision model to score this render for realism and completeness">Check quality</button>
	<button data-action="optimize" title="Dedup, weld, resample and meshopt-compress a copy for the web">Optimize</button>
	<span class="sep" aria-hidden="true"></span>
	<button data-action="snapshot" title="Save the current view as a PNG next to the model">Snapshot</button>
	<button data-action="turntable" title="Save a looping turntable GIF next to the model">Turntable</button>
	<button data-action="embed" title="Insert an &lt;agent-3d&gt; embed snippet">Embed</button>
	<button data-action="rig" title="Add a humanoid skeleton with the three.ws rigger">Rig</button>
	<button data-action="openInBrowser" title="Open this model in the three.ws viewer">three.ws</button>
</div>

<script nonce="${nonce}">window.__THREEWS_CONFIG__ = ${JSON.stringify(config)};</script>
<script nonce="${nonce}" src="${asset('viewer.js')}"></script>
</body>
</html>`;
}

function setting(key, fallback) {
	return vscode.workspace.getConfiguration('threews3d').get(key, fallback);
}

function randomNonce() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
	return out;
}
