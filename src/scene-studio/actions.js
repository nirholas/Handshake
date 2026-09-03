// Scene Studio — layered quality-of-life action bar.
//
// Sibling to the vendored r184 editor (src/scene-studio/vendor/**) — never
// edits vendor files, only reads `editor` and mounts its own DOM/CSS. Adds
// three affordances the vendored File/Export menus don't offer on their own:
//
//   • Import from Forge: paste the GLB URL from a Forge (or Forge Max)
//     result and drop it straight into the scene, using the same undo-able
//     AddObjectCommand path the ?model= deep-link importer uses.
//   • Export presets    — one click for "Web GLB" or "AR bundle (USDZ)",
//     instead of hovering File ▸ Export ▸ GLB/USDZ in the vendored menu.
//   • Share / Embed      — uploads the current scene as a GLB and opens the
//     platform's existing "Embed this model" panel (iframe / web component /
//     <agent-3d> snippet) — the same modal Forge results use.
//
// Failures surface through the shared toast (src/shared/toast.js) and the
// import prompt through the shared <dialog> Modal (src/shared/modal.js), so a
// bad URL or a dead upload reads like the rest of the platform instead of a
// native alert()/prompt() box that ignores the studio's theme and traps focus
// outside the editor.

import { addGltfBufferToScene } from './loader.js';
import { showEmbedPanel } from '../forge-embed-panel.js';
import { Modal } from '../shared/modal.js';
import { toast, toastError, toastSuccess } from '../shared/toast.js';

const STYLE_ID = 'tws-studio-actions-styles';

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}

function getAnimations(scene) {
	const animations = [];
	scene.traverse((object) => animations.push(...object.animations));
	return animations;
}

function saveArrayBuffer(buffer, filename) {
	const blob = new Blob([buffer], { type: 'application/octet-stream' });
	downloadBlob(blob, filename);
}

function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Human-readable cause for a failed fetch/parse, for the toast copy. */
export function describeImportFailure(error) {
	const raw = String(error?.message || error || '').trim();
	// A thrown plain object stringifies to "[object Object]", which is worse
	// than saying nothing; fetch/parse rejections are not always Errors.
	const message = !raw || raw.startsWith('[object ') ? 'Unknown error' : raw;
	if (/^HTTP 40[13]$/.test(message)) return 'that link is private or expired';
	if (/^HTTP 404$/.test(message)) return 'nothing is hosted at that link';
	if (/^HTTP 5\d\d$/.test(message)) return 'the host that stores it is down';
	if (/failed to fetch|networkerror|load failed/i.test(message)) {
		return 'the host blocked the request (no CORS header) or is unreachable';
	}
	return message;
}

// Same GLB export shape as the vendored File ▸ Export ▸ GLB menu item —
// binary, with cloned+optimized animation clips.
async function exportSceneGlb(editor) {
	const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
	const scene = editor.scene;
	const animations = getAnimations(scene).map((clip) => clip.clone().optimize());
	const exporter = new GLTFExporter();
	return new Promise((resolve, reject) => {
		// binary: true always resolves an ArrayBuffer (the GLB container),
		// never the plain-JSON glTF shape — matches the vendored File ▸
		// Export ▸ GLB menu item exactly.
		exporter.parse(scene, resolve, reject, { binary: true, animations });
	});
}

async function exportSceneUsdz(editor) {
	const { USDZExporter } = await import('three/addons/exporters/USDZExporter.js');
	const exporter = new USDZExporter();
	return exporter.parseAsync(editor.scene);
}

/**
 * The scene's own name when the user set one in the sidebar, else a stable
 * fallback. Deliberately NOT derived from document.title: the page title is
 * "Scene Studio · Assemble 3D worlds · three.ws" for every scene, so using it
 * labelled every shared embed with the studio's marketing string.
 */
export function sceneTitle(editor) {
	const name = String(editor.scene?.name || '').trim();
	return name && name.toLowerCase() !== 'scene' ? name : 'Scene composed on three.ws';
}

