// /assistant — builder page for the assistant widget.
//
// Left card edits a config object; the right card renders the copy-paste
// script snippet; and the page itself runs the REAL loader
// (public/assistant/v1.js) so every change re-inits the live widget in the
// corner. No mock preview — what you see is the shipped widget.

import { sanitizeAccent, normalizeMode } from './assistant-widget-core.js';

const config = {
	avatar: '',
	bg: '',
	mode: 'both',
	name: '',
	greeting: '',
	context: '',
	accent: '#f97316',
	position: 'right',
};

const snippetEl = document.getElementById('snippet');
const copyBtn = document.getElementById('copy-btn');
const avatarSelect = document.getElementById('cfg-avatar');
const avatarUrlInput = document.getElementById('cfg-avatar-url');
const bgColorInput = document.getElementById('cfg-bg-color');
const nameInput = document.getElementById('cfg-name');
const greetingInput = document.getElementById('cfg-greeting');
const contextInput = document.getElementById('cfg-context');
const accentInput = document.getElementById('cfg-accent');
const previewStatusEl = document.getElementById('preview-status');
const previewStatusTextEl = document.getElementById('preview-status-text');
const previewRetryBtn = document.getElementById('preview-retry');

// ── Snippet rendering ─────────────────────────────────────────────────────
function escapeAttr(value) {
	return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function snippetAttrs() {
	const attrs = [];
	if (config.avatar) attrs.push(['data-avatar', config.avatar]);
	if (config.bg) attrs.push(['data-bg', config.bg]);
	if (config.mode !== 'both') attrs.push(['data-mode', config.mode]);
	if (config.name) attrs.push(['data-name', config.name]);
	if (config.greeting) attrs.push(['data-greeting', config.greeting]);
	if (config.context) attrs.push(['data-context', config.context]);
	if (config.accent.toLowerCase() !== '#f97316') attrs.push(['data-accent', config.accent]);
	if (config.position !== 'right') attrs.push(['data-position', config.position]);
	return attrs;
}

function renderSnippet() {
	const attrs = snippetAttrs();
	const lines = [`<span class="tag">&lt;script</span> <span class="attr">src</span>=<span class="val">"https://three.ws/assistant/v1.js"</span> <span class="attr">async</span>`];
	for (const [key, value] of attrs) {
		lines.push(`  <span class="attr">${key}</span>=<span class="val">"${escapeAttr(value)}"</span>`);
	}
	lines[lines.length - 1] += `<span class="tag">&gt;&lt;/script&gt;</span>`;
	snippetEl.innerHTML = lines.join('\n');
}

function snippetText() {
	const attrs = snippetAttrs()
		.map(([key, value]) => `\n  ${key}="${String(value).replace(/"/g, '&quot;')}"`)
		.join('');
	return `<script src="https://three.ws/assistant/v1.js" async${attrs}><\/script>`;
}

// ── Live widget (the real loader, re-inited on every change) ──────────────
const PREVIEW_COPY = {
	loading: 'Starting the live preview...',
	ready: 'Live preview running in the corner. Every change above re-mounts it.',
	error:
		"The live preview couldn't start (the widget script didn't load). Your snippet " +
		'above is still correct, and the widget works on your own site.',
};

function setPreviewState(state) {
	previewStatusEl.dataset.state = state;
	previewStatusTextEl.textContent = PREVIEW_COPY[state];
	previewRetryBtn.hidden = state !== 'error';
}

let loaderReady = null;
function ensureLoader() {
	if (loaderReady) return loaderReady;
	setPreviewState('loading');
	loaderReady = new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.src = '/assistant/v1.js';
		s.setAttribute('data-manual', ''); // we drive init ourselves
		s.onload = () => {
			if (window.ThreeAssistant) resolve();
			else reject(new Error('assistant loader loaded without ThreeAssistant'));
		};
		s.onerror = () => reject(new Error('assistant loader failed to load'));
		document.head.appendChild(s);
	}).catch((err) => {
		// Drop the rejected promise so Retry re-fetches instead of replaying it.
		loaderReady = null;
		removeLoaderTag();
		throw err;
	});
	return loaderReady;
}

