// Forge dropzone — paste or drop reference photos anywhere on /forge.
//
// Two capture paths, both routed through the `forge:add-images` hook in
// src/forge.js (which switches to the right input mode and distributes files
// into free view slots, or the sketch slot in sketch mode):
//
//   • Paste (⌘V / Ctrl+V) — an image on the clipboard becomes a reference
//     view from anywhere on the page. Text pastes into inputs are untouched.
//   • Drag a file over the page — outside photo mode a full-page overlay
//     invites the drop ("the slots aren't visible, so say where it goes");
//     inside photo mode the slots already light up individually, so the only
//     page-level job is catching drops that miss a slot instead of letting
//     the browser navigate away to the image.
//
// Self-contained: injects its own styles, owns its overlay + toast nodes,
// talks to forge.js only via the CustomEvent contract.

const STYLE_ID = 'forge-dropzone-styles';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function injectStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
		.forge-drop-overlay {
			position: fixed;
			inset: 0;
			z-index: 80;
			display: grid;
			place-items: center;
			background: color-mix(in srgb, var(--bg, #0b0b10) 72%, transparent);
			backdrop-filter: blur(3px);
			-webkit-backdrop-filter: blur(3px);
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.15s ease;
		}
		.forge-drop-overlay[data-active='true'] {
			opacity: 1;
			pointer-events: auto;
		}
		.forge-drop-card {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.6rem;
			padding: 2.2rem 2.8rem;
			border: 2px dashed var(--accent, #7c9cff);
			border-radius: var(--radius-lg, 16px);
			background: var(--surface-1, rgba(255, 255, 255, 0.04));
			text-align: center;
			transform: scale(0.97);
			transition: transform 0.15s ease;
		}
		.forge-drop-overlay[data-active='true'] .forge-drop-card {
			transform: scale(1);
		}
		.forge-drop-card .glyph {
			font-size: 2rem;
			color: var(--accent, #7c9cff);
			line-height: 1;
		}
		.forge-drop-card h3 {
			margin: 0;
			color: var(--ink, #fff);
			font-family: var(--font-display, inherit);
			font-size: var(--text-lg, 1.1rem);
		}
		.forge-drop-card p {
			margin: 0;
			color: var(--ink-dim, #aab);
			font-size: var(--text-sm, 0.85rem);
			max-width: 34ch;
		}
		.forge-toast {
			position: fixed;
			left: 50%;
			bottom: 28px;
			transform: translate(-50%, 8px);
			z-index: 90;
			background: var(--surface-3, #1d1d26);
			border: 1px solid var(--stroke-strong, rgba(255, 255, 255, 0.16));
			border-radius: 999px;
			color: var(--ink, #fff);
			font-size: var(--text-sm, 0.85rem);
			padding: 0.55rem 1.1rem;
			box-shadow: 0 12px 32px -12px rgba(0, 0, 0, 0.7);
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.18s ease, transform 0.18s ease;
		}
		.forge-toast[data-show='true'] {
			opacity: 1;
			transform: translate(-50%, 0);
		}
		@media (prefers-reduced-motion: reduce) {
			.forge-drop-overlay, .forge-drop-card, .forge-toast {
				transition: none;
			}
		}
	`;
	document.head.appendChild(style);
}

// ── Toast ───────────────────────────────────────────────────────────────────

let toastEl = null;
let toastTimer = null;
function toast(message) {
	if (!toastEl) {
		toastEl = document.createElement('div');
		toastEl.className = 'forge-toast';
		toastEl.setAttribute('role', 'status');
		toastEl.setAttribute('aria-live', 'polite');
		document.body.appendChild(toastEl);
	}
	toastEl.textContent = message;
	toastEl.dataset.show = 'true';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		toastEl.dataset.show = 'false';
	}, 2600);
}

// ── Mode + file helpers ─────────────────────────────────────────────────────

function currentMode() {
	return (
		document.querySelector('#mode-switch [aria-selected="true"]')?.dataset.mode || 'text'
	);
}

function imageFilesOf(list) {
	return Array.from(list || []).filter((f) => f && IMAGE_TYPES.has(f.type));
}

function addImages(files, source) {
	if (!files.length) return;
	const sketch = currentMode() === 'sketch';
	document.dispatchEvent(new CustomEvent('forge:add-images', { detail: { files } }));
	if (sketch) {
		toast(`${source} added as your sketch`);
	} else {
		toast(
			files.length === 1
				? `${source} added as a reference view`
				: `${files.length} photos added as reference views`,
		);
	}
}

// ── Paste ───────────────────────────────────────────────────────────────────

document.addEventListener('paste', (e) => {
	const files = imageFilesOf(e.clipboardData?.files);
	if (!files.length) return; // text paste — leave the browser alone
	e.preventDefault();
	addImages(files, 'Pasted image');
});

// ── Page-level drag & drop ──────────────────────────────────────────────────

let overlay = null;
function ensureOverlay() {
	if (overlay) return overlay;
	overlay = document.createElement('div');
	overlay.className = 'forge-drop-overlay';
	overlay.setAttribute('aria-hidden', 'true');
	overlay.innerHTML = `
		<div class="forge-drop-card">
			<span class="glyph" aria-hidden="true">⇣</span>
			<h3>Drop photos to forge in 3D</h3>
			<p>1–6 views of one object. I'll switch to <strong>From photos</strong> and place them for you.</p>
		</div>`;
	document.body.appendChild(overlay);
	return overlay;
}

function draggingFiles(e) {
	return Array.from(e.dataTransfer?.types || []).includes('Files');
}

// dragenter/leave fire for every child node — a depth counter is the reliable
// way to know when the pointer truly left the window.
let dragDepth = 0;
function setOverlay(active) {
	ensureOverlay().dataset.active = String(active);
}

document.addEventListener('dragenter', (e) => {
	if (!draggingFiles(e)) return;
	dragDepth++;
	// In photo mode the view slots are on screen and light up themselves; the
	// overlay would cover them and steal their per-slot targeting.
	if (currentMode() !== 'image') setOverlay(true);
});

document.addEventListener('dragleave', () => {
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) setOverlay(false);
});

document.addEventListener('dragover', (e) => {
	if (!draggingFiles(e)) return;
	// Without this the drop never fires and the browser navigates to the file.
	e.preventDefault();
});

document.addEventListener('drop', (e) => {
	dragDepth = 0;
	setOverlay(false);
	if (!draggingFiles(e)) return;
	e.preventDefault();
	// A drop directly on a view slot was already handled there (capture order:
	// slot listener runs first and reads the same event) — don't double-add.
	if (e.target instanceof Element && e.target.closest('.view-slot')) return;
	const files = imageFilesOf(e.dataTransfer.files);
	if (!files.length) {
		toast('Only PNG, JPG, or WebP images can become reference views');
		return;
	}
	addImages(files, 'Dropped photo');
});

injectStyles();
