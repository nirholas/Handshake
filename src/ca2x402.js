// CA → x402 — frontend surface.
//
// Paste any token contract address; get a live, payable x402 endpoint for that
// token's market intel. The page is a thin shell over two real endpoints:
//   • GET /api/ca2x402/resolve  — free: token identity + the generated service
//   • GET /api/x402/token-intel — the paid x402 service the snippets call
//
// Nothing here is sampled. When a CA has no market, we render a designed
// "not found" state; when the resolver is down we say so and offer a retry.

import { apiFetch } from './api.js';

const root = document.getElementById('cx-root');

// The platform coin is the canonical example — $THREE is the only coin three.ws
// promotes (CA pinned in CLAUDE.md). The tool itself accepts any address.
const EXAMPLE_CA = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const state = {
	ca: '',
	loading: false,
	result: null, // { token, service }
	error: null, // { code, message }
	challenge: null, // raw 402 body from the live endpoint
	challengeState: 'idle', // idle | loading | done | error
	tab: 'curl',
};

// ── utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortCa(m) { return m ? `${m.slice(0, 4)}…${m.slice(-4)}` : ''; }
function fmtUsd(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	if (v === 0) return '$0';
	if (v < 0.0001) return `$${v.toExponential(2)}`;
	if (v < 1) return `$${v.toPrecision(3)}`;
	return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
function fmtCompact(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	return `$${Number(n).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })}`;
}
function fmtPct(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function pctClass(n) { const v = Number(n); return v > 0 ? 'cx-pos' : v < 0 ? 'cx-neg' : ''; }
function looksLikeCa(s) {
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[a-fA-F0-9]{40}$/.test(s);
}

async function copy(text, btn) {
	try {
		await navigator.clipboard.writeText(text);
		if (btn) {
			const prev = btn.textContent;
			btn.textContent = 'Copied';
			btn.classList.add('cx-copied');
			setTimeout(() => { btn.textContent = prev; btn.classList.remove('cx-copied'); }, 1400);
		}
	} catch { /* clipboard blocked — no-op, the value is still visible */ }
}

// ── data ──────────────────────────────────────────────────────────────────────
async function resolve(ca) {
	state.loading = true;
	state.error = null;
	state.result = null;
	state.challenge = null;
	state.challengeState = 'idle';
	render();
	try {
		const r = await apiFetch(`/api/ca2x402/resolve?mint=${encodeURIComponent(ca)}`);
		const body = await r.json().catch(() => null);
		if (!r.ok || !body?.ok) {
			state.error = {
				code: body?.error || 'error',
				message: body?.error_description || 'Could not resolve that address.',
			};
		} else {
			state.result = body;
		}
	} catch {
		state.error = { code: 'network', message: 'Network error reaching the resolver. Check your connection and retry.' };
	} finally {
		state.loading = false;
		render();
	}
}

async function fetchChallenge() {
	const ep = state.result?.service?.endpoint;
	if (!ep) return;
	state.challengeState = 'loading';
	render();
	try {
		// Hit the real paid endpoint with no payment header — it answers 402 with
		// the exact payment requirements. This is the live proof, not a mock.
		const r = await fetch(ep, { headers: { Accept: 'application/json' } });
		const body = await r.json().catch(() => null);
		state.challenge = { status: r.status, body };
		state.challengeState = 'done';
	} catch {
		state.challengeState = 'error';
	}
	render();
}

// ── views ───────────────────────────────────────────────────────────────────
function hero() {
	return `
		<section class="cx-hero">
			<div class="cx-badge">x402 · agent-payable</div>
			<h1 id="cx-title">CA <span class="cx-arrow">→</span> x402</h1>
			<p class="cx-sub">
				Paste any token contract address. Get a live, payable <strong>x402 endpoint</strong>
				for its market intel — price, momentum, and a bullish/bearish signal — that any agent
				can call for <strong>$0.01 USDC</strong>. Discoverable in the bazaar. No keys, no backend.
			</p>
			<form class="cx-form" id="cx-form" autocomplete="off">
				<input
					id="cx-input"
					class="cx-input"
					type="text"
					inputmode="text"
					spellcheck="false"
					placeholder="Paste a token contract address (Solana mint or 0x…)"
					aria-label="Token contract address"
					value="${esc(state.ca)}"
				/>
				<button class="cx-go" type="submit" ${state.loading ? 'disabled' : ''}>
					${state.loading ? 'Resolving…' : 'Resolve →'}
				</button>
			</form>
			<div class="cx-examples">
				<span>Try it:</span>
				<button class="cx-chip" data-ca="${EXAMPLE_CA}" type="button">$THREE</button>
				<span class="cx-chip-hint">${shortCa(EXAMPLE_CA)}</span>
			</div>
		</section>`;
}

function emptyState() {
	const steps = [
		['Paste', 'Any Solana mint or EVM contract address.'],
		['Resolve', 'We pull its live market from DexScreener and brand a signal to its ticker.'],
		['Ship', 'You get a payable x402 endpoint + copy-paste snippets, live in the bazaar.'],
	];
	return `
		<section class="cx-empty">
			<div class="cx-steps">
				${steps.map(([h, b], i) => `
					<div class="cx-step">
						<div class="cx-step-n">${i + 1}</div>
						<div><div class="cx-step-h">${esc(h)}</div><div class="cx-step-b">${esc(b)}</div></div>
					</div>`).join('')}
			</div>
		</section>`;
}

function loadingState() {
	return `
		<section class="cx-card cx-skeleton" aria-busy="true" aria-label="Resolving">
			<div class="cx-sk-row"><div class="cx-sk cx-sk-av"></div><div class="cx-sk-lines"><div class="cx-sk cx-sk-l1"></div><div class="cx-sk cx-sk-l2"></div></div></div>
			<div class="cx-sk-grid">${Array.from({ length: 4 }).map(() => '<div class="cx-sk cx-sk-cell"></div>').join('')}</div>
		</section>`;
}

function errorState() {
	const e = state.error;
	const isNotFound = e.code === 'token_not_found';
	return `
		<section class="cx-card cx-error">
			<div class="cx-error-ic" aria-hidden="true">${isNotFound ? '∅' : '!'}</div>
			<h2>${isNotFound ? 'No market found for that address' : 'Could not resolve'}</h2>
			<p>${esc(e.message)}</p>
			<button class="cx-retry" id="cx-retry" type="button">Try another address</button>
		</section>`;
}

function signalPill(sig) {
	if (!sig) return '';
	const map = { bullish: 'cx-bull', bearish: 'cx-bear', neutral: 'cx-neu' };
	return `<span class="cx-pill ${map[sig] || 'cx-neu'}">${esc(sig)}</span>`;
}

// Multi-timeframe momentum strip — m5 / 1h / 6h / 24h price change. Shows the
// shape of the move (accelerating vs. fading), not just its 24h endpoint.
function momentumStrip(m) {
	if (!m) return '';
	const cells = [['5m', m.m5], ['1h', m.h1], ['6h', m.h6], ['24h', m.h24]];
	if (cells.every(([, v]) => v == null)) return '';
	return `
		<div class="cx-momentum" role="group" aria-label="Momentum by timeframe">
			${cells.map(([k, v]) => `
				<div class="cx-mom">
					<div class="cx-mom-k">${k}</div>
					<div class="cx-mom-v ${pctClass(v)}">${fmtPct(v)}</div>
				</div>`).join('')}
		</div>`;
}

// Risk panel — the due-diligence score (0 safe … 100 critical) and the factors
// behind it. The headline number is what someone screenshots before aping in.
function riskPanel(r) {
	if (!r || typeof r.score !== 'number') return '';
	const lvl = r.level || 'medium';
	return `
		<div class="cx-risk cx-risk-${esc(lvl)}">
			<div class="cx-risk-head">
				<div class="cx-risk-gauge" style="--cx-risk:${Math.max(0, Math.min(100, r.score))}">
					<div class="cx-risk-score">${r.score}</div>
					<div class="cx-risk-100">/100</div>
				</div>
				<div class="cx-risk-id">
					<div class="cx-risk-label">Risk score <span class="cx-risk-lvl">${esc(lvl)}</span></div>
					<div class="cx-risk-summary">${esc(r.summary || '')}</div>
				</div>
			</div>
			${Array.isArray(r.factors) && r.factors.length ? `
				<ul class="cx-risk-factors">
					${r.factors.map((f) => `
						<li class="cx-rf cx-rf-${esc(f.status || 'unknown')}">
							<span class="cx-rf-dot" aria-hidden="true"></span>
							<span class="cx-rf-label">${esc(f.label)}</span>
							<span class="cx-rf-detail">${esc(f.detail)}</span>
						</li>`).join('')}
				</ul>` : ''}
		</div>`;
}

function tokenCard(t) {
	const chain = t.chain ? `<span class="cx-chain">${esc(t.chain)}</span>` : '';
	const avatar = t.image
		? `<img class="cx-av" src="${esc(t.image)}" alt="" loading="lazy" data-fallback="element" data-fallback-class="cx-av cx-av-ph" data-fallback-text="${esc((t.symbol || '?').slice(0, 2))}" />`
		: `<div class="cx-av cx-av-ph">${esc((t.symbol || '?').slice(0, 2))}</div>`;
	const stats = [
		['Price', fmtUsd(t.price_usd)],
		['24h', `<span class="${pctClass(t.change_24h)}">${fmtPct(t.change_24h)}</span>`],
		['Market cap', fmtCompact(t.market_cap_usd)],
		['Liquidity', fmtCompact(t.liquidity_usd)],
		['24h volume', fmtCompact(t.volume_24h_usd)],
	];
	return `
		<section class="cx-card cx-token">
			<div class="cx-token-head">
				${avatar}
				<div class="cx-token-id">
					<div class="cx-token-sym">${esc(t.symbol || 'Unknown')} ${chain}</div>
					<div class="cx-token-name">${esc(t.name || '')}</div>
					<button class="cx-mint" type="button" data-copy="${esc(t.mint)}" title="Copy contract address">
						${shortCa(t.mint)} <span class="cx-mint-ic">⧉</span>
					</button>
				</div>
				${t.signal ? `<div class="cx-token-sig">${signalPill(t.signal)}</div>` : ''}
			</div>
			<div class="cx-stats">
				${stats.map(([k, v]) => `<div class="cx-stat"><div class="cx-stat-k">${k}</div><div class="cx-stat-v">${v}</div></div>`).join('')}
			</div>
			${t.headline ? `<div class="cx-signal"><div class="cx-signal-h">${esc(t.headline)}</div><div class="cx-signal-r">${esc(t.rationale || '')}</div></div>` : ''}
			${t.pair_url ? `<a class="cx-dexlink" href="${esc(t.pair_url)}" target="_blank" rel="noopener">View pair on ${esc(t.dex || 'DEX')} ↗</a>` : ''}
		</section>`;
}

function serviceCard(s) {
	const nets = (s.networks || []).map((n) => `<span class="cx-net cx-net-${esc(n)}">${esc(n)}</span>`).join('');
	const tabs = [['curl', 'cURL'], ['node', 'Node'], ['agent', 'Agent']];
	const snippet = s.snippets?.[state.tab] || '';
	return `
		<section class="cx-card cx-service">
			<div class="cx-service-top">
				<div>
					<div class="cx-service-label">Your x402 endpoint</div>
					<button class="cx-endpoint" type="button" data-copy="${esc(s.endpoint)}" title="Copy endpoint URL">
						<span class="cx-method">GET</span>
						<span class="cx-url">${esc(s.endpoint)}</span>
						<span class="cx-mint-ic">⧉</span>
					</button>
				</div>
			</div>
			<div class="cx-service-meta">
				<div class="cx-meta"><span class="cx-meta-k">Price</span><span class="cx-meta-v">${fmtUsd(s.price_usd)} <em>${esc(s.asset || 'USDC')}</em></span></div>
				<div class="cx-meta"><span class="cx-meta-k">Networks</span><span class="cx-meta-v cx-nets">${nets}</span></div>
				<div class="cx-meta"><span class="cx-meta-k">Discovery</span><span class="cx-meta-v">${s.bazaar_discoverable ? '<span class="cx-ok">● in bazaar</span>' : '—'}</span></div>
			</div>

			<div class="cx-snippets">
				<div class="cx-tabs" role="tablist" aria-label="Call snippets">
					${tabs.map(([id, label]) => `<button class="cx-tab ${state.tab === id ? 'cx-tab-on' : ''}" role="tab" aria-selected="${state.tab === id}" data-tab="${id}" type="button">${label}</button>`).join('')}
				</div>
				<div class="cx-code-wrap">
					<button class="cx-copy" type="button" data-copy="${esc(snippet)}">Copy</button>
					<pre class="cx-code"><code>${esc(snippet)}</code></pre>
				</div>
			</div>

			<div class="cx-challenge">
				<button class="cx-challenge-btn" id="cx-challenge-btn" type="button" ${state.challengeState === 'loading' ? 'disabled' : ''}>
					${state.challengeState === 'loading' ? 'Fetching…' : 'Fetch the live 402 challenge'}
				</button>
				<span class="cx-challenge-hint">Calls the real endpoint with no payment — see the exact requirements an agent would settle.</span>
				${renderChallenge()}
			</div>
		</section>`;
}

function renderChallenge() {
	if (state.challengeState === 'idle') return '';
	if (state.challengeState === 'error') {
		return `<div class="cx-challenge-out cx-challenge-err">Endpoint unreachable. Retry in a moment.</div>`;
	}
	if (state.challengeState === 'done' && state.challenge) {
		const { status, body } = state.challenge;
		const pretty = JSON.stringify(body, null, 2);
		return `
			<div class="cx-challenge-out">
				<div class="cx-challenge-status">HTTP <strong>${status}</strong> ${status === 402 ? 'Payment Required — exactly what a buyer settles against' : ''}</div>
				<pre class="cx-code cx-code-sm"><code>${esc(pretty)}</code></pre>
			</div>`;
	}
	return '';
}

function render() {
	let body;
	if (state.loading) body = loadingState();
	else if (state.error) body = errorState();
	else if (state.result) body = tokenCard(state.result.token) + serviceCard(state.result.service);
	else body = emptyState();

	root.innerHTML = hero() + `<div class="cx-results">${body}</div>`;
	wire();
}

// ── events ──────────────────────────────────────────────────────────────────
function wire() {
	const form = document.getElementById('cx-form');
	const input = document.getElementById('cx-input');
	form?.addEventListener('submit', (e) => {
		e.preventDefault();
		const ca = (input.value || '').trim();
		if (!ca) return;
		if (!looksLikeCa(ca)) {
			state.error = { code: 'invalid_mint', message: 'That does not look like a Solana mint or 0x contract address.' };
			state.result = null;
			render();
			return;
		}
		state.ca = ca;
		syncUrl(ca);
		resolve(ca);
	});

	root.querySelectorAll('.cx-chip').forEach((c) => c.addEventListener('click', () => {
		const ca = c.dataset.ca;
		state.ca = ca;
		if (input) input.value = ca;
		syncUrl(ca);
		resolve(ca);
	}));

	root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b.classList.contains('cx-copy') ? b : null)));

	root.querySelectorAll('.cx-tab').forEach((t) => t.addEventListener('click', () => {
		state.tab = t.dataset.tab;
		render();
	}));

	document.getElementById('cx-retry')?.addEventListener('click', () => {
		state.error = null;
		state.ca = '';
		syncUrl('');
		render();
		document.getElementById('cx-input')?.focus();
	});

	document.getElementById('cx-challenge-btn')?.addEventListener('click', fetchChallenge);
}

function syncUrl(ca) {
	const u = new URL(window.location.href);
	if (ca) u.searchParams.set('ca', ca);
	else u.searchParams.delete('ca');
	window.history.replaceState(null, '', u);
}

// ── boot ──────────────────────────────────────────────────────────────────────
const initial = new URL(window.location.href).searchParams.get('ca');
if (initial && looksLikeCa(initial.trim())) {
	state.ca = initial.trim();
	render();
	resolve(state.ca);
} else {
	render();
}
