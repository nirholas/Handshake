// Forge "See it in your space" — bridge desktop → phone AR.
//
// model-viewer can only enter AR on a phone/tablet, so a desktop visitor who
// just forged something has no way to place it in their room. This panel
// closes that gap:
//   • on a desktop, it shows a QR code to the AR-capable embed viewer
//     (/forge/embed) — scan it and the model opens on your phone, one tap from
//     AR (the embed page reveals a big "View in AR" launcher there).
//   • on a touch device, it launches AR straight from the page's own viewer.
//
// Self-contained: reads the live GLB URL off the result bar's Download link,
// reuses the zero-dep QR encoder and the shared Modal — no coupling to
// src/forge.js internals, no network calls, no new dependencies.

import { Modal } from './shared/modal.js';
import { renderQRToSVG } from './erc8004/qr.js';

const ORIGIN = 'https://three.ws';
const STYLE_ID = 'tws-forge-ar-styles';

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function absoluteGlb(url) {
	if (!url) return '';
	try {
		return new URL(url, ORIGIN).href;
	} catch {
		return url;
	}
}

// Short URL for the QR (no title — keeps the code low-density and easy to scan).
function arUrl(glbUrl) {
	return `${ORIGIN}/forge/embed?src=${encodeURIComponent(glbUrl)}`;
}

// Richer URL for the tappable link (carries the prompt through as alt text).
function arLink(glbUrl, title) {
	const u = arUrl(glbUrl);
	return title ? `${u}&title=${encodeURIComponent(title.slice(0, 120))}` : u;
}

function isTouch() {
	return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
}

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = CSS;
	(document.head || document.documentElement).appendChild(el);
}

function qrMarkup(glbUrl) {
	try {
		const svg = renderQRToSVG(arUrl(glbUrl), {
			scale: 6,
			margin: 2,
			dark: '#0b0b0b',
			light: '#ffffff',
		});
		return `<div class="tws-ar-qr" aria-label="QR code linking to the AR viewer">${svg}</div>`;
	} catch {
		// Payload too large for the encoder — degrade to link-only, never a broken QR.
		return '';
	}
}

const cubeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z"/><path d="m3 7 9 5 9-5"/><path d="M12 12v10"/></svg>`;

function studioLink(glbUrl, title) {
	const u = `/ar/studio?src=${encodeURIComponent(glbUrl)}`;
	return title ? `${u}&title=${encodeURIComponent(title.slice(0, 80))}` : u;
}

function bodyHtml({ glbUrl, title, touch }) {
	const link = esc(arLink(glbUrl, title));
	const nameHtml = title ? `<p class="tws-ar-name">${esc(title)}</p>` : '';
	const qr = qrMarkup(glbUrl);
	const studio = `<a class="tws-ar-link" href="${esc(studioLink(glbUrl, title))}">Arrange several models together in the AR Studio ↗</a>`;

	const linkBtn = `<a class="tws-ar-cta" href="${link}" target="_blank" rel="noopener">${cubeIcon}<span>Open AR viewer</span></a>`;

	if (touch) {
		// Touch device: launch AR right here from the page's own viewer.
		const qrSecondary = qr
			? `<details class="tws-ar-more">
					<summary>On a computer? Scan from your phone</summary>
					${qr}
				</details>`
			: '';
		return `
			<div class="tws-ar">
				${nameHtml}
				<p class="tws-ar-hint">Place this model in your room — point your camera at a flat surface and drop it in.</p>
				<button class="tws-ar-cta" type="button" data-ar-launch>${cubeIcon}<span>View in your space</span></button>
				<a class="tws-ar-link" href="${link}" target="_blank" rel="noopener">Open in a new tab instead ↗</a>
				${studio}
				${qrSecondary}
			</div>
		`;
	}

	// Desktop: QR is the bridge to the phone.
	return `
		<div class="tws-ar">
			${nameHtml}
			${qr}
			<p class="tws-ar-hint">Scan with your phone camera to view this model in AR and place it in your room.</p>
			${linkBtn}
			${studio}
		</div>
	`;
}

