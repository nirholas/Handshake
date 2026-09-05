// The 3D viewer: a custom editor for .glb/.gltf files in the workspace, and a
// panel for models that live on a URL.
//
// The host owns the file: it reads the bytes, runs the inspector, and streams
// the report to the webview. The webview owns the picture.

import * as vscode from 'vscode';
import { reportFor } from './inspect.js';
import { trackPanel } from './active-panel.js';

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
		trackPanel(panel);

		const src = panel.webview.asWebviewUri(document.uri).toString();
		const wire = attachViewer(this.context, panel, {
			src,
			resource: document.uri,
			links: this.links,
			output: this.output,
			readBytes: () => vscode.workspace.fs.readFile(document.uri),
		});

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
export function openRemoteModel(context, links, output, url, title) {
	const panel = vscode.window.createWebviewPanel(
		VIEW_TYPE,
		title || 'three.ws 3D',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
		},
	);
	panel.webview.html = viewerHtml(panel.webview, context.extensionUri);
	trackPanel(panel);
	const wire = attachViewer(context, panel, {
		src: url,
		remoteUrl: url,
		links,
		output,
		readBytes: async () => {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return new Uint8Array(await res.arrayBuffer());
		},
	});
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

	const sendReport = async () => {
		try {
			const bytes = await readBytes();
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
		} else if (msg?.type === 'error') {
			output.appendLine(`viewer: ${msg.message}`);
		} else if (msg?.type === 'snapshot') {
			await saveSnapshot(msg.dataUrl, resource, output);
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
	if (action === 'openInBrowser') {
		await vscode.commands.executeCommand('threews3d.openInBrowser', target);
	} else if (action === 'embed') {
		await vscode.commands.executeCommand('threews3d.insertEmbed', target);
	} else if (action === 'rig') {
		await vscode.commands.executeCommand('threews3d.rigModel', target);
	}
}

/** Write the webview's PNG next to the model (or into the workspace root). */
async function saveSnapshot(dataUrl, resource, output) {
	const match = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
	if (!match) {
		vscode.window.showErrorMessage('three.ws 3D: the snapshot came back empty.');
		return;
	}
	const bytes = Buffer.from(match[1], 'base64');
	const folder = resource
		? vscode.Uri.joinPath(resource, '..')
		: vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!folder) {
		vscode.window.showErrorMessage('three.ws 3D: open a folder to save a snapshot into.');
		return;
	}
	const stem = resource ? path(resource).replace(/\.(glb|gltf)$/i, '') : 'model';
	const target = vscode.Uri.joinPath(folder, `${stem}.png`);
	await vscode.workspace.fs.writeFile(target, bytes);
	output.appendLine(`snapshot written to ${target.fsPath}`);
	const open = await vscode.window.showInformationMessage(
		`Snapshot saved as ${path(target)}`,
		'Open',
	);
	if (open === 'Open') await vscode.commands.executeCommand('vscode.open', target);
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
	</span>
	<button data-toggle="grid" aria-pressed="${config.showGrid ? 'true' : 'false'}" title="Show the ground grid">Grid</button>
	<button data-toggle="wireframe" aria-pressed="false" title="Draw the mesh as a wireframe">Wireframe</button>
	<button data-toggle="skeleton" aria-pressed="false" title="Overlay the skeleton">Skeleton</button>
	<button data-toggle="rotate" aria-pressed="${config.autoRotate ? 'true' : 'false'}" title="Orbit the camera automatically">Rotate</button>
	<button data-action="reset" title="Frame the model again">Reset view</button>
	<button data-toggle="report" aria-pressed="false" title="Triangles, materials, textures, rig, and optimization notes">Report</button>
	<button data-action="snapshot" title="Save the current view as a PNG next to the model">Snapshot</button>
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
