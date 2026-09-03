/**
 * Alpha-drip editor: a leader prices the latency of their own signal.
 *
 * Mounted on the copy dashboard for every agent the signed-in user owns that
 * someone is actually copying. The leader sets how long each $THREE tier waits
 * before the copy intent is revealed to them; higher tiers can never wait
 * longer, and the public delay is always the longest.
 *
 * The server is the authority on every rule here (api/_lib/alpha-drip.js). This
 * form mirrors them so the leader is told immediately rather than after a
 * round trip, and it never invents a rule the server does not enforce.
 *
 * Import and call `mountAlphaDripPanel(el)`.
 */

import { escapeHtml } from './trader-format.js';

const $ = (sel, root) => root.querySelector(sel);
const $$ = (sel, root) => Array.from(root.querySelectorAll(sel));

const STYLE_ID = 'alpha-drip-styles';
const STYLE = `
.ad-lead { border: 1px solid var(--nxt-stroke, #23262e); border-radius: 10px; padding: 14px; margin-bottom: 12px; background: var(--nxt-bg-2, #14161b); }
.ad-lead:last-child { margin-bottom: 0; }
.ad-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ad-name { font-weight: 600; font-size: 14px; }
.ad-copiers { font-size: 12px; color: var(--nxt-ink-dim, #8b90a0); font-variant-numeric: tabular-nums; }
.ad-summary { font-size: 12.5px; color: var(--nxt-ink-dim, #8b90a0); margin: 6px 0 0; }
.ad-modes { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
.ad-mode { font-size: 12px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--nxt-stroke, #23262e); background: transparent; color: var(--nxt-ink, #e7e9ee); cursor: pointer; transition: border-color .14s ease, background .14s ease, transform .14s ease; }
.ad-mode:hover { border-color: var(--nxt-stroke-strong, #3a3f4b); transform: translateY(-1px); }
.ad-mode:focus-visible { outline: 2px solid var(--nxt-accent, #63e6be); outline-offset: 2px; }
.ad-mode[aria-pressed="true"] { background: var(--nxt-accent, #63e6be); color: #061018; border-color: transparent; }
.ad-grid { display: grid; gap: 8px; margin: 12px 0; }
.ad-row { display: grid; grid-template-columns: minmax(96px, 1.1fr) minmax(84px, 1fr) minmax(84px, 1fr); gap: 8px; align-items: center; }
.ad-row-h { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--nxt-ink-dim, #8b90a0); }
.ad-tier { font-size: 13px; display: flex; flex-direction: column; gap: 1px; }
.ad-tier small { font-size: 11px; color: var(--nxt-ink-dim, #8b90a0); }
.ad-lead input[type="number"], .ad-lead textarea { width: 100%; font: inherit; font-size: 13px; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--nxt-stroke, #23262e); background: var(--nxt-bg, #0d0f13); color: var(--nxt-ink, #e7e9ee); transition: border-color .14s ease; }
.ad-lead input[type="number"]:hover, .ad-lead textarea:hover { border-color: var(--nxt-stroke-strong, #3a3f4b); }
.ad-lead input[type="number"]:focus-visible, .ad-lead textarea:focus-visible { outline: 2px solid var(--nxt-accent, #63e6be); outline-offset: 1px; border-color: transparent; }
.ad-lead textarea { resize: vertical; min-height: 58px; }
.ad-field { margin: 10px 0; }
.ad-field label { display: block; font-size: 12px; color: var(--nxt-ink-dim, #8b90a0); margin-bottom: 4px; }
.ad-note { font-size: 12px; color: var(--nxt-ink-dim, #8b90a0); margin: 8px 0 0; line-height: 1.5; }
.ad-warn { font-size: 12px; color: var(--nxt-warn, #f59e0b); margin: 8px 0 0; line-height: 1.5; }
.ad-err { font-size: 12px; color: var(--nxt-danger, #f87171); margin: 8px 0 0; }
.ad-ok { font-size: 12px; color: var(--nxt-success, #4ade80); margin: 8px 0 0; }
.ad-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.ad-btn { font-size: 12px; padding: 6px 14px; border-radius: 7px; border: 1px solid var(--nxt-stroke, #23262e); background: var(--nxt-bg-2, #14161b); color: var(--nxt-ink, #e7e9ee); cursor: pointer; transition: border-color .14s ease, transform .14s ease, opacity .14s ease; }
.ad-btn:hover:not(:disabled) { border-color: var(--nxt-stroke-strong, #3a3f4b); transform: translateY(-1px); }
.ad-btn:focus-visible { outline: 2px solid var(--nxt-accent, #63e6be); outline-offset: 2px; }
.ad-btn:disabled { opacity: .55; cursor: progress; }
.ad-btn.primary { background: var(--nxt-accent, #63e6be); color: #061018; border-color: transparent; }
.ad-sk { height: 74px; border-radius: 10px; background: var(--nxt-bg-2, #14161b); animation: ad-pulse 1.4s ease infinite; }
@keyframes ad-pulse { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }
.ad-fold { transition: opacity .16s ease; }
.ad-fold[hidden] { display: none; }
@media (max-width: 560px) {
	.ad-row { grid-template-columns: 1fr 1fr; }
	.ad-row .ad-tier { grid-column: 1 / -1; }
}
@media (prefers-reduced-motion: reduce) {
	.ad-btn, .ad-mode, .ad-lead input, .ad-lead textarea, .ad-fold { transition: none; }
	.ad-sk { animation: none; }
}`;

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

