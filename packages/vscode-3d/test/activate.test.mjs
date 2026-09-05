// Activates the bundled extension against a stand-in extension host and checks
// that everything package.json promises actually exists at runtime: the
// commands, the trees, the custom editor, and the viewer webview it renders.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const { vscode, state, makePanel } = require('./fake-vscode.cjs');

// The bundle requires 'vscode', which only the real host provides.
const load = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscode;
	return load.call(this, request, parent, isMain);
};

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const extension = require('../dist/extension.cjs');

const context = {
	subscriptions: [],
	extensionUri: vscode.Uri.file('/ext'),
	workspaceState: (() => {
		const store = new Map();
		return { get: (k, d) => (store.has(k) ? store.get(k) : d), update: (k, v) => (store.set(k, v), Promise.resolve()) };
	})(),
};

test('activate registers every contributed command', () => {
	extension.activate(context);
	for (const { command } of manifest.contributes.commands) {
		assert.ok(state.commands.has(command), `${command} was never registered`);
	}
});

test('activate registers both tree views and the custom editor', () => {
	for (const view of manifest.contributes.views.threews3d) {
		assert.ok(state.trees.has(view.id), `${view.id} has no provider`);
	}
	assert.ok(state.customEditors.has('threews3d.modelViewer'));
});

test('the workspace tree lists model files with their size', async () => {
	state.files = [vscode.Uri.file('/workspace/models/robot.glb')];
	const provider = state.trees.get('threews3d.models').provider;
	await provider.refresh();
	const children = await provider.getChildren();
	assert.equal(children.length, 1);
	assert.equal(children[0].label, 'robot.glb');
	assert.equal(children[0].description, '1.0 KB');
	assert.equal(children[0].command.arguments[1], 'threews3d.modelViewer');
});

test('the viewer webview is nonce-gated and loads only local assets', async () => {
	const provider = state.customEditors.get('threews3d.modelViewer');
	const uri = vscode.Uri.file('/workspace/models/robot.glb');
	const document = await provider.openCustomDocument(uri);
	const panel = makePanel();
	await provider.resolveCustomEditor(document, panel);

	const html = panel.webview.html;
	const nonce = /nonce-([A-Za-z0-9]{32})/.exec(html)?.[1];
	assert.ok(nonce, 'the CSP carries no nonce');
	assert.ok(html.includes(`<script nonce="${nonce}" src="https://fake.vscode-cdn.net/ext/media/viewer.js">`));
	assert.ok(html.includes("default-src 'none'"), 'CSP is not locked down');
	assert.ok(html.includes("'wasm-unsafe-eval'"), 'the wasm decoders would be blocked');
	assert.ok(!/src="http(s)?:\/\/(?!fake\.vscode-cdn\.net)/.test(html), 'the webview loads a remote asset');
	assert.ok(html.includes('id="toolbar"'));
	assert.ok(panel.webview.options.enableScripts);
	assert.equal(panel.webview.options.localResourceRoots.length, 2);
});

test('the viewer hands the webview the model as soon as it is ready', async () => {
	const provider = state.customEditors.get('threews3d.modelViewer');
	const uri = vscode.Uri.file('/workspace/models/robot.glb');
	const panel = makePanel();
	const posted = [];
	panel.webview.postMessage = (msg) => {
		posted.push(msg);
		return Promise.resolve(true);
	};
	await provider.resolveCustomEditor(await provider.openCustomDocument(uri), panel);
	panel.webview.send({ type: 'ready' });
	await new Promise((r) => setImmediate(r));
	const load = posted.find((m) => m.type === 'load');
	assert.ok(load, 'the model was never sent to the webview');
	assert.equal(load.src, 'https://fake.vscode-cdn.net/workspace/models/robot.glb');
});
