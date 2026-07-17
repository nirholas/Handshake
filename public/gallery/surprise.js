/**
 * "Surprise me": the one-click instant avatar.
 *
 * The shortest path on the site from landing to "I made something": no prompt to
 * type, no photo to upload, no sign-in to see it. One click asks the server to
 * compose a unique, rigged avatar (POST /api/avatars/surprise → GLB bytes), and
 * this module reveals it live on a tinted stage. Reroll for another in a tap;
 * "Make it mine" hands the exact same GLB to the guest flow
 * (guest-avatar.stage → /create-review), where it can be named and saved.
 *
 * Wiring is one attribute: put `data-surprise-avatar` on any button and this
 * module (auto-run on import from gallery.js) attaches the handler. A shared
 * `/gallery?surprise=<seed>` link auto-opens the same avatar the sharer saw.
 */

import { stage as stageGuestAvatar } from '../../src/guest-avatar.js';

const ENDPOINT = '/api/avatars/surprise';
const REVIEW_URL = '/create-review';

let modal = null;
let currentBlobUrl = null;
let currentMeta = null;
let lastFocus = null;

// Deterministic hue from the seed so the stage tint matches the avatar and a
// reroll visibly changes the backdrop: a small, satisfying signal of "new one".
function hueFromSeed(seed) {
	let h = 0;
	const s = String(seed || '');
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return h % 360;
}

function ensureModelViewer() {
	if (customElements.get('model-viewer')) return;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';
	document.head.appendChild(s);
}

function buildModal() {
	const el = document.createElement('div');
	el.className = 'surprise-modal';
	el.setAttribute('role', 'dialog');
	el.setAttribute('aria-modal', 'true');
	el.setAttribute('aria-label', 'Your surprise avatar');
	el.innerHTML = `
		<div class="surprise-backdrop" data-close></div>
		<div class="surprise-panel" role="document">
			<button class="surprise-close" data-close type="button" aria-label="Close">
				<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>
			</button>
			<div class="surprise-stage" data-stage>
				<model-viewer class="surprise-viewer" camera-controls disable-pan disable-tap
					interaction-prompt="none" auto-rotate rotation-per-second="16deg"
					camera-orbit="18deg 86deg 105%" field-of-view="26deg" exposure="1.05"
					shadow-intensity="0.35" shadow-softness="1" environment-image="neutral"
					tone-mapping="neutral" hidden></model-viewer>
				<div class="surprise-loading" data-loading>
					<div class="surprise-orb"></div>
					<p class="surprise-loading-text" aria-live="polite">Composing a one-of-a-kind avatar…</p>
				</div>
				<div class="surprise-error" data-error hidden>
					<p data-error-text></p>
					<button class="surprise-btn surprise-btn--ghost" data-again type="button">Try again</button>
				</div>
			</div>
			<div class="surprise-meta" data-meta hidden>
				<span class="surprise-eyebrow">// your avatar</span>
				<h2 class="surprise-name" data-name>-</h2>
				<p class="surprise-tags">Rigged &amp; animation-ready · Yours to keep · No two alike</p>
			</div>
			<div class="surprise-actions" data-actions hidden>
				<button class="surprise-btn surprise-btn--ghost" data-again type="button">
					<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M4 10a6 6 0 1 1 1.8 4.3M4 15v-4h4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
					Surprise me again
				</button>
				<button class="surprise-btn surprise-btn--primary" data-claim type="button">Make it mine →</button>
			</div>
			<button class="surprise-share" data-share type="button" hidden>Copy a link to this avatar</button>
		</div>`;
	document.body.appendChild(el);

	el.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', close));
	el.querySelectorAll('[data-again]').forEach((n) => n.addEventListener('click', () => reveal()));
	el.querySelector('[data-claim]').addEventListener('click', claim);
	el.querySelector('[data-share]').addEventListener('click', copyShareLink);
	document.addEventListener('keydown', onKeydown);
	return el;
}

function onKeydown(e) {
	if (!modal || modal.hidden) return;
	if (e.key === 'Escape') close();
}

function setState(state) {
	// state: 'loading' | 'ready' | 'error'
	const stage = modal.querySelector('[data-stage]');
	const viewer = modal.querySelector('.surprise-viewer');
	modal.querySelector('[data-loading]').hidden = state !== 'loading';
	modal.querySelector('[data-error]').hidden = state !== 'error';
	viewer.hidden = state !== 'ready';
	modal.querySelector('[data-meta]').hidden = state !== 'ready';
	modal.querySelector('[data-actions]').hidden = state !== 'ready';
	modal.querySelector('[data-share]').hidden = state !== 'ready';
	stage.dataset.state = state;
	// The reroll buttons should not stack requests.
	modal.querySelectorAll('[data-again]').forEach((b) => { b.disabled = state === 'loading'; });
}

