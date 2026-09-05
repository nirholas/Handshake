// three.ws 3D: the VS Code extension entry point.
//
// Registers the model viewer (a custom editor for .glb/.gltf), the workspace and
// gallery trees, the language features for <agent-3d> embeds, and the commands
// that generate, refine, animate, optimize, compare, rig, embed, and import
// models through the live three.ws studio. Every call hits the real public API;
// nothing here is stubbed.

import * as vscode from 'vscode';
import { GalleryProvider } from './gallery-tree.js';
import { ModelLinks } from './links.js';
import { ModelsProvider } from './models-tree.js';
import { ModelViewerProvider, VIEW_TYPE, openLocalModel, openRemoteModel, playClipIn, request } from './viewer.js';
import { TOOLS, callTool } from './studio.js';
import { downloadModel } from './download.js';
import { buildEmbedSnippet, resolveEmbedRelease, viewerUrl } from './embed.js';
import { slugFromUrl, uniqueName } from './naming.js';
import { activeViewer } from './active-panel.js';
import { clipSlug, fetchClip, generateMotion, listLibrary } from './animations.js';
import { refineModel } from './refine.js';
import { PRESETS, describeSavings, optimizeGlb } from './optimize.js';
import { committedBytes, compareModels } from './compare.js';
import { checkQuality, qualityMarkdown } from './quality.js';
import { createStatusBar } from './status-bar.js';
import { registerEmbedLanguage } from './embed-language-vscode.js';

let output;
let links;
let extensionContext;

export function activate(context) {
	extensionContext = context;
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
		createStatusBar(),
		registerEmbedLanguage(context, { origin, output }),
	);

	const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	reg('threews3d.generateModel', () => generate('model'));
	reg('threews3d.generateAvatar', () => generate('avatar'));
	reg('threews3d.rigModel', (target) => rig(target));
	reg('threews3d.refineModel', (target) => refine(target));
	reg('threews3d.animate', (target) => animate(target));
	reg('threews3d.animateFromText', (target) => animateFromText(target));
	reg('threews3d.optimizeModel', (target) => optimize(target));
	reg('threews3d.compareWithHead', (target) => compareWithHead(target));
	reg('threews3d.checkQuality', (target) => quality(target));
	reg('threews3d.insertEmbed', (target) => insertEmbed(target));
	reg('threews3d.previewUrl', (url) => previewUrl(context, url));
	reg('threews3d.previewCreation', (item) => {
		if (item?.glbUrl) openRemoteModel(context, links, output, item.glbUrl, title(item));
	});
	reg('threews3d.importGalleryItem', (node) => importCreation(node?.creation || node));
	reg('threews3d.openInBrowser', (target) => openInBrowser(target));
	reg('threews3d.copyModelUrl', (target) => copyModelUrl(target));
	reg('threews3d.saveSnapshot', () => withViewer((panel) => panel.threews.post({ type: 'snapshot' })));
	reg('threews3d.exportTurntable', () => withViewer((panel) => panel.threews.post({ type: 'turntable' })));
	reg('threews3d.toggleReport', () => withViewer((panel) => panel.threews.post({ type: 'toggle-report' })));
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

function withViewer(fn) {
	const panel = activeViewer();
	if (!panel?.threews) {
		vscode.window.showWarningMessage('three.ws 3D: open a model in the viewer first.');
		return;
	}
	return fn(panel);
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
		validateInput: validatePrompt,
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
				await links.set(saved.uri, model.glbUrl, { prompt: prompt.trim() });
				await openInViewer(saved.uri);
				await offerFollowUp(saved.uri);
			} catch (err) {
				if (token.isCancellationRequested) return;
				report(err, kind === 'avatar' ? 'avatar generation' : 'model generation');
			}
		},
	);
}

function validatePrompt(v) {
	const value = v.trim();
	if (value.length < 3) return 'Describe the subject in at least 3 characters';
	if (value.length > 1000) return 'Keep the description under 1000 characters';
	return null;
}

