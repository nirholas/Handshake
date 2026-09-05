// Wires the pure embed rules (embed-language.js) into VS Code: diagnostics with
// quick fixes, hovers, completions, and CodeLenses for <agent-3d> in HTML and
// the frameworks people embed from.

import * as vscode from 'vscode';
import {
	ATTRIBUTES,
	attributeAt,
	completionContext,
	diagnose,
	findEmbeds,
	findLibraryScripts,
	tagHover,
} from './embed-language.js';
import { resolveEmbedRelease } from './embed.js';

export const LANGUAGES = Object.freeze([
	'html',
	'javascriptreact',
	'typescriptreact',
	'javascript',
	'typescript',
	'vue',
	'svelte',
	'astro',
	'markdown',
	'php',
	'handlebars',
	'erb',
	'twig',
	'liquid',
]);

const SELECTOR = LANGUAGES.map((language) => ({ language }));
const SEVERITY = {
	error: vscode.DiagnosticSeverity.Error,
	warning: vscode.DiagnosticSeverity.Warning,
	information: vscode.DiagnosticSeverity.Information,
	hint: vscode.DiagnosticSeverity.Hint,
};
const RELEASE_TTL_MS = 10 * 60_000;
const DEBOUNCE_MS = 250;

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ origin: () => string, output: vscode.OutputChannel }} deps
 */
