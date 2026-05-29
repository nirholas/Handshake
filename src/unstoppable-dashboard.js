// Unstoppable Agent dashboard — polls the paid status endpoint and renders
// live agent state: balance, runway, activity feed, and daily reflection.
//
// Behavior:
//   - Polls GET /api/agents/unstoppable-status every 60 seconds.
//   - On 200: renders live data, stores in localStorage.
//   - On 402: parses challenge body, shows payment requirement notice.
//   - Falls back to localStorage cache for display while unpaid.

const STATUS_ENDPOINT = '/api/agents/unstoppable-status';
const POLL_INTERVAL_MS = 60_000;
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
	el.textContent = formatted;
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
			statusText.textContent = 'CONSERVING';
		} else if (status === 'halted') {
			badge.classList.add('badge-halted');
			statusText.textContent = 'HALTED';
		} else {
			badge.classList.add('badge-running');
			statusText.textContent = 'RUNNING';
		}
	}

	if (runwayBadge) {
		const days = parseFloat(runwayDays);
		runwayBadge.textContent = isFinite(days) && days < 9990
			? `Runway: ${days.toFixed(1)} days`
			: 'Runway: stable';
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
		el24hEarnings.textContent = formatUsdc(earnings);
		el24hEarnings.className = 'stat-val pos';
	}
	if (el24hCosts) {
		el24hCosts.textContent = formatUsdc(costs);
		el24hCosts.className = 'stat-val neg';
	}
	if (elLifetimeNet) {
		elLifetimeNet.textContent = formatUsdc(lifetimeNet.toFixed(6));
		elLifetimeNet.className = 'stat-val' + (lifetimeNet >= 0 ? ' pos' : ' neg');
	}
}

function renderReflection(reflection) {
	const card = document.getElementById('reflectionCard');
	if (!card) return;

	if (!reflection) {
		card.innerHTML = '<div class="reflection-text" style="color: var(--text-3); font-style: italic;">No reflection written yet today.</div>';
		return;
	}

	card.innerHTML = `
		<div class="reflection-text">${escapeHtml(reflection.summary)}</div>
		${reflection.strategy_notes
			? `<div class="reflection-strategy">${escapeHtml(reflection.strategy_notes)}</div>`
			: ''}
		<div class="reflection-date">${reflection.date || ''}</div>
	`;
}

function renderActivityFeed(activities) {
	const feed = document.getElementById('activityFeed');
	if (!feed) return;

	if (!activities || activities.length === 0) {
		feed.innerHTML = '<div class="empty-state">No activity yet.</div>';
		return;
	}

	feed.innerHTML = activities.map((a) => {
		const type = a.action_type || 'unknown';
		const costNum = parseFloat(a.cost_usdc || 0);
		const revNum = parseFloat(a.revenue_usdc || 0);

		let metaParts = [relativeTime(a.created_at)];
		if (costNum > 0) metaParts.push(`<span class="activity-cost">-${formatUsdc(a.cost_usdc)}</span>`);
		if (revNum > 0) metaParts.push(`<span class="activity-revenue">+${formatUsdc(a.revenue_usdc)}</span>`);

		return `
			<div class="activity-row">
				<span class="action-badge ${escapeHtml(type)}">${escapeHtml(type)}</span>
				<div class="activity-content">
					<div class="activity-desc">${escapeHtml(a.description || '')}</div>
					<div class="activity-meta">${metaParts.join(' · ')}</div>
				</div>
			</div>
		`;
	}).join('');
}

function renderFull(data, { fromCache = false } = {}) {
	const treasury = data.treasury || {};
	const atomics = treasury.balance_usdc_atomics || 0;

	renderBalance(atomics);
	renderStatus(data.status, treasury.runway_days);
	renderStats(data);
	renderReflection(data.latest_reflection);
	renderActivityFeed(data.recent_activity);

	const updatedEl = document.getElementById('heroUpdated');
	if (updatedEl) {
		if (fromCache) {
			updatedEl.textContent = 'Showing cached data — live data costs $0.01 per query';
		} else {
			updatedEl.textContent = 'Updated ' + relativeTime(new Date().toISOString());
		}
	}
}