async function offerFollowUp(uri) {
	const choice = await vscode.window.showInformationMessage(
		`Saved ${vscode.workspace.asRelativePath(uri, false)}`,
		'Refine it',
		'Rig for animation',
		'Insert embed',
	);
	if (choice === 'Insert embed') await vscode.commands.executeCommand('threews3d.insertEmbed', uri);
	if (choice === 'Rig for animation') await vscode.commands.executeCommand('threews3d.rigModel', uri);
	if (choice === 'Refine it') await vscode.commands.executeCommand('threews3d.refineModel', uri);
}

async function openInViewer(uri) {
	await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
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
				const meta = uriOf(target) ? links.meta(uriOf(target)) : null;
				await links.set(saved.uri, rigged.glbUrl, { prompt: meta?.prompt || null });
				await openInViewer(saved.uri);
				const next = await vscode.window.showInformationMessage(
					`Saved ${vscode.workspace.asRelativePath(saved.uri, false)}. It has a skeleton now.`,
					'Try an animation',
				);
				if (next) await vscode.commands.executeCommand('threews3d.animate', saved.uri);
			} catch (err) {
				if (token.isCancellationRequested) return;
				report(err, 'rigging');
			}
		},
	);
}

// ------------------------------------------------------------------ refining

async function refine(target, presetInstruction = '') {
	const uri = uriOf(target);
	const url = await resolveUrl(target, {
		title: 'Refine a model',
		prompt: 'https URL of the model to refine',
	});
	if (!url) return;
	const meta = uri ? links.meta(uri) : null;
	const instruction = await vscode.window.showInputBox({
		title: 'Refine this model',
		prompt: meta?.prompt
			? `Describe the change to "${meta.prompt.slice(0, 60)}". The new version keeps its form and materials.`
			: 'Describe the change. The new version is generated anchored to this one.',
		placeHolder: 'make it metallic · bigger helmet · add a cape · lower poly, chunkier shapes',
		value: presetInstruction || undefined,
		validateInput: (v) => {
			const value = v.trim();
			if (value.length < 1) return 'Describe the change';
			if (value.length > 500) return 'Keep the change under 500 characters';
			return null;
		},
	});
	if (!instruction) return;

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Refining: ${instruction.trim().slice(0, 40)}`, cancellable: true },
		async (progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			progress.report({ message: 'generating a new version anchored to this one…' });
			try {
				const result = await refineModel(
					origin(),
					{ glbUrl: url, instruction: instruction.trim(), parentPrompt: meta?.prompt, lineage: meta?.lineage },
					{ signal: controller.signal, onStatus: (message) => progress.report({ message }) },
				);
				output.appendLine(`${TOOLS.refine}: ${result.glbUrl} (version ${result.lineage.length} of the lineage)`);
				progress.report({ message: 'saving into the workspace…' });
				const stem = uri ? stemOf(uri) : slugFromUrl(url);
				const saved = await downloadModel(result.glbUrl, {
					prompt: `${stem}-v${result.lineage.length}`,
					token,
					progress,
				});
				await links.set(saved.uri, result.glbUrl, { prompt: result.prompt, lineage: result.lineage });
				// The parent keeps the same lineage so a second refinement of it branches
				// from the right version instead of forking a fresh history.
				if (uri && meta) await links.set(uri, meta.url, { lineage: result.lineage });
				await openInViewer(saved.uri);
				const next = await vscode.window.showInformationMessage(
					`Saved ${vscode.workspace.asRelativePath(saved.uri, false)} (version ${result.lineage.length}).`,
					'Refine again',
					'Compare with previous',
				);
				if (next === 'Refine again') await vscode.commands.executeCommand('threews3d.refineModel', saved.uri);
				if (next === 'Compare with previous' && uri) await compareFiles(uri, saved.uri, 'previous version', `version ${result.lineage.length}`);
			} catch (err) {
				if (token.isCancellationRequested) return;
				report(err, 'refining the model');
			}
		},
	);
}

// ----------------------------------------------------------------- animating

/** The library is fetched once per session; 2,800 rows is under a megabyte. */
let libraryPromise = null;

function library() {
	if (!libraryPromise) {
		libraryPromise = listLibrary(origin()).catch((err) => {
			libraryPromise = null;
			throw err;
		});
	}
	return libraryPromise;
}

async function animate(target) {
	const panel = await viewerFor(target);
	if (!panel) return;
	if (panel.threews.stats && !panel.threews.stats.bones) {
		const pick = await vscode.window.showWarningMessage(
			'This model has no skeleton, so a library clip has nothing to drive. Rig it first.',
			'Rig for animation',
		);
		if (pick) await vscode.commands.executeCommand('threews3d.rigModel', target);
		return;
	}

	const quickPick = vscode.window.createQuickPick();
	quickPick.title = 'Try a library animation';
	quickPick.placeholder = 'Type to search 2,800 clips: idle, walk, wave, dance, sit, punch, or describe a new motion';
	quickPick.matchOnDescription = true;
	quickPick.busy = true;
	const describe = { label: '$(sparkle) Describe a motion in words…', alwaysShow: true, kind: 'text' };
	quickPick.items = [describe];
	quickPick.show();

	let clips;
	try {
		clips = await library();
	} catch (err) {
		quickPick.hide();
		report(err, 'loading the animation library');
		return;
	}
	quickPick.busy = false;
	quickPick.items = [
		describe,
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		...clips.map((clip) => ({
			label: clip.label,
			description: `${clip.duration.toFixed(1)}s${clip.loop ? ' · loops' : ''}`,
			clip,
		})),
	];

	const chosen = await new Promise((resolve) => {
		quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
		quickPick.onDidHide(() => resolve(undefined));
	});
	quickPick.dispose();
	if (!chosen) return;
	if (chosen.kind === 'text') return animateFromText(target);
	await playOnViewer(panel, chosen.clip.url, { label: chosen.clip.label, loop: chosen.clip.loop });
}

async function animateFromText(target) {
	const panel = await viewerFor(target);
	if (!panel) return;
	const prompt = await vscode.window.showInputBox({
		title: 'Animate from a text prompt',
		prompt: 'Describe the motion. A motion model samples it on the three.ws GPU fleet and the clip is retargeted onto this rig.',
		placeHolder: 'waving confidently with the right hand · a slow tai-chi sweep · jumping for joy',
		validateInput: validatePrompt,
	});
	if (!prompt) return;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Animating: ${prompt.trim().slice(0, 40)}`, cancellable: true },
		async (progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			progress.report({ message: 'queued on the GPU fleet…' });
			try {
				const { clip } = await generateMotion(origin(), prompt.trim(), {
					signal: controller.signal,
					onStatus: (message) => progress.report({ message }),
				});
				await playClip(panel, clip, { label: prompt.trim().slice(0, 60), loop: false });
			} catch (err) {
				if (token.isCancellationRequested) return;
				report(err, 'text to animation');
			}
		},
	);
}

