/**
 * The confirmation card: the one place a person says yes to a physical action.
 *
 * When the agent asks to unlock a door, open a garage, or disarm an alarm, the
 * server does not do it. It freezes the action, mints a confirmation, and hands
 * the browser a `home_tool` event with `status: 'pending_confirmation'`. This
 * module renders that as a card with the sentence the SERVER composed, a live
 * countdown, and one button.
 *
 * Three product decisions live in here, and each one is deliberate:
 *
 *   1. **The card shows the server's sentence, never the model's.** The summary
 *      comes from the confirmation record, which was composed from the resolved
 *      entities before any of this reached a browser. A model that has been
 *      talked into something cannot change what the person is asked.
 *   2. **The button sends an id and nothing else.** The action is already frozen
 *      server-side. There is no form here, because there is nothing about the
 *      action for a client to decide.
 *   3. **The countdown is real.** Ninety seconds is the whole lifetime of a
 *      confirmation, and a card that silently goes dead is worse than one that
 *      says so. At zero the card retires itself and tells the person to ask
 *      again.
 *
 * Usage from any chat surface:
 *
 *   import { renderHomeConfirmation } from './home-confirm-card.js';
 *   if (evt.type === 'home_tool' && evt.status === 'pending_confirmation') {
 *     renderHomeConfirmation(logEl, evt.data, { onResolved: (r) => … });
 *   }
 */

let stylesInjected = false;

/**
 * Mount a confirmation card.
 *
 * @param {HTMLElement} container where to append it
 * @param {object} payload the `data` of a `home_tool` SSE event
 * @param {{ onResolved?: (result: object) => void }} [options]
 * @returns {HTMLElement|null} the card, or null when the payload is not pending
 */
export function renderHomeConfirmation(container, payload, options = {}) {
	const pending = payload?.confirmation;
	const homeId = payload?.home?.id;
	if (!container || !pending?.id || !homeId) return null;

	injectStyles();

	const card = document.createElement('div');
	card.className = 'home-confirm';
	card.setAttribute('role', 'group');
	card.setAttribute('aria-label', 'Home action awaiting your approval');

	const risk = pending.risk === 'security' ? 'Security' : 'Physical';
	card.innerHTML = `
		<div class="home-confirm-head">
			<span class="home-confirm-badge" data-risk="${escapeAttr(pending.risk || 'physical')}">${escapeHtml(risk)}</span>
			<span class="home-confirm-title">Needs your approval</span>
			<span class="home-confirm-clock" aria-live="off"></span>
		</div>
		<p class="home-confirm-summary"></p>
		<ul class="home-confirm-entities"></ul>
		<div class="home-confirm-actions">
			<button type="button" class="home-confirm-yes">Yes, ${escapeHtml(verbOf(pending))}</button>
			<button type="button" class="home-confirm-no">Not now</button>
		</div>
		<p class="home-confirm-status" role="status" aria-live="polite"></p>
	`;

	// textContent, not innerHTML: the summary is server-composed but it embeds
	// device names, and a device name is a string a stranger can write.
	card.querySelector('.home-confirm-summary').textContent = pending.summary || 'This will change something in your home.';

	const list = card.querySelector('.home-confirm-entities');
	for (const entity of pending.entities || []) {
		const li = document.createElement('li');
		li.textContent = entity.name || entity.entity_id;
		li.title = entity.entity_id;
		list.appendChild(li);
	}
	if (!list.childElementCount) list.remove();

	const clock = card.querySelector('.home-confirm-clock');
	const status = card.querySelector('.home-confirm-status');
	const yes = card.querySelector('.home-confirm-yes');
	const no = card.querySelector('.home-confirm-no');

	const expiresAt = pending.expires_at ? Date.parse(pending.expires_at) : Date.now() + (pending.expires_in_seconds || 90) * 1000;
	let timer = null;

	function retire(message, tone) {
		if (timer) clearInterval(timer);
		timer = null;
		yes.disabled = true;
		no.disabled = true;
		clock.textContent = '';
		card.dataset.state = tone;
		status.textContent = message;
	}

	function tick() {
		const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
		clock.textContent = `${left}s`;
		card.classList.toggle('is-urgent', left <= 15);
		if (left === 0) retire('This expired. Ask again if you still want it.', 'expired');
	}
	tick();
	timer = setInterval(tick, 1000);

	no.addEventListener('click', () => {
		retire('Left alone. Nothing changed in your home.', 'declined');
		options.onResolved?.({ ok: false, declined: true, confirmation_id: pending.id });
	});

	yes.addEventListener('click', async () => {
		yes.disabled = true;
		no.disabled = true;
		status.textContent = 'Sending…';
		try {
			const result = await approveHomeConfirmation(homeId, pending.id);
			retire(result.message, result.ok ? 'done' : 'failed');
			options.onResolved?.(result);
		} catch (err) {
			retire(err.message || 'Could not reach three.ws.', 'failed');
			options.onResolved?.({ ok: false, message: err.message });
		}
	});

	container.appendChild(card);
	if (typeof container.scrollTo === 'function') container.scrollTop = container.scrollHeight;
	return card;
}

/**
 * Redeem a confirmation. Session cookie plus a one-time CSRF token, which is the
 * only credential this endpoint accepts: a bearer token, including one holding
 * `home:act`, is refused server-side by design.
 *
 * @param {string} homeId
 * @param {string} confirmationId
 * @returns {Promise<{ ok: boolean, message: string, ran?: string }>}
 */
