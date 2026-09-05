// three.ws 3D: the VS Code extension entry point.
//
// Registers the model viewer (a custom editor for .glb/.gltf), the workspace and
// gallery trees, and the commands that generate, rig, embed, and import models
// through the live three.ws studio. Every call hits the real public API; nothing
// here is stubbed.

import * as vscode from 'vscode';
import { GalleryProvider } from './gallery-tree.js';
import { ModelLinks } from './links.js';
import { ModelsProvider } from './models-tree.js';
import { ModelViewerProvider, openRemoteModel } from './viewer.js';
import { TOOLS, callTool } from './studio.js';
import { downloadModel } from './download.js';
import { buildEmbedSnippet, resolveEmbedRelease, viewerUrl } from './embed.js';
import { slugFromUrl } from './naming.js';
import { activeViewer } from './active-panel.js';

let output;
let links;

export function activate(context) {
	output = vscode.window.createOutputChannel('three.ws 3D');
	links = new ModelLinks(context.workspaceState);

	const models = new ModelsProvider(links);
	const gallery = new GalleryProvider();
	const modelsView = vscode.window.createTreeView('threews3d.models', {
		treeDataProvider: models,
	});
	const galleryView = vscode.window.createTreeView('threews3d.gallery', {
		treeDataProvider: gallery,
	});

	context.subscriptions.push(
		output,
		models,
		gallery,
		modelsView,
		galleryView,
		ModelViewerProvider.register(context, links, output),
	);

	const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	reg('threews3d.generateModel', () => generate('model'));
	reg('threews3d.generateAvatar', () => generate('avatar'));
	reg('threews3d.rigModel', (target) => rig(target));
	reg('threews3d.insertEmbed', (target) => insertEmbed(target));
	reg('threews3d.previewUrl', () => previewUrl(context));
	reg('threews3d.previewCreation', (item) => {
		if (item?.glbUrl) openRemoteModel(context, links, output, item.glbUrl, title(item));
	});
	reg('threews3d.importGalleryItem', (node) => importCreation(node?.creation || node));
	reg('threews3d.openInBrowser', (target) => openInBrowser(target));
	reg('threews3d.copyModelUrl', (target) => copyModelUrl(target));
	reg('threews3d.saveSnapshot', () => {
		const panel = activeViewer();
		if (!panel) {
			vscode.window.showWarningMessage('three.ws 3D: open a model in the viewer first.');
			return;
		}
		panel.webview.postMessage({ type: 'snapshot' });
	});
	reg('threews3d.refreshModels', () => models.refresh());
	reg('threews3d.refreshGallery', () => gallery.refresh());

	models.refresh();
	// The gallery view starts collapsed; load it the first time it is expanded so
	// activation never blocks on the network.
	const once = galleryView.onDidChangeVisibility((e) => {
		if (e.visible) {
			once.dispose();
			gallery.refresh();
		}
	});
	context.subscriptions.push(once);
}

export function deactivate() {}

function config() {
	return vscode.workspace.getConfiguration('threews3d');
}

function origin() {
	return config().get('origin', 'https://three.ws');
}

function title(creation) {
	return creation.prompt ? creation.prompt.slice(0, 48) : `creation ${creation.id.slice(0, 8)}`;
}

// ---------------------------------------------------------------- generation

async function generate(kind) {
	const prompt = await vscode.window.showInputBox({
		title: kind === 'avatar' ? 'Generate a 3D avatar' : 'Generate a 3D model',
		prompt:
			kind === 'avatar'
				? 'Describe the character. Lead with the subject, then clothing and colours.'
				: 'Describe one object. Lead with the subject, then its materials and colours.',
		placeHolder:
			kind === 'avatar'
				? 'a cheerful astronaut in a white suit with an orange visor'
				: 'a friendly round robot mascot, glossy white plastic, big blue eyes',
		validateInput: (v) => {
			const value = v.trim();
			if (value.length < 3) return 'Describe the subject in at least 3 characters';
			if (value.length > 1000) return 'Keep the description under 1000 characters';
			return null;
		},
	});
	if (!prompt) return;

	const args =
		kind === 'avatar'
			? { prompt: prompt.trim() }
			: { prompt: prompt.trim(), tier: config().get('tier', 'draft') };
	const tool = kind === 'avatar' ? TOOLS.avatar : TOOLS.model;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: kind === 'avatar' ? 'Generating your avatar' : 'Generating your 3D model',
			cancellable: true,
		},
		async (progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			progress.report({ message: 'the free lane is working on it…' });
			try {
				const model = await callTool(origin(), tool, args, { signal: controller.signal });
				output.appendLine(`${tool}: ${model.glbUrl}`);
				progress.report({ message: 'saving into the workspace…' });
				const saved = await downloadModel(model.glbUrl, {
					prompt: prompt.trim(),
					token,
					progress,
				});
				await links.set(saved.uri, model.glbUrl);
				await openInViewer(saved.uri);
				await offerFollowUp(saved.uri);
			} catch (err) {
				if (token.isCancellationRequested) return;
				report(err, kind === 'avatar' ? 'avatar generation' : 'model generation');
			}
		},
	);
}

async function offerFollowUp(uri) {
	const choice = await vscode.window.showInformationMessage(
		`Saved ${vscode.workspace.asRelativePath(uri, false)}`,
		'Insert embed',
		'Rig for animation',
	);
	if (choice === 'Insert embed') await vscode.commands.executeCommand('threews3d.insertEmbed', uri);
	if (choice === 'Rig for animation') await vscode.commands.executeCommand('threews3d.rigModel', uri);
}

