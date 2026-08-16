/**
 * Coin Autopilot: control surface + live narration for the autonomous coin agent.
 *
 * Reads /api/pump/autopilot (the caller's launched coins, their per-coin policy,
 * recent autonomous actions). Lets the owner tune the rules that gate the
 * run-buyback and run-distribute-payments crons, and narrates each on-chain
 * move through the agent's avatar.
 *
 * Thresholds are denominated in USDC in the UI and stored as atomics (6 dp).
 */

const API = '/api/pump/autopilot';
const USDC_DECIMALS = 6;
const POLL_MS = 20_000;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
	String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/** Both columns ship with `aria-busy` set so the skeletons announce as loading.
 *  Every render path has to clear it, or a screen reader is told the region is
 *  still loading for as long as the tab stays open. */
function settle(el) {
	if (el) el.removeAttribute('aria-busy');
}

function usdcFromAtomics(atomics) {
	const n = Number(BigInt(atomics || '0')) / 10 ** USDC_DECIMALS;
	if (!Number.isFinite(n)) return '0';
	// Trim trailing zeros, keep up to 6 dp.
	return parseFloat(n.toFixed(USDC_DECIMALS)).toString();
}

function atomicsFromUsdc(usdc) {
	const n = Number(usdc);
	if (!Number.isFinite(n) || n < 0) return '0';
	return BigInt(Math.round(n * 10 ** USDC_DECIMALS)).toString();
}