export async function approveHomeConfirmation(homeId, confirmationId) {
	const csrf = await fetchCsrfToken();
	const res = await fetch(`/api/home/${encodeURIComponent(homeId)}/confirm`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
		body: JSON.stringify({ confirmation_id: confirmationId }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		return {
			ok: false,
			message: body.error_description || body.message || `That did not go through (${res.status}).`,
			code: body.error || null,
		};
	}
	return { ok: true, message: 'Done.', ran: body.ran, confirmation_id: confirmationId };
}

async function fetchCsrfToken() {
	try {
		const res = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!res.ok) return null;
		const body = await res.json();
		return body.data?.token || body.token || null;
	} catch {
		return null;
	}
}

function verbOf(pending) {
	const service = String(pending.service || '');
	if (service.includes('unlock')) return 'unlock';
	if (service.includes('disarm')) return 'disarm';
	if (service.includes('open')) return 'open';
	if (service.includes('position')) return 'move it';
	return 'do it';
}

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function escapeAttr(value) {
	return escapeHtml(value).replace(/\s+/g, '-');
}

function injectStyles() {
	if (stylesInjected || typeof document === 'undefined') return;
	stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'home-confirm-styles';
	style.textContent = `
.home-confirm {
	border: 1px solid var(--color-border-strong, rgba(255,255,255,.22));
	border-left: 3px solid var(--color-warning, #f5a524);
	border-radius: var(--radius-md, 10px);
	background: var(--color-surface, rgba(255,255,255,.04));
	padding: var(--space-md, 1rem);
	margin: var(--space-sm, .618rem) 0;
	display: grid;
	gap: var(--space-xs, .382rem);
	max-width: 100%;
	animation: home-confirm-in .22s ease-out;
}
@media (prefers-reduced-motion: reduce) { .home-confirm { animation: none; } }
@keyframes home-confirm-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.home-confirm[data-state="done"] { border-left-color: var(--color-success, #2ecc71); }
.home-confirm[data-state="failed"] { border-left-color: var(--color-danger, #ff5c5c); }
.home-confirm[data-state="expired"], .home-confirm[data-state="declined"] { border-left-color: var(--color-border, rgba(255,255,255,.18)); opacity: .72; }
.home-confirm-head { display: flex; align-items: center; gap: var(--space-xs, .382rem); }
.home-confirm-badge {
	font-size: var(--text-2xs, .6875rem);
	text-transform: uppercase;
	letter-spacing: .06em;
	padding: 2px 7px;
	border-radius: var(--radius-pill, 999px);
	background: color-mix(in srgb, var(--color-warning, #f5a524) 20%, transparent);
	color: var(--color-warning, #f5a524);
}
.home-confirm-badge[data-risk="security"] { background: color-mix(in srgb, var(--color-danger, #ff5c5c) 18%, transparent); color: var(--color-danger, #ff5c5c); }
.home-confirm-title { font-size: var(--text-md, .8125rem); font-weight: var(--weight-semibold, 600); color: var(--color-text-bright, #fff); }
.home-confirm-clock { margin-left: auto; font-variant-numeric: tabular-nums; font-size: var(--text-sm, .764rem); color: var(--color-text-dim, rgba(255,255,255,.6)); }
.home-confirm.is-urgent .home-confirm-clock { color: var(--color-danger, #ff5c5c); }
.home-confirm-summary { margin: 0; font-size: var(--text-ui, .875rem); line-height: var(--leading-normal, 1.618); color: var(--color-text, rgba(255,255,255,.86)); }
.home-confirm-entities { margin: 0; padding-left: 1.1em; font-size: var(--text-sm, .764rem); color: var(--color-text-dim, rgba(255,255,255,.6)); }
.home-confirm-actions { display: flex; flex-wrap: wrap; gap: var(--space-xs, .382rem); margin-top: var(--space-2xs, .236rem); }
.home-confirm-actions button {
	font: inherit;
	font-size: var(--text-md, .8125rem);
	padding: .45em 1em;
	border-radius: var(--radius-sm, 6px);
	border: 1px solid var(--color-border, rgba(255,255,255,.18));
	background: transparent;
	color: var(--color-text, rgba(255,255,255,.86));
	cursor: pointer;
	transition: background .15s ease, border-color .15s ease, transform .1s ease;
}
.home-confirm-yes { background: var(--color-accent, #4f8cff); border-color: transparent; color: #05070d; font-weight: var(--weight-semibold, 600); }
.home-confirm-actions button:hover:not(:disabled) { transform: translateY(-1px); }
.home-confirm-no:hover:not(:disabled) { background: var(--color-surface-2, rgba(255,255,255,.08)); border-color: var(--color-border-strong, rgba(255,255,255,.28)); }
.home-confirm-actions button:active:not(:disabled) { transform: translateY(0); }
.home-confirm-actions button:focus-visible { outline: 2px solid var(--color-accent, #4f8cff); outline-offset: 2px; }
.home-confirm-actions button:disabled { opacity: .5; cursor: default; }
.home-confirm-status:empty { display: none; }
.home-confirm-status { margin: 0; font-size: var(--text-sm, .764rem); color: var(--color-text-dim, rgba(255,255,255,.6)); }
`;
	document.head.appendChild(style);
}
