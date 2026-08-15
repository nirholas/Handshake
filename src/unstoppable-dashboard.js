// Unstoppable Agent dashboard — renders the agent's live economy: balance,
// runway, 24h P&L, activity feed, and daily reflection.
//
// Two reads back this page, and the difference between them is the product:
//   - GET /api/agents/unstoppable-public   free, edge-cached one agent tick
//     (5 min). This is what every visitor sees, so the dashboard is populated
//     the moment it opens rather than being a paywall notice with no numbers.
//   - GET /api/agents/unstoppable-status   $0.01 USDC over x402. Real-time,
//     20 activity rows, and the only read that credits the treasury it
//     reports. The donate button pays it and swaps the live reading in.
//
// Failure handling: the last good reading is cached in localStorage and shown
// while a fetch is failing, always labelled as stale, alongside an actionable
// error banner. A poll fault backs the cadence off; a good poll snaps it back.

import { log } from './shared/log.js';

const PUBLIC_ENDPOINT = '/api/agents/unstoppable-public';
const LIVE_ENDPOINT = '/api/agents/unstoppable-status';
const POLL_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 300_000; // 5 minutes
const LOCALSTORAGE_KEY = 'unstoppable_last_reading';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function atomicsToUsdc(atomics) {
	return (Number(atomics) / 1_000_000).toFixed(6);
}

function formatUsdc(usdc) {
	const n = parseFloat(usdc);
	if (isNaN(n)) return '$—';
	return '$' + n.toFixed(n < 0.01 ? 6 : 4);
}

function relativeTime(isoString) {
	if (!isoString) return '';
	const diff = Date.now() - new Date(isoString).getTime();
	const s = Math.floor(diff / 1000);
	if (s < 5) return 'just now';
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

function showToast(msg, duration = 3000) {
	const el = document.getElementById('toast');
	if (!el) return;
	el.textContent = msg;
	el.classList.add('show');
	setTimeout(() => el.classList.remove('show'), duration);
}

// Claim an element for the script. The i18n catalog pass lands after an async
// locale fetch and would otherwise revert a rendered value to its placeholder
// copy; src/i18n.js honours this flag (see `scriptOwns`).
function own(el) {
	if (el) el.setAttribute('data-i18n-owned', '1');
	return el;
}

function setText(el, text) {
	if (!el) return;
	own(el).textContent = text;
}

function saveToCache(data) {
	try {
		localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify({ data, savedAt: new Date().toISOString() }));
	} catch {
		// Storage quota or private browsing — ignore.
	}
}