async function playOnViewer(panel, clipUrl, { label, loop }) {
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: `Retargeting "${label}"` },
		async () => {
			try {
				const clip = await fetchClip(clipUrl);
				await playClip(panel, clip, { label, loop });
			} catch (err) {
				report(err, 'loading the clip');
			}
		},
	);
}

async function playClip(panel, clip, { label, loop }) {
	const result = await playClipIn(panel, { clip, label, loop });
	if (result.ok) {
		const pct = Math.round(result.coverage * 100);
		vscode.window.setStatusBarMessage(
			`$(play) "${label}" is playing on ${result.matched} of ${result.total} bones (${pct}% coverage). Bake clip writes it into the file.`,
			8000,
		);
		return;
	}
	const pick = await vscode.window.showWarningMessage(
		result.message
			? `three.ws 3D: ${result.message}`
			: `This rig matched ${result.matched} of ${result.total} bones the clip drives (${Math.round(result.coverage * 100)}%), below the floor the retargeter accepts. Its bone names are not a humanoid convention the platform knows; rigging it through three.ws gives it one that is.`,
		'Rig for animation',
	);
	if (pick) await vscode.commands.executeCommand('threews3d.rigModel', panel.threews.resource || panel.threews.remoteUrl);
}

/** The viewer showing `target`, opening it if needed; the active viewer when there is no target. */
async function viewerFor(target) {
	const uri = uriOf(target);
	const active = activeViewer();
	if (!uri) {
		if (active?.threews) return active;
		vscode.window.showWarningMessage('three.ws 3D: open a model in the viewer first.');
		return null;
	}
	if (active?.threews && sameTarget(active, uri)) return active;
	if (uri.scheme === 'http' || uri.scheme === 'https') {
		const panel = openRemoteModel(extensionContext, links, output, uri.toString(), slugFromUrl(uri.toString()));
		await ready(panel);
		return panel;
	}
	await openInViewer(uri);
	const panel = activeViewer();
	if (!panel?.threews) return null;
	await ready(panel);
	return panel;
}