// A CSRF token is single-use (the server burns it on first use and returns it
// as { data: { token } }), so it is fetched per mutation and never cached.
async function csrfToken() {
	try {
		const r = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!r.ok) return null;
		const j = await r.json().catch(() => null);
		return j?.data?.token || null;
	} catch {
		return null;
	}
}

async function api(path, opts = {}) {
	const headers = { accept: 'application/json', ...(opts.headers || {}) };
	if (opts.body) {
		headers['content-type'] = 'application/json';
		const token = await csrfToken();
		if (token) headers['x-csrf-token'] = token;
	}
	const res = await fetch(path, { credentials: 'include', ...opts, headers });
	const body = await res.json().catch(() => ({}));
	return { ok: res.ok, status: res.status, body };
}

/** "45s" / "2m 30s": matches formatDelay() in api/_lib/alpha-drip.js. */
export function formatDelay(sec) {
	const s = Math.max(0, Math.round(Number(sec) || 0));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const r = s % 60;
	return r ? `${m}m ${r}s` : `${m}m`;
}

/**
 * Mirror of the server's monotonicity rule, so a leader is told before they
 * save instead of after. The server still re-checks everything.
 */
export function validateLadder(rows, publicDelay) {
	const priced = rows.filter((r) => r.delay_sec != null);
	// rows arrive high tier first
	let prev = 0;
	for (const r of priced) {
		if (r.delay_sec < prev) return `${r.label} waits less than a higher tier. A higher tier can never wait longer.`;
		prev = r.delay_sec;
	}
	if (priced.length && publicDelay < prev) return 'Everyone else must wait at least as long as the slowest paid tier.';
	if (!priced.length && publicDelay === 0) return 'Set at least one delay, or switch back to releasing to everyone at once.';
	return null;
}

export async function mountAlphaDripPanel(el) {
	ensureStyles();
	el.innerHTML = `<div class="ad-sk" role="status" aria-label="Loading your signal release settings"></div>`;

	let res;
	try {
		res = await api('/api/copy/alpha-drip?mine=1');
	} catch {
		return renderError(el, 'Could not reach the server.', () => mountAlphaDripPanel(el));
	}
	if (res.status === 401) { el.innerHTML = ''; return; }
	if (!res.ok) return renderError(el, res.body?.message || 'Could not load your release settings.', () => mountAlphaDripPanel(el));

	const leaders = res.body.leaders || [];
	// Nothing to price until somebody is copying you. Render nothing rather than
	// an empty box: the copy dashboard already tells a non-leader what to do next.
	if (!leaders.length) { el.innerHTML = ''; return; }

	el.innerHTML = leaders.map(leaderCard).join('');
	for (const leader of leaders) wireCard(el, leader);
}

function renderError(el, message, retry) {
	el.innerHTML = `
		<div class="ad-lead">
			<p class="ad-err">${escapeHtml(message)}</p>
			<div class="ad-actions"><button type="button" class="ad-btn" data-ad-retry>Try again</button></div>
		</div>`;
	$('[data-ad-retry]', el)?.addEventListener('click', retry);
}