function loadFromCache() {
	try {
		const raw = localStorage.getItem(LOCALSTORAGE_KEY);
		if (!raw) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function escapeHtml(str) {
	if (typeof str !== 'string') return '';
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ─── Renderers ────────────────────────────────────────────────────────────────

let previousBalance = null;

function renderBalance(atomics) {
	const el = document.getElementById('balanceDisplay');
	if (!el) return;
	const formatted = formatUsdc(atomicsToUsdc(atomics)) + ' USDC';
	if (previousBalance !== null && previousBalance !== atomics) {
		el.classList.add('updating');
		setTimeout(() => el.classList.remove('updating'), 800);
	}
	previousBalance = atomics;
	setText(el, formatted);
}

function renderStatus(status, runwayDays) {
	const dot = document.getElementById('agentDot');
	const badge = document.getElementById('statusBadge');
	const statusText = document.getElementById('statusText');
	const runwayBadge = document.getElementById('runwayBadge');

	if (dot) {
		dot.className = 'agent-dot';
		if (status === 'conservation') dot.classList.add('conservation');
		if (status === 'halted') dot.classList.add('halted');
	}

	if (badge && statusText) {
		badge.className = 'badge';
		if (status === 'conservation') {
			badge.classList.add('badge-conservation');
			setText(statusText, 'CONSERVING');
			badge.setAttribute('aria-label', 'Agent status: conserving runway');
		} else if (status === 'halted') {
			badge.classList.add('badge-halted');
			setText(statusText, 'HALTED');
			badge.setAttribute('aria-label', 'Agent status: halted, treasury at the hard floor');
		} else {
			badge.classList.add('badge-running');
			setText(statusText, 'RUNNING');
			badge.setAttribute('aria-label', 'Agent status: running');
		}
	}

	if (runwayBadge) {
		const days = parseFloat(runwayDays);
		// The treasury reports 9999 days when nothing has burned in 24h, which is
		// a "no burn measured" signal rather than a 27-year runway.
		setText(runwayBadge, isFinite(days) && days < 9990
			? `Runway: ${days.toFixed(1)} days`
			: 'Runway: no burn measured');
	}
}

function renderStats(data) {
	const earnings = data.activity_24h?.earnings_usdc || '0';
	const costs = data.activity_24h?.costs_usdc || '0';
	const lifetimeEarned = parseFloat(data.treasury?.lifetime_earned_usdc || 0);
	const lifetimeSpent = parseFloat(data.treasury?.lifetime_spent_usdc || 0);
	const lifetimeNet = lifetimeEarned - lifetimeSpent;

	const el24hEarnings = document.getElementById('stat24hEarnings');
	const el24hCosts = document.getElementById('stat24hCosts');
	const elLifetimeNet = document.getElementById('statLifetimeNet');

	if (el24hEarnings) {
		setText(el24hEarnings, formatUsdc(earnings));
		el24hEarnings.className = 'stat-val pos';
	}
	if (el24hCosts) {
		setText(el24hCosts, formatUsdc(costs));
		el24hCosts.className = 'stat-val neg';
	}
	if (elLifetimeNet) {
		setText(elLifetimeNet, formatUsdc(lifetimeNet.toFixed(6)));
		elLifetimeNet.className = 'stat-val' + (lifetimeNet >= 0 ? ' pos' : ' neg');
	}
}

function renderReflection(reflection) {
	const card = document.getElementById('reflectionCard');
	if (!card) return;
	own(card);

	if (!reflection) {
		card.innerHTML = '<div class="reflection-text" style="color: var(--text-3); font-style: italic;">No reflection written yet today. The agent writes one per day, after its first tick past midnight UTC.</div>';
		return;
	}

	card.innerHTML = `
		<div class="reflection-text">${escapeHtml(reflection.summary)}</div>
		${reflection.strategy_notes
			? `<div class="reflection-strategy">${escapeHtml(reflection.strategy_notes)}</div>`
			: ''}
		<div class="reflection-date">${escapeHtml(reflection.date || '')}</div>
	`;
}

function renderActivityFeed(activities) {
	const feed = document.getElementById('activityFeed');
	if (!feed) return;
	own(feed);

	if (!activities || activities.length === 0) {
		feed.innerHTML = '<div class="empty-state">No activity logged yet.<span class="empty-hint">The agent ticks every 5 minutes; its first sense, think, earn cycle will appear here.</span></div>';
		return;
	}

	feed.innerHTML = activities.map((a) => {
		const type = a.action_type || 'unknown';
		const costNum = parseFloat(a.cost_usdc || 0);
		const revNum = parseFloat(a.revenue_usdc || 0);

		const metaParts = [escapeHtml(relativeTime(a.created_at))];
		if (costNum > 0) metaParts.push(`<span class="activity-cost">-${formatUsdc(a.cost_usdc)}</span>`);
		if (revNum > 0) metaParts.push(`<span class="activity-revenue">+${formatUsdc(a.revenue_usdc)}</span>`);

		return `
			<div class="activity-row">
				<span class="action-badge ${escapeHtml(type)}">${escapeHtml(type)}</span>
				<div class="activity-content">
					<div class="activity-desc" title="${escapeHtml(a.description || '')}">${escapeHtml(a.description || '')}</div>
					<div class="activity-meta">${metaParts.join(' · ')}</div>
				</div>
			</div>
		`;
	}).join('');
}

// `source` is what the rendered numbers actually are:
//   'live'   → a paid, real-time reading the visitor just unlocked
//   'public' → the free snapshot, up to one agent tick behind
//   'cache'  → the last reading this browser saw, while a fetch is failing
function renderFull(data, { source = 'public', savedAt = null, asOf = null } = {}) {
	const treasury = data.treasury || {};
	const atomics = treasury.balance_usdc_atomics || 0;

	renderBalance(atomics);
	renderStatus(data.status, treasury.runway_days);
	renderStats(data);
	renderReflection(data.latest_reflection);
	renderActivityFeed(data.recent_activity);

	const updatedEl = document.getElementById('heroUpdated');
	if (!updatedEl) return;
	own(updatedEl);

	if (source === 'live') {
		updatedEl.innerHTML = `<span class="data-source live">Live reading</span> · paid ${escapeHtml(relativeTime(new Date().toISOString()))}`;
	} else if (source === 'cache') {
		const age = savedAt ? relativeTime(savedAt) : 'earlier';
		updatedEl.innerHTML = `<span class="data-source">Last known reading</span> · from ${escapeHtml(age)}`;
	} else {
		const age = asOf ? relativeTime(asOf) : 'just now';
		updatedEl.innerHTML = `<span class="data-source">Free snapshot</span> · ${escapeHtml(age)} · refreshed every 5 min`;
	}
}

function renderPrice(priceUsdc) {
	const price = parseFloat(priceUsdc);
	if (!isFinite(price)) return;
	const priceEl = document.getElementById('priceDisplay');
	if (priceEl) setText(priceEl, `$${price.toFixed(2)}`);

	const btn = document.getElementById('donateBtn');
	if (btn) {
		setText(btn, `Unlock the live reading — $${price.toFixed(2)}`);
		btn.setAttribute('data-i18n-owned', '1');
		btn.setAttribute('aria-label', `Pay $${price.toFixed(2)} USDC for the live reading and fund the agent`);
	}
}

// Designed failure state. The visitor gets what broke, what they are looking at
// instead, and two ways forward: retry, or open the endpoint and see for
// themselves. Never a blank void and never stale numbers passed off as current.
function renderError(reason) {
	const banner = document.getElementById('heroError');
	const text = document.getElementById('heroErrorText');
	const cached = loadFromCache();

	if (text) {
		own(text).textContent = reason === 'db_unavailable'
			? "The agent's datastore is not answering, so its treasury cannot be read right now."
			: "The agent's status feed is unreachable right now.";
	}
	if (banner) banner.classList.add('show');

	if (cached?.data) {
		renderFull(cached.data, { source: 'cache', savedAt: cached.savedAt });
		return;
	}

	// Nothing cached: every panel says what happened rather than shimmering forever.
	const updatedEl = document.getElementById('heroUpdated');
	if (updatedEl) {
		own(updatedEl).innerHTML = '<span class="data-source">No reading available</span> · retrying automatically';
	}

	const balance = document.getElementById('balanceDisplay');
	if (balance) setText(balance, '$—');
	for (const id of ['stat24hEarnings', 'stat24hCosts', 'statLifetimeNet']) {
		const el = document.getElementById(id);
		if (el) { setText(el, '—'); el.className = 'stat-val'; }
	}
	renderStatus('unknown', NaN);
	const statusText = document.getElementById('statusText');
	if (statusText) setText(statusText, 'UNREACHABLE');

	const feed = document.getElementById('activityFeed');
	if (feed) {
		own(feed).innerHTML = `
			<div class="feed-error">
				<div class="feed-error-title">Activity feed unavailable</div>
				<div class="feed-error-body">The snapshot endpoint did not answer. This page retries on its own; you can also retry now.</div>
				<button class="btn" type="button" data-retry>Retry now</button>
			</div>
		`;
		feed.querySelector('[data-retry]')?.addEventListener('click', retryNow);
	}

	const card = document.getElementById('reflectionCard');
	if (card) {
		own(card).innerHTML = '<div class="reflection-text" style="color: var(--text-3); font-style: italic;">The latest reflection could not be loaded.</div>';
	}
}

function clearError() {
	const banner = document.getElementById('heroError');
	if (banner) banner.classList.remove('show');
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function fetchSnapshot() {
	let response;
	try {
		response = await fetch(PUBLIC_ENDPOINT, {
			method: 'GET',
			headers: { accept: 'application/json' },
		});
	} catch (err) {
		log.warn('[unstoppable-dashboard] fetch error:', err.message);
		return { ok: false, reason: 'network' };
	}

	if (!response.ok) {
		log.warn('[unstoppable-dashboard] unexpected status:', response.status);
		return { ok: false, reason: 'http_' + response.status };
	}

	let data = null;
	try {
		data = await response.json();
	} catch {
		return { ok: false, reason: 'malformed' };
	}

	// A reachable endpoint that cannot reach the database answers 200 with
	// available:false rather than fabricating a zeroed treasury.
	if (!data || data.available === false) {
		return { ok: false, reason: data?.reason || 'unavailable' };
	}

	return { ok: true, data };
}

// Returns true when the poll succeeded, so the scheduler can reset its backoff.
async function poll() {
	const result = await fetchSnapshot();

	if (result.ok) {
		clearError();
		renderFull(result.data, { source: 'public', asOf: result.data.as_of });
		renderPrice(result.data.live_price_usdc);
		saveToCache(result.data);
		return true;
	}

	renderError(result.reason);
	return false;
}

// Self-scheduling poll loop with exponential backoff: a healthy poll keeps the
// 60s cadence, a fault doubles the delay up to 5 minutes so a degraded API is
// not hammered, and the next success snaps it straight back to 60s.
let currentDelayMs = POLL_INTERVAL_MS;
let pollTimer = null;
let polling = false;

async function scheduledPoll() {
	if (polling) return;
	polling = true;
	let healthy = false;
	try {
		healthy = await poll();
	} catch (err) {
		log.warn('[unstoppable-dashboard] poll threw:', err?.message);
	} finally {
		polling = false;
	}

	currentDelayMs = healthy ? POLL_INTERVAL_MS : Math.min(currentDelayMs * 2, MAX_BACKOFF_MS);
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = setTimeout(scheduledPoll, currentDelayMs);
}

// Manual retry from an error state: fetch immediately instead of waiting out
// the backoff the fault just introduced.
function retryNow() {
	if (pollTimer) clearTimeout(pollTimer);
	currentDelayMs = POLL_INTERVAL_MS;
	scheduledPoll();
}

// ─── Paid unlock ──────────────────────────────────────────────────────────────

// Paying funds the agent for real: a settled x402 call to the status endpoint
// credits the treasury (recordRevenue) and returns the real-time state the
// payer just bought. The x402 checkout modal (window.X402, loaded from
// /x402.js) handles wallet connect, SIWX, and settlement on Base or Solana.
async function unlockLive() {
	const X402 = window.X402;
	if (!X402 || typeof X402.pay !== 'function') {
		showToast('Payment module still loading — please try again in a moment.');
		return;
	}

	const btn = document.getElementById('donateBtn');
	const retry = document.getElementById('donateRetry');
	try {
		if (btn) btn.disabled = true;
		if (retry) retry.classList.remove('show');
		const out = await X402.pay({
			endpoint: LIVE_ENDPOINT,
			method: 'GET',
			action: "Fund the Unstoppable Agent's runway",
		});
		if (!out?.ok) return;

		showToast('Payment confirmed — thank you for keeping the agent alive.');
		// The paid response IS the live reading the payer unlocked.
		if (out.result && typeof out.result === 'object' && out.result.treasury) {
			clearError();
			renderFull(out.result, { source: 'live' });
			saveToCache(out.result);
		} else {
			retryNow();
		}
	} catch (err) {
		if (err?.code === 'cancelled') return; // payer dismissed the checkout
		showToast('Payment failed: ' + String(err?.message || 'unknown error').slice(0, 80));
		// Keep the button live and surface a top-up path — the most common
		// failure here is an under-funded wallet, which a top-up + retry fixes.
		if (retry) retry.classList.add('show');
	} finally {
		// Re-enable so the payer can retry immediately after topping up.
		if (btn) btn.disabled = false;
	}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

export function init() {
	// Bound here rather than with onclick attributes: the site CSP is set up for
	// module scripts, and an inline handler would be a maintenance trap.
	document.getElementById('donateBtn')?.addEventListener('click', unlockLive);
	document.getElementById('retryBtn')?.addEventListener('click', retryNow);

	// Paint the last known reading immediately so the page is never blank while
	// the first fetch is in flight. The poll relabels it a second later.
	const cached = loadFromCache();
	if (cached?.data) renderFull(cached.data, { source: 'cache', savedAt: cached.savedAt });

	if (pollTimer) clearTimeout(pollTimer);
	scheduledPoll();

	// Re-poll when the tab comes back to the foreground: a dashboard left open
	// on a background tab is exactly where stale numbers go unnoticed.
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') retryNow();
	});
}

// Auto-init on DOMContentLoaded.
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