function fmtUsdc(atomics) {
	const n = Number(BigInt(atomics || '0')) / 10 ** USDC_DECIMALS;
	if (!Number.isFinite(n)) return '$0';
	return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function timeAgo(ts) {
	const ms = Date.now() - new Date(ts).getTime();
	if (!Number.isFinite(ms)) return '';
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

let _toastTimer;
function toast(msg, isErr = false) {
	const el = $('#toast');
	if (!el) return;
	el.textContent = msg;
	el.className = isErr ? 'show err' : 'show';
	clearTimeout(_toastTimer);
	_toastTimer = setTimeout(() => (el.className = ''), 2600);
}

// ── Narration ────────────────────────────────────────────────────────────────

const NARRATE = {
	buyback: {
		confirmed: (a, sym) =>
			a.amount_atomics && a.amount_atomics !== '0'
				? `Bought back and burned ${fmtUsdc(a.amount_atomics)} of $${sym}. Supply just got scarcer.`
				: `Ran a buyback-and-burn on $${sym}. Supply just got scarcer.`,
		pending: (a, sym) => `Buyback for $${sym} is queued, waiting for a keeper to sign.`,
		failed: (a, sym) => `Buyback for $${sym} hit a snag: ${a.error || 'unknown error'}.`,
	},
	distribute: {
		confirmed: (a, sym) =>
			a.amount_atomics && a.amount_atomics !== '0'
				? `Distributed ${fmtUsdc(a.amount_atomics)} in creator fees to $${sym} holders.`
				: `Distributed creator fees to $${sym} holders.`,
		pending: (a, sym) => `Fee distribution for $${sym} is queued for the next keeper run.`,
		failed: (a, sym) => `Fee distribution for $${sym} failed: ${a.error || 'unknown error'}.`,
	},
};

let _lastNarratedKey = null;

function narrate(activity, coinsById, agentImage) {
	const node = $('#narrator');
	if (!node) return;
	node.style.display = 'flex';

	// Pick the newest meaningful action (skip the noisy 'skipped' rows).
	const a = activity.find((x) => x.status !== 'skipped');
	const avatarEl = $('#narratorAvatar');
	if (agentImage && avatarEl && !avatarEl.querySelector('img')) {
		avatarEl.insertAdjacentHTML('afterbegin', `<img loading="lazy" decoding="async" src="${esc(agentImage)}" alt="">`);
		const nf = avatarEl.querySelector('.nf');
		if (nf) nf.style.display = 'none';
	}

	if (!a) {
		$('#narratorLine').textContent = 'Standing by. No autonomous actions yet.';
		$('#narratorLine').className = 'narrator-line';
		$('#narratorMeta').textContent = 'Your agent will speak here the moment it acts.';
		return;
	}

	const coin = coinsById.get(a.mint_id);
	const sym = coin?.symbol || coin?.name || 'your coin';
	const phrase = NARRATE[a.kind]?.[a.status]?.(a, sym) || `${a.kind} ${a.status} on $${sym}.`;
	const key = `${a.kind}:${a.status}:${a.tx_signature || a.at}`;

	const lineEl = $('#narratorLine');
	lineEl.textContent = phrase;
	lineEl.className =
		'narrator-line' + (a.status === 'confirmed' ? ' pos' : a.status === 'failed' ? ' neg' : '');
	$('#narratorMeta').textContent = `${coin?.name || ''} · ${timeAgo(a.at)}`.replace(/^ · /, '');

	// Flash the avatar ring only when a genuinely new action arrives.
	if (key !== _lastNarratedKey) {
		_lastNarratedKey = key;
		node.classList.remove('flash');
		void node.offsetWidth; // reflow to restart the animation
		node.classList.add('flash');
	}
}

// ── Rendering ────────────────────────────────────────────────────────────────

function coinCard(c) {
	const p = c.policy;
	const on = p.enabled;
	const label = c.name || c.symbol || 'this coin';
	const initials = (c.symbol || c.name || 'A').slice(0, 2).toUpperCase();
	const img = c.image
		? `<img loading="lazy" decoding="async" src="${esc(c.image)}" alt="" data-fallback="remove">`
		: '';
	const gradPill = c.stats.graduated
		? `<span class="pill grad"><span class="dot"></span>Graduated</span>`
		: c.stats.progress_pct != null
			? `<span class="pill paused" title="Bonding-curve progress">${Number(c.stats.progress_pct).toFixed(0)}% to grad</span>`
			: '';
	// The API reports `configured: false` for a coin with no policy row: it runs
	// on the platform defaults, which is not the same as rules the owner chose.
	// Say so, or an inherited "Autopilot on" reads as a deliberate setting.
	const defaultPill = p.configured
		? ''
		: `<span class="pill default" data-role="default-pill" title="No rules saved yet. This coin runs on the platform defaults until you change something here.">Defaults</span>`;
	// Field ids are per-coin so the visible "Min" label points at the right input
	// on a page that renders one card per launched coin.
	const bbId = `bb-min-${esc(c.mint)}`;
	const dsId = `ds-min-${esc(c.mint)}`;

	return `
	<div class="coin-card ${on ? 'on' : ''}" data-mint="${esc(c.mint)}" data-network="${esc(c.network)}">
		<div class="coin-head">
			<div class="coin-img">${img}<span class="cf">${esc(initials)}</span></div>
			<div class="coin-id">
				<div class="coin-name">${esc(c.name || c.symbol)} <span style="color:var(--text-4);font-weight:400">$${esc(c.symbol || '')}</span></div>
				<div class="coin-sub">
					${esc(c.mint.slice(0, 6))}…${esc(c.mint.slice(-6))}
					${c.pump_url ? ` · <a href="${esc(c.pump_url)}" target="_blank" rel="noopener">pump.fun ↗</a>` : ''}
				</div>
			</div>
			<div class="coin-status">
				${gradPill}
				${defaultPill}
				<span class="pill ${on ? 'live' : 'paused'}" data-role="status-pill">
					<span class="dot"></span>${on ? 'Autopilot on' : 'Paused'}
				</span>
				<span class="save-state" data-role="save-state" role="status" aria-live="polite"></span>
				<label class="sw" title="Master autopilot switch">
					<input type="checkbox" data-field="enabled" aria-label="Autopilot for ${esc(label)}" ${on ? 'checked' : ''}>
					<span class="sw-track"></span>
				</label>
			</div>
		</div>
		<div class="coin-body">
			<div class="coin-stats">
				<div><div class="cstat-v" style="color:var(--mint)">${fmtUsdc(c.totals.burned_atomics)}</div><div class="cstat-l">Burned</div></div>
				<div><div class="cstat-v">${c.totals.distribute_runs}</div><div class="cstat-l">Distributions</div></div>
				<div><div class="cstat-v">${fmtUsdc(c.totals.paid_atomics)}</div><div class="cstat-l">Fees in</div></div>
				<div><div class="cstat-v">${c.totals.paid_count}</div><div class="cstat-l">Payments</div></div>
			</div>

			<div class="rules">
				<div class="rule ${p.buyback_enabled ? '' : 'off'}" data-rule="buyback">
					<div class="rule-head">
						<div><div class="rule-title">Buyback &amp; burn</div></div>
						<label class="sw"><input type="checkbox" data-field="buyback_enabled" aria-label="Buyback and burn for ${esc(label)}" ${p.buyback_enabled ? 'checked' : ''}><span class="sw-track"></span></label>
					</div>
					<div class="rule-desc">Spend collected creator fees to buy the token back and burn it once the buyback vault clears your floor.</div>
					<div class="rule-field">
						<label for="${bbId}">Min</label>
						<div class="amt-wrap">
							<input type="number" min="0" step="0.01" id="${bbId}" data-field="buyback_min_usdc"
								aria-label="Minimum buyback vault balance in USDC before ${esc(label)} buys back"
								value="${esc(usdcFromAtomics(p.buyback_min_atomics))}">
							<span class="amt-unit">USDC</span>
						</div>
					</div>
					<label class="rule-check"><input type="checkbox" data-field="buyback_full_swap" ${p.buyback_full_swap ? 'checked' : ''}> Swap fees → token before burning (vs burn-only)</label>
				</div>

				<div class="rule ${p.distribute_enabled ? '' : 'off'}" data-rule="distribute">
					<div class="rule-head">
						<div><div class="rule-title">Distribute to holders</div></div>
						<label class="sw"><input type="checkbox" data-field="distribute_enabled" aria-label="Distribute to holders for ${esc(label)}" ${p.distribute_enabled ? 'checked' : ''}><span class="sw-track"></span></label>
					</div>
					<div class="rule-desc">Push accumulated payment-vault fees out to your configured shareholders once the vault clears your floor.</div>
					<div class="rule-field">
						<label for="${dsId}">Min</label>
						<div class="amt-wrap">
							<input type="number" min="0" step="0.01" id="${dsId}" data-field="distribute_min_usdc"
								aria-label="Minimum payment vault balance in USDC before ${esc(label)} distributes"
								value="${esc(usdcFromAtomics(p.distribute_min_atomics))}">
							<span class="amt-unit">USDC</span>
						</div>
					</div>
					<label class="rule-check"><input type="checkbox" data-field="narrate" ${p.narrate ? 'checked' : ''}> Narrate this coin's actions on the live feed</label>
				</div>
			</div>
		</div>
	</div>`;
}

function activityRow(a, coinsById) {
	const coin = coinsById.get(a.mint_id);
	const sym = coin?.symbol ? `$${esc(coin.symbol)}` : 'coin';
	let desc;
	if (a.kind === 'buyback') {
		desc =
			a.status === 'confirmed'
				? `Burned ${a.amount_atomics ? esc(fmtUsdc(a.amount_atomics)) : 'fees'} of ${sym}`
				: a.status === 'skipped'
					? `No buyback for ${sym} — below threshold or empty vault`
					: a.status === 'failed'
						? `Buyback failed for ${sym}: ${esc((a.error || '').slice(0, 80))}`
						: `Buyback queued for ${sym}`;
	} else {
		desc =
			a.status === 'confirmed'
				? `Distributed ${a.amount_atomics ? esc(fmtUsdc(a.amount_atomics)) : 'fees'} to ${sym} holders`
				: a.status === 'skipped'
					? `No distribution for ${sym} — below threshold or empty vault`
					: a.status === 'failed'
						? `Distribution failed for ${sym}: ${esc((a.error || '').slice(0, 80))}`
						: `Distribution queued for ${sym}`;
	}
	const sig = a.tx_signature
		? ` <a class="sig" href="https://solscan.io/tx/${esc(a.tx_signature)}" target="_blank" rel="noopener">${esc(a.tx_signature.slice(0, 8))}…</a>`
		: '';
	return `
	<div class="act-row">
		<span class="act-badge ${a.kind}">${a.kind}</span>
		<div class="act-content">
			<div class="act-desc">${desc}${sig}</div>
			<div class="act-meta"><span class="act-status ${esc(a.status)}">${esc(a.status)}</span><span>${timeAgo(a.at)}</span></div>
		</div>
	</div>`;
}

function renderEmpty() {
	$('#coins').innerHTML = `
		<div class="empty">
			<h3>No coins yet</h3>
			<p>Launch a coin for one of your agents, then it can run itself here.</p>
			<a class="btn primary" href="/dashboard">Launch a coin →</a>
		</div>`;
	$('#activity').innerHTML = `<div class="empty" style="border:none;padding:24px 0;text-align:left;color:var(--text-4)">Activity will appear once your coins start acting.</div>`;
	$('#narrator').style.display = 'none';
}

function renderSignedOut() {
	$('#coins').innerHTML = `
		<div class="empty">
			<h3>Sign in to manage autopilot</h3>
			<p>Connect your three.ws account to control your coins' autonomous buybacks and fee distribution.</p>
			<a class="btn primary" href="/dashboard">Go to dashboard →</a>
		</div>`;
	$('#activity').innerHTML = '';
	$('#narrator').style.display = 'none';
}

function renderError(msg) {
	$('#coins').innerHTML = `<div class="empty"><h3>Couldn't load</h3><p>${esc(msg)}</p><button class="btn" id="retry">Retry</button></div>`;
	$('#retry')?.addEventListener('click', () => load());
}

// ── Save (debounced per coin) ────────────────────────────────────────────────

const _saveTimers = new Map();

function collectPolicy(card) {
	const get = (f) => card.querySelector(`[data-field="${f}"]`);
	return {
		mint: card.dataset.mint,
		network: card.dataset.network,
		enabled: get('enabled').checked,
		buyback_enabled: get('buyback_enabled').checked,
		buyback_full_swap: get('buyback_full_swap').checked,
		buyback_min_atomics: atomicsFromUsdc(get('buyback_min_usdc').value),
		distribute_enabled: get('distribute_enabled').checked,
		distribute_min_atomics: atomicsFromUsdc(get('distribute_min_usdc').value),
		narrate: get('narrate').checked,
	};
}

async function savePolicy(card) {
	const body = collectPolicy(card);
	try {
		const r = await fetch(API, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!r.ok) {
			const d = await r.json().catch(() => ({}));
			throw new Error(d.error_description || d.error || `save failed (${r.status})`);
		}
		toast('Autopilot updated');
	} catch (e) {
		toast(e.message || 'Save failed', true);
	}
}

function queueSave(card, immediate = false) {
	const key = card.dataset.mint;
	clearTimeout(_saveTimers.get(key));
	if (immediate) {
		savePolicy(card);
		return;
	}
	_saveTimers.set(key, setTimeout(() => savePolicy(card), 600));
}

function wireCard(card) {
	card.addEventListener('change', (e) => {
		const field = e.target.dataset?.field;
		if (!field) return;
		// Reflect master + per-rule enable visually right away.
		if (field === 'enabled') {
			const on = e.target.checked;
			card.classList.toggle('on', on);
			const pill = card.querySelector('[data-role="status-pill"]');
			if (pill) {
				pill.className = `pill ${on ? 'live' : 'paused'}`;
				pill.innerHTML = `<span class="dot"></span>${on ? 'Autopilot on' : 'Paused'}`;
			}
		}
		if (field === 'buyback_enabled') card.querySelector('[data-rule="buyback"]').classList.toggle('off', !e.target.checked);
		if (field === 'distribute_enabled') card.querySelector('[data-rule="distribute"]').classList.toggle('off', !e.target.checked);
		queueSave(card, e.target.type === 'checkbox');
	});
}

// ── Load + poll ──────────────────────────────────────────────────────────────

let _coinsById = new Map();
let _agentImage = null;

async function load() {
	let data;
	try {
		const r = await fetch(API, { credentials: 'include' });
		if (r.status === 401) return renderSignedOut();
		if (!r.ok) {
			const d = await r.json().catch(() => ({}));
			return renderError(d.error_description || d.error || `request failed (${r.status})`);
		}
		data = await r.json();
	} catch {
		return renderError('Network error — check your connection and retry.');
	}

	const coins = data.coins || [];
	if (!coins.length) return renderEmpty();

	_coinsById = new Map(coins.map((c) => [c.id, c]));
	_agentImage = coins.find((c) => c.image)?.image || null;

	$('#coins').innerHTML = coins.map(coinCard).join('');
	$('#coins').querySelectorAll('.coin-card').forEach(wireCard);

	renderActivity(data.activity || []);
	narrate(data.activity || [], _coinsById, _agentImage);
}

function renderActivity(activity) {
	const el = $('#activity');
	if (!el) return;
	if (!activity.length) {
		el.innerHTML = `<div class="empty" style="border:none;padding:24px 0;text-align:left;color:var(--text-4)">No autonomous actions yet. Your agent acts as fees accumulate past your thresholds.</div>`;
		return;
	}
	el.innerHTML = activity.map((a) => activityRow(a, _coinsById)).join('');
}

/** Lightweight refresh — only the activity feed + narrator, never clobbers
 *  the control inputs the user may be editing. */
async function refreshActivity() {
	if (document.hidden) return;
	try {
		const r = await fetch(API, { credentials: 'include' });
		if (!r.ok) return;
		const data = await r.json();
		if (data.coins) _coinsById = new Map(data.coins.map((c) => [c.id, c]));
		renderActivity(data.activity || []);
		narrate(data.activity || [], _coinsById, _agentImage);
	} catch {
		/* transient — next tick retries */
	}
}

load();
setInterval(refreshActivity, POLL_MS);