function sameTarget(panel, uri) {
	const t = panel.threews;
	if (t.resource) return t.resource.toString() === uri.toString();
	return t.remoteUrl === uri.toString();
}

/** Wait until the webview has loaded a model (its `loaded` message sets stats). */
function ready(panel, timeoutMs = 60_000) {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			if (panel.threews?.stats || Date.now() - started > timeoutMs) return resolve();
			setTimeout(tick, 150);
		};
		tick();
	});
}

// ---------------------------------------------------------------- optimizing

async function optimize(target) {
	const uri = await resolveLocal(target, 'optimize');
	if (!uri) return;
	const preset = await vscode.window.showQuickPick(
		Object.entries(PRESETS).map(([id, p]) => ({ label: p.label, detail: p.detail, id })),
		{ title: 'Optimize for the web', placeHolder: 'A copy is written next to the model; the original is untouched.' },
	);
	if (!preset) return;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Optimizing the model' },
		async (progress) => {
			try {
				progress.report({ message: 'dedup, prune, weld, resample, meshopt…' });
				const bytes = await vscode.workspace.fs.readFile(uri);
				const result = await optimizeGlb(bytes, { preset: preset.id });
				const folder = vscode.Uri.joinPath(uri, '..');
				const target = await freeName(folder, `${stemOf(uri)}.web`, '.glb');
				await vscode.workspace.fs.writeFile(target, result.bytes);
				const meta = links.meta(uri);
				if (meta) await links.set(target, meta.url, { prompt: meta.prompt });
				const savings = describeSavings(result.before, result.after);
				output.appendLine(`optimized ${uri.fsPath} -> ${target.fsPath}: ${savings}`);
				const pick = await vscode.window.showInformationMessage(
					`Saved ${vscode.workspace.asRelativePath(target, false)}: ${savings}.`,
					'Open',
					'Compare',
				);
				if (pick === 'Open') await openInViewer(target);
				if (pick === 'Compare') await compareFiles(uri, target, 'original', 'optimized');
			} catch (err) {
				report(err, 'optimizing the model');
			}
		},
	);
}

// ------------------------------------------------------------------ comparing

async function compareWithHead(target) {
	const uri = await resolveLocal(target, 'compare');
	if (!uri) return;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Comparing with the committed version' },
		async () => {
			try {
				const [before, after] = await Promise.all([committedBytes(uri.fsPath), vscode.workspace.fs.readFile(uri)]);
				if (sameBytes(before, after)) {
					vscode.window.showInformationMessage(`${vscode.workspace.asRelativePath(uri, false)} is identical to the committed version.`);
					return;
				}
				const { changeset, markdown } = await compareModels(before, after, { nameA: 'HEAD', nameB: 'working tree' });
				const stash = vscode.Uri.joinPath(extensionContext.globalStorageUri, 'compare');
				await vscode.workspace.fs.createDirectory(stash);
				const headCopy = vscode.Uri.joinPath(stash, `${stemOf(uri)}@HEAD.glb`);
				await vscode.workspace.fs.writeFile(headCopy, before);
				await showMarkdown(markdown, `${stemOf(uri)}: HEAD vs working tree`);
				openLocalModel(extensionContext, links, output, headCopy, `${path(uri)} @ HEAD`, vscode.ViewColumn.Beside);
				const severity = changeset?.severity ? ` Severity: ${changeset.severity}.` : '';
				vscode.window.setStatusBarMessage(`$(git-compare) ${path(uri)} compared with HEAD.${severity}`, 8000);
			} catch (err) {
				report(err, 'comparing with the committed version');
			}
		},
	);
}

