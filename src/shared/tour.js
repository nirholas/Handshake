/**
 * three.ws tour engine — reusable guided spotlight/coachmark system
 *
 * API:
 *   startTour(steps, options) → Promise<'completed' | 'skipped'>
 *
 * steps: Array<{
 *   target:    string | (() => Element | null),  // CSS selector or function
 *   title:     string,
 *   body:      string,
 *   placement: 'auto' | 'above' | 'below',       // default 'auto'
 *   action?:   (el: Element) => void,             // called after spotlight
 * }>
 *
 * options: {
 *   id:         string,                           // namespaced key for persistence
 *   sync:       boolean,                          // server-persist, default true
 *   onComplete: () => void,
 *   onSkip:     () => void,
 * }
 *
 * Persistence:
 *   - localStorage key: `tour:${id}:done`
 *   - When signed in, syncs to /api/dashboard/prefs (PATCH tours.${id} = true)
 *   - Pass `sync: false` on public, signed-out surfaces: the prefs endpoint
 *     needs a session, so the sync would only ever 401 there
 *   - isTourDone(id) checks both localStorage and prefs cache
 *
 * Accessibility:
 *   - ARIA live region announces each step
 *   - role="dialog" + aria-modal="false" on bubble
 *   - focus moves to primary action button each step
 *   - Escape → skip; ←/→ arrows navigate
 *   - Backdrop click → skip
 */

const PREFS_URL = '/api/dashboard/prefs';
const _prefsCacheKey = 'tour:prefs:cache';
const _prefsCache = (() => {
	try { return JSON.parse(localStorage.getItem(_prefsCacheKey) || '{}'); } catch { return {}; }
})();

function _savePrefsCache() {
	try { localStorage.setItem(_prefsCacheKey, JSON.stringify(_prefsCache)); } catch {}
}

function _lsKey(id) { return `tour:${id}:done`; }

export function isTourDone(id) {
	if (localStorage.getItem(_lsKey(id))) return true;
	return !!_prefsCache.tours?.[id];
}

/**
 * Record a tour as completed.
 *
 * @param {string} id
 * @param {{ sync?: boolean }} [opts] `sync: false` keeps the record local only.
 *   /api/dashboard/prefs requires a session, so on a public page (the docs
 *   world, any signed-out marketing surface) the sync answers 401 and the
 *   browser logs a console error for a request that was never going to work.
 *   Authed surfaces leave it on and keep cross-device persistence.
 */
export function markTourDone(id, { sync = true } = {}) {
	localStorage.setItem(_lsKey(id), '1');
	if (!sync) return;
	// Best-effort server sync
	fetch(PREFS_URL, {
		method: 'PATCH',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ prefs: { tours: { ..._prefsCache.tours, [id]: true } } }),
	}).then(r => {
		if (r.ok) {
			_prefsCache.tours = { ..._prefsCache.tours, [id]: true };
			_savePrefsCache();
		}
	}).catch(() => {});
}