/** Ask for a GLB URL in the platform's own dialog. Resolves null on cancel. */
function askForModelUrl(triggerBtn) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const modal = new Modal({
			title: 'Import a model',
			body: `
				<label class="tws-sa-field" for="tws-sa-url">
					<span>GLB or glTF URL</span>
					<input id="tws-sa-url" class="tws-sa-input" type="url" inputmode="url"
						placeholder="https://…/model.glb" autocomplete="off" spellcheck="false" />
				</label>
				<p class="tws-sa-hint">
					Paste the link from a <a href="/forge">Forge</a> or
					<a href="/forge-max">Forge Max</a> result (its Download or
					&ldquo;Copy share link&rdquo; button). The model is added to the
					current scene, and Edit&nbsp;▸&nbsp;Undo removes it again.
				</p>
				<p class="tws-sa-error" role="alert" hidden></p>
			`,
			actions: `
				<button type="button" class="tws-sa-dlg-btn" data-dlg="cancel">Cancel</button>
				<button type="button" class="tws-sa-dlg-btn tws-sa-dlg-primary" data-dlg="import">Import</button>
			`,
			onClose: () => done(null),
		}).open(triggerBtn);

		const input = modal.bodyEl.querySelector('#tws-sa-url');
		const errorEl = modal.bodyEl.querySelector('.tws-sa-error');
		input.focus();

		const fail = (message) => {
			errorEl.textContent = message;
			errorEl.hidden = false;
			input.setAttribute('aria-invalid', 'true');
			input.focus();
		};

		const submit = () => {
			const trimmed = input.value.trim();
			if (!trimmed) return fail('Paste a link first.');
			if (!/^https:\/\//i.test(trimmed)) {
				return fail('That is not an https link. Copy the GLB link from the result bar and try again.');
			}
			done(trimmed);
			modal.close();
		};

		input.addEventListener('input', () => {
			errorEl.hidden = true;
			input.removeAttribute('aria-invalid');
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		});
		modal.actionsEl.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-dlg]');
			if (!btn) return;
			if (btn.dataset.dlg === 'import') submit();
			else modal.close();
		});
	});
}

/**
 * Open the import dialog and, on a confirmed URL, fetch + add the model.
 * Exported so the empty-state overlay can offer the same flow without
 * duplicating the fetch/label/error handling.
 * @param {import('./vendor/js/Editor.js').Editor} editor
 * @param {HTMLElement} [triggerBtn] focus returns here when the dialog closes.
 */
export async function openImportDialog(editor, triggerBtn) {
	const url = await askForModelUrl(triggerBtn);
	if (!url) return;

	const base = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
	const label = (base.replace(/\.(glb|gltf)$/i, '') || 'Forge model').slice(0, 64);
	const settle = toast(`Importing ${label}…`, { duration: 60000 });
	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const contents = await res.arrayBuffer();
		await addGltfBufferToScene(editor, contents, label);
		settle();
		toastSuccess(`${label} added to the scene.`);
	} catch (error) {
		settle();
		toastError(
			`Could not import that model: ${describeImportFailure(error)}. ` +
				'Download the GLB and drag the file into the editor instead.',
			{ duration: 7000 },
		);
	}
}

function closeMenu(menu) {
	menu?.remove();
}

function showExportMenu(editor, anchorBtn) {
	document.querySelector('.tws-sa-menu')?.remove();
	const menu = document.createElement('div');
	menu.className = 'tws-sa-menu';
	menu.setAttribute('role', 'menu');
	menu.innerHTML = `
		<button type="button" role="menuitem" data-preset="glb">Web GLB <span>.glb — orbit-ready, compressed</span></button>
		<button type="button" role="menuitem" data-preset="usdz">AR bundle <span>.usdz — iOS Quick Look</span></button>
	`;
	document.body.appendChild(menu);
	const rect = anchorBtn.getBoundingClientRect();
	menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
	menu.style.top = `${rect.bottom + 8}px`;
	anchorBtn.setAttribute('aria-expanded', 'true');

	const dismiss = () => {
		closeMenu(menu);
		anchorBtn.setAttribute('aria-expanded', 'false');
		document.removeEventListener('click', onDocClick, true);
		document.removeEventListener('keydown', onKeydown, true);
	};

	const onDocClick = (e) => {
		if (!menu.contains(e.target) && e.target !== anchorBtn) dismiss();
	};
	const onKeydown = (e) => {
		if (e.key === 'Escape') {
			dismiss();
			anchorBtn.focus();
		}
	};
	setTimeout(() => {
		document.addEventListener('click', onDocClick, true);
		document.addEventListener('keydown', onKeydown, true);
	}, 0);
	menu.querySelector('button')?.focus();

	menu.addEventListener('click', async (e) => {
		const btn = e.target.closest('[data-preset]');
		if (!btn) return;
		const isGlb = btn.dataset.preset === 'glb';
		dismiss();
		const settle = toast(`Exporting ${isGlb ? 'GLB' : 'USDZ'}…`, { duration: 60000 });
		try {
			if (isGlb) saveArrayBuffer(await exportSceneGlb(editor), 'scene.glb');
			else saveArrayBuffer(await exportSceneUsdz(editor), 'scene.usdz');
			settle();
			toastSuccess(isGlb ? 'scene.glb downloaded.' : 'scene.usdz downloaded.');
		} catch (error) {
			settle();
			toastError(`Export failed: ${error?.message || error}`, { duration: 7000 });
		}
	});
}