async function openInViewer(uri) {
	await vscode.commands.executeCommand('vscode.openWith', uri, 'threews3d.modelViewer');
}

// --------------------------------------------------------------------- rigging

async function rig(target) {
	const url = await resolveUrl(target, {
		title: 'Rig a model for animation',
		prompt: 'https URL of the static GLB to rig',
	});
	if (!url) return;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Rigging the model',
			cancellable: true,
		},
		async (progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			progress.report({ message: 'fitting a humanoid skeleton…' });
			try {
				const rigged = await callTool(
					origin(),
					TOOLS.rig,
					{ glb_url: url },
					{ signal: controller.signal },
				);
				output.appendLine(`${TOOLS.rig}: ${rigged.glbUrl}`);
				const saved = await downloadModel(rigged.glbUrl, {
					prompt: `${slugFromUrl(url)}-rigged`,
					token,
					progress,
				});
				await links.set(saved.uri, rigged.glbUrl);
				await openInViewer(saved.uri);
			} catch (err) {
				if (token.isCancellationRequested) return;
				report(err, 'rigging');
			}
		},
	);
}

// ---------------------------------------------------------------------- embed

async function insertEmbed(target) {
	const src = await resolveUrl(target, {
		title: 'Insert an <agent-3d> embed',
		prompt: 'https URL of the hosted model the embed should show',
	});
	if (!src) return;

	let snippet;
	try {
		const release = await resolveEmbedRelease(origin(), config().get('embedChannel', 'pinned'));
		snippet = buildEmbedSnippet({ src, origin: origin(), ...release });
	} catch (err) {
		report(err, 'building the embed snippet');
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (editor) {
		await editor.edit((edit) => {
			for (const selection of editor.selections) edit.replace(selection, snippet);
		});
		return;
	}
	await vscode.env.clipboard.writeText(snippet);
	vscode.window.showInformationMessage(
		'three.ws 3D: no editor was open, so the embed snippet was copied to the clipboard.',
	);
}

// -------------------------------------------------------------------- viewing

async function previewUrl(context) {
	const url = await vscode.window.showInputBox({
		title: 'Preview a model URL',
		prompt: 'https URL of a .glb or .gltf file',
		placeHolder: 'https://three.ws/avatars/default.glb',
		validateInput: (v) => (isHttpUrl(v) ? null : 'Enter a valid http(s) URL'),
	});
	if (!url) return;
	openRemoteModel(context, links, output, url.trim(), slugFromUrl(url));
}

async function importCreation(creation) {
	if (!creation?.glbUrl) return;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Importing the model', cancellable: true },
		async (progress, token) => {
			try {
				const saved = await downloadModel(creation.glbUrl, {
					prompt: creation.prompt || slugFromUrl(creation.glbUrl),
					token,
					progress,
				});
				await links.set(saved.uri, creation.glbUrl);
				await openInViewer(saved.uri);
			} catch (err) {
				if (token.isCancellationRequested) return;
				report(err, 'importing the model');
			}
		},
	);
}

async function openInBrowser(target) {
	const url = await resolveUrl(target, {
		title: 'Open in the three.ws viewer',
		prompt: 'https URL of the hosted model',
	});
	if (!url) return;
	await vscode.env.openExternal(vscode.Uri.parse(viewerUrl(origin(), url)));
}

async function copyModelUrl(target) {
	const url = await resolveUrl(target, {
		title: 'Copy the model URL',
		prompt: 'https URL of the hosted model',
	});
	if (!url) return;
	await vscode.env.clipboard.writeText(url);
	vscode.window.showInformationMessage('three.ws 3D: model URL copied.');
}

// -------------------------------------------------------------------- helpers

/**
 * Work out which hosted model a command should act on.
 *
 * Tree items and explorer entries arrive as a Uri; models this extension
 * generated or imported carry their CDN URL in the link store. A local file with
 * no recorded URL cannot be embedded or rigged (the studio and the browser both
 * need to fetch it), so the user is asked for one rather than being handed a
 * broken snippet.
 */
async function resolveUrl(target, { title: boxTitle, prompt }) {
	const uri = target?.resourceUri || target;
	if (typeof uri === 'string' && isHttpUrl(uri)) return uri;
	if (uri instanceof vscode.Uri) {
		if (uri.scheme === 'http' || uri.scheme === 'https') return uri.toString();
		const known = links.get(uri);
		if (known) return known;
	}
	const name = uri instanceof vscode.Uri ? vscode.workspace.asRelativePath(uri, false) : '';
	const entered = await vscode.window.showInputBox({
		title: boxTitle,
		prompt: name
			? `${name} has no public URL yet. Paste the https URL where the model is hosted.`
			: prompt,
		placeHolder: 'https://…/model.glb',
		validateInput: (v) => (isHttpUrl(v) ? null : 'Enter a valid http(s) URL'),
	});
	return entered?.trim() || null;
}

function isHttpUrl(value) {
	try {
		const url = new URL(String(value).trim());
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

function report(err, what) {
	const message = err?.message || String(err);
	output.appendLine(`${what} failed: ${message}`);
	vscode.window.showErrorMessage(`three.ws 3D: ${what} failed. ${message}`, 'Show log').then((pick) => {
		if (pick === 'Show log') output.show(true);
	});
}
