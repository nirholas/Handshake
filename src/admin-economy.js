// /admin/economy: autonomous economy health dashboard (DOM layer).
//
// All judgement lives in admin-economy-core.js; this file only fetches and
// renders. Three real reads, no mocks and no synthetic numbers:
//   GET /api/pulse?view=stats            public   money actually moved
//   GET /api/admin/circulation-health    Bearer   per-lane ok/skipped/error
//   GET /api/cron/treasury-topup?dry=1   Bearer   funding chain, plan only
//
// The topup read is explicitly the ?dry=1 plan: it performs the same balance
// reads a live sweep would, moves no SOL, writes no ledger row and sends no
// alerts. A dashboard must never be able to spend money by being opened.

import { diagnose, chainLinks, totalDeficit, fmtSol, fmtUsd, ALL_KINDS, attemptsFor } from './admin-economy-core.js';

const SECRET_KEY = 'tws:admin:cron-secret';
const REFRESH_MS = 30_000;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = String(text);
	return node;
};

let secret = '';
let timer = null;
let paused = false;
let inFlight = false;

// ── data ─────────────────────────────────────────────────────────────────────

async function getJson(url, withAuth) {
	const res = await fetch(url, {
		headers: withAuth ? { authorization: `Bearer ${secret}` } : {},
		cache: 'no-store',
		credentials: 'same-origin',
	});
	if (res.status === 401 || res.status === 403) {
		const err = new Error('unauthorized');
		err.unauthorized = true;
		throw err;
	}
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json();
}

/** Each source fails independently: one dead endpoint must not blank the page. */
async function loadAll() {
	const [stats, health, topup] = await Promise.all([
		getJson('/api/pulse?view=stats', false).then((r) => r?.data ?? r).catch(() => null),
		getJson('/api/admin/circulation-health', true).catch((e) => {
			if (e.unauthorized) throw e;
			return null;
		}),
		getJson('/api/cron/treasury-topup?dry=1', true).catch((e) => {
			if (e.unauthorized) throw e;
			return null;
		}),
	]);
	return { stats, health, topup };
}

// ── render ───────────────────────────────────────────────────────────────────

function renderVerdict(data) {
	const v = diagnose(data);
	const box = $('ec-verdict');
	box.dataset.level = v.level;
	box.hidden = false;
	$('ec-verdict-title').textContent = v.title;
	$('ec-verdict-detail').textContent = v.detail;
}

function statCard(label, value, note) {
	const card = el('div', 'ec-card');
	card.append(el('p', 'ec-k', label));
	const v = el('p', 'ec-v');
	v.textContent = value;
	card.append(v);
	if (note) card.append(el('p', 'ec-note', note));
	return card;
}

function renderPulse(stats) {
	const host = $('ec-pulse');
	host.textContent = '';
	if (!stats) {
		host.append(el('div', 'ec-error', 'Could not read the public pulse stats.'));
		return;
	}
	const vol = stats.volume_24h || {};
	host.append(
		statCard('Volume 24h', fmtUsd(vol.usd), `${fmtSol(vol.sol)} SOL of real settled movement`),
		statCard('Trades 24h', String(stats.trades_24h ?? 0), `${stats.snipes_24h ?? 0} of them snipes`),
		statCard('Tips 24h', String(stats.tips_24h?.count ?? 0), `${fmtSol(stats.tips_24h?.sol)} SOL sent between agents`),
		statCard('Active wallets', String(stats.active_wallets_24h ?? 0), 'Distinct agent wallets that moved value'),
	);
}

function renderChain(data) {
	const host = $('ec-chain');
	host.textContent = '';
	if (!data.topup) {
		host.append(el('div', 'ec-error', 'Could not read the funding chain. Check the operator secret and the treasury-topup route.'));
		return;
	}
	for (const link of chainLinks(data)) {
		const box = el('div', 'ec-link');
		box.dataset.state = link.state;
		box.append(el('h3', null, link.label));
		const amt = el('div', 'ec-amt');
		amt.textContent = `${link.unit === 'USDC' ? fmtUsd(link.amount) : fmtSol(link.amount)}`;
		box.append(amt);
		box.append(el('div', 'ec-floor', `floor ${link.unit === 'USDC' ? fmtUsd(link.floor) : fmtSol(link.floor)} ${link.unit}`));
		const meter = el('div', 'ec-meter');
		const fill = el('i');
		fill.style.width = `${Math.round(link.fill * 100)}%`;
		meter.append(fill);
		box.append(meter, el('p', 'ec-note', link.note));
		host.append(box);
	}

	const deficit = totalDeficit(data);
	$('ec-chain-summary').textContent = deficit > 0
		? `Chain is short ${fmtSol(deficit)} SOL. Reclaim runs first, then a capped USDC conversion.`
		: 'Every link is at or above its floor.';
}

