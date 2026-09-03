// Public $THREE coin page (/three-token).
//
// The canonical, trustworthy page for the protocol token: a live price header,
// the real bonding-curve chart, a streaming trade tape, and a one-click buy.
// Reuses the shared $THREE store (single source of truth) for the header, the
// bonding-curve widget, the SSE trade stream, and the Jupiter swap modal — no
// bespoke data plumbing, no mock data.

import { createThreeTokenData, THREE_MINT } from './pump/three-token-data.js';
import { mountBondingCurve } from './widgets/bonding-curve.js';
import { openSwapModal } from './swap-jupiter.js';
import { trackFunnelStep, ANALYTICS_EVENTS } from './analytics.js';
import { emptyStateHTML, errorStateHTML, ensureStateKitStyles } from './shared/state-kit.js';
import { paintVerifiedBadge } from './pump/verified-badge.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_URL = `https://pump.fun/coin/${THREE_MINT}`;
const MAX_TAPE_ROWS = 40;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── formatters ──────────────────────────────────────────────────────────────
const fmtUsd = (n, max = 2) => {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v !== 0 && Math.abs(v) < 1 ? 6 : max });
};
const fmtCompactUsd = (n) => {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
	if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
	if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
	return fmtUsd(v);
};
const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
const fmtPct = (n) => {
	const v = Number(n);
	if (!Number.isFinite(v)) return '';
	const s = v >= 0 ? '+' : '';
	return `${s}${v.toFixed(2)}%`;
};
const shortAddr = (a) => { const s = String(a || ''); return s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Clipboard with a real fallback: navigator.clipboard is undefined on http
// origins and can be permission-denied, so drop to a selection copy before
// reporting failure. Returns whether the text actually made it to the clipboard.
async function copyText(text) {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch { /* fall through to the selection path */ }
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
	document.body.appendChild(ta);
	try {
		ta.select();
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		ta.remove();
	}
}

const relTime = (sec) => {
	const d = Math.max(0, Math.floor(Date.now() / 1000 - Number(sec || 0)));
	if (d < 60) return `${d}s`;
	if (d < 3600) return `${Math.floor(d / 60)}m`;
	return `${Math.floor(d / 3600)}h`;
};

// ── styles ──────────────────────────────────────────────────────────────────
function injectStyles() {
	const css = `
	:root { color-scheme: dark; }
	html { scroll-behavior: smooth; }
	* { box-sizing: border-box; }
	body { margin:0; background:#0a0a0d; color:#f5f5f7; font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
	a { color:inherit; }
	.tk-wrap { max-width:1080px; margin:0 auto; padding:24px 18px 64px; }
	.tk-head { display:flex; align-items:center; gap:14px; margin-bottom:4px; }
	.tk-logo { width:46px; height:46px; border-radius:12px; background:#111116; border:1px solid #232329; display:grid; place-items:center; flex-shrink:0; overflow:hidden; }
	.tk-logo img { width:32px; height:32px; display:block; }
	.tk-titlerow { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
	.tk-title { font-size:26px; font-weight:800; margin:0; letter-spacing:-0.02em; }
	.tk-sub { margin:0; color:#9a9aa3; font-size:13px; }
	.tk-ca { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; color:#8a8a93; cursor:pointer; border:1px solid #232329; border-radius:8px; padding:3px 8px; background:none; }
	.tk-ca:hover { color:#fff; border-color:#3a3a42; }
	.tk-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:18px 0 22px; }
	.tk-stat { background:#111116; border:1px solid #1d1d24; border-radius:12px; padding:14px 16px; }
	.tk-stat-l { font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:#7d7d86; margin-bottom:5px; }
	.tk-stat-v { font-size:22px; font-weight:700; font-family:ui-monospace,Menlo,monospace; }
	.tk-why { margin:2px 0 22px; }
	.tk-why h2 { font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#7d7d86; margin:0 0 12px; }
	.tk-why-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(212px,1fr)); gap:12px; }
	.tk-why-card { background:#111116; border:1px solid #1d1d24; border-radius:12px; padding:15px 16px; transition:border-color .15s,transform .12s; }
	.tk-why-card:hover { border-color:#2a2a32; transform:translateY(-2px); }
	.tk-why-ico { font-size:19px; line-height:1; margin-bottom:9px; }
	.tk-why-t { font-size:14px; font-weight:700; margin:0 0 5px; letter-spacing:-0.01em; color:#f5f5f7; }
	.tk-why-d { font-size:12.5px; color:#9a9aa3; line-height:1.5; margin:0; }
	.tk-why-d b { color:#4ade80; font-weight:700; }
	.tk-why-link { display:inline-block; margin-top:9px; font-size:12px; color:#7CC4FF; text-decoration:none; }
	.tk-why-link:hover { text-decoration:underline; }
	.tk-grid { display:grid; grid-template-columns:1.1fr 0.9fr; gap:18px; }
	@media (max-width:820px){ .tk-grid { grid-template-columns:1fr; } }
	/* Grid/flex children default to min-width:auto, so a wide monospace row
	   (a trade line, a buyback receipt) grows its track past the viewport and
	   clips off-screen at 320px. Let every track shrink to its box instead. */
	.tk-grid > *, .tk-card, .tk-trade, .tk-trade > *, .tk-bb-run, .tk-bb-run > *, .tk-bb-head > * { min-width:0; }
	.tk-card { background:#111116; border:1px solid #1d1d24; border-radius:14px; padding:18px; }
	.tk-card h2 { font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:#7d7d86; margin:0 0 12px; }
	.tk-buy { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
	.tk-btn { appearance:none; border:1px solid #2a2a32; background:#1a1a20; color:#fff; border-radius:10px; padding:11px 18px; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:8px; transition:background .15s,border-color .15s,transform .1s; }
	.tk-btn:hover { background:#23232b; border-color:#3a3a44; }
	.tk-btn:active { transform:translateY(1px); }
	.tk-btn.primary { background:linear-gradient(135deg,#fff,#cfcfd6); color:#000; border:none; }
	.tk-btn.primary:hover { filter:brightness(0.95); }
	.tk-btn:focus-visible { outline:2px solid #7CC4FF; outline-offset:2px; }
	.tk-wrap a:focus-visible, .tk-ca:focus-visible { outline:2px solid #7CC4FF; outline-offset:2px; border-radius:6px; }
	.tk-tape { display:flex; flex-direction:column; gap:2px; max-height:430px; overflow-y:auto; }
	.tk-trade { display:grid; grid-template-columns:54px 1fr auto; gap:8px; align-items:center; padding:8px 10px; border-radius:8px; font-size:13px; }
	.tk-trade.buy { background:rgba(74,222,128,0.07); }
	.tk-trade.sell { background:rgba(248,113,113,0.07); }
	.tk-trade.in { animation:tkIn .35s ease; }
	@keyframes tkIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }
	.tk-side { font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; }
	.tk-side.buy { color:#4ade80; } .tk-side.sell { color:#f87171; }
	.tk-trader { font-family:ui-monospace,Menlo,monospace; color:#b8b8c0; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; }
	.tk-trader:hover { color:#fff; }
	.tk-amt { font-family:ui-monospace,Menlo,monospace; text-align:right; }
	.tk-amt small { color:#7d7d86; }
	.tk-status { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:#7d7d86; }
	.tk-dot { width:7px; height:7px; border-radius:50%; background:#4ade80; box-shadow:0 0 8px #4ade80; }
	.tk-dot.off { background:#f87171; box-shadow:none; }
	.tk-empty { text-align:center; color:#7d7d86; font-size:13px; padding:40px 0; }
	.tk-stats-err { grid-column:1/-1; }
	.tk-skel { background:linear-gradient(90deg,#16161c,#1d1d24,#16161c); background-size:200% 100%; animation:tkSh 1.4s infinite; border-radius:10px; }
	@keyframes tkSh { from { background-position:200% 0; } to { background-position:-200% 0; } }
	.tk-foot { display:flex; gap:18px; flex-wrap:wrap; margin-top:26px; font-size:13px; }
	.tk-foot a { color:#9a9aa3; text-decoration:none; } .tk-foot a:hover { color:#fff; }
	.tk-bb { margin-top:18px; }
	.tk-bb-commit { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin:0 0 8px; }
	.tk-bb-commit b { font-size:30px; line-height:1; font-weight:800; font-family:ui-monospace,Menlo,monospace; background:linear-gradient(90deg,#4ade80,#22d3ee); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
	.tk-bb-commit em { font-style:normal; color:#d8d8e0; font-size:14px; font-weight:600; }
	.tk-bb-lead { color:#9a9aa3; font-size:13px; margin:0 0 14px; line-height:1.55; }
	.tk-bb-empty { color:#b8b8c0; font-size:14px; line-height:1.6; }
	.tk-bb-empty strong { color:#f5f5f7; }
	.tk-bb-empty span { display:block; color:#7d7d86; font-size:13px; margin-top:6px; }
	.tk-bb-head { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:14px; }
	.tk-bb-k { font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:#7d7d86; margin-bottom:4px; }
	.tk-bb-v { font-size:19px; font-weight:700; font-family:ui-monospace,Menlo,monospace; }
	.tk-bb-bar { height:8px; border-radius:6px; background:#1d1d24; overflow:hidden; }
	.tk-bb-bar span { display:block; height:100%; background:linear-gradient(90deg,#4ade80,#22d3ee); border-radius:6px; transition:width .6s ease; }
	.tk-bb-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:10px; font-size:12.5px; color:#7d7d86; }
	.tk-bb-foot a { color:#7CC4FF; text-decoration:none; } .tk-bb-foot a:hover { text-decoration:underline; }
	.tk-bb-runs-h { font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:#7d7d86; margin:18px 0 8px; }
	.tk-bb-runs { display:flex; flex-direction:column; gap:3px; }
	.tk-bb-run { display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center; padding:8px 10px; border-radius:8px; font-size:12.5px; background:#0e0e12; border:1px solid #16161c; }
	.tk-bb-run:hover { background:#15151b; border-color:#23232b; }
	.tk-bb-run-date { color:#7d7d86; font-family:ui-monospace,Menlo,monospace; }
	.tk-bb-run-amt { font-family:ui-monospace,Menlo,monospace; color:#d8d8e0; }
	.tk-bb-run-amt b { color:#4ade80; font-weight:700; }
	.tk-bb-run a { color:#7CC4FF; text-decoration:none; justify-self:end; white-space:nowrap; }
	.tk-bb-run a:hover { text-decoration:underline; }
	@media (max-width:560px){ .tk-bb-head { grid-template-columns:repeat(2,1fr); gap:8px; } }
	@media (prefers-reduced-motion: reduce){ html { scroll-behavior:auto; } .tk-trade.in { animation:none; } .tk-skel { animation:none; } .tk-bb-bar span { transition:none; } .tk-why-card { transition:none; } }
	`;
	const el = document.createElement('style');
	el.textContent = css;
	document.head.appendChild(el);
}

// ── header (price + protocol stats) from the shared store ───────────────────
function renderHeaderStats(token) {
	const stats = [
		{ l: 'Price', v: fmtUsd(token.price_usd, 6), sub: token.price_change_24h != null ? fmtPct(token.price_change_24h) : '' },
		{ l: 'Market Cap', v: fmtCompactUsd(token.market_cap) },
		{ l: '24h Volume', v: fmtCompactUsd(token.volume_24h) },
		{ l: 'Holders', v: token.holders != null ? fmtNum(token.holders) : '—' },
	];
	return stats.map((s) => {
		const up = s.sub?.startsWith('+');
		return `<div class="tk-stat">
			<div class="tk-stat-l">${esc(s.l)}</div>
			<div class="tk-stat-v">${s.v}</div>
			${s.sub ? `<div style="font-size:12px;margin-top:3px;color:${up ? '#4ade80' : '#f87171'}">${s.sub} 24h</div>` : ''}
		</div>`;
	}).join('');
}

// ── why hold $THREE — the four real utility pillars ──────────────────────────
// Each line maps to a live mechanism in the codebase (buyback engine, reflections
// split leg, hold-to-access tiers, deploy/spend sinks) — concrete, not marketing.
// The buyback % is wired to the live commitment so the headline is always current.
function renderWhyHold(commitPct) {
	const pct = Number.isFinite(Number(commitPct)) ? Number(commitPct) : 50;
	const pctLabel = `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
	const pillars = [
		{ ico: '🔄', t: 'Revenue buybacks', d: `<b>${pctLabel}</b> of all platform revenue buys $THREE on the open market and routes it to the treasury — on-chain, verifiable.`, link: { href: '#tk-bb-proof', label: 'See the proof ↓' } },
		{ ico: '💸', t: 'Holder rewards', d: 'Every paid action reflects $THREE back to holders pro-rata — deflation-free yield, no burn.' },
		{ ico: '🎟️', t: 'Hold to access', d: 'Hold $THREE to unlock fee discounts, higher quotas, and pro perks across the platform.', link: { href: '/dashboard/three-token', label: 'View tiers →' } },
		{ ico: '⚙️', t: 'Powers the economy', d: '$THREE is spent to deploy agents, forge avatars, and trade the marketplace — real usage, real demand.' },
	];
	return `<h2>Why hold $THREE</h2><div class="tk-why-grid">${pillars
		.map(
			(p) => `<div class="tk-why-card">
				<div class="tk-why-ico" aria-hidden="true">${p.ico}</div>
				<p class="tk-why-t">${esc(p.t)}</p>
				<p class="tk-why-d">${p.d}</p>
				${p.link ? `<a class="tk-why-link" href="${p.link.href}">${esc(p.link.label)}</a>` : ''}
			</div>`,
		)
		.join('')}</div>`;
}

// ── programmatic buybacks (revenue → $THREE → treasury) ──────────────────────
const fmtRunDate = (at) => (at ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

// The verifiable receipt list: each confirmed buy, clickable to its Solscan tx.
// Proof, not a claim — this is what answers "why hold $THREE".
function renderBuybackRuns(runs) {
	if (!Array.isArray(runs) || !runs.length) return '';
	const rows = runs
		.filter((r) => r && r.signature)
		.map((r) => {
			const amt = `${fmtUsd(r.usdc)} → <b>${fmtNum(r.three)}</b> $THREE`;
			return `<div class="tk-bb-run">
				<span class="tk-bb-run-date">${esc(fmtRunDate(r.at))}</span>
				<span class="tk-bb-run-amt">${amt}</span>
				<a href="https://solscan.io/tx/${esc(r.signature)}" target="_blank" rel="noopener" title="Verify on Solscan">Verify ↗</a>
			</div>`;
		})
		.join('');
	if (!rows) return '';
	return `<div class="tk-bb-runs-h">Verifiable buybacks — every buy, on-chain</div><div class="tk-bb-runs">${rows}</div>`;
}

function renderBuyback(bb) {
	if (!bb) {
		return errorStateHTML({
			title: 'Buyback data is unavailable',
			body: 'The protocol stats feed didn’t respond. Every buyback is on-chain, so you can verify the treasury directly while this reconnects.',
			actions: [
				{ label: 'Retry', id: 'bb-retry', primary: true },
				{ label: 'Verify on Solscan', id: 'bb-solscan' },
			],
		});
	}
	const revenue = fmtUsd(bb.revenue_usd);
	// The published promise — the headline a holder repeats. Defaults guard a
	// partial payload so the commitment always renders.
	const commitPct = Number.isFinite(Number(bb.commit_pct)) ? Number(bb.commit_pct) : 50;
	const commitLabel = `${commitPct % 1 === 0 ? commitPct.toFixed(0) : commitPct.toFixed(1)}%`;
	const commit = `<div class="tk-bb-commit"><b>${commitLabel}</b><em>of all platform revenue → $THREE buybacks</em></div>`;
	const lead = `The $THREE protocol commits a fixed share of platform revenue to buying $THREE on the open market and routing it to the treasury — on-chain, on a schedule, every buy verifiable below. No burn: supply is never destroyed.`;

	if (!bb.runs) {
		return `
			${commit}
			<p class="tk-bb-lead">${lead}</p>
			<div class="tk-bb-empty">
				<strong>${revenue}</strong> in platform revenue earned so far · <strong>${fmtUsd(bb.committed_usd)}</strong> committed to buybacks at ${commitLabel}.
				<span>Buys begin as the treasury deploys revenue on-chain — each one appears here with its Solscan receipt.</span>
			</div>`;
	}

	// Progress = share of the COMMITMENT already deployed on-chain (keeping the
	// promise), distinct from the raw deployed/revenue ratio.
	const pct = Math.max(0, Math.min(100, Number(bb.commitment_progress_pct) || 0));
	return `
		${commit}
		<p class="tk-bb-lead">${lead}</p>
		<div class="tk-bb-head">
			<div><div class="tk-bb-k">Revenue earned</div><div class="tk-bb-v">${revenue}</div></div>
			<div><div class="tk-bb-k">Committed (${commitLabel})</div><div class="tk-bb-v">${fmtUsd(bb.committed_usd)}</div></div>
			<div><div class="tk-bb-k">Deployed on-chain</div><div class="tk-bb-v">${fmtUsd(bb.deployed_usd)}</div></div>
			<div><div class="tk-bb-k">$THREE bought back</div><div class="tk-bb-v">${fmtNum(bb.three_bought)}</div></div>
		</div>
		<div class="tk-bb-bar" role="progressbar" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100" aria-label="Share of the buyback commitment deployed on-chain">
			<span style="width:${pct}%"></span>
		</div>
		<div class="tk-bb-foot">
			<span>${pct.toFixed(1)}% of the ${commitLabel} commitment deployed · ${fmtNum(bb.runs)} buyback${bb.runs === 1 ? '' : 's'}</span>
		</div>
		${renderBuybackRuns(bb.recent_runs)}`;
}

// ── live trade tape (DEX swap poll) ──────────────────────────────────────────
// $THREE has graduated, so its swaps happen on a DEX pool, not the pump.fun
// bonding curve — the PumpPortal trade WS streams nothing for it. We poll the
// real DEX trades (GeckoTerminal, edge-cached so a crowd shares one upstream
// call) and prepend new swaps with the same enter animation, so the tape is a
// genuine live feed of on-chain trades.
const TAPE_POLL_MS = 9_000;

const TAPE_EMPTY_HTML = () => emptyStateHTML({
	compact: true,
	live: true,
	icon: '',
	title: 'Live trades will appear here',
	body: 'As people buy and sell $THREE, each trade streams in here in real time.',
	tip: 'Live on-chain swaps from the $THREE DEX pool, refreshed every few seconds.',
});

function startTradeTape(tapeEl, statusEl) {
	let stopped = false;
	let timer = null;
	let everLoaded = false;
	let failStreak = 0;
	const seen = new Set();

	const setStatus = (online) => {
		statusEl.innerHTML = `<span class="tk-dot ${online ? '' : 'off'}"></span>${online ? 'Live' : 'Reconnecting…'}`;
	};

	const addTrade = (t, animate) => {
		if (!t || !t.signature || seen.has(t.signature)) return;
		if (t.mint && t.mint !== THREE_MINT) return;
		seen.add(t.signature);
		// Drop the empty-state placeholder on the first real trade.
		const empty = tapeEl.querySelector('[data-empty]');
		if (empty) empty.remove();
		const stale = tapeEl.querySelector('[data-tape-error]');
		if (stale) stale.remove();

		const isBuy = t.is_buy ?? t.txType === 'buy';
		const usd = t.sol_value_usd != null ? fmtUsd(t.sol_value_usd) : null;
		const sol = t.sol_amount != null ? `${Number(t.sol_amount).toFixed(3)} SOL` : '';
		const row = document.createElement('div');
		row.className = `tk-trade ${isBuy ? 'buy' : 'sell'}${animate && !REDUCED_MOTION ? ' in' : ''}`;
		row.dataset.sig = t.signature;
		row.innerHTML = `
			<span class="tk-side ${isBuy ? 'buy' : 'sell'}">${isBuy ? 'Buy' : 'Sell'}</span>
			<a class="tk-trader" href="https://solscan.io/account/${esc(t.trader || '')}" target="_blank" rel="noopener">${esc(shortAddr(t.trader))}</a>
			<span class="tk-amt">${usd || sol}${usd && sol ? ` <small>${sol}</small>` : ''} <small>· ${relTime(t.timestamp)}</small></span>`;
		tapeEl.prepend(row);
		while (tapeEl.children.length > MAX_TAPE_ROWS) tapeEl.lastElementChild.remove();

		// Bound the dedupe set over a long session — rebuild from what's on screen.
		if (seen.size > 3000) {
			seen.clear();
			tapeEl.querySelectorAll('[data-sig]').forEach((el) => seen.add(el.dataset.sig));
		}
	};

	const poll = async () => {
		if (stopped) return;
		try {
			const r = await fetch(
				`/api/pump/dex-trades?mint=${encodeURIComponent(THREE_MINT)}&limit=${MAX_TAPE_ROWS}`,
				{ headers: { accept: 'application/json' } },
			);
			if (!r.ok) throw new Error(`trades ${r.status}`);
			const d = await r.json();
			const trades = Array.isArray(d.trades) ? d.trades : [];
			// Endpoint returns newest-first; insert oldest-first so prepend leaves the
			// newest trade on top. First load paints without animation; later polls
			// animate only the genuinely new rows.
			const animate = everLoaded;
			for (let i = trades.length - 1; i >= 0; i--) addTrade(trades[i], animate);
			everLoaded = true;
			failStreak = 0;
			// A poll that succeeds but returns nothing is a quiet market, not a
			// fault: put the empty state back if an error frame is showing.
			const errBox = tapeEl.querySelector('[data-tape-error]');
			if (errBox && !tapeEl.querySelector('.tk-trade')) {
				tapeEl.innerHTML = `<div data-empty>${TAPE_EMPTY_HTML()}</div>`;
			}
			setStatus(true);
		} catch {
			failStreak += 1;
			setStatus(false);
			// Only claim an outage once nothing has ever loaded and two polls in a
			// row have failed. With rows on screen the last good frame stands.
			if (!everLoaded && failStreak >= 2 && !tapeEl.querySelector('[data-tape-error]')) {
				tapeEl.innerHTML = `<div data-tape-error>${errorStateHTML({
					title: 'Trade feed is unreachable',
					body: 'The $THREE swap feed didn’t respond. Trading itself is unaffected: the pool is live on-chain.',
					actions: [
						{ label: 'Retry', id: 'tape-retry', primary: true },
						{ label: 'View trades on Solscan ↗', id: 'tape-solscan' },
					],
				})}</div>`;
			}
		}
	};

	tapeEl.addEventListener('click', (e) => {
		const act = e.target.closest('[data-sk-action]')?.dataset.skAction;
		if (act === 'tape-retry') {
			failStreak = 0;
			tapeEl.innerHTML = `<div data-empty>${TAPE_EMPTY_HTML()}</div>`;
			poll();
		} else if (act === 'tape-solscan') {
			window.open(`https://solscan.io/token/${THREE_MINT}`, '_blank', 'noopener');
		}
	});

	setStatus(false);
	poll();
	timer = setInterval(poll, TAPE_POLL_MS);
	return () => { stopped = true; clearInterval(timer); };
}