function revokeBlob() {
	if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
}

async function reveal(seed) {
	ensureModelViewer();
	setState('loading');
	const url = seed ? `${ENDPOINT}?seed=${encodeURIComponent(seed)}` : ENDPOINT;
	try {
		const res = await fetch(url, { method: 'POST', headers: { accept: 'model/gltf-binary' } });
		if (!res.ok) {
			if (res.status === 429) throw new Error('Give it a second: that was a lot of avatars at once.');
			throw new Error(`Could not compose an avatar (HTTP ${res.status}).`);
		}
		let meta = {};
		try { meta = JSON.parse(res.headers.get('x-avatar-meta') || '{}'); } catch { /* header optional */ }
		const blob = await res.blob();
		revokeBlob();
		currentBlobUrl = URL.createObjectURL(blob);
		currentMeta = { ...meta, blob };

		const viewer = modal.querySelector('.surprise-viewer');
		viewer.src = currentBlobUrl;
		const hue = hueFromSeed(meta.seed);
		modal.querySelector('[data-stage]').style.setProperty('--surprise-hue', String(hue));
		modal.querySelector('[data-name]').textContent = meta.name || 'Your avatar';

		// Keep the URL shareable without a reload.
		if (meta.seed) {
			try {
				const u = new URL(window.location.href);
				u.searchParams.set('surprise', meta.seed);
				window.history.replaceState({}, '', u);
			} catch { /* non-fatal */ }
		}
		setState('ready');
	} catch (err) {
		modal.querySelector('[data-error-text]').textContent = err?.message || 'Something went wrong. Try again.';
		setState('error');
	}
}

async function claim() {
	if (!currentMeta?.blob) return;
	const btn = modal.querySelector('[data-claim]');
	btn.disabled = true;
	btn.textContent = 'Saving…';
	try {
		await stageGuestAvatar(currentMeta.blob, {
			source: 'studio-surprise',
			name: currentMeta.name || 'Surprise avatar',
			source_meta: { surprise: true, seed: currentMeta.seed, ...(currentMeta.descriptor || {}) },
		});
		window.location.href = REVIEW_URL;
	} catch (err) {
		btn.disabled = false;
		btn.textContent = 'Make it mine →';
		modal.querySelector('[data-error-text]').textContent = err?.message || 'Could not save it locally. Try again.';
		setState('error');
	}
}

async function copyShareLink() {
	if (!currentMeta?.seed) return;
	const link = `${window.location.origin}/gallery?surprise=${encodeURIComponent(currentMeta.seed)}`;
	const btn = modal.querySelector('[data-share]');
	try {
		await navigator.clipboard.writeText(link);
		const prev = btn.textContent;
		btn.textContent = 'Link copied ✓';
		setTimeout(() => { btn.textContent = prev; }, 1800);
	} catch {
		btn.textContent = link;
	}
}

function open(seed) {
	if (!modal) modal = buildModal();
	lastFocus = document.activeElement;
	modal.hidden = false;
	document.body.style.overflow = 'hidden';
	requestAnimationFrame(() => modal.classList.add('is-open'));
	modal.querySelector('.surprise-close').focus();
	reveal(seed);
}

function close() {
	if (!modal) return;
	modal.classList.remove('is-open');
	document.body.style.overflow = '';
	const viewer = modal.querySelector('.surprise-viewer');
	if (viewer) viewer.src = '';
	revokeBlob();
	setTimeout(() => { if (modal) modal.hidden = true; }, 200);
	if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
}

function wire() {
	document.querySelectorAll('[data-surprise-avatar]').forEach((btn) => {
		if (btn.dataset.surpriseWired) return;
		btn.dataset.surpriseWired = '1';
		btn.addEventListener('click', (e) => { e.preventDefault(); open(); });
	});
	// Deep-link: /gallery?surprise=<seed> opens straight into that avatar.
	try {
		const seed = new URL(window.location.href).searchParams.get('surprise');
		if (seed) open(seed);
	} catch { /* non-fatal */ }
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', wire);
} else {
	wire();
}

export { open as openSurprise };
