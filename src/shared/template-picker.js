/**
 * Create-from-template picker — a reusable modal that lets a user start a new
 * avatar from a curated, ready-made template (or any avatar in the public
 * gallery) on every creation surface.
 *
 * The whole flow is page-agnostic:
 *   1. openTemplatePicker() shows curated templates with live 3D previews and a
 *      "browse the full gallery" escape hatch.
 *   2. createFromTemplate() takes the chosen GLB, stages it locally (no sign-in
 *      required), and forwards to /create-review — the same review → save step
 *      the rest of the create flow uses.
 *
 * Wiring a page up is one line of markup: add `data-create-from-template` to any
 * button/link and import this module. wireTemplateButtons() (auto-run on import)
 * finds them and attaches the handler.
 *
 * Usage:
 *   import '/src/shared/template-picker.js';            // auto-wires [data-create-from-template]
 *   // or drive it directly:
 *   import { createFromTemplate, openTemplatePicker } from '/src/shared/template-picker.js';
 *   await createFromTemplate();
 */

import './template-picker.css';
import { AVATAR_TEMPLATES } from './avatar-templates.js';
import { stage as stageGuestAvatar } from '../guest-avatar.js';
import { openAvatarPicker } from '../avatar-gallery-picker.js';
import { log } from './log.js';

import { ensureModelViewerOrFallback } from './model-viewer-loader.js';
const REVIEW_URL = '/create-review';

// Shared loader: three CDNs, a per-source timeout and a visible fallback on
// every <model-viewer> in this picker when none of them can be reached.
function ensureModelViewer() {
	ensureModelViewerOrFallback(document);
}

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Opens the curated template picker as a modal.
 * @returns {Promise<{name:string, url:string, source:string, source_meta:object}|null>}
 *   The chosen template (or gallery avatar normalized to the same shape), or
 *   null if the user dismissed the picker.
 */
export function openTemplatePicker() {
	return new Promise((resolve) => {
		ensureModelViewer();

		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			close();
			resolve(value);
		};

		const overlay = document.createElement('div');
		overlay.className = 'twtpl-overlay';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-label', 'Create from a template');

		const cards = AVATAR_TEMPLATES.map(
			(t) => `
			<button type="button" class="twtpl-card" data-template="${esc(t.id)}" aria-label="Start from ${esc(t.name)}">
				<span class="twtpl-card-stage">
					<model-viewer
						src="${esc(t.url)}"
						alt="${esc(t.name)} avatar preview"
						auto-rotate
						auto-rotate-delay="0"
						rotation-per-second="20deg"
						interaction-prompt="none"
						disable-zoom
						disable-pan
						disable-tap
						camera-orbit="15deg 80deg auto"
						shadow-intensity="0.5"
						shadow-softness="0.9"
						exposure="1"
						environment-image="neutral"
						loading="lazy"
						reveal="auto"
					></model-viewer>
				</span>
				<span class="twtpl-card-body">
					<span class="twtpl-card-name">${esc(t.name)}</span>
					<span class="twtpl-card-tagline">${esc(t.tagline)}</span>
					<span class="twtpl-card-chips">${(t.tags || [])
						.map((tag) => `<span class="twtpl-chip">${esc(tag)}</span>`)
						.join('')}</span>
				</span>
				<span class="twtpl-card-cta">Use this avatar →</span>
			</button>`,
		).join('');

		overlay.innerHTML = `
			<div class="twtpl-shell">
				<div class="twtpl-header">
					<div>
						<h2 class="twtpl-title">Start from a template</h2>
						<p class="twtpl-sub">Pick a ready-made avatar and make it yours — no download, no sign-in to start.</p>
					</div>
					<button type="button" class="twtpl-close" aria-label="Close">&times;</button>
				</div>
				<div class="twtpl-grid">${cards}</div>
				<div class="twtpl-footer">
					<span class="twtpl-footer-hint">Want more options?</span>
					<button type="button" class="twtpl-browse" data-role="browse-gallery">Browse the full gallery →</button>
				</div>
			</div>
		`;

		const shell = overlay.querySelector('.twtpl-shell');
		const onKey = (e) => {
			if (e.key === 'Escape') finish(null);
		};

		function close() {
			document.removeEventListener('keydown', onKey);
			overlay.classList.remove('twtpl-open');
			setTimeout(() => overlay.remove(), 180);
			document.documentElement.style.overflow = '';
		}

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) finish(null);
		});
		overlay.querySelector('.twtpl-close').addEventListener('click', () => finish(null));

		overlay.querySelectorAll('.twtpl-card').forEach((card) => {
			card.addEventListener('click', () => {
				const t = AVATAR_TEMPLATES.find((x) => x.id === card.dataset.template);
				if (!t) return;
				finish({
					name: t.name,
					url: t.url,
					source: 'import',
					source_meta: { provider: 'template', template_id: t.id, source_url: t.url },
				});
			});
		});

		overlay.querySelector('[data-role="browse-gallery"]').addEventListener('click', async () => {
			// Hand off to the full public gallery picker, then normalize its
			// selection back into the template shape so the caller has one contract.
			const avatar = await openAvatarPicker({
				source: 'public',
				title: 'Pick an avatar to start from',
				ctaLabel: 'Use this avatar',
				showModes: false,
			});
			if (!avatar) return; // user backed out of the gallery; keep template picker open
			const url = avatar.model_url || avatar.url;
			if (!url) return;
			finish({
				name: avatar.name || 'Remixed avatar',
				url,
				source: 'import',
				source_meta: { provider: 'remix', fork_of: avatar.id, source_url: url },
			});
		});

		document.documentElement.style.overflow = 'hidden';
		document.body.appendChild(overlay);
		document.addEventListener('keydown', onKey);
		requestAnimationFrame(() => {
			overlay.classList.add('twtpl-open');
			shell.querySelector('.twtpl-card')?.focus();
		});
	});
}