async function shareScene(editor, triggerBtn) {
	if (editor.scene.children.length === 0) {
		toast('Add something to the scene first: use Add ▸, Import from Forge, or drag a GLB in.');
		return;
	}

	const original = triggerBtn.textContent;
	triggerBtn.disabled = true;
	triggerBtn.textContent = 'Exporting…';
	try {
		const buffer = await exportSceneGlb(editor);
		const blob = new Blob([buffer], { type: 'model/gltf-binary' });

		triggerBtn.textContent = 'Uploading…';
		const presignRes = await fetch('/api/scene-glb-upload', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ content_type: 'model/gltf-binary', size_bytes: blob.size }),
		});
		const presign = await presignRes.json().catch(() => null);
		if (!presignRes.ok || !presign?.upload_url) {
			throw new Error(presign?.message || `Upload not available (HTTP ${presignRes.status})`);
		}

		const putRes = await fetch(presign.upload_url, {
			method: presign.method || 'PUT',
			headers: presign.headers || { 'content-type': 'model/gltf-binary' },
			body: blob,
		});
		if (!putRes.ok) throw new Error(`Upload failed (HTTP ${putRes.status})`);

		showEmbedPanel({ glbUrl: presign.public_url, title: sceneTitle(editor) }, triggerBtn);
	} catch (error) {
		toastError(
			`Could not share this scene: ${error?.message || error}. ` +
				'Export ▸ Web GLB still saves it to your machine.',
			{ duration: 7000 },
		);
	} finally {
		triggerBtn.disabled = false;
		triggerBtn.textContent = original;
	}
}

/**
 * Keep the bar clear of the sidebar. The vendored sidebar is 350px wide above
 * 600px AND user-resizable (Resizer.js writes `#sidebar.style.width` on drag),
 * so a static `right: 12px` parked all three buttons on top of the
 * SCENE / PROJECT / SETTINGS tab row at every desktop width. Mirroring the live
 * width into a custom property keeps the bar docked beside the sidebar through
 * a resize drag as well as a window resize.
 *
 * The property is written on the studio container, not on the bar, so the
 * empty-state overlay (empty-state.js) inherits the same measurement and stays
 * centred on the viewport rather than on the window.
 */
function trackSidebarWidth(container) {
	const sidebar = document.getElementById('sidebar');
	if (!sidebar) return () => {};
	const apply = () => {
		container.style.setProperty(
			'--tws-sa-sidebar-w',
			`${Math.round(sidebar.getBoundingClientRect().width)}px`,
		);
	};
	apply();
	if (typeof ResizeObserver === 'undefined') {
		window.addEventListener('resize', apply);
		return () => window.removeEventListener('resize', apply);
	}
	const observer = new ResizeObserver(apply);
	observer.observe(sidebar);
	return () => observer.disconnect();
}

/**
 * Mount the action bar into the Scene Studio container.
 * @param {import('./vendor/js/Editor.js').Editor} editor
 * @param {HTMLElement} container
 */
export function mountStudioActions(editor, container) {
	ensureStyles();
	const bar = document.createElement('div');
	bar.className = 'tws-sa-bar';
	bar.setAttribute('role', 'toolbar');
	bar.setAttribute('aria-label', 'Scene Studio quick actions');
	bar.innerHTML = `
		<button type="button" class="tws-sa-btn" data-action="import" aria-label="Import a model from Forge">⤵ Import from Forge</button>
		<button type="button" class="tws-sa-btn" data-action="export" aria-label="Export presets" aria-haspopup="menu" aria-expanded="false">⇩ Export</button>
		<button type="button" class="tws-sa-btn tws-sa-primary" data-action="share" aria-label="Share or embed this scene">🔗 Share</button>
	`;
	container.appendChild(bar);
	trackSidebarWidth(container);

	bar.addEventListener('click', (e) => {
		const btn = e.target.closest('.tws-sa-btn');
		if (!btn) return;
		if (btn.dataset.action === 'import') openImportDialog(editor, btn);
		else if (btn.dataset.action === 'export') showExportMenu(editor, btn);
		else if (btn.dataset.action === 'share') shareScene(editor, btn);
	});

	return bar;
}