async function compareFiles(a, b, nameA, nameB) {
	try {
		const [before, after] = await Promise.all([vscode.workspace.fs.readFile(a), vscode.workspace.fs.readFile(b)]);
		const { markdown } = await compareModels(before, after, { nameA, nameB });
		await showMarkdown(markdown, `${path(a)} vs ${path(b)}`);
	} catch (err) {
		report(err, 'comparing the models');
	}
}

function sameBytes(a, b) {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

// -------------------------------------------------------------------- quality

async function quality(target) {
	const panel = await viewerFor(target);
	if (!panel) return;
	const uri = panel.threews.resource;
	const meta = uri ? links.meta(uri) : null;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Checking quality', cancellable: true },
		async (progress, token) => {
			const controller = new AbortController();
			token.onCancellationRequested(() => controller.abort());
			try {
				progress.report({ message: 'rendering the current view…' });
				const render = await request(panel, { type: 'render' });
				if (!render?.dataUrl) throw new Error(render?.message || 'the viewer produced no render');
				progress.report({ message: 'a vision model is scoring it…' });
				const { verdict } = await checkQuality(origin(), { image: render.dataUrl, prompt: meta?.prompt }, { signal: controller.signal });
				const name = uri ? path(uri) : panel.title;
				output.appendLine(`quality ${name}: ${verdict.qa_available ? `${verdict.pass ? 'pass' : 'fail'} ${verdict.score}` : 'unavailable'}`);
				await showMarkdown(qualityMarkdown(verdict, { modelName: name, prompt: meta?.prompt }), `Quality: ${name}`);
				if (verdict.qa_available && !verdict.pass && verdict.suggested_retry_hint && (uri || panel.threews.remoteUrl)) {
					const pick = await vscode.window.showInformationMessage(
						`Scored ${Math.round(verdict.score)}/100. ${verdict.suggested_retry_hint}`,
						'Refine with this hint',
					);
					if (pick) await refine(uri || vscode.Uri.parse(panel.threews.remoteUrl), verdict.suggested_retry_hint);
				}
			} catch (err) {
				if (token.isCancellationRequested) return;
				report(err, 'the quality check');
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

async function previewUrl(context, given) {
	const url =
		typeof given === 'string' && isHttpUrl(given)
			? given
			: await vscode.window.showInputBox({
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
				await links.set(saved.uri, creation.glbUrl, { prompt: creation.prompt || null });
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

/** Show a Markdown document in the preview, beside the current editor. */
async function showMarkdown(markdown, name) {
	const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `<!-- ${name} -->\n\n${markdown}` });
	await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
}

function uriOf(target) {
	const uri = target?.resourceUri || target;
	if (uri instanceof vscode.Uri) return uri;
	if (typeof uri === 'string' && isHttpUrl(uri)) return vscode.Uri.parse(uri);
	return null;
}

/** A model on disk for commands that rewrite bytes; falls back to the active viewer's file. */
async function resolveLocal(target, verb) {
	const uri = uriOf(target) || activeViewer()?.threews?.resource || null;
	if (uri && uri.scheme !== 'http' && uri.scheme !== 'https') return uri;
	vscode.window.showWarningMessage(`three.ws 3D: open a model file from the workspace to ${verb} it.`);
	return null;
}

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

function stemOf(uri) {
	return path(uri).replace(/\.(glb|gltf)$/i, '');
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
	if (message === 'cancelled') return;
	output.appendLine(`${what} failed: ${message}`);
	vscode.window.showErrorMessage(`three.ws 3D: ${what} failed. ${message}`, 'Show log').then((pick) => {
		if (pick === 'Show log') output.show(true);
	});
}