export function registerEmbedLanguage(context, { origin, output }) {
	const diagnostics = vscode.languages.createDiagnosticCollection('three.ws 3D');
	// VS Code hands code-action providers copies of the diagnostics, so the fix
	// for each one is kept here, keyed by document, code, and range.
	const fixes = new Map();
	const timers = new Map();
	let release = null;
	let releaseAt = 0;
	let releasePromise = null;

	/** The current library release, refreshed every ten minutes; null offline. */
	const currentRelease = () => {
		if (release && Date.now() - releaseAt < RELEASE_TTL_MS) return Promise.resolve(release);
		if (!releasePromise) {
			releasePromise = resolveEmbedRelease(origin(), 'pinned')
				.then((r) => {
					release = r.integrity ? r : null;
					releaseAt = Date.now();
					return release;
				})
				.catch(() => null)
				.finally(() => {
					releasePromise = null;
				});
		}
		return releasePromise;
	};

	/** Cheap pre-check so documents with no embed never run the rules. */
	const mentions = (doc) => /agent-3d/i.test(doc.getText());

	const refresh = async (doc) => {
		if (!LANGUAGES.includes(doc.languageId)) return;
		if (!vscode.workspace.getConfiguration('threews3d').get('embedDiagnostics', true) || !mentions(doc)) {
			diagnostics.delete(doc.uri);
			return;
		}
		const text = doc.getText();
		const rel = await currentRelease();
		const findings = diagnose(text, { release: rel, origin: origin() });
		const docFixes = new Map();
		diagnostics.set(
			doc.uri,
			findings.map((f) => {
				const r = range(doc, f.start, f.end);
				const d = new vscode.Diagnostic(r, f.message, SEVERITY[f.severity]);
				d.source = 'three.ws';
				d.code = f.code;
				if (f.fix) docFixes.set(fixKey(f.code, r), f.fix);
				return d;
			}),
		);
		fixes.set(doc.uri.toString(), docFixes);
	};

	const schedule = (doc) => {
		clearTimeout(timers.get(doc.uri.toString()));
		timers.set(
			doc.uri.toString(),
			setTimeout(() => {
				timers.delete(doc.uri.toString());
				refresh(doc).catch((err) => output.appendLine(`embed diagnostics failed: ${err?.message || err}`));
			}, DEBOUNCE_MS),
		);
	};

	for (const doc of vscode.workspace.textDocuments) schedule(doc);

	const codeActions = vscode.languages.registerCodeActionsProvider(SELECTOR, {
		provideCodeActions(doc, _range, ctx) {
			const actions = [];
			const docFixes = fixes.get(doc.uri.toString());
			if (!docFixes) return actions;
			for (const d of ctx.diagnostics) {
				if (d.source !== 'three.ws') continue;
				const fix = docFixes.get(fixKey(d.code, d.range));
				if (!fix) continue;
				const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
				action.diagnostics = [d];
				action.isPreferred = true;
				action.edit = new vscode.WorkspaceEdit();
				action.edit.replace(doc.uri, range(doc, fix.start, fix.end), fix.text);
				actions.push(action);
			}
			return actions;
		},
	});

	const hover = vscode.languages.registerHoverProvider(SELECTOR, {
		provideHover(doc, position) {
			const text = doc.getText();
			const offset = doc.offsetAt(position);
			for (const embed of findEmbeds(text)) {
				if (offset < embed.start || offset > embed.end) continue;
				if (offset <= embed.tagEnd) {
					return new vscode.Hover(markdown(tagHover(origin())), range(doc, embed.start, embed.tagEnd));
				}
				const a = attributeAt(embed, offset);
				const def = a && ATTRIBUTES.find((x) => x.name === a.name.toLowerCase());
				if (def) {
					const lines = [`**\`${def.name}\`**`, '', def.doc];
					if (def.values) lines.push('', `Values: ${def.values.map((v) => `\`${v}\``).join(', ')}`);
					if (def.flag) lines.push('', 'Boolean: present or absent.');
					lines.push('', `[Embedding guide](${origin()}/docs/embedding)`);
					return new vscode.Hover(markdown(lines.join('\n')), range(doc, a.start, a.nameEnd));
				}
			}
			return null;
		},
	});

	const completions = vscode.languages.registerCompletionItemProvider(
		SELECTOR,
		{
			provideCompletionItems(doc, position) {
				const text = doc.getText();
				const ctx = completionContext(text, doc.offsetAt(position));
				if (!ctx) return null;
				if (ctx.kind === 'value') {
					if (!ctx.def?.values) return null;
					return ctx.def.values.map((v) => {
						const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember);
						item.detail = `${ctx.def.name} value`;
						return item;
					});
				}
				const present = new Set(ctx.embed.attrs.map((a) => a.name.toLowerCase()));
				return ATTRIBUTES.filter((a) => !present.has(a.name)).map((a, i) => {
					const item = new vscode.CompletionItem(a.name, vscode.CompletionItemKind.Property);
					item.documentation = markdown(a.doc);
					item.detail = a.source ? 'source' : a.flag ? 'flag' : 'attribute';
					item.sortText = `${a.source ? '0' : '1'}${String(i).padStart(3, '0')}`;
					item.insertText = a.flag
						? a.name
						: new vscode.SnippetString(`${a.name}="\${1${a.values ? `|${a.values.join(',')}|` : ''}}"`);
					return item;
				});
			},
		},
		' ',
		'"',
	);

	const lenses = vscode.languages.registerCodeLensProvider(SELECTOR, {
		provideCodeLenses(doc) {
			if (!mentions(doc)) return [];
			const text = doc.getText();
			const out = [];
			for (const embed of findEmbeds(text)) {
				const r = range(doc, embed.start, embed.tagEnd);
				const model = embed.attrs.find((a) => ['body', 'src'].includes(a.name.toLowerCase()) && a.value && /^https?:\/\/.*\.(glb|gltf)(\?.*)?$/i.test(a.value.trim()));
				if (model) {
					out.push(new vscode.CodeLens(r, { title: '$(eye) Preview model', command: 'threews3d.previewUrl', arguments: [model.value.trim()] }));
				}
				out.push(new vscode.CodeLens(r, { title: 'Embedding guide', command: 'vscode.open', arguments: [vscode.Uri.parse(`${origin()}/docs/embedding`)] }));
			}
			for (const script of findLibraryScripts(text)) {
				if (!script.exact) {
					out.push(new vscode.CodeLens(range(doc, script.start, script.end), { title: '$(pin) Pin the library version', command: 'editor.action.quickFix' }));
				}
			}
			return out;
		},
	});

	return vscode.Disposable.from(
		diagnostics,
		codeActions,
		hover,
		completions,
		lenses,
		vscode.workspace.onDidOpenTextDocument(schedule),
		vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('threews3d.embedDiagnostics')) {
				for (const doc of vscode.workspace.textDocuments) schedule(doc);
			}
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => {
			diagnostics.delete(doc.uri);
			fixes.delete(doc.uri.toString());
		}),
		{ dispose: () => timers.forEach((t) => clearTimeout(t)) },
	);
}

function fixKey(code, r) {
	return `${code}@${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
}

function range(doc, start, end) {
	return new vscode.Range(doc.positionAt(start), doc.positionAt(Math.max(start, end)));
}

function markdown(value) {
	const md = new vscode.MarkdownString(value);
	md.supportThemeIcons = true;
	return md;
}