function leaderCard(leader) {
	const id = leader.leader_agent_id;
	const drip = leader.drip;
	const tiers = drip.tiers || [];
	const byTier = new Map((drip.schedule || []).map((e) => [e.tier, e]));
	// High tier first: the seat a leader prices first is the one they sell.
	const ordered = [...tiers].reverse();

	const rows = ordered.map((t) => {
		const entry = byTier.get(t.id);
		return `
			<div class="ad-row" data-tier="${escapeHtml(t.id)}">
				<span class="ad-tier">${escapeHtml(t.label)}<small>holds $${t.min_usd}+ of $THREE</small></span>
				<input type="number" min="0" max="900" step="1" inputmode="numeric"
					data-ad-delay="${escapeHtml(t.id)}"
					value="${entry ? entry.delay_sec : ''}"
					placeholder="inherit"
					aria-label="${escapeHtml(t.label)} tier delay in seconds" />
				<input type="number" min="0" step="0.001" inputmode="decimal"
					data-ad-cap="${escapeHtml(t.id)}"
					value="${entry && entry.max_copy_size_sol != null ? entry.max_copy_size_sol : ''}"
					placeholder="no cap"
					aria-label="${escapeHtml(t.label)} tier max copy size in SOL" />
			</div>`;
	}).join('');

	return `
		<div class="ad-lead" data-ad-leader="${escapeHtml(id)}">
			<div class="ad-head">
				<span class="ad-name">${escapeHtml(leader.leader_name || 'Your trader')}</span>
				<span class="ad-copiers">${leader.copiers} ${leader.copiers === 1 ? 'copier' : 'copiers'}</span>
			</div>
			<p class="ad-summary" data-ad-summary>${escapeHtml(drip.summary)}</p>

			<div class="ad-modes" role="group" aria-label="Signal release mode">
				<button type="button" class="ad-mode" data-ad-mode="off" aria-pressed="${drip.enabled ? 'false' : 'true'}">Everyone at once</button>
				<button type="button" class="ad-mode" data-ad-mode="on" aria-pressed="${drip.enabled ? 'true' : 'false'}">Tiered release</button>
			</div>

			<div class="ad-fold" data-ad-fold ${drip.enabled ? '' : 'hidden'}>
				<div class="ad-row ad-row-h" aria-hidden="true">
					<span>$THREE tier</span><span>Delay (s)</span><span>Max copy (◎)</span>
				</div>
				<div class="ad-grid">
					${rows}
					<div class="ad-row" data-tier="__public">
						<span class="ad-tier">Everyone else<small>holds no $THREE</small></span>
						<input type="number" min="0" max="900" step="1" inputmode="numeric"
							data-ad-public value="${drip.public_delay_sec}"
							aria-label="Public delay in seconds" />
						<span></span>
					</div>
				</div>
				<div class="ad-field">
					<label for="ad-disc-${escapeHtml(id)}">What subscribers are told (optional)</label>
					<textarea id="ad-disc-${escapeHtml(id)}" data-ad-disclosure maxlength="280"
						placeholder="e.g. Gold and above get my calls the moment I fire.">${escapeHtml(drip.leader_note || '')}</textarea>
				</div>
				<div class="ad-field">
					<label for="ad-cap-${escapeHtml(id)}">Capacity note (optional)</label>
					<textarea id="ad-cap-${escapeHtml(id)}" data-ad-capacity maxlength="280"
						placeholder="e.g. Early tiers are size-capped so later tiers still get a fill.">${escapeHtml(drip.capacity_note || '')}</textarea>
				</div>
				<p class="ad-note">Leave a tier blank to inherit the next tier down. Every trade still lands in your public track record either way: a ladder delays the reveal, never the record.</p>
			</div>

			<div class="ad-actions">
				<button type="button" class="ad-btn primary" data-ad-save>Save release</button>
				<button type="button" class="ad-btn" data-ad-suggest>Suggest a ladder</button>
				<a class="ad-btn" href="/docs/alpha-drip">How this works</a>
			</div>
			<p class="ad-warn" data-ad-warn hidden></p>
			<p class="ad-err" data-ad-err hidden></p>
			<p class="ad-ok" data-ad-ok hidden></p>
		</div>`;
}