/** Remove a failed loader tag so a retry isn't blocked by a dead script node. */
function removeLoaderTag() {
	for (const tag of document.querySelectorAll('script[src="/assistant/v1.js"]')) tag.remove();
}

let applyTimer = 0;
function applyLive() {
	clearTimeout(applyTimer);
	applyTimer = setTimeout(async () => {
		try {
			await ensureLoader();
			const wasOpen = Boolean(window.ThreeAssistant?.instance?.isOpen);
			window.ThreeAssistant.init({ ...config, open: wasOpen });
			setPreviewState('ready');
		} catch {
			setPreviewState('error');
		}
	}, 250);
}

previewRetryBtn.addEventListener('click', () => {
	setPreviewState('loading');
	applyLive();
});

function update(patch) {
	Object.assign(config, patch);
	renderSnippet();
	applyLive();
}

// ── Control wiring ────────────────────────────────────────────────────────
avatarSelect.addEventListener('change', () => {
	const custom = avatarSelect.value === 'custom';
	avatarUrlInput.hidden = !custom;
	update({ avatar: custom ? avatarUrlInput.value.trim() : avatarSelect.value });
	if (custom) avatarUrlInput.focus();
});
avatarUrlInput.addEventListener('input', () => update({ avatar: avatarUrlInput.value.trim() }));

for (const swatch of document.querySelectorAll('.swatch')) {
	swatch.addEventListener('click', () => {
		for (const s of document.querySelectorAll('.swatch')) s.setAttribute('aria-pressed', 'false');
		swatch.setAttribute('aria-pressed', 'true');
		const isCustom = swatch.dataset.bg === 'custom-color';
		bgColorInput.hidden = !isCustom;
		update({ bg: isCustom ? bgColorInput.value : swatch.dataset.bg });
	});
}
bgColorInput.addEventListener('input', () => update({ bg: bgColorInput.value }));

for (const btn of document.querySelectorAll('[data-mode]')) {
	btn.addEventListener('click', () => {
		for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', 'false');
		btn.setAttribute('aria-pressed', 'true');
		update({ mode: normalizeMode(btn.dataset.mode) });
	});
}

for (const btn of document.querySelectorAll('[data-pos]')) {
	btn.addEventListener('click', () => {
		for (const b of document.querySelectorAll('[data-pos]')) b.setAttribute('aria-pressed', 'false');
		btn.setAttribute('aria-pressed', 'true');
		update({ position: btn.dataset.pos });
	});
}

nameInput.addEventListener('input', () => update({ name: nameInput.value.trim() }));
greetingInput.addEventListener('input', () => update({ greeting: greetingInput.value.trim() }));
contextInput.addEventListener('input', () => update({ context: contextInput.value.trim() }));
accentInput.addEventListener('input', () => update({ accent: sanitizeAccent(accentInput.value) }));

let copyBtnLabel = '';
copyBtn.addEventListener('click', async () => {
	// Read the resting label at click time: i18n may have translated it, and
	// restoring a hardcoded English string below would undo that.
	if (!copyBtnLabel) copyBtnLabel = copyBtn.textContent.trim();
	try {
		await navigator.clipboard.writeText(snippetText());
		copyBtn.textContent = 'Copied!';
	} catch {
		// Clipboard API blocked (permissions / http) — select the snippet so
		// the user can copy manually.
		const range = document.createRange();
		range.selectNodeContents(snippetEl);
		const sel = getSelection();
		sel.removeAllRanges();
		sel.addRange(range);
		copyBtn.textContent = 'Press Ctrl+C';
	}
	setTimeout(() => {
		copyBtn.textContent = copyBtnLabel;
	}, 1600);
});

// ── Boot ──────────────────────────────────────────────────────────────────
renderSnippet();
applyLive();
