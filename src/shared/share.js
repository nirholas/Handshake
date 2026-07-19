/**
 * Share panel — one-tap share for agents, forge creations, and scans.
 *
 * Usage:
 *   import { showSharePanel } from './shared/share.js';
 *   showSharePanel(
 *     { kind: 'agent', id, title, description, shareUrl, remixUrl },
 *     triggerElement   // optional — focus returns here on close
 *   );
 *
 * entity shape:
 *   kind        'agent' | 'forge' | 'scan'
 *   id          string
 *   title       string
 *   description string  (optional)
 *   shareUrl    string  — canonical URL that has OG meta
 *   remixUrl    string  — deep-link back into the create flow
 *   previewImage string — optional OG/card image URL shown at the top of the panel
 *                         so the user sees exactly what their link will unfurl as
 */

import { Modal } from './modal.js';

const STYLE_ID = 'tws-share-styles';
const FARCASTER_COMPOSE = 'https://warpcast.com/~/compose';
const X_INTENT = 'https://x.com/intent/tweet';

export function showSharePanel(entity, triggerEl = null) {
	ensureShareStyles();

	const { title = '', description = '', shareUrl, remixUrl, previewImage, shareText } = entity;

	// Callers can supply a full per-entity share template (built from the
	// entity's real facts); the generic "<title> on three.ws" stays the default.
	const xText = encodeURIComponent(shareText ? `${shareText}\n` : `${title} on three.ws\n`);
	const xUrl = encodeURIComponent(shareUrl || location.href);
	const xHref = `${X_INTENT}?text=${xText}&url=${xUrl}`;

	const fcText = encodeURIComponent(shareText ? `${shareText}: ` : `${title} on three.ws; `);
	const fcEmbed = encodeURIComponent(shareUrl || location.href);
	const fcHref = `${FARCASTER_COMPOSE}?text=${fcText}&embeds[]=${fcEmbed}`;

	const descHtml = description
		? `<p class="tws-sp-desc">${esc(description)}</p>`
		: '';

	// Live preview of exactly what the link unfurls as — the real OG/card image.
	// Lazy + graceful: if the image fails to load it simply removes itself.
	const previewHtml = previewImage
		? `<div class="tws-sp-preview">
				<img src="${esc(previewImage)}" alt="${esc(title)} card preview" loading="lazy" decoding="async"
					onerror="this.closest('.tws-sp-preview')?.remove()" />
			</div>`
		: '';

	const remixHtml = remixUrl
		? `<a class="tws-sp-btn tws-sp-remix" href="${esc(remixUrl)}">
				${sparkleIcon()}
				Remix in three.ws →
			</a>`
		: '';

	const body = `
		<div class="tws-sp">
			${previewHtml}
			${descHtml}
			<button class="tws-sp-btn tws-sp-copy" type="button" data-share-copy="${esc(shareUrl || '')}">
				${linkIcon()}
				<span class="tws-sp-copy-label">Copy link</span>
			</button>
			<a class="tws-sp-btn tws-sp-x" href="${esc(xHref)}" target="_blank" rel="noopener noreferrer">
				${xIcon()}
				Share on X
			</a>
			<a class="tws-sp-btn tws-sp-fc" href="${esc(fcHref)}" target="_blank" rel="noopener noreferrer">
				${farcasterIcon()}
				Share on Farcaster
			</a>
			${remixHtml}
		</div>
	`;

	const modal = Modal.show({
		title: `Share "${esc(title)}"`,
		body,
		dismissible: true,
	}, triggerEl);

	// Wire copy-link button inside the modal body
	modal.bodyEl.addEventListener('click', async (e) => {
		const btn = e.target.closest('[data-share-copy]');
		if (!btn) return;

		const url = btn.dataset.shareCopy;
		const label = btn.querySelector('.tws-sp-copy-label');
		const original = label?.textContent;

		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url);
			} else {
				// Graceful fallback: create a temporary input, select + copy
				const tmp = document.createElement('input');
				tmp.value = url;
				tmp.style.position = 'absolute';
				tmp.style.opacity = '0';
				document.body.appendChild(tmp);
				tmp.select();
				document.execCommand('copy');
				document.body.removeChild(tmp);
			}

			if (label) {
				label.textContent = 'Copied!';
				btn.classList.add('tws-sp-copy--success');
				setTimeout(() => {
					label.textContent = original;
					btn.classList.remove('tws-sp-copy--success');
				}, 2200);
			}
		} catch {
			if (label) {
				label.textContent = 'Could not copy — try manually';
				setTimeout(() => { label.textContent = original; }, 2800);
			}
		}
	});

	return modal;
}

