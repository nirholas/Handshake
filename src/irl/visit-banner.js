/**
 * "You're here to meet …" banner for /irl?pin=<id> visitors.
 *
 * Someone who scanned a sign at a real spot arrives with one intent: see the
 * agent that lives here. Until the presence-gated nearby read returns that pin,
 * the page would otherwise look identical to an empty street, so this banner
 * names the agent they came for (from the public, coordinate-free agent card),
 * tells them how close they need to be, and steps aside the moment the agent
 * appears. Self-styled and self-fetching so src/irl.js only wires state changes.
 *
 * States: loading → searching | no-gps | gone, then found (auto-retires).
 */

import { meetBannerCopy } from './visit-link.js';

const FOUND_LINGER_MS = 5200;
const STYLE_ID = 'irl-visit-banner-styles';

const CSS = `
.irl-visit {
	position: fixed; left: 50%; top: calc(env(safe-area-inset-top, 0px) + 66px);
	transform: translate(-50%, -8px);
	z-index: 12; width: min(440px, calc(100vw - 24px));
	display: flex; align-items: center; gap: 12px;
	padding: 10px 12px 10px 10px;
	background: linear-gradient(180deg, rgba(17,21,31,0.94), rgba(11,14,21,0.96));
	border: 1px solid rgba(125,211,252,0.28);
	border-radius: 16px;
	box-shadow: 0 14px 40px rgba(0,0,0,0.5);
	color: #eef2f8;
	font: 500 13px/1.4 var(--font-body, system-ui, sans-serif);
	opacity: 0; pointer-events: none;
	transition: opacity .28s ease, transform .32s cubic-bezier(.22,.61,.36,1);
}
.irl-visit.is-visible { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
.irl-visit[hidden] { display: none; }
.irl-visit.is-found { border-color: rgba(52,211,153,0.45); }
.irl-visit.is-gone { border-color: rgba(255,176,32,0.4); }
.irl-visit-thumb {
	width: 44px; height: 44px; flex: 0 0 44px; border-radius: 12px;
	background: rgba(125,211,252,0.12); overflow: hidden;
	display: grid; place-items: center; font-size: 20px;
}
.irl-visit-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.irl-visit-thumb.is-loading { animation: irl-visit-shimmer 1.2s ease-in-out infinite; }
@keyframes irl-visit-shimmer { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
.irl-visit-text { flex: 1 1 auto; min-width: 0; }
.irl-visit-title { margin: 0; font-weight: 700; font-size: 14px; letter-spacing: -.01em; color: #f4f7fb; }
.irl-visit-body { margin: 2px 0 0; color: #a7b3c6; }
.irl-visit-cta {
	margin-top: 6px; display: inline-flex; align-items: center; min-height: 30px; padding: 0 10px;
	border-radius: 999px; border: 1px solid rgba(125,211,252,0.4);
	background: rgba(125,211,252,0.12); color: #bfe6ff;
	font: 600 12px/1 var(--font-body, system-ui, sans-serif); cursor: pointer;
	transition: background .15s ease, transform .1s ease;
}
.irl-visit-cta:hover { background: rgba(125,211,252,0.2); }
.irl-visit-cta:active { transform: scale(.97); }
.irl-visit-cta:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
.irl-visit-close {
	flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%;
	border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06);
	color: #cbd5e1; font-size: 16px; line-height: 1; cursor: pointer;
	display: grid; place-items: center;
	transition: background .15s ease;
}
.irl-visit-close:hover { background: rgba(255,255,255,0.14); }
.irl-visit-close:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
	.irl-visit { transition: opacity .15s ease; transform: translate(-50%, 0); }
	.irl-visit-thumb.is-loading { animation: none; }
}
`;

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = CSS;
	document.head.appendChild(s);
}

/**
 * Mount the banner for one pin. Resolves the agent's public card itself; the
 * caller drives `setState()` from GPS + nearby events and `destroy()` on teardown.
 *
 * @param {{ pinId: string, onPlace?: () => void }} opts
 */
export function mountVisitBanner({ pinId, onPlace } = {}) {
	if (!pinId || typeof document === 'undefined') return null;
	ensureStyles();

	const el = document.createElement('aside');
	el.className = 'irl-visit';
	el.setAttribute('role', 'status');
	el.setAttribute('aria-live', 'polite');
	el.innerHTML =
		`<div class="irl-visit-thumb is-loading" aria-hidden="true">✦</div>` +
		`<div class="irl-visit-text"><p class="irl-visit-title"></p><p class="irl-visit-body"></p></div>` +
		`<button type="button" class="irl-visit-close" aria-label="Dismiss">×</button>`;
	document.body.appendChild(el);

	const thumb = el.querySelector('.irl-visit-thumb');
	const title = el.querySelector('.irl-visit-title');
	const body  = el.querySelector('.irl-visit-body');
	let name = '';
	let state = 'loading';
	let dismissed = false;
	let retireTimer = null;

	const show = () => {
		if (dismissed) return;
		el.hidden = false;
		requestAnimationFrame(() => el.classList.add('is-visible'));
	};
	const hide = () => {
		el.classList.remove('is-visible');
		setTimeout(() => { if (!el.classList.contains('is-visible')) el.hidden = true; }, 320);
	};

	function render() {
		const copy = meetBannerCopy({ name, state: state === 'loading' ? 'searching' : state });
		title.textContent = copy.title;
		body.textContent = copy.body;
		el.classList.toggle('is-found', state === 'found');
		el.classList.toggle('is-gone', state === 'gone');
		const old = el.querySelector('.irl-visit-cta');
		if (old) old.remove();
		if (state === 'gone' && typeof onPlace === 'function') {
			const cta = document.createElement('button');
			cta.type = 'button';
			cta.className = 'irl-visit-cta';
			cta.textContent = 'Place an agent here';
			cta.addEventListener('click', () => { hide(); onPlace(); });
			body.after(cta);
		}
	}

	function setState(next) {
		if (state === 'gone' && next !== 'gone') return;
		if (state === 'found' && next === 'searching') return;
		if (state === next) return;
		state = next;
		render();
		if (next === 'found') {
			show();
			clearTimeout(retireTimer);
			retireTimer = setTimeout(hide, FOUND_LINGER_MS);
		} else {
			show();
		}
	}

	el.querySelector('.irl-visit-close').addEventListener('click', () => { dismissed = true; hide(); });

	render();
	show();

	// Public card only: name, bio, thumbnail. Never a coordinate; a 404 means the
	// pin expired or was removed, which is the one state the visitor must be told.
	fetch(`/api/irl/agent-card?pin=${encodeURIComponent(pinId)}`)
		.then(async (r) => {
			if (r.status === 404) { setState('gone'); return; }
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const { card } = await r.json();
			name = card?.agent?.name || '';
			const src = card?.agent?.thumbnail_url;
			if (src) {
				const img = document.createElement('img');
				img.alt = '';
				img.decoding = 'async';
				img.src = src;
				img.addEventListener('error', () => { img.remove(); thumb.textContent = '✦'; });
				thumb.textContent = '';
				thumb.appendChild(img);
			}
			thumb.classList.remove('is-loading');
			render();
		})
		.catch(() => {
			// Card unreachable: keep the neutral copy, the walk-up still works.
			thumb.classList.remove('is-loading');
			render();
		});

	return {
		setState,
		get state() { return state; },
		destroy() { clearTimeout(retireTimer); el.remove(); },
	};
}