/**
 * Full create-from-template flow: open the picker, stage the chosen GLB locally,
 * and forward to the review step. Safe to call from any creation page.
 * @returns {Promise<boolean>} true if an avatar was staged and navigation began.
 */
export async function createFromTemplate() {
	const choice = await openTemplatePicker();
	if (!choice) return false;
	return stageAndReview(choice);
}

async function stageAndReview(choice) {
	const overlay = showStagingOverlay('Preparing your avatar…');
	try {
		const res = await fetch(choice.url, { mode: 'cors' });
		if (!res.ok) throw new Error(`Could not load the model (HTTP ${res.status}).`);
		updateStagingOverlay(overlay, 'Saving locally…');
		const blob = await res.blob();
		await stageGuestAvatar(blob, {
			source: choice.source || 'import',
			name: choice.name,
			source_meta: choice.source_meta || {},
		});
		updateStagingOverlay(overlay, 'Opening preview…');
		window.location.href = REVIEW_URL;
		return true;
	} catch (err) {
		log.error('[template-picker] stage failed:', err);
		hideStagingOverlay(overlay);
		showToast(err.message || 'Could not start from this template. Try another.');
		return false;
	}
}

// ── Tiny self-contained overlay/toast (works on any page) ───────────────────

function showStagingOverlay(label) {
	const el = document.createElement('div');
	el.className = 'twtpl-stage-overlay';
	el.setAttribute('role', 'status');
	el.setAttribute('aria-live', 'polite');
	el.innerHTML = `<span class="twtpl-spinner twtpl-spinner--lg" aria-hidden="true"></span><span class="twtpl-stage-label"></span>`;
	el.querySelector('.twtpl-stage-label').textContent = label;
	document.documentElement.style.overflow = 'hidden';
	document.body.appendChild(el);
	requestAnimationFrame(() => el.classList.add('twtpl-open'));
	return el;
}

function updateStagingOverlay(el, label) {
	const l = el?.querySelector('.twtpl-stage-label');
	if (l) l.textContent = label;
}

function hideStagingOverlay(el) {
	if (!el) return;
	el.remove();
	document.documentElement.style.overflow = '';
}

let _toastTimer = null;
function showToast(msg) {
	let el = document.querySelector('.twtpl-toast');
	if (!el) {
		el = document.createElement('div');
		el.className = 'twtpl-toast';
		el.setAttribute('role', 'alert');
		document.body.appendChild(el);
	}
	el.textContent = msg;
	requestAnimationFrame(() => el.classList.add('twtpl-toast--show'));
	clearTimeout(_toastTimer);
	_toastTimer = setTimeout(() => {
		el.classList.remove('twtpl-toast--show');
		setTimeout(() => el.remove(), 250);
	}, 4500);
}

// ── Auto-wiring ─────────────────────────────────────────────────────────────

/**
 * Wire every `[data-create-from-template]` element under `root` to the flow.
 * Idempotent — already-wired elements are skipped, so it's safe to call again
 * after injecting markup dynamically (e.g. after nav/gallery cards render).
 */
export function wireTemplateButtons(root = document) {
	root.querySelectorAll('[data-create-from-template]').forEach((el) => {
		if (el.dataset.twtplWired === '1') return;
		el.dataset.twtplWired = '1';
		el.addEventListener('click', (e) => {
			e.preventDefault();
			createFromTemplate();
		});
	});
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => wireTemplateButtons());
	} else {
		wireTemplateButtons();
	}
}