function wireCard(root, leader) {
	const card = $(`[data-ad-leader="${CSS.escape(leader.leader_agent_id)}"]`, root);
	if (!card) return;
	const fold = $('[data-ad-fold]', card);
	const warn = $('[data-ad-warn]', card);
	const err = $('[data-ad-err]', card);
	const okMsg = $('[data-ad-ok]', card);
	const summary = $('[data-ad-summary]', card);
	const tierLabels = new Map((leader.drip.tiers || []).map((t) => [t.id, t.label]));

	const say = (node, text) => {
		node.textContent = text || '';
		node.hidden = !text;
	};
	const clear = () => { say(err, ''); say(okMsg, ''); };

	const enabled = () => $('[data-ad-mode="on"]', card).getAttribute('aria-pressed') === 'true';

	const readLadder = () => {
		const rows = $$('[data-ad-delay]', card).map((input) => {
			const tier = input.dataset.adDelay;
			const raw = input.value.trim();
			const cap = $(`[data-ad-cap="${CSS.escape(tier)}"]`, card).value.trim();
			return {
				tier,
				label: tierLabels.get(tier) || tier,
				delay_sec: raw === '' ? null : Math.round(Number(raw)),
				max_copy_size_sol: cap === '' ? null : Number(cap),
			};
		});
		const pub = Math.round(Number($('[data-ad-public]', card).value.trim() || 0));
		return { rows, publicDelay: Number.isFinite(pub) ? pub : 0 };
	};

	const describe = () => {
		if (!enabled()) return 'Every copier gets this leader\'s signal at the same moment.';
		const { rows, publicDelay } = readLadder();
		const parts = rows
			.filter((r) => r.delay_sec != null)
			.map((r) => `${r.label}+ ${r.delay_sec === 0 ? 'instant' : `after ${formatDelay(r.delay_sec)}`}`);
		parts.push(`everyone else ${publicDelay === 0 ? 'instant' : `after ${formatDelay(publicDelay)}`}`);
		return `${parts.join(', ')}.`;
	};

	const refresh = () => {
		summary.textContent = describe();
		if (!enabled()) { say(warn, ''); return; }
		const { rows, publicDelay } = readLadder();
		say(warn, validateLadder(rows, publicDelay) || '');
	};

	for (const btn of $$('[data-ad-mode]', card)) {
		btn.addEventListener('click', () => {
			const on = btn.dataset.adMode === 'on';
			$('[data-ad-mode="on"]', card).setAttribute('aria-pressed', String(on));
			$('[data-ad-mode="off"]', card).setAttribute('aria-pressed', String(!on));
			fold.hidden = !on;
			clear();
			refresh();
		});
	}
	for (const input of $$('input[type="number"]', card)) {
		input.addEventListener('input', () => { clear(); refresh(); });
	}

	$('[data-ad-save]', card).addEventListener('click', async (ev) => {
		const btn = ev.currentTarget;
		clear();
		const { rows, publicDelay } = readLadder();
		if (enabled()) {
			const problem = validateLadder(rows, publicDelay);
			if (problem) return say(err, problem);
		}
		btn.disabled = true;
		btn.textContent = 'Saving…';
		try {
			const res = await api('/api/copy/alpha-drip', {
				method: 'POST',
				body: JSON.stringify({
					leader_agent_id: leader.leader_agent_id,
					enabled: enabled(),
					public_delay_sec: enabled() ? publicDelay : 0,
					schedule: enabled() ? rows.filter((r) => r.delay_sec != null).map((r) => ({
						tier: r.tier, delay_sec: r.delay_sec, max_copy_size_sol: r.max_copy_size_sol,
					})) : [],
					disclosure: $('[data-ad-disclosure]', card).value.trim() || null,
					capacity_note: $('[data-ad-capacity]', card).value.trim() || null,
				}),
			});
			if (!res.ok) return say(err, res.body?.message || 'Could not save the release ladder.');
			summary.textContent = res.body.drip.summary;
			say(warn, res.body.fairness?.warning || '');
			say(okMsg, 'Saved. New signals release on this ladder.');
		} catch {
			say(err, 'Could not reach the server. Try again.');
		} finally {
			btn.disabled = false;
			btn.textContent = 'Save release';
		}
	});

	$('[data-ad-suggest]', card).addEventListener('click', async (ev) => {
		const btn = ev.currentTarget;
		clear();
		btn.disabled = true;
		btn.textContent = 'Drafting…';
		try {
			const res = await api('/api/copy/alpha-drip', {
				method: 'POST',
				body: JSON.stringify({ action: 'recommend', leader_agent_id: leader.leader_agent_id }),
			});
			if (!res.ok) return say(err, res.body?.message || 'Could not draft a ladder.');
			applySuggestion(card, res.body.suggestion);
			$('[data-ad-mode="on"]', card).setAttribute('aria-pressed', 'true');
			$('[data-ad-mode="off"]', card).setAttribute('aria-pressed', 'false');
			fold.hidden = false;
			refresh();
			say(warn, res.body.fairness?.warning || '');
			say(okMsg, 'Draft loaded. Nothing is live until you save it.');
		} catch {
			say(err, 'Could not reach the server. Try again.');
		} finally {
			btn.disabled = false;
			btn.textContent = 'Suggest a ladder';
		}
	});

	refresh();
}

function applySuggestion(card, suggestion) {
	const byTier = new Map((suggestion.schedule || []).map((e) => [e.tier, e]));
	for (const input of $$('[data-ad-delay]', card)) {
		const entry = byTier.get(input.dataset.adDelay);
		input.value = entry ? String(entry.delay_sec) : '';
		const cap = $(`[data-ad-cap="${CSS.escape(input.dataset.adDelay)}"]`, card);
		cap.value = entry && entry.max_copy_size_sol != null ? String(entry.max_copy_size_sol) : '';
	}
	$('[data-ad-public]', card).value = String(suggestion.public_delay_sec ?? 0);
	if (suggestion.leader_note) $('[data-ad-disclosure]', card).value = suggestion.leader_note;
	if (suggestion.capacity_note) $('[data-ad-capacity]', card).value = suggestion.capacity_note;
}