// ── buy flow: Phantom → in-page swap, else pump.fun ─────────────────────────
async function buyThree() {
	const provider = window.solana || window.phantom?.solana;
	if (!provider?.isPhantom) {
		window.open(PUMP_URL, '_blank', 'noopener');
		return;
	}
	try {
		const resp = provider.publicKey ? { publicKey: provider.publicKey } : await provider.connect();
		const wallet = resp.publicKey.toString();
		openSwapModal({ wallet, getProvider: () => provider, defaultInputMint: SOL_MINT, defaultOutputMint: THREE_MINT });
	} catch {
		window.open(PUMP_URL, '_blank', 'noopener');
	}
}

// Latest $THREE price seen by the store — used to enrich the buy-click event.
let _lastThreePrice = null;

// ── boot ─────────────────────────────────────────────────────────────────────
function boot() {
	injectStyles();
	ensureStateKitStyles();
	document.title = '$THREE · Live price, chart & trades · three.ws';

	// $THREE holder funnel, step 1: the token page is in view.
	trackFunnelStep('three', ANALYTICS_EVENTS.TOKEN_PAGE_VIEWED, {});

	const wrap = document.createElement('main');
	wrap.className = 'tk-wrap';
	wrap.innerHTML = `
		<div class="tk-head">
			<div class="tk-logo"><img loading="lazy" decoding="async" src="/favicon.svg" alt="three.ws" width="32" height="32" /></div>
			<div style="flex:1;min-width:0">
				<div class="tk-titlerow"><h1 class="tk-title">$THREE</h1><span data-verified></span></div>
				<p class="tk-sub">The protocol token powering the three.ws agent economy</p>
			</div>
			<button class="tk-ca" data-ca title="Copy contract address: ${esc(THREE_MINT)}">${esc(shortAddr(THREE_MINT))} · copy</button>
		</div>
		<div class="tk-stats" data-stats>
			${Array.from({ length: 4 }, () => `<div class="tk-stat"><div class="tk-skel" style="height:48px"></div></div>`).join('')}
		</div>
		<div class="tk-why" data-why>${renderWhyHold(50)}</div>
		<div class="tk-grid">
			<div class="tk-card">
				<h2>Bonding curve</h2>
				<div data-curve></div>
				<div class="tk-buy">
					<button class="tk-btn primary" data-buy>Buy $THREE</button>
					<a class="tk-btn" href="${PUMP_URL}" target="_blank" rel="noopener">View on pump.fun ↗</a>
				</div>
			</div>
			<div class="tk-card">
				<h2 style="display:flex;align-items:center;justify-content:space-between">Live trades <span class="tk-status" data-tape-status></span></h2>
				<div class="tk-tape" data-tape>
					<div data-empty>${TAPE_EMPTY_HTML()}</div>
				</div>
			</div>
		</div>
		<div class="tk-card tk-bb" id="tk-bb-proof">
			<h2>Programmatic buybacks</h2>
			<div data-buyback><div class="tk-skel" style="height:96px"></div></div>
		</div>
		<div class="tk-foot">
			<a href="/dashboard/holders">🏆 Holder leaderboard</a>
			<a href="/three-live">⚡ Protocol Pulse (live 3D)</a>
			<a href="/dashboard/three-token">📊 $THREE dashboard</a>
			<a href="https://solscan.io/token/${THREE_MINT}" target="_blank" rel="noopener">🔎 Solscan ↗</a>
		</div>
	`;
	document.body.appendChild(wrap);

	// Copy CA. The async clipboard is unavailable outside a secure context and
	// can be denied by permission policy, so fall back to a selection copy and,
	// failing that, tell the reader instead of silently doing nothing.
	const caBtn = wrap.querySelector('[data-ca]');
	const caLabel = caBtn.textContent;
	let caTimer = null;
	const flashCa = (text) => {
		caBtn.textContent = text;
		clearTimeout(caTimer);
		caTimer = setTimeout(() => { caBtn.textContent = caLabel; }, 1600);
	};
	caBtn.addEventListener('click', async () => {
		if (await copyText(THREE_MINT)) flashCa('Copied ✓');
		else flashCa('Copy failed');
	});

	// Buy — funnel step 2: buy intent.
	wrap.querySelector('[data-buy]').addEventListener('click', () => {
		trackFunnelStep('three', ANALYTICS_EVENTS.TOKEN_BUY_CLICKED, {
			source: 'token_page',
			...(_lastThreePrice != null ? { price_usd: _lastThreePrice } : {}),
		});
		buyThree().catch(() => window.open(PUMP_URL, '_blank', 'noopener'));
	});

	// Bonding curve — real on-chain reads for the $THREE mint.
	mountBondingCurve(wrap.querySelector('[data-curve]'), { mint: THREE_MINT, network: 'mainnet', showUsd: true, refreshMs: 15_000, accent: '#4ade80' });

	// Header stats from the shared store (price/mcap/volume/holders).
	const statsEl = wrap.querySelector('[data-stats]');
	// pump.fun verification, straight off the live stats payload. Fades in on the
	// first snapshot that carries it, so the header never flashes.
	const verifiedEl = wrap.querySelector('[data-verified]');
	const store = createThreeTokenData({ pollMs: 30_000, anchorEl: wrap });
	store.subscribe((state) => {
		const p = state.protocol;
		if (p.status === 'ok' && p.token) {
			if (p.token.price_usd != null) _lastThreePrice = Number(p.token.price_usd);
			statsEl.innerHTML = renderHeaderStats(p.token);
			paintVerifiedBadge(verifiedEl, p.token);
		}
		else if (p.status === 'error') {
			statsEl.innerHTML = `<div class="tk-stats-err">${errorStateHTML({
				title: 'Live market data is unavailable',
				body: 'The $THREE price feed didn’t respond. The market is unaffected: price, cap and volume are still live on pump.fun.',
				actions: [
					{ label: 'Retry', id: 'stats-retry', primary: true },
					{ label: 'View on pump.fun ↗', id: 'stats-pump' },
				],
			})}</div>`;
		}
	});

	// Live trade tape.
	startTradeTape(wrap.querySelector('[data-tape]'), wrap.querySelector('[data-tape-status]'));

	// Programmatic buyback panel + live commitment % in the "why hold" pillars —
	// both from one protocol stats fetch.
	const bbEl = wrap.querySelector('[data-buyback]');
	const whyEl = wrap.querySelector('[data-why]');
	const loadBuyback = () => {
		bbEl.innerHTML = '<div class="tk-skel" style="height:96px"></div>';
		return fetch('/api/three-token/stats', { headers: { accept: 'application/json' } })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`stats ${r.status}`))))
			.then((d) => {
				bbEl.innerHTML = renderBuyback(d.buyback);
				if (d.buyback?.commit_pct != null) whyEl.innerHTML = renderWhyHold(d.buyback.commit_pct);
			})
			.catch(() => { bbEl.innerHTML = renderBuyback(null); });
	};
	bbEl.addEventListener('click', (e) => {
		const act = e.target.closest('[data-sk-action]')?.dataset.skAction;
		if (act === 'bb-retry') loadBuyback();
		else if (act === 'bb-solscan') window.open(`https://solscan.io/token/${THREE_MINT}`, '_blank', 'noopener');
	});
	loadBuyback();

	// Header stats recover through the same store the header reads from.
	statsEl.addEventListener('click', (e) => {
		const act = e.target.closest('[data-sk-action]')?.dataset.skAction;
		if (act === 'stats-retry') {
			statsEl.innerHTML = Array.from({ length: 4 }, () => '<div class="tk-stat"><div class="tk-skel" style="height:48px"></div></div>').join('');
			store.refresh();
		} else if (act === 'stats-pump') window.open(PUMP_URL, '_blank', 'noopener');
	});
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