function renderPaymentRequired(challenge) {
	// Parse price from the challenge accepts array.
	let priceUsdc = '0.01';
	try {
		const firstAccept = challenge?.accepts?.[0];
		if (firstAccept?.amount) {
			priceUsdc = (parseInt(firstAccept.amount, 10) / 1_000_000).toFixed(4);
		}
	} catch {
		// Use default.
	}

	const priceEl = document.getElementById('priceDisplay');
	if (priceEl) priceEl.textContent = `$${priceUsdc}`;

	const notice = document.getElementById('paymentNotice');
	if (notice) notice.style.display = '';

	const updatedEl = document.getElementById('heroUpdated');
	if (updatedEl) updatedEl.textContent = 'Payment required for live data';
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

// ─── Polling ──────────────────────────────────────────────────────────────────

async function fetchStatus() {
	let response;
	try {
		response = await fetch(STATUS_ENDPOINT, {
			method: 'GET',
			headers: { 'accept': 'application/json' },
		});
	} catch (err) {
		console.warn('[unstoppable-dashboard] fetch error:', err.message);
		return null;
	}

	if (response.status === 200) {
		const data = await response.json();
		saveToCache(data);
		return { ok: true, data };
	}

	if (response.status === 402) {
		let challenge = null;
		try {
			challenge = await response.json();
		} catch {
			// Response might not be JSON.
		}
		return { ok: false, status: 402, challenge };
	}

	console.warn('[unstoppable-dashboard] unexpected status:', response.status);
	return null;
}

async function poll() {
	const result = await fetchStatus();

	if (result?.ok) {
		renderFull(result.data);
		const notice = document.getElementById('paymentNotice');
		if (notice) notice.style.display = 'none';
		return;
	}

	if (result?.status === 402) {
		renderPaymentRequired(result.challenge);
		// Show cached data if available.
		const cached = loadFromCache();
		if (cached?.data) {
			renderFull(cached.data, { fromCache: true });
		} else {
			// No cache — show zeroed state.
			const el = document.getElementById('balanceDisplay');
			if (el) el.textContent = '—';
			const activityFeed = document.getElementById('activityFeed');
			if (activityFeed) activityFeed.innerHTML = '<div class="empty-state">Pay $0.01 to see live data.</div>';
			const card = document.getElementById('reflectionCard');
			if (card) card.innerHTML = '<div class="reflection-text" style="color: var(--text-3); font-style: italic;">Pay to unlock live reflections.</div>';
		}
		return;
	}

	// Network or server error — try to show cache.
	const cached = loadFromCache();
	if (cached?.data) {
		renderFull(cached.data, { fromCache: true });
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Donating funds the agent for real: a paid x402 call to the status endpoint
// credits the treasury (recordRevenue) and returns the live state the donor
// just paid for. The x402 checkout modal (window.X402, loaded from /x402.js)
// handles wallet connect, SIWX, and settlement on Base or Solana.
async function donate() {
	const X402 = window.X402;
	if (!X402 || typeof X402.pay !== 'function') {
		showToast('Payment module still loading — please try again in a moment.');
		return;
	}

	const btn = document.getElementById('donateBtn');
	try {
		if (btn) btn.disabled = true;
		const out = await X402.pay({
			endpoint: STATUS_ENDPOINT,
			method: 'GET',
			action: "Fund the Unstoppable Agent's runway",
		});
		if (!out?.ok) return;

		showToast('Donation confirmed — thank you for keeping the agent alive.');
		// The paid response is the live status the donor unlocked.
		if (out.result && typeof out.result === 'object') {
			renderFull(out.result);
			saveToCache(out.result);
			const notice = document.getElementById('paymentNotice');
			if (notice) notice.style.display = 'none';
		} else {
			poll();
		}
	} catch (err) {
		if (err?.code === 'cancelled') return; // donor dismissed the checkout
		showToast('Payment failed: ' + String(err?.message || 'unknown error').slice(0, 80));
	} finally {
		if (btn) btn.disabled = false;
	}
}

export function init() {
	// Expose public methods for onclick handlers.
	window.__unstoppable = { donate };

	// Show cached data immediately while we fetch.
	const cached = loadFromCache();
	if (cached?.data) {
		renderFull(cached.data, { fromCache: true });
	}

	// First poll immediately, then on interval.
	poll();
	setInterval(poll, POLL_INTERVAL_MS);

	// Update relative timestamps every 30s without re-fetching.
	setInterval(() => {
		const updatedEl = document.getElementById('heroUpdated');
		if (updatedEl && !updatedEl.textContent.includes('Showing cached') && !updatedEl.textContent.includes('Payment required')) {
			updatedEl.textContent = 'Updated ' + relativeTime(new Date().toISOString());
		}
	}, 30_000);
}

// Auto-init on DOMContentLoaded.
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