// ── Icon SVGs ──────────────────────────────────────────────────────────────

function linkIcon() {
	return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
}

function xIcon() {
	// X (formerly Twitter) logo
	return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.259 5.631zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;
}

function farcasterIcon() {
	return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.927 2C6.428 2 2 6.42 2 11.908s4.428 9.908 9.927 9.908c5.5 0 9.927-4.42 9.927-9.908C21.854 6.42 17.427 2 11.927 2zM8.5 7.5h7l.5 2h-1.5v5.5h-1.5V9.5h-1.5v5.5H10V9.5H8.5L8.5 7.5z"/></svg>`;
}

function sparkleIcon() {
	return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l2.4 7.2 7.6 0-6.2 4.4 2.4 7.4-6.2-4.4-6.2 4.4 2.4-7.4-6.2-4.4 7.6 0z"/></svg>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function ensureShareStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = SHARE_CSS;
	(document.head || document.documentElement).appendChild(style);
}

const SHARE_CSS = `
/* ── Share panel — tws-sp-* ─────────────────────────────────────────────── */

.tws-sp {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 4px 0 2px;
}

.tws-sp-desc {
	margin: 0 0 6px;
	font-size: 13px;
	color: var(--ink-dim, #888);
	line-height: 1.5;
}

/* OG/card preview — what the shared link unfurls as */
.tws-sp-preview {
	margin: 0 0 10px;
	border-radius: var(--radius-control, 10px);
	overflow: hidden;
	border: 1px solid var(--stroke, rgba(255,255,255,0.08));
	background: var(--surface-2, rgba(255,255,255,0.03));
	aspect-ratio: 1200 / 630;
}
.tws-sp-preview img {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.tws-sp-btn {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 16px;
	border-radius: var(--radius-control, 10px);
	font: 500 14px/1 var(--font-body, system-ui, sans-serif);
	cursor: pointer;
	text-decoration: none;
	border: 1px solid var(--stroke, rgba(255,255,255,0.08));
	background: var(--surface-2, rgba(255,255,255,0.04));
	color: var(--ink, #e8e8e8);
	transition: background 0.14s ease, border-color 0.14s ease, transform 0.1s ease;
	width: 100%;
	box-sizing: border-box;
}
.tws-sp-btn:hover {
	background: var(--surface-3, rgba(255,255,255,0.09));
	border-color: var(--stroke-strong, rgba(255,255,255,0.15));
}
.tws-sp-btn:active { transform: translateY(1px); }
.tws-sp-btn:focus-visible {
	outline: 2px solid rgba(255,255,255,0.35);
	outline-offset: 2px;
}

/* Copy button */
.tws-sp-copy--success {
	border-color: var(--accent, rgba(255,255,255,0.3)) !important;
	color: var(--ink, #e8e8e8);
}

/* Remix CTA — primary style */
.tws-sp-remix {
	background: var(--btn-primary-bg, rgba(255,255,255,0.9));
	color: var(--btn-primary-fg, #0a0a0f);
	border-color: transparent;
	margin-top: 4px;
	font-weight: 600;
}
.tws-sp-remix:hover {
	background: var(--btn-primary-bg-hover, rgba(255,255,255,0.85));
	color: var(--btn-primary-fg, #0a0a0f);
}
.tws-sp-remix svg { color: inherit; }

@media (max-width: 400px) {
	.tws-sp-btn { padding: 11px 12px; font-size: 13px; }
}
`;

if (typeof window !== 'undefined') {
	window.twsShare = { showSharePanel };
}