export function showARPanel({ glbUrl, title } = {}, triggerEl = null) {
	ensureStyles();
	const abs = absoluteGlb(glbUrl);
	if (!abs) return null;
	const touch = isTouch();

	const modal = new Modal({
		title: 'See it in your space',
		body: bodyHtml({ glbUrl: abs, title: (title || '').trim(), touch }),
		dismissible: true,
	}).open(triggerEl);

	const root = modal.bodyEl;
	root.addEventListener('click', (e) => {
		if (!e.target.closest('[data-ar-launch]')) return;
		// Launch AR from the page's main viewer (already AR-enabled in result state).
		const viewer = document.getElementById('viewer');
		try {
			viewer?.activateAR?.();
			modal.close?.();
		} catch {
			/* fall back to the "open in new tab" link the user can still tap */
		}
	});

	return modal;
}

// Wire the result-bar button. GLB URL is read from the Download link at click
// time, so this never depends on Forge's internal state.
function wire() {
	const btn = document.getElementById('forge-ar-btn');
	if (!btn || btn.dataset.arWired) return;
	btn.dataset.arWired = '1';
	btn.addEventListener('click', () => {
		const glbUrl = document.getElementById('download')?.getAttribute('href') || '';
		const title = document.getElementById('result-label')?.textContent || '';
		if (!glbUrl) return;
		showARPanel({ glbUrl, title }, btn);
	});
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', wire, { once: true });
	} else {
		wire();
	}
}

const CSS = `
.tws-ar { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 4px 0 2px; text-align: center; }
.tws-ar-name {
	margin: 0; max-width: 32ch;
	font: 600 14px/1.4 var(--font-body, system-ui, sans-serif);
	color: var(--ink, #ececf4);
}
.tws-ar-qr {
	width: 208px; height: 208px; padding: 12px;
	background: #fff; border-radius: 16px;
	box-shadow: 0 16px 40px -16px rgba(0,0,0,0.7);
	display: grid; place-items: center;
}
.tws-ar-qr svg { width: 100%; height: 100%; display: block; border-radius: 4px; }
.tws-ar-hint {
	margin: 0; max-width: 34ch;
	font-size: 13px; line-height: 1.5; color: var(--ink-dim, #9a9aa8);
}
.tws-ar-cta {
	display: inline-flex; align-items: center; justify-content: center; gap: 9px;
	width: 100%; box-sizing: border-box; cursor: pointer; text-decoration: none;
	padding: 13px 18px; border: 0; border-radius: 12px;
	font: 600 14.5px/1 var(--font-body, system-ui, sans-serif);
	color: #07140e; background: var(--success, #6ee7b7);
	box-shadow: 0 10px 28px -10px rgba(110,231,183,0.55);
	transition: filter 0.14s ease, transform 0.1s ease;
}
.tws-ar-cta:hover { filter: brightness(1.06); }
.tws-ar-cta:active { transform: translateY(1px); }
.tws-ar-cta:focus-visible { outline: 2px solid var(--ink, #fff); outline-offset: 2px; }
.tws-ar-cta svg { width: 18px; height: 18px; }
.tws-ar-link {
	font-size: 13px; color: var(--accent, #6ee7b7); text-decoration: none;
}
.tws-ar-link:hover { text-decoration: underline; }
.tws-ar-more { width: 100%; margin-top: 2px; }
.tws-ar-more summary {
	cursor: pointer; list-style: none; font-size: 12.5px;
	color: var(--ink-dim, #9a9aa8); padding: 6px 0;
}
.tws-ar-more summary::-webkit-details-marker { display: none; }
.tws-ar-more summary:hover { color: var(--ink, #ececf4); }
.tws-ar-more[open] summary { margin-bottom: 10px; }
.tws-ar-more .tws-ar-qr { width: 168px; height: 168px; margin: 0 auto; }
`;
