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
	globalStorageUri: vscode.Uri.file('/global'),
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
	for (const action of ['animate', 'refine', 'quality', 'optimize', 'turntable', 'bake', 'snapshot', 'embed', 'rig']) {
		assert.ok(html.includes(`data-action="${action}"`), `toolbar lacks ${action}`);
	}
	assert.ok(panel.webview.options.enableScripts);
	assert.equal(panel.webview.options.localResourceRoots.length, 2);
});

test('the webview bundle carries the retargeter and the GIF encoder, and no CDN URL', () => {
	const bundle = readFileSync(new URL('../media/viewer.js', import.meta.url), 'utf8');
	assert.ok(bundle.includes('retargetClip'), 'the retargeter is not bundled');
	assert.ok(bundle.includes('GIF89a'), 'the GIF encoder is not bundled');
	assert.ok(!/https:\/\/(cdn|unpkg|cdnjs|jsdelivr)\./.test(bundle), 'the webview reaches a CDN');
});

test('the host bundle does not carry the native sharp module', () => {
	const bundle = readFileSync(new URL('../dist/extension.cjs', import.meta.url), 'utf8');
	assert.ok(!bundle.includes('node_modules/sharp/'), 'sharp was bundled into the extension host');
	assert.ok(bundle.includes('texture resizing is not available inside the editor'));
});

test('language features register for HTML and the frameworks people embed from', () => {
	const languages = new Set(state.providers.hovers[0].selector.map((s) => s.language));
	for (const id of ['html', 'javascriptreact', 'typescriptreact', 'vue', 'svelte', 'astro', 'markdown']) {
		assert.ok(languages.has(id), `${id} has no hover provider`);
	}
	assert.equal(state.providers.codeActions.length, 1);
	assert.equal(state.providers.completions.length, 1);
	assert.equal(state.providers.codeLenses.length, 1);
	assert.equal(state.statusBarItems.length, 1);
	assert.equal(state.statusBarItems[0].shown, false, 'the status bar shows with no viewer open');
});

test('opening an HTML file with a broken embed produces diagnostics with quick fixes', async () => {
	const doc = new vscode.TextDocument(
		vscode.Uri.file('/workspace/index.html'),
		'html',
		'<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>\n<agent-3d modee="floating"></agent-3d>\n',
	);
	state.documents.push(doc);
	state.openDocument.fire(doc);
	// Diagnostics are debounced and the release lookup may hit the network; wait for either.
	for (let i = 0; i < 60 && !state.diagnostics.has(doc.uri.toString()); i++) await new Promise((r) => setTimeout(r, 100));
	const diagnostics = state.diagnostics.get(doc.uri.toString());
	assert.ok(diagnostics, 'no diagnostics were published');
	const codes = diagnostics.map((d) => d.code).sort();
	assert.ok(codes.includes('no-source'), codes.join());
	assert.ok(codes.includes('no-size'), codes.join());
	assert.ok(codes.includes('unknown-attribute'), codes.join());
	assert.ok(codes.includes('unpinned-library'), codes.join());
	for (const d of diagnostics) assert.equal(d.source, 'three.ws');

	const { provider } = state.providers.codeActions[0];
	const actions = provider.provideCodeActions(doc, null, { diagnostics });
	const titles = actions.map((a) => a.title);
	assert.ok(titles.includes('Rename to mode'), titles.join(' | '));
	assert.ok(titles.includes('Add an inline size (400×500)'), titles.join(' | '));
	const rename = actions.find((a) => a.title === 'Rename to mode');
	assert.equal(rename.edit.edits[0].text, 'mode');

	const hover = state.providers.hovers[0].provider.provideHover(doc, doc.positionAt(doc.getText().indexOf('<agent-3d') + 3));
	assert.match(hover.contents.value, /live three\.ws agent/);

	const completions = state.providers.completions[0].provider.provideCompletionItems(doc, doc.positionAt(doc.getText().indexOf('modee')));
	assert.ok(completions.some((c) => c.label === 'src'));
	assert.ok(completions.some((c) => c.label === 'body'));

	const lenses = state.providers.codeLenses[0].provider.provideCodeLenses(doc);
	assert.ok(lenses.some((l) => l.command.title.includes('Pin the library version')));
	assert.ok(lenses.some((l) => l.command.title === 'Embedding guide'));

	state.closeDocument.fire(doc);
	assert.ok(!state.diagnostics.has(doc.uri.toString()));
});

test('a document with no embed gets no diagnostics and is never scanned', async () => {
	const doc = new vscode.TextDocument(vscode.Uri.file('/workspace/plain.html'), 'html', '<div>hello</div>');
	state.openDocument.fire(doc);
	await new Promise((r) => setTimeout(r, 400));
	assert.ok(!state.diagnostics.has(doc.uri.toString()));
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