function pill(tone, text) {
	const p = el('span', 'ec-pill', text);
	p.dataset.tone = tone;
	return p;
}

function renderLanes(health) {
	const host = $('ec-lanes');
	host.textContent = '';
	const byKind = health?.window_24h?.by_kind;
	if (!byKind) {
		host.append(el('div', 'ec-error', 'Could not read per-lane activity.'));
		return;
	}

	const rows = ALL_KINDS.filter((k) => byKind[k]).map((k) => ({ kind: k, ...byKind[k] }));
	if (!rows.length) {
		const empty = el('div', 'ec-empty');
		empty.append(document.createTextNode('No actions recorded in the last 24 hours. '));
		empty.append(el('b', null, 'That points at the pulse-tick cron, not at the lanes.'));
		host.append(empty);
		return;
	}

	const table = el('table', 'ec-table');
	const thead = el('thead');
	const hr = el('tr');
	for (const h of ['Lane', 'State', 'OK', 'Skipped', 'Error', 'Last problem']) hr.append(el('th', null, h));
	thead.append(hr);
	table.append(thead);

	const tbody = el('tbody');
	for (const r of rows) {
		const tr = el('tr');
		tr.append(el('td', null, r.kind));

		const attempts = attemptsFor(byKind, r.kind);
		const okN = Number(r.ok || 0);
		const cell = el('td');
		if (attempts === 0) cell.append(pill('warn', 'never ran'));
		else if (okN === 0) cell.append(pill('bad', 'all failing'));
		else if (Number(r.error || 0) > 0) cell.append(pill('warn', 'degraded'));
		else cell.append(pill('good', 'settling'));
		tr.append(cell);

		for (const v of [r.ok, r.skipped, r.error]) tr.append(el('td', 'ec-num', String(v ?? 0)));
		tr.append(el('td', 'ec-reason', r.last_problem || '-'));
		tbody.append(tr);
	}
	table.append(tbody);

	const scroll = el('div', 'ec-scroll');
	scroll.append(table);
	host.append(scroll);
}

function renderFuel(data) {
	const host = $('ec-fuel');
	host.textContent = '';
	const caps = data.health?.fuel?.caps;
	const fuel = data.topup?.fuel;
	if (!caps && !fuel) {
		host.append(el('div', 'ec-error', 'Could not read the refuel lane.'));
		return;
	}

	const reason = fuel?.reason || 'unknown';
	const reasonText = {
		not_needed: 'Not needed: the chain covers itself.',
		sufficient_sol: 'Not needed: the master already covers the run.',
		no_spare_usdc: 'Blocked: no USDC left above the keep floor.',
		usdc_read_failed: 'Blocked: the balance could not be read at all.',
		daily_cap_reached: "Paused: today's conversion cap is spent.",
		cooldown: 'Paused: a swap just landed and is still settling.',
		dry_run: 'Would swap now (this is the plan-only read).',
	}[reason] || reason;

	host.append(
		statCard('Refuel state', reason.replace(/_/g, ' '), reasonText),
		statCard('Spent today', fmtUsd(data.health?.fuel?.today_usd), `of a ${fmtUsd(caps?.daily_usd)} daily cap`),
		statCard('Per run cap', fmtUsd(caps?.per_run_usd), `lifts the master toward ${fmtSol(caps?.target_sol)} SOL`),
		statCard('Recent swaps', String((data.health?.fuel?.recent || []).length), 'USDC converted to SOL, most recent first'),
	);

	const recent = data.health?.fuel?.recent || [];
	const list = $('ec-fuel-recent');
	list.textContent = '';
	if (!recent.length) {
		list.append(el('div', 'ec-empty', 'No refuel swaps recorded yet. The lane only fires on a real shortage.'));
		return;
	}
	const table = el('table', 'ec-table');
	const thead = el('thead');
	const hr = el('tr');
	for (const h of ['When', 'Spent', 'Bought', 'Impact', 'Transaction']) hr.append(el('th', null, h));
	thead.append(hr);
	table.append(thead);
	const tbody = el('tbody');
	for (const s of recent.slice(0, 8)) {
		const tr = el('tr');
		tr.append(el('td', null, s.at ? new Date(s.at).toLocaleString() : '-'));
		tr.append(el('td', 'ec-num', fmtUsd(s.usd)));
		tr.append(el('td', 'ec-num', `${fmtSol(s.sol)} SOL`));
		tr.append(el('td', 'ec-num', `${Number(s.price_impact_pct || 0).toFixed(2)}%`));
		const txCell = el('td');
		if (s.signature) {
			const a = el('a', null, `${String(s.signature).slice(0, 10)}…`);
			a.href = `https://solscan.io/tx/${s.signature}`;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			txCell.append(a);
		} else txCell.textContent = '-';
		tr.append(txCell);
		tbody.append(tr);
	}
	table.append(tbody);
	const scroll = el('div', 'ec-scroll');
	scroll.append(table);
	list.append(scroll);
}