const CSS = `
.tws-sa-bar {
	/* Clears the vendored #menubar row (fixed 36px tall — see
	   src/scene-studio/vendor/css/main.css, also the reference #player/#viewport
	   use for their own top offset) at every breakpoint we support (320/768/1440),
	   so this bar never sits on top of File/Edit/Add/View/Render/Help.
	   Horizontally it clears the sidebar too: --tws-sa-sidebar-w is written by
	   trackSidebarWidth() above and follows the resizer drag. */
	position: absolute; top: 44px; right: calc(var(--tws-sa-sidebar-w, 350px) + 12px);
	z-index: 10;
	display: flex; gap: 6px;
	font: 600 12px/1 system-ui, -apple-system, sans-serif;
}
.tws-sa-btn {
	appearance: none; cursor: pointer; white-space: nowrap;
	border: 1px solid rgba(255,255,255,0.16); border-radius: 8px;
	padding: 7px 11px; background: rgba(20,20,24,0.82); color: #e8e8ec;
	backdrop-filter: blur(6px);
	transition: background 0.14s, border-color 0.14s, transform 0.08s;
}
.tws-sa-btn:hover { background: rgba(34,34,40,0.92); border-color: rgba(255,255,255,0.3); }
.tws-sa-btn:active { transform: translateY(1px); }
.tws-sa-btn:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
.tws-sa-btn:disabled { opacity: 0.6; cursor: default; }
.tws-sa-btn.tws-sa-primary { background: #e8e8ec; color: #0a0a0f; border-color: transparent; }
.tws-sa-btn.tws-sa-primary:hover { background: #ffffff; }
.tws-sa-menu {
	position: fixed; z-index: 1000;
	display: flex; flex-direction: column; gap: 2px;
	background: rgba(18,18,22,0.98); border: 1px solid rgba(255,255,255,0.14);
	border-radius: 10px; padding: 6px; min-width: 220px;
	box-shadow: 0 12px 32px rgba(0,0,0,0.45);
	font: 600 12.5px/1.3 system-ui, sans-serif;
}
.tws-sa-menu button {
	appearance: none; cursor: pointer; text-align: left;
	border: 0; border-radius: 7px; padding: 8px 10px;
	background: transparent; color: #e8e8ec;
}
.tws-sa-menu button:hover, .tws-sa-menu button:focus-visible { background: rgba(255,255,255,0.08); outline: none; }
.tws-sa-menu button span { display: block; margin-top: 2px; font-weight: 400; font-size: 11px; color: #9a9aa8; }

/* Import dialog (mounted inside the shared <dialog> Modal). */
.tws-sa-field { display: block; }
.tws-sa-field > span {
	display: block; margin-bottom: 6px;
	font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
	color: var(--ink, #f2f3f7);
}
.tws-sa-input {
	width: 100%; box-sizing: border-box;
	border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
	padding: 9px 11px; background: rgba(10,10,14,0.8); color: var(--ink, #f2f3f7);
	font: 400 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.tws-sa-input:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 1px; }
.tws-sa-input[aria-invalid='true'] { border-color: rgba(255,122,138,0.7); }
.tws-sa-hint { margin: 10px 0 0; font-size: 12.5px; line-height: 1.5; }
.tws-sa-hint a { color: #6ee7b7; }
.tws-sa-error {
	margin: 10px 0 0; font-size: 12.5px; line-height: 1.5; color: #ff7a8a;
}
.tws-sa-error[hidden] { display: none; }
.tws-sa-dlg-btn {
	appearance: none; cursor: pointer;
	border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
	padding: 8px 14px; background: transparent; color: var(--ink, #f2f3f7);
	font: 600 13px/1 system-ui, sans-serif;
	transition: background 0.14s, border-color 0.14s;
}
.tws-sa-dlg-btn:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.32); }
.tws-sa-dlg-btn:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
.tws-sa-dlg-primary { background: #e8e8ec; color: #0a0a0f; border-color: transparent; }
.tws-sa-dlg-primary:hover { background: #ffffff; }

@media (prefers-reduced-motion: reduce) { .tws-sa-btn, .tws-sa-dlg-btn { transition: none; } }
/* Narrow viewports: the vendored sidebar stops being a right-hand column and
   docks full-width along the bottom (vendor/css/main.css, max-width 600px), so
   the bar reclaims the right edge. It stays pinned top-right (never bottom:
   that corner is reserved for the site-wide "Getting started" launcher pill on
   every page, see public/getting-started.js) and shrinks to fit under the
   vendor menubar. */
@media (max-width: 600px) {
	.tws-sa-bar {
		right: 12px;
		flex-wrap: wrap; justify-content: flex-end; max-width: calc(100% - 16px);
	}
	.tws-sa-btn { font-size: 11px; padding: 6px 8px; }
}
`;