// Pull latest prefs from server into local cache (called on page load if desired)
export function syncTourPrefs() {
	fetch(PREFS_URL, { credentials: 'include' })
		.then(r => r.ok ? r.json() : null)
		.then(data => {
			if (data?.prefs?.tours) {
				_prefsCache.tours = { ..._prefsCache.tours, ...data.prefs.tours };
				_savePrefsCache();
				// Mark any server-done tours done in localStorage too
				for (const [id, done] of Object.entries(data.prefs.tours)) {
					if (done) localStorage.setItem(_lsKey(id), '1');
				}
			}
		})
		.catch(() => {});
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function waitFor(selector, ms = 2000) {
	return new Promise(resolve => {
		const el = document.querySelector(selector);
		if (el) { resolve(el); return; }
		const obs = new MutationObserver(() => {
			const found = document.querySelector(selector);
			if (found) { obs.disconnect(); resolve(found); }
		});
		obs.observe(document.body, { childList: true, subtree: true });
		setTimeout(() => { obs.disconnect(); resolve(null); }, ms);
	});
}

const SPOT_PAD = 8;

function positionBubble(bubble, targetRect, placement) {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const bw = Math.min(300, vw - 32);
	bubble.style.width = `${bw}px`;

	// Horizontal centering over target
	const left = Math.max(16, Math.min(targetRect.left + targetRect.width / 2 - bw / 2, vw - bw - 16));
	bubble.style.left = `${left}px`;

	const spaceBelow = vh - targetRect.bottom;
	const spaceAbove = targetRect.top;
	const goBelow = placement === 'below' || (placement !== 'above' && spaceBelow >= 160) || spaceAbove < 160;

	if (goBelow) {
		bubble.style.top = `${targetRect.bottom + SPOT_PAD + 6}px`;
		bubble.style.bottom = '';
	} else {
		bubble.style.top = '';
		bubble.style.bottom = `${vh - targetRect.top + SPOT_PAD + 6}px`;
	}
}

function injectStyles() {
	if (document.getElementById('tour-engine-css')) return;
	const style = document.createElement('style');
	style.id = 'tour-engine-css';
	style.textContent = `
.tour-overlay {
	position: fixed; inset: 0; z-index: 10000;
	background: rgba(0,0,0,0.55);
	pointer-events: all;
}
.tour-spotlight {
	position: fixed; z-index: 10001;
	border-radius: 8px;
	box-shadow: 0 0 0 9999px rgba(0,0,0,0.55), 0 0 0 2px rgba(255,255,255,0.18);
	pointer-events: none;
	transition: top .22s, left .22s, width .22s, height .22s;
}
.tour-bubble {
	position: fixed; z-index: 10002;
	background: var(--panel, #18181b);
	border: 1px solid var(--border, rgba(255,255,255,0.1));
	border-radius: 12px;
	padding: 16px;
	box-shadow: 0 8px 32px rgba(0,0,0,0.45);
	pointer-events: all;
	animation: tourFadeIn .18s ease;
}
@keyframes tourFadeIn { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:none } }
.tour-meta {
	font-size: 11px;
	color: var(--ink-dim, rgba(255,255,255,0.4));
	margin-bottom: 4px;
	font-weight: 600;
	letter-spacing: .04em;
	text-transform: uppercase;
}
.tour-title {
	font-size: 15px;
	font-weight: 700;
	color: var(--text, #fff);
	margin-bottom: 6px;
	line-height: 1.3;
}
.tour-body {
	font-size: 13px;
	color: var(--ink-dim, rgba(255,255,255,0.65));
	margin: 0 0 14px;
	line-height: 1.5;
}
.tour-nav {
	display: flex;
	align-items: center;
	gap: 8px;
}
.tour-skip {
	font-size: 12px;
	color: var(--ink-dim, rgba(255,255,255,0.45));
	background: none;
	border: none;
	padding: 4px 0;
	cursor: pointer;
	margin-right: auto;
}
.tour-skip:hover { color: var(--text, #fff); }
.tour-btn-ghost {
	font-size: 13px;
	padding: 6px 12px;
	background: var(--panel-2, rgba(255,255,255,0.06));
	border: 1px solid var(--border, rgba(255,255,255,0.1));
	border-radius: 6px;
	color: var(--text, #fff);
	cursor: pointer;
	transition: background .15s;
}
.tour-btn-ghost:hover { background: var(--panel-3, rgba(255,255,255,0.12)); }
.tour-btn-primary {
	font-size: 13px;
	padding: 6px 14px;
	background: var(--accent, #6366f1);
	border: none;
	border-radius: 6px;
	color: #fff;
	font-weight: 600;
	cursor: pointer;
	transition: background .15s;
}
.tour-btn-primary:hover { background: var(--accent-hi, #818cf8); }
.tour-sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
[data-tour-target] { position: relative; z-index: 10001; border-radius: 6px; outline: 2px solid rgba(99,102,241,0.6); outline-offset: 3px; }
`;
	document.head.appendChild(style);
}

/**
 * @param {Array} steps
 * @param {{ id?: string, sync?: boolean, onComplete?: Function, onSkip?: Function }} [options]
 *   `sync` is forwarded to markTourDone; see there for when to turn it off.
 */
export function startTour(steps, { id, sync = true, onComplete, onSkip } = {}) {
	if (id && isTourDone(id)) return Promise.resolve('completed');

	injectStyles();

	return new Promise(resolve => {
		const overlay = document.createElement('div');
		overlay.className = 'tour-overlay';
		overlay.setAttribute('aria-hidden', 'true');

		const spotlight = document.createElement('div');
		spotlight.className = 'tour-spotlight';
		spotlight.setAttribute('aria-hidden', 'true');

		const bubble = document.createElement('div');
		bubble.className = 'tour-bubble';
		bubble.setAttribute('role', 'dialog');
		bubble.setAttribute('aria-modal', 'false');
		bubble.setAttribute('aria-label', 'Guided tour');
		bubble.setAttribute('tabindex', '-1');

		const sr = document.createElement('div');
		sr.className = 'tour-sr-only';
		sr.setAttribute('aria-live', 'polite');
		sr.setAttribute('aria-atomic', 'true');

		document.body.append(overlay, spotlight, bubble, sr);

		let idx = 0;
		let activeEl = null;
		let resizeObs = null;

		function cleanup() {
			overlay.remove();
			spotlight.remove();
			bubble.remove();
			sr.remove();
			if (activeEl) activeEl.removeAttribute('data-tour-target');
			document.removeEventListener('keydown', onKey);
			resizeObs?.disconnect();
		}

		function finish(outcome) {
			cleanup();
			if (outcome === 'completed') {
				if (id) markTourDone(id, { sync });
				onComplete?.();
			} else {
				onSkip?.();
			}
			resolve(outcome);
		}

		function updateSpotlight(el) {
			const rect = el.getBoundingClientRect();
			spotlight.style.top = `${rect.top - SPOT_PAD}px`;
			spotlight.style.left = `${rect.left - SPOT_PAD}px`;
			spotlight.style.width = `${rect.width + SPOT_PAD * 2}px`;
			spotlight.style.height = `${rect.height + SPOT_PAD * 2}px`;
		}

		async function goTo(i) {
			if (i >= steps.length) { finish('completed'); return; }

			const step = steps[i];
			idx = i;

			// Clear previous target
			if (activeEl) { activeEl.removeAttribute('data-tour-target'); activeEl = null; }

			// Resolve element
			let el = null;
			if (typeof step.target === 'function') {
				el = step.target();
			} else if (typeof step.target === 'string') {
				el = document.querySelector(step.target);
				if (!el) el = await waitFor(step.target, 2500);
			}
			if (!el) { goTo(i + 1); return; } // skip missing elements

			activeEl = el;
			el.setAttribute('data-tour-target', '');
			el.scrollIntoView({ block: 'nearest', inline: 'nearest' });

			updateSpotlight(el);

			// Track resize
			resizeObs?.disconnect();
			resizeObs = new ResizeObserver(() => { if (activeEl) updateSpotlight(activeEl); });
			resizeObs.observe(el);

			step.action?.(el);

			// Render bubble
			const isFirst = i === 0;
			const isLast = i === steps.length - 1;
			bubble.innerHTML = `
				<div class="tour-meta">${i + 1} / ${steps.length}</div>
				<div class="tour-title">${esc(step.title)}</div>
				<p class="tour-body">${esc(step.body)}</p>
				<div class="tour-nav">
					<button class="tour-skip" type="button" data-action="skip">Skip</button>
					${!isFirst ? `<button class="tour-btn-ghost" type="button" data-action="back">← Back</button>` : ''}
					<button class="tour-btn-primary" type="button" data-action="next">${isLast ? 'Done ✓' : 'Next →'}</button>
				</div>
			`;

			const rect = el.getBoundingClientRect();
			positionBubble(bubble, rect, step.placement || 'auto');

			sr.textContent = `Step ${i + 1} of ${steps.length}: ${step.title}. ${step.body}`;

			bubble.querySelector('[data-action="next"]').addEventListener('click', () => goTo(i + 1));
			bubble.querySelector('[data-action="skip"]').addEventListener('click', () => finish('skipped'));
			bubble.querySelector('[data-action="back"]')?.addEventListener('click', () => goTo(i - 1));

			bubble.querySelector('[data-action="next"]').focus();
		}

		function onKey(e) {
			if (e.key === 'Escape') { finish('skipped'); return; }
			if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goTo(idx + 1); }
			if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && idx > 0) { e.preventDefault(); goTo(idx - 1); }
		}

		// Clicking the dark overlay skips the tour
		overlay.addEventListener('click', () => finish('skipped'));

		document.addEventListener('keydown', onKey);
		window.addEventListener('resize', () => { if (activeEl) updateSpotlight(activeEl); }, { passive: true });

		goTo(0);
	});
}
