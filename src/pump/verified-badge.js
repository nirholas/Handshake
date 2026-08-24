// The "Verified on pump.fun" badge.
//
// pump.fun verifies a project's coin as officially belonging to that project.
// Every three.ws surface that puts the $THREE header in front of a user should
// carry that badge, and all of them must carry the SAME one: a badge that says
// something different on the token page than on the dashboard is worth less
// than no badge at all. So the markup, the styles, and the render rule live
// here, and the surfaces import them.
//
// The render rule is deliberately strict: the badge appears only when the live
// stats payload reports `verified === true`. `/api/three-token/stats` reads
// that flag straight off pump.fun's public coin record on every (cached)
// request, so if pump.fun ever withdraws the badge, ours disappears with it.
// `false` (not verified) and `null` (upstream unreadable this request) both
// render nothing: silence is the only honest output for both.
//
// A surface renders it by importing `paintVerifiedBadge` and handing it a slot
// element plus the token block from the stats payload; styles inject themselves
// on first paint, so there is nothing else to wire.

const STYLE_ID = 'tws-pump-verified-badge';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
.pv-badge {
	display:inline-flex; align-items:center; gap:5px;
	font-size:11.5px; font-weight:700; letter-spacing:0.01em; line-height:1;
	color:#4ade80; background:rgba(74,222,128,.10);
	border:1px solid rgba(74,222,128,.28); border-radius:999px;
	padding:4px 10px 4px 7px; text-decoration:none; white-space:nowrap;
	opacity:0; transform:translateY(-2px);
	transition:opacity .22s ease, transform .22s ease, background .15s, border-color .15s;
}
.pv-badge.is-on { opacity:1; transform:none; }
.pv-badge:hover { background:rgba(74,222,128,.17); border-color:rgba(74,222,128,.5); }
.pv-badge:focus-visible { outline:2px solid #4ade80; outline-offset:2px; }
.pv-badge svg { width:13px; height:13px; display:block; flex-shrink:0; }
@media (prefers-reduced-motion: reduce) { .pv-badge { transition:none; } }
`;

/** Inject the badge stylesheet once. Idempotent and SSR-safe. */
export function ensureVerifiedBadgeStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CSS;
	(document.head || document.documentElement).appendChild(style);
}

/**
 * Badge markup for a `/api/three-token/stats` token block, or '' when the token
 * is not currently verified (or verification could not be read).
 *
 * @param {{ verified?: boolean|null, pump_url?: string|null, mint?: string|null }|null} token
 * @param {{ label?: string }} [opts]
 * @returns {string} HTML, or '' to render nothing.
 */
export function verifiedBadgeHTML(token, opts = {}) {
	if (token?.verified !== true) return '';
	const href = token.pump_url || (token.mint ? `https://pump.fun/coin/${encodeURIComponent(token.mint)}` : 'https://pump.fun');
	const label = opts.label || 'Verified on pump.fun';
	return `<a class="pv-badge" href="${esc(href)}" target="_blank" rel="noopener" title="pump.fun has verified this as the official three.ws token">`
		+ `<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 1.5l2.1 1.6 2.6-.2.8 2.5 2.2 1.4-1 2.4 1 2.4-2.2 1.4-.8 2.5-2.6-.2L10 18.5l-2.1-1.6-2.6.2-.8-2.5-2.2-1.4 1-2.4-1-2.4 2.2-1.4.8-2.5 2.6.2L10 1.5zm-.9 11.6l4.6-4.6-1.3-1.3-3.3 3.3-1.5-1.5-1.3 1.3 2.8 2.8z"/></svg>`
		+ `${esc(label)}</a>`;
}

/**
 * Render the badge into a slot element, fading it in on the snapshot that first
 * carries verification. Re-rendering with the same token is a no-op, so a 30s
 * stats poll never restarts the animation.
 *
 * @param {Element|null} slot
 * @param {object|null} token
 * @param {{ label?: string }} [opts]
 */
export function paintVerifiedBadge(slot, token, opts = {}) {
	if (!slot) return;
	ensureVerifiedBadgeStyles();
	const html = verifiedBadgeHTML(token, opts);
	if (slot.innerHTML === html) return;
	slot.innerHTML = html;
	const badge = slot.firstElementChild;
	if (!badge) return;
	if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => badge.classList.add('is-on'));
	else badge.classList.add('is-on');
}
