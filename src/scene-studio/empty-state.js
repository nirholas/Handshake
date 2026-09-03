// Scene Studio: first-run empty state.
//
// The vendored editor opens on a scene holding nothing but the default camera,
// which renders as a bare grid: technically correct, and completely silent
// about what to do next. Someone arriving from /scene has no way to learn that
// the Add menu, a dragged GLB, and a Forge link are all valid starting points.
//
// This overlay says so, and retires itself the moment the scene has content
// (including a scene restored from the editor's IndexedDB autosave, which lands
// after this module mounts). It is a sibling module: it reads `editor` and
// mounts its own DOM, never touching vendor/**.

import { openImportDialog } from './actions.js';

const STYLE_ID = 'tws-studio-empty-styles';

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}

/**
 * Mount the empty-state overlay into the Scene Studio container.
 * @param {import('./vendor/js/Editor.js').Editor} editor
 * @param {HTMLElement} container
 * @returns {HTMLElement} the overlay element.
 */
export function mountEmptyState(editor, container) {
	ensureStyles();

	const el = document.createElement('div');
	el.className = 'tws-se';
	el.hidden = true;
	el.innerHTML = `
		<div class="tws-se-card">
			<p class="tws-se-eyebrow">Empty scene</p>
			<h2 class="tws-se-title">Start with a model</h2>
			<p class="tws-se-copy">
				Drag a <strong>.glb</strong> or <strong>.gltf</strong> file anywhere onto this
				page, pick a primitive from the <strong>Add</strong> menu above, or pull in a
				model you already generated.
			</p>
			<div class="tws-se-actions">
				<button type="button" class="tws-se-btn tws-se-primary" data-se="import">Import a model by URL</button>
				<a class="tws-se-btn" href="/forge">Generate one in Forge</a>
			</div>
			<p class="tws-se-foot">
				Everything you build here autosaves to this browser, and
				<strong>Export</strong> writes a GLB or a USDZ you can take anywhere.
			</p>
		</div>
	`;
	container.appendChild(el);

	el.querySelector('[data-se="import"]').addEventListener('click', (e) => {
		openImportDialog(editor, e.currentTarget);
	});

	const sync = () => {
		el.hidden = editor.scene.children.length > 0;
	};

	editor.signals.sceneGraphChanged.add(sync);
	editor.signals.editorCleared.add(sync);
	sync();

	return el;
}

const CSS = `
.tws-se {
	/* Sits over the viewport only: the vendored #viewport is inset by the 36px
	   menubar and the sidebar column, and this mirrors that box so the card
	   centres on the 3D view rather than on the whole window. Pointer events
	   pass through everywhere except the card, so orbiting an empty grid still
	   works while the hint is up. */
	position: absolute;
	top: 36px; left: 0; bottom: 0;
	right: var(--tws-sa-sidebar-w, 350px);
	z-index: 5;
	display: flex; align-items: center; justify-content: center;
	padding: 16px;
	pointer-events: none;
}
.tws-se[hidden] { display: none; }
.tws-se-card {
	pointer-events: auto;
	max-width: 420px; width: 100%;
	box-sizing: border-box;
	padding: 22px 24px;
	border: 1px solid rgba(255,255,255,0.12);
	border-radius: 14px;
	background: rgba(14,15,21,0.86);
	backdrop-filter: blur(14px);
	-webkit-backdrop-filter: blur(14px);
	box-shadow: 0 18px 48px rgba(0,0,0,0.5);
	color: #e8e8ec;
	font-family: system-ui, -apple-system, sans-serif;
	animation: tws-se-in 0.28s ease both;
}
@keyframes tws-se-in {
	from { opacity: 0; transform: translateY(8px); }
	to { opacity: 1; transform: none; }
}
.tws-se-eyebrow {
	margin: 0 0 6px; font-size: 11px; font-weight: 700;
	letter-spacing: 0.09em; text-transform: uppercase; color: #6ee7b7;
}
.tws-se-title { margin: 0 0 8px; font-size: 19px; font-weight: 650; color: #fff; }
.tws-se-copy, .tws-se-foot {
	margin: 0; font-size: 13px; line-height: 1.55; color: #a8a9b8;
}
.tws-se-copy strong, .tws-se-foot strong { color: #d5d6e0; font-weight: 600; }
.tws-se-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 14px; }
.tws-se-btn {
	appearance: none; cursor: pointer; text-decoration: none;
	display: inline-flex; align-items: center;
	border: 1px solid rgba(255,255,255,0.18); border-radius: 9px;
	padding: 9px 13px; background: transparent; color: #e8e8ec;
	font: 600 12.5px/1 system-ui, sans-serif;
	transition: background 0.14s, border-color 0.14s, transform 0.08s;
}
.tws-se-btn:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.34); }
.tws-se-btn:active { transform: translateY(1px); }
.tws-se-btn:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
.tws-se-primary { background: #e8e8ec; color: #0a0a0f; border-color: transparent; }
.tws-se-primary:hover { background: #fff; }
.tws-se-foot { font-size: 12px; }
@media (prefers-reduced-motion: reduce) {
	.tws-se-card { animation: none; }
	.tws-se-btn { transition: none; }
}
/* Below 600px the vendored sidebar docks along the bottom instead of the right
   (vendor/css/main.css), so the overlay spans the full width and stops above it. */
@media (max-width: 600px) {
	.tws-se { right: 0; bottom: 320px; }
	.tws-se-card { padding: 18px; }
	.tws-se-title { font-size: 17px; }
}
`;