function renderEngine(health) {
	const host = $('ec-engine');
	host.textContent = '';
	if (!health) {
		host.append(el('div', 'ec-error', 'Could not read engine configuration.'));
		return;
	}
	const live = health.liveness || {};
	host.append(
		statCard('Agent pool', String(health.pool_size ?? 0), `target ${health.config?.pool_target ?? '?'}, ${health.quarantined_agents ?? 0} quarantined`),
		statCard('Actions / tick', String(health.config?.actions_per_tick ?? 0), 'Paid slots are cut when the treasury is thin'),
		statCard('Actions 24h', String(live.actions_24h ?? 0), `${live.actions_1h ?? 0} in the last hour`),
		statCard('Last action', live.minutes_since == null ? '-' : `${live.minutes_since}m ago`, live.stale ? 'Stale: the tick may have stopped' : 'Ticking normally'),
	);
}

function setStamp() {
	$('ec-stamp').textContent = `updated ${new Date().toLocaleTimeString()}`;
}

function showSkeletons() {
	for (const id of ['ec-pulse', 'ec-engine', 'ec-fuel']) {
		const host = $(id);
		host.textContent = '';
		for (let i = 0; i < 4; i++) {
			const card = el('div', 'ec-card');
			const k = el('p', 'ec-k ec-skeleton', 'loading');
			const v = el('p', 'ec-v ec-skeleton', '0.0000');
			card.append(k, v);
			host.append(card);
		}
	}
}

// ── controller ───────────────────────────────────────────────────────────────

async function refresh() {
	if (inFlight) return;
	inFlight = true;
	$('ec-root').setAttribute('aria-busy', 'true');
	try {
		const data = await loadAll();
		renderVerdict(data);
		renderPulse(data.stats);
		renderEngine(data.health);
		renderChain(data);
		renderLanes(data.health);
		renderFuel(data);
		setStamp();
		$('ec-gate-err').textContent = '';
	} catch (e) {
		if (e.unauthorized) {
			sessionStorage.removeItem(SECRET_KEY);
			secret = '';
			stopTimer();
			showGate('That secret was rejected.');
		} else {
			$('ec-stamp').textContent = `refresh failed: ${e.message}`;
		}
	} finally {
		inFlight = false;
		$('ec-root').setAttribute('aria-busy', 'false');
	}
}

function startTimer() {
	stopTimer();
	if (!paused) timer = setInterval(refresh, REFRESH_MS);
}

function stopTimer() {
	if (timer) clearInterval(timer);
	timer = null;
}

function showGate(message) {
	$('ec-gate').hidden = false;
	$('ec-panel').hidden = true;
	$('ec-hint').hidden = true;
	if (message) $('ec-gate-err').textContent = message;
	$('ec-secret').focus();
}

function showPanel() {
	$('ec-gate').hidden = true;
	$('ec-panel').hidden = false;
	$('ec-hint').hidden = false;
	showSkeletons();
	refresh();
	startTimer();
}

function init() {
	secret = sessionStorage.getItem(SECRET_KEY) || '';

	$('ec-gate-form').addEventListener('submit', (e) => {
		e.preventDefault();
		const value = $('ec-secret').value.trim();
		if (!value) {
			$('ec-gate-err').textContent = 'Enter the operator secret.';
			return;
		}
		secret = value;
		sessionStorage.setItem(SECRET_KEY, value);
		$('ec-secret').value = '';
		showPanel();
	});

	$('ec-refresh').addEventListener('click', refresh);
	$('ec-pause').addEventListener('click', () => {
		paused = !paused;
		$('ec-pause').textContent = paused ? 'Resume' : 'Pause';
		$('ec-pause').setAttribute('aria-pressed', String(paused));
		if (paused) stopTimer();
		else startTimer();
	});

	document.addEventListener('keydown', (e) => {
		if (e.target.matches('input, textarea')) return;
		if (e.key === 'r') refresh();
		if (e.key === 'p') $('ec-pause').click();
	});

	// Pause polling in a hidden tab: an ops page left open all day should not
	// keep hitting the RPC-backed reads for nobody.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stopTimer();
		else if (!paused && !$('ec-panel').hidden) { refresh(); startTimer(); }
	});

	if (secret) showPanel();
	else showGate();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
