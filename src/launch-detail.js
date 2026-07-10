// ════════════════════════════════════════════════════════════════════════════
// /launches/<mint> — the rich, addressable profile for one coin.
//
// Every other launch surface bounces traders out to pump.fun. This page keeps
// them on three.ws and answers every question a trader actually has, in one
// place, from real on-chain data:
//
//   · WHAT is it        — live name / symbol / logo / price / market cap /
//                         graduation, streamed from /api/pump/coin
//   · IS IT SAFE        — the Coin Intelligence verdict (quality / bundle /
//                         organic / snipe / concentration / fresh wallets /
//                         risk flags), from /api/pump/launch-detail
//   · WHAT HAPPENED     — the labeled outcome (graduated / rugged / ATH ×)
//   · WHERE IS IT GOING — the live price chart (/api/pump/price-history) and
//                         the live trade tape (/api/pump/trades-stream, SSE)
//   · WHO HOLDS IT      — holder count + concentration (/api/coin/:mint/cohorts)
//   · WHO MADE IT       — the agent behind the mint and its verifiable track
//                         record (TraderScore), deep-linked to /trader & /agents
//   · WHY HOLD          — buyback-and-burn economics for agent-payment coins
//   · WHAT CAN I DO     — buy, view in 3D, enter the coin's world, watch, share
//
// Honesty contract: a signal the engine did not measure renders as "not
// measured", never as 0. A coin we never observed still renders — the page
// degrades to whatever is real for that mint and tells the user what's missing.
// ════════════════════════════════════════════════════════════════════════════

import {
	escapeHtml,
	compact,
	fmtSol,
	fmtUsd,
	fmtPct,
	pnlClass,
	shortAddr,
	relTime,
	verifiedBadge,
} from './trader-format.js';
import { walletChipEl } from './shared/agent-wallet-chip.js';
import { agentAvatarGlb, hasCustomAvatar, seeInWorldHref } from './shared/agent-3d.js';
import { resolveDevR2Url } from './shared/dev-r2-proxy.js';
import { flashValue, rippleOnce, liveDot, setLiveDot } from './ui-juice.js';

const GRADUATION_CAP_USD = 69_000; // pump.fun bonding-curve graduation threshold
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const state = {
	mint: null,
	network: 'mainnet',
	detail: null,
	coin: null,
	tape: null, // EventSource handle
	chartInterval: '15m',
	chartView: 'native', // 'native' (Birdeye area chart) | 'dexscreener' (interactive embed); hydrated from localStorage in boot()
	dexFrameTimer: 0, // watchdog for a stalled DexScreener embed
	priceTimer: 0,
};

// The chart-source choice is a viewing preference, not coin-specific — persist it
// so a trader who prefers the full DexScreener terminal keeps it across coins.
const CHART_VIEW_KEY = 'ld_chart_view';

function readChartView() {
	try {
		const v = localStorage.getItem(CHART_VIEW_KEY);
		return v === 'dexscreener' || v === 'native' ? v : 'native';
	} catch {
		return 'native';
	}
}

function writeChartView(view) {
	try {
		localStorage.setItem(CHART_VIEW_KEY, view);
	} catch {
		/* storage full / blocked — non-fatal, the in-memory state still switches */
	}
}

// ── Jupiter Terminal lazy loader ─────────────────────────────────────────────
// We load the Jupiter Terminal script only when the user clicks Buy, so it
// never slows down cold page loads. The script self-registers as window.Jupiter.

let _jupState = 'idle'; // idle | loading | ready | error
const _jupCallbacks = [];

function loadJupiter() {
	if (_jupState === 'ready') return Promise.resolve();
	if (_jupState === 'error') return Promise.reject(new Error('Jupiter Terminal failed to load'));
	return new Promise((resolve, reject) => {
		_jupCallbacks.push({ resolve, reject });
		if (_jupState === 'loading') return;
		_jupState = 'loading';
		const s = document.createElement('script');
		s.src = 'https://terminal.jup.ag/main-v3.js';
		s.onload = () => {
			_jupState = 'ready';
			_jupCallbacks.splice(0).forEach((cb) => cb.resolve());
		};
		s.onerror = () => {
			_jupState = 'error';
			_jupCallbacks.splice(0).forEach((cb) => cb.reject(new Error('Jupiter Terminal failed to load')));
		};
		document.head.appendChild(s);
	});
}

function openSwapModal(mint, symbol) {
	// Remove any pre-existing modal (guard against double-click race).
	document.getElementById('ld-swap-overlay')?.remove();

	const containerId = 'jup-terminal-container';
	const title = `Buy ${symbol ? `$${symbol}` : 'this token'}`;

	const closeModal = () => {
		overlay.remove();
		// Destroy the terminal instance so it doesn't leak event listeners.
		try { window.Jupiter?.close?.(); } catch { /* fine */ }
	};

	const loader = el('div', { class: 'ld-swap-loading' }, [
		el('div', { class: 'ld-skel', style: 'height:420px;border-radius:var(--radius-md)' }),
	]);
	const container = el('div', { id: containerId, class: 'ld-swap-terminal' });

	const modal = el('div', { class: 'ld-swap-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
		el('div', { class: 'ld-swap-head' }, [
			el('span', { class: 'ld-swap-title', text: title }),
			el('button', {
				class: 'ld-swap-close',
				type: 'button',
				'aria-label': 'Close swap',
				text: '✕',
				onclick: closeModal,
			}),
		]),
		loader,
		container,
	]);

	const overlay = el('div', { id: 'ld-swap-overlay', class: 'ld-swap-overlay' });
	overlay.appendChild(modal);
	document.body.appendChild(overlay);

	// Close on backdrop click or Escape.
	overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
	const escListener = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escListener); } };
	document.addEventListener('keydown', escListener);

	loadJupiter()
		.then(() => {
			loader.style.display = 'none';
			// Route RPC through our proxy — it rotates Helius → Alchemy → public
			// endpoints server-side, so blockhash fetch and tx submission survive
			// any single provider being down or rate-limiting the browser.
			window.Jupiter.init({
				displayMode: 'integrated',
				integratedTargetId: containerId,
				endpoint: `${location.origin}/api/solana-rpc`,
				formProps: {
					initialInputMint: SOL_MINT,
					initialOutputMint: mint,
					swapMode: 'ExactIn',
					fixedOutputMint: true,
				},
				containerStyles: {
					borderRadius: '12px',
					overflow: 'hidden',
					background: 'var(--bg-0, #0a0a0a)',
				},
			});
		})
		.catch(() => {
			loader.replaceChildren(
				el('div', { class: 'ld-swap-error' }, [
					el('p', { text: 'Could not load the swap terminal.' }),
					el('a', {
						class: 'ld-btn ld-btn-primary',
						href: `https://pump.fun/${mint}`,
						target: '_blank',
						rel: 'noopener noreferrer',
						text: `Trade on pump.fun ↗`,
					}),
				]),
			);
		});
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const c of [].concat(children || [])) {
		if (c == null || c === false) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

// Update or create a <meta> tag by property or name attribute.
function setMeta(prop, content) {
	let el = document.querySelector(`meta[property="${prop}"]`) ||
	         document.querySelector(`meta[name="${prop}"]`);
	if (!el) {
		el = document.createElement('meta');
		el.setAttribute(prop.startsWith('og:') || prop.startsWith('twitter:') ? 'property' : 'name', prop);
		document.head.appendChild(el);
	}
	el.setAttribute('content', content);
}

function svg(tag, attrs) {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	return node;
}

function section(target, title, body, { tag = null } = {}) {
	const head = el('div', { class: 'ld-sec-head' }, [
		el('h2', { class: 'ld-sec-title', text: title }),
		tag ? el('span', { class: 'ld-sec-tag', text: tag }) : null,
	]);
	target.replaceChildren(head, body);
	target.classList.add('ld-revealed');
}

// ── formatting ───────────────────────────────────────────────────────────────

function fmtMcap(n) {
	if (!Number.isFinite(n)) return '—';
	if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
	return `$${n.toFixed(0)}`;
}

function fmtPrice(n) {
	if (!Number.isFinite(n) || n <= 0) return '—';
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n >= 0.001) return `$${n.toFixed(5)}`;
	return `$${n.toExponential(2)}`;
}

function pctText(v) {
	// signal helpers express 0..1 fractions; render as whole percents
	return v == null ? null : `${Math.round(v * 100)}%`;
}

// ── mint resolution ──────────────────────────────────────────────────────────

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function resolveMint() {
	const parts = location.pathname.split('/').filter(Boolean);
	const fromPath = parts[0] === 'launches' ? parts[1] : null;
	const qs = new URLSearchParams(location.search);
	const fromQuery = qs.get('mint');
	const candidate = (fromPath || fromQuery || '').trim();
	state.network = qs.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	return MINT_RE.test(candidate) ? candidate : null;
}

// ── data ─────────────────────────────────────────────────────────────────────

async function fetchJson(url, { signal } = {}) {
	const r = await fetch(url, { signal });
	if (!r.ok) {
		// Carry the status and the API's machine-readable code so callers can tell
		// an honest empty state ("this coin has no market yet") apart from an
		// outage, and offer Retry only where retrying can actually help.
		const err = new Error(`${url} → ${r.status}`);
		err.status = r.status;
		err.code = await r.clone().json().then((b) => b?.error).catch(() => null);
		throw err;
	}
	return r.json();
}

async function loadDetail() {
	const params = new URLSearchParams({ mint: state.mint, network: state.network });
	return fetchJson(`/api/pump/launch-detail?${params}`);
}

async function loadCoin() {
	// Live pump.fun market — mainnet only (devnet has no pump.fun market data).
	if (state.network !== 'mainnet') return null;
	try {
		return await fetchJson(`/api/pump/coin?mint=${encodeURIComponent(state.mint)}`);
	} catch {
		return null;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// HERO
// ════════════════════════════════════════════════════════════════════════════

function graduationRing(pct, size = 76) {
	const value = Math.max(0, Math.min(100, Number(pct) || 0));
	const r = size / 2 - 6;
	const c = 2 * Math.PI * r;
	const dash = (value / 100) * c;
	const node = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'ld-ring', role: 'img', 'aria-label': `${Math.round(value)}% to graduation` });
	node.append(
		svg('circle', { cx: size / 2, cy: size / 2, r, class: 'ld-ring-track' }),
		svg('circle', {
			cx: size / 2,
			cy: size / 2,
			r,
			class: 'ld-ring-arc',
			'stroke-dasharray': `${dash.toFixed(1)} ${(c - dash).toFixed(1)}`,
			transform: `rotate(-90 ${size / 2} ${size / 2})`,
		}),
	);
	return node;
}

function outcomeBadge(outcome) {
	if (!outcome || !outcome.outcome) return null;
	const map = {
		graduated: { label: 'Graduated', tone: 'good', tip: 'This coin completed its bonding curve and moved to an AMM pool.' },
		rugged: { label: 'Rugged', tone: 'bad', tip: 'The Intelligence Engine labeled this coin as rugged.' },
		survived: { label: 'Survived', tone: 'good', tip: 'Still trading after the observation window.' },
		died: { label: 'Faded', tone: 'muted', tip: 'Activity collapsed shortly after launch.' },
		unknown: null,
	};
	const meta = map[outcome.outcome];
	if (!meta) return null;
	const parts = [el('span', { text: meta.label })];
	if (Number.isFinite(outcome.ath_multiple) && outcome.ath_multiple > 1) {
		parts.push(el('b', { text: `${outcome.ath_multiple.toFixed(1)}× ATH` }));
	}
	return el('span', { class: `ld-outcome ld-outcome-${meta.tone}`, title: meta.tip }, parts);
}

function socialLinks(socials, intel) {
	const links = [];
	const s = socials || {};
	if (s.twitter) links.push(['𝕏', s.twitter, 'X / Twitter']);
	if (s.telegram) links.push(['Telegram', s.telegram, 'Telegram']);
	if (s.website) links.push(['Website', s.website, 'Website']);
	if (!links.length) return null;
	return el(
		'div',
		{ class: 'ld-socials' },
		links.map(([label, href, aria]) =>
			el('a', { class: 'ld-social', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': aria, text: label }),
		),
	);
}

function copyButton(value, label) {
	const btn = el('button', {
		class: 'ld-copy',
		type: 'button',
		'aria-label': `Copy ${label}`,
		title: `Copy ${label}`,
		onclick: async () => {
			try {
				await navigator.clipboard.writeText(value);
				const old = btn.textContent;
				btn.textContent = 'Copied';
				btn.classList.add('ld-copied');
				setTimeout(() => {
					btn.textContent = old;
					btn.classList.remove('ld-copied');
				}, 1400);
			} catch {
				/* clipboard blocked — selection fallback */
				const r = document.createRange();
				r.selectNodeContents(btn);
				window.getSelection()?.removeAllRanges();
				window.getSelection()?.addRange(r);
			}
		},
		text: shortAddr(value, 5, 5),
	});
	return btn;
}

function renderHero() {
	const target = $('ld-hero');
	const { detail, coin } = state;
	const intel = detail.intel;
	const reg = detail.registry;

	// Identity, with graceful fallback precedence: live market → registry → intel.
	const name = coin?.name || reg?.name || intel?.name || 'Unknown coin';
	const symbol = (coin?.symbol || reg?.symbol || intel?.symbol || '').toUpperCase();
	const image = coin?.image_uri || coin?.image || intel?.image_uri || null;

	document.title = `${symbol ? `$${symbol} · ` : ''}${name} · three.ws`;

	const mcap = Number(coin?.usd_market_cap);
	const supplyAtomic = Number(coin?.total_supply);
	const supply = Number.isFinite(supplyAtomic) && supplyAtomic > 0 ? supplyAtomic / 1e6 : null;
	const price = supply && Number.isFinite(mcap) ? mcap / supply : null;
	const graduated = coin?.complete === true;
	const gradPct = graduated ? 100 : Number.isFinite(mcap) ? Math.max(0, Math.min(100, (mcap / GRADUATION_CAP_USD) * 100)) : null;

	const avatar = el('div', { class: 'ld-coin-avatar' }, [
		image
			? el('img', { src: image, alt: '', loading: 'eager', referrerpolicy: 'no-referrer', onerror: function () { this.style.display = 'none'; } })
			: el('span', { class: 'ld-avatar-glyph', text: (symbol || name)[0] || '?' }),
	]);

	const idBlock = el('div', { class: 'ld-id' }, [
		el('div', { class: 'ld-id-line' }, [
			el('h1', { class: 'ld-name', text: name }),
			symbol ? el('span', { class: 'ld-symbol', text: `$${symbol}` }) : null,
			outcomeBadge(detail.outcome),
		]),
		el('div', { class: 'ld-id-meta' }, [
			detail.found ? el('span', { class: 'ld-chip ld-chip-launch', title: 'Launched by a three.ws agent', text: 'three.ws launch' }) : null,
			state.network === 'devnet' ? el('span', { class: 'ld-chip', text: 'Devnet' }) : null,
			intel?.category ? el('span', { class: 'ld-chip', text: intel.category }) : null,
			copyButton(state.mint, 'mint address'),
		]),
		socialLinks(intel?.socials, intel),
	]);

	// Live market stat strip.
	const stat = (label, value, cls = '') =>
		el('div', { class: `ld-stat ${cls}` }, [
			el('dt', { text: label }),
			el('dd', { text: value }),
		]);

	const stats = el('dl', { class: 'ld-hero-stats' }, [
		stat('Price', fmtPrice(price), 'ld-stat-price'),
		stat('Market cap', fmtMcap(mcap), 'ld-stat-mcap'),
		stat('24h volume', fmtMcap(Number(coin?.volume_24h ?? coin?.volume24h))),
		stat('Total supply', supply != null ? compact(supply) : '—'),
		stat('Launched', reg?.created_at || intel?.created_at ? relTime(reg?.created_at || intel?.created_at) : '—'),
	]);

	const gradWrap = gradPct != null
		? el('div', { class: 'ld-grad', title: graduated ? 'Graduated to AMM' : `${Math.round(gradPct)}% to graduation` }, [
				graduationRing(gradPct),
				el('div', { class: 'ld-grad-cap' }, [
					el('span', { class: 'ld-grad-pct', text: graduated ? 'Graduated' : `${Math.round(gradPct)}%` }),
					el('span', { class: 'ld-grad-sub', text: graduated ? 'on AMM' : 'to graduation' }),
				]),
			])
		: null;

	target.replaceChildren(
		el('div', { class: 'ld-hero-top' }, [avatar, idBlock, gradWrap]),
		stats,
	);
	target.classList.add('ld-revealed');
}

// ════════════════════════════════════════════════════════════════════════════
// MARKET METRICS — multi-timeframe price moves + live on-chain safety read
// ════════════════════════════════════════════════════════════════════════════
//
// Two live reads, each real and independently degradable:
//   · price moves — one 5m-candle pull (/api/pump/price-history), windowed in the
//     client into 5m / 1h / 6h / 24h percentage moves. A window is shown only
//     when the history actually spans (most of) it, so a young coin renders "—"
//     for 24h rather than a misleading figure derived from two hours of data.
//   · trust strip — the same pre-trade firewall verdict the autonomous sniper
//     enforces (/api/pump/safety): a live SPL mint/freeze authority audit + a
//     tradable-venue read, scored 0..100. Answers the on-chain trust questions a
//     GMGN-style terminal leads with — can the dev mint more, freeze your tokens,
//     is there a real venue — at a glance, every value traceable to chain state.

const TF_WINDOWS = [
	{ key: '5m', label: '5m', sec: 300 },
	{ key: '1h', label: '1h', sec: 3600 },
	{ key: '6h', label: '6h', sec: 21600 },
	{ key: '24h', label: '24h', sec: 86400 },
];

// Window a single ascending 5m-candle series into per-timeframe % moves. Returns
// null when there isn't enough data to compute even the shortest window.
function priceDeltas(pts) {
	const sorted = (pts || [])
		.filter((p) => Number.isFinite(p.c) && Number.isFinite(p.t) && p.c > 0)
		.sort((a, b) => a.t - b.t);
	if (sorted.length < 2) return null;
	const last = sorted[sorted.length - 1];
	const span = last.t - sorted[0].t;
	const deltas = TF_WINDOWS.map((w) => {
		// Require ≥60% of the window in history before quoting it — never fabricate
		// a long-horizon move from a short series.
		if (span < w.sec * 0.6) return { ...w, pct: null };
		const target = last.t - w.sec;
		let ref = sorted[0];
		for (const p of sorted) { if (p.t >= target) { ref = p; break; } }
		return { ...w, pct: ref.c ? ((last.c - ref.c) / ref.c) * 100 : null };
	});
	return { last: last.c, deltas };
}

function renderTimeframeStrip(host) {
	host.replaceChildren(el('div', { class: 'ld-skel ld-skel-strip' }));
	const to = Math.floor(Date.now() / 1000);
	const from = to - 30 * 3600;
	fetchJson(`/api/pump/price-history?mint=${encodeURIComponent(state.mint)}&interval=5m&from=${from}&to=${to}`)
		.then((body) => {
			const res = priceDeltas(body.data);
			if (!res || res.deltas.every((d) => d.pct == null)) {
				host.replaceChildren(el('p', { class: 'ld-mtf-empty', text: 'Not enough trade history yet for price moves.' }));
				return;
			}
			host.replaceChildren(
				el('div', { class: 'ld-mtf' }, res.deltas.map((d) =>
					el('div', { class: 'ld-mtf-cell' }, [
						el('span', { class: 'ld-mtf-label', text: d.label }),
						el('span', {
							class: `ld-mtf-val ${d.pct == null ? 'ld-muted' : pnlClass(d.pct)}`,
							text: d.pct == null ? '—' : fmtPct(d.pct, { sign: true }),
						}),
					]),
				)),
			);
		})
		.catch(() => {
			host.replaceChildren(
				el('div', { class: 'ld-mtf-empty' }, [
					el('span', { text: 'Price moves unavailable right now.' }),
					el('button', { class: 'ld-btn ld-btn-ghost', type: 'button', text: 'Retry', onclick: () => renderTimeframeStrip(host) }),
				]),
			);
		});
}

const TRUST_TONE = { pass: 'good', warn: 'warn', fail: 'danger', skip: 'muted' };
const VERDICT_META = {
	allow: { label: 'Tradable', tone: 'good' },
	warn: { label: 'Caution', tone: 'warn' },
	block: { label: 'High risk', tone: 'danger' },
};
const VENUE_LABEL = {
	live_amm_pool: 'AMM pool',
	live_bonding_curve: 'Bonding curve',
	no_tradable_venue: 'None',
	curve_reserves_empty: 'Drained',
	pool_reserves_empty: 'Drained',
};

function trustChip(label, value, tone, title) {
	return el('div', { class: 'ld-trust', title: title || null }, [
		el('span', { class: 'ld-trust-k', text: label }),
		el('span', { class: `ld-trust-v ld-${tone}`, text: value }),
	]);
}

function renderTrustStrip(host) {
	host.replaceChildren(el('div', { class: 'ld-skel ld-skel-strip' }));
	fetchJson(`/api/pump/safety?mint=${encodeURIComponent(state.mint)}&network=${state.network}`)
		.then((s) => {
			const checks = Array.isArray(s.checks) ? s.checks : [];
			const byName = (n) => checks.find((c) => c.name === n);
			const auth = byName('mint_authority');
			const venue = byName('venue');
			const sell = byName('round_trip');

			const chips = [];
			// A null on-chain authority means it was renounced — the dev can no longer
			// inflate supply (mint) or freeze your account (the cleanest honeypot).
			if (auth) {
				const unread = auth.reason === 'authority_read_failed' || auth.reason === 'mint_not_found';
				const mintActive = auth.detail?.mint_authority != null;
				const freezeActive = auth.detail?.freeze_authority != null;
				chips.push(trustChip('Mint authority', unread ? 'Unknown' : mintActive ? 'Active' : 'Revoked',
					unread ? 'muted' : mintActive ? 'danger' : 'good',
					mintActive ? 'The creator can still mint new supply and dilute holders.' : 'Mint authority renounced — supply is fixed.'));
				chips.push(trustChip('Freeze authority', unread ? 'Unknown' : freezeActive ? 'Active' : 'Revoked',
					unread ? 'muted' : freezeActive ? 'danger' : 'good',
					freezeActive ? 'The creator can freeze your token account — you may be unable to sell.' : 'Freeze authority renounced — your tokens cannot be frozen.'));
			}
			if (venue) {
				chips.push(trustChip('Liquidity', VENUE_LABEL[venue.reason] || (venue.status === 'pass' ? 'Live' : '—'),
					TRUST_TONE[venue.status] || 'muted', 'Where this coin can actually be traded.'));
			}
			if (sell) {
				const label = sell.status === 'pass' ? 'Sellable' : sell.status === 'fail' ? 'Honeypot' : 'Untested';
				chips.push(trustChip('Sell test', label, TRUST_TONE[sell.status] || 'muted',
					sell.status === 'skip' ? 'A live buy→sell round-trip is simulated at trade time.' : 'Simulated buy→sell round-trip on-chain.'));
			}

			if (!chips.length) {
				host.replaceChildren(el('p', { class: 'ld-mtf-empty', text: 'Safety checks are unavailable for this coin.' }));
				return;
			}

			const v = VERDICT_META[s.verdict] || { label: 'Unscored', tone: 'muted' };
			const head = el('div', { class: 'ld-trust-head' }, [
				el('span', { class: `ld-verdict-pill ld-pill-${v.tone}`, text: v.label }),
				Number.isFinite(Number(s.score)) ? el('span', { class: 'ld-trust-score', text: `${Math.round(Number(s.score))}/100 safety` }) : null,
			]);
			host.replaceChildren(head, el('div', { class: 'ld-trust-grid' }, chips));
		})
		.catch(() => {
			host.replaceChildren(
				el('div', { class: 'ld-mtf-empty' }, [
					el('span', { text: 'Safety check unavailable right now.' }),
					el('button', { class: 'ld-btn ld-btn-ghost', type: 'button', text: 'Retry', onclick: () => renderTrustStrip(host) }),
				]),
			);
		});
}

function renderMetrics() {
	const target = $('ld-metrics');
	if (!target) return;
	if (state.network !== 'mainnet') {
		section(target, 'Market metrics', el('div', { class: 'ld-empty ld-empty-sm' }, [
			el('p', { text: 'Live price moves and on-chain safety checks are mainnet-only.' }),
		]));
		return;
	}
	const tfHost = el('div', { class: 'ld-mtf-host' });
	const trustHost = el('div', { class: 'ld-trust-host' });
	const body = el('div', { class: 'ld-metrics-body' }, [
		el('div', { class: 'ld-metrics-block' }, [el('h3', { class: 'ld-metrics-h', text: 'Price moves' }), tfHost]),
		el('div', { class: 'ld-metrics-block' }, [el('h3', { class: 'ld-metrics-h', text: 'On-chain safety' }), trustHost]),
	]);
	section(target, 'Market metrics', body, { tag: 'live' });
	renderTimeframeStrip(tfHost);
	renderTrustStrip(trustHost);
}

// ════════════════════════════════════════════════════════════════════════════
// INTELLIGENCE VERDICT
// ════════════════════════════════════════════════════════════════════════════

const FLAG_META = {
	bundle_launch: { label: 'Bundle launch', tone: 'danger', tip: 'Many wallets bought in the same block — likely coordinated.' },
	dev_dumped: { label: 'Dev dumped', tone: 'danger', tip: 'The creator sold their position.' },
	dev_dump: { label: 'Dev dumped', tone: 'danger', tip: 'The creator sold their position.' },
	single_whale: { label: 'Single whale', tone: 'danger', tip: 'One wallet holds an outsized share of supply.' },
	low_diversity: { label: 'Low diversity', tone: 'danger', tip: 'Few unique buyers — thin, concentrated participation.' },
	fresh_wallet_swarm: { label: 'Fresh-wallet swarm', tone: 'danger', tip: 'A cluster of brand-new wallets bought together.' },
	sell_pressure: { label: 'Sell pressure', tone: 'warn', tip: 'Sells are outpacing buys early.' },
	sniped: { label: 'Sniped', tone: 'warn', tip: 'Snipers grabbed supply in the first moments.' },
};

function scoreTone(score) {
	if (score == null) return 'muted';
	if (score >= 70) return 'good';
	if (score >= 45) return 'warn';
	return 'danger';
}

function gauge(label, value01, { invert = false } = {}) {
	// value01 in 0..1; invert means lower-is-better (concentration, snipe).
	const measured = value01 != null;
	const pct = measured ? Math.max(0, Math.min(100, value01 * 100)) : 0;
	const good = invert ? 100 - pct : pct;
	const tone = !measured ? 'muted' : good >= 66 ? 'good' : good >= 40 ? 'warn' : 'danger';
	return el('div', { class: 'ld-gauge' }, [
		el('div', { class: 'ld-gauge-head' }, [
			el('span', { class: 'ld-gauge-label', text: label }),
			el('span', { class: `ld-gauge-val ld-${tone}`, text: measured ? `${Math.round(pct)}%` : 'not measured' }),
		]),
		el('div', { class: 'ld-gauge-track' }, [
			el('div', { class: `ld-gauge-fill ld-fill-${tone}`, style: `width:${measured ? pct : 0}%` }),
		]),
	]);
}

function renderVerdict() {
	const target = $('ld-verdict');
	const intel = state.detail.intel;

	if (!intel) {
		section(
			target,
			'Coin Intelligence',
			el('div', { class: 'ld-empty' }, [
				el('p', { class: 'ld-empty-title', text: 'Not yet observed by the Intelligence Engine.' }),
				el('p', {
					text:
						state.network === 'devnet'
							? 'The engine watches mainnet launches. Devnet coins carry no intelligence signals.'
							: 'This coin launched before the engine started watching, or its first seconds were not captured. New mainnet launches are scored within ~90 seconds.',
				}),
				el('a', { class: 'ld-btn ld-btn-ghost', href: '/radar', text: 'Open the live radar →' }),
			]),
			{ tag: 'engine' },
		);
		return;
	}

	const q = intel.quality_score;
	const tone = scoreTone(q);
	const headline = el('div', { class: 'ld-verdict-head' }, [
		el('div', { class: `ld-quality ld-quality-${tone}` }, [
			el('span', { class: 'ld-quality-num', text: q != null ? String(Math.round(q)) : '—' }),
			el('span', { class: 'ld-quality-max', text: '/100' }),
		]),
		el('div', { class: 'ld-verdict-copy' }, [
			el('span', { class: 'ld-verdict-label', text: 'Quality score' }),
			el('p', {
				class: 'ld-narrative',
				text:
					intel.narrative ||
					(q >= 70
						? 'Signals read organic: diverse buyers, healthy timing, no dominant whale.'
						: q >= 45
							? 'Mixed signals — some concentration or coordination worth a closer look.'
							: 'High-risk signals: coordination, concentration, or early sell pressure.'),
			}),
		]),
	]);

	const flags = (intel.risk_flags || []).length
		? el(
				'div',
				{ class: 'ld-flags' },
				intel.risk_flags.map((f) => {
					const m = FLAG_META[f] || { label: f.replace(/_/g, ' '), tone: 'warn', tip: '' };
					return el('span', { class: `ld-flag ld-flag-${m.tone}`, title: m.tip, text: m.label });
				}),
			)
		: el('div', { class: 'ld-flags' }, [
				el('span', { class: 'ld-flag ld-flag-good', text: 'No risk flags raised' }),
			]);

	const gauges = el('div', { class: 'ld-gauges' }, [
		gauge('Organic', intel.organic_score),
		gauge('Bundle coordination', intel.bundle_score, { invert: true }),
		gauge('Sniped early', intel.snipe_ratio, { invert: true }),
		gauge('Top-10 concentration', intel.concentration_top10, { invert: true }),
		gauge('Fresh wallets', intel.fresh_wallet_ratio, { invert: true }),
		gauge('Funder clustering', intel.bubblemap_connectivity, { invert: true }),
	]);

	// First-seconds aggregates — the raw observed activity behind the scores.
	const kv = (label, value) =>
		value == null
			? null
			: el('div', { class: 'ld-kv' }, [el('span', { text: label }), el('b', { text: value })]);
	const aggregates = el('div', { class: 'ld-aggregates' }, [
		kv('Buys', intel.buy_count != null ? compact(intel.buy_count) : null),
		kv('Sells', intel.sell_count != null ? compact(intel.sell_count) : null),
		kv('Unique buyers', intel.unique_buyers != null ? compact(intel.unique_buyers) : null),
		kv('Buy volume', intel.buy_volume_sol != null ? fmtSol(intel.buy_volume_sol, { sign: false }) : null),
		kv('Dev buy', intel.dev_buy_sol != null ? fmtSol(intel.dev_buy_sol, { sign: false }) : null),
		kv('Largest buy', intel.largest_buy_sol != null ? fmtSol(intel.largest_buy_sol, { sign: false }) : null),
		kv('Observed for', intel.observation_seconds != null ? `${intel.observation_seconds}s` : null),
	]);

	const body = el('div', { class: 'ld-verdict' }, [headline, flags, gauges, aggregates]);
	section(target, 'Coin Intelligence', body, { tag: 'first ~90s, on-chain' });
}

// ════════════════════════════════════════════════════════════════════════════
// ORACLE CONVICTION — fused conviction score from the Oracle system
// ════════════════════════════════════════════════════════════════════════════

const ORACLE_TIER_META = {
	prime:   { label: 'PRIME',   color: '#c084fc', bg: 'rgba(192,132,252,.14)' },
	strong:  { label: 'STRONG',  color: '#34d399', bg: 'rgba(52,211,153,.12)' },
	lean:    { label: 'LEAN',    color: '#fbbf24', bg: 'rgba(251,191,36,.12)' },
	watch:   { label: 'WATCH',   color: '#94a3b8', bg: 'rgba(148,163,184,.1)' },
	avoid:   { label: 'AVOID',   color: '#f87171', bg: 'rgba(248,113,113,.12)' },
};
const ORACLE_PILLAR_COLORS = {
	pedigree: '#5fe3ff', structure: '#34d399', narrative: '#a07bff', momentum: '#fbbf24',
};

async function renderOracleConviction() {
	const target = $('ld-oracle');
	if (!target || state.network !== 'mainnet') return;
	target.replaceChildren(el('div', { class: 'ld-skel', style: 'height:140px' }));

	let data;
	try {
		const r = await fetch(`/api/oracle/coin?mint=${encodeURIComponent(state.mint)}`);
		if (!r.ok) { target.replaceChildren(); return; }
		data = await r.json();
	} catch { target.replaceChildren(); return; }

	const cv = data.conviction;
	if (!cv) { target.replaceChildren(); return; }

	const tier = cv.tier || 'watch';
	const meta = ORACLE_TIER_META[tier] || ORACLE_TIER_META.watch;
	const score = Math.round(Number(cv.score ?? 0));
	const pillars = cv.pillars || {};

	const tierBadge = el('span', {
		class: 'ld-oracle-tier',
		style: `background:${meta.bg};color:${meta.color};border-color:${meta.color}40`,
		text: meta.label,
	});

	const scoreDial = el('div', { class: 'ld-oracle-dial' }, [
		el('span', { class: 'ld-oracle-score', text: String(score) }),
		el('span', { class: 'ld-oracle-score-max', text: '/100' }),
	]);

	const pillarRow = el('div', { class: 'ld-oracle-pillars' },
		['pedigree', 'structure', 'narrative', 'momentum'].map((key) => {
			const val = Math.round(Number(pillars[key] ?? 0));
			const bar = el('div', { class: 'ld-oracle-pillar-bar' }, [
				el('div', {
					class: 'ld-oracle-pillar-fill',
					style: `width:${val}%;background:${ORACLE_PILLAR_COLORS[key]}`,
				}),
			]);
			return el('div', { class: 'ld-oracle-pillar' }, [
				el('span', { class: 'ld-oracle-pillar-label', text: key }),
				bar,
				el('span', { class: 'ld-oracle-pillar-val', text: String(val) }),
			]);
		}),
	);

	const actions = el('div', { class: 'ld-oracle-actions' }, [
		el('a', {
			class: 'ld-btn ld-btn-ghost ld-btn-sm ld-btn-block',
			href: `/oracle/coin/${encodeURIComponent(state.mint)}`,
			target: '_blank',
			rel: 'noopener',
			text: 'Full conviction breakdown ↗',
		}),
	]);

	const body = el('div', { class: 'ld-oracle-body' }, [
		el('div', { class: 'ld-oracle-head' }, [scoreDial, tierBadge]),
		pillarRow,
		actions,
	]);
	section(target, 'Oracle Conviction', body, { tag: 'fused · 4 reads' });
}

// ════════════════════════════════════════════════════════════════════════════
// SMART MONEY  — who is in this coin, and what is their track record
//
// The single most actionable question a trader has isn't "what is the chart" —
// it's "who else is in, and do they win." The Smart Money Radar answers it: it
// crosses every wallet's footprint in this coin against which coins those same
// wallets historically graduated, scoring the *pedigree of the money* buying in.
// Data: /api/pump/smart-money?mint= (404 until the rollup has scored this coin).
// ════════════════════════════════════════════════════════════════════════════

const WALLET_LABEL = {
	smart_money: { label: 'Smart money', tone: 'good', tip: 'A wallet with a proven record of buying coins that went on to graduate.' },
	sniper: { label: 'Sniper', tone: 'warn', tip: 'Habitually grabs supply in the first moments of a launch.' },
	dumper: { label: 'Dumper', tone: 'danger', tip: 'Tends to sell into early buyers — exits fast.' },
	rugger: { label: 'Rugger', tone: 'danger', tip: 'Has been tied to coins that rugged.' },
	fresh: { label: 'Fresh', tone: 'muted', tip: 'A brand-new wallet with no track record yet.' },
	neutral: { label: 'Neutral', tone: 'muted', tip: 'Trades both ways with no decisive edge.' },
	unproven: { label: 'Unproven', tone: 'muted', tip: 'Not enough history to judge.' },
};

function walletRow(w) {
	const meta = WALLET_LABEL[w.label] || { label: (w.label || 'wallet').replace(/_/g, ' '), tone: 'muted', tip: '' };
	const winPct = w.win_rate != null ? Math.round(w.win_rate * 100) : null;
	const record =
		w.wins != null && w.duds != null && w.wins + w.duds > 0 ? `${w.wins}–${w.duds}` : null;

	return el(
		'a',
		{
			class: 'ld-sm-row',
			href: `https://solscan.io/account/${w.wallet}`,
			target: '_blank',
			rel: 'noopener noreferrer',
			'aria-label': `${meta.label} ${shortAddr(w.wallet)} — bought ${fmtSol(w.buy_sol, { sign: false })}`,
		},
		[
			el('span', { class: `ld-sm-dot ld-fill-${meta.tone}`, 'aria-hidden': 'true' }),
			el('div', { class: 'ld-sm-who' }, [
				el('span', { class: 'ld-sm-addr', text: shortAddr(w.wallet, 4, 4) }),
				el('span', { class: `ld-sm-label ld-${meta.tone}`, title: meta.tip, text: meta.label }),
			]),
			el('div', { class: 'ld-sm-rec' }, [
				winPct != null ? el('span', { class: 'ld-sm-win', text: `${winPct}% win` }) : null,
				record ? el('span', { class: 'ld-sm-wd', text: record }) : null,
			]),
			el('span', { class: 'ld-sm-buy', text: fmtSol(w.buy_sol, { sign: false }) }),
		],
	);
}

async function renderSmartMoney() {
	const target = $('ld-smart');
	if (state.network !== 'mainnet') {
		target.hidden = true;
		return;
	}

	let data = null;
	try {
		data = await fetchJson(`/api/pump/smart-money?mint=${encodeURIComponent(state.mint)}`);
	} catch {
		// 404 = the rollup hasn't scored this coin yet (too new, or pre-dates the
		// engine). Render an honest "not scored yet" rather than hiding the panel.
		section(
			target,
			'Smart money',
			el('div', { class: 'ld-empty ld-empty-sm' }, [
				el('p', { class: 'ld-empty-title', text: 'No smart-money read yet.' }),
				el('p', {
					text: 'The radar scores a coin once proven wallets touch it. New launches are picked up within minutes — check back, or watch the live radar.',
				}),
				el('a', { class: 'ld-btn ld-btn-ghost', href: '/radar', text: 'Open the Smart Money radar →' }),
			]),
			{ tag: 'wallet pedigree' },
		);
		return;
	}

	const coin = data.coin || {};
	const notable = (data.notable || [])
		.filter((w) => w && w.wallet)
		.sort((a, b) => Number(b.buy_sol || 0) - Number(a.buy_sol || 0));
	const score = Number(coin.smart_money_score);
	const tone = scoreTone(Number.isFinite(score) ? score : null);
	const provenSol = Number(coin.proven_buy_sol) || 0;
	const smartCount =
		Number(coin.smart_wallet_count) || notable.filter((w) => w.label === 'smart_money').length;

	// The hook line — concrete, FOMO-honest, never synthesized.
	const lede =
		smartCount > 0
			? `${smartCount} proven ${smartCount === 1 ? 'wallet has' : 'wallets have'} put ${fmtSol(provenSol, { sign: false })} into this coin.`
			: provenSol > 0
				? `${fmtSol(provenSol, { sign: false })} of the money here traces to wallets with a track record.`
				: 'No wallets with a proven track record have bought this coin yet.';

	const headline = el('div', { class: 'ld-sm-head' }, [
		el('div', { class: `ld-quality ld-quality-${tone}` }, [
			el('span', { class: 'ld-quality-num', text: Number.isFinite(score) ? String(Math.round(score)) : '—' }),
			el('span', { class: 'ld-quality-max', text: 'pedigree' }),
		]),
		el('div', { class: 'ld-verdict-copy' }, [
			el('span', { class: 'ld-verdict-label', text: 'Smart-money score' }),
			el('p', { class: 'ld-narrative', text: lede }),
		]),
	]);

	const children = [headline];

	if (notable.length) {
		children.push(
			el('div', { class: 'ld-sm-list' }, [
				el('div', { class: 'ld-sm-list-head' }, [
					el('span', { text: 'Wallet' }),
					el('span', { text: 'Record' }),
					el('span', { text: 'Bought' }),
				]),
				...notable.slice(0, 8).map(walletRow),
			]),
		);
	} else {
		children.push(
			el('p', {
				class: 'ld-agent-note',
				text: 'The radar is watching, but no notable wallets have surfaced in this coin yet.',
			}),
		);
	}

	children.push(
		el('a', { class: 'ld-actions-foot', href: '/radar', text: 'See everything the smart money is buying →' }),
	);

	section(target, 'Smart money', el('div', { class: 'ld-sm' }, children), { tag: 'wallet pedigree' });
}

// ════════════════════════════════════════════════════════════════════════════
// PRICE CHART
// ════════════════════════════════════════════════════════════════════════════

const INTERVALS = [
	['5m', '5m'],
	['15m', '15m'],
	['1H', '1h'],
	['4H', '4h'],
	['1D', '1d'],
];
const WINDOW_HOURS = { '5m': 12, '15m': 36, '1h': 96, '4h': 480, '1d': 2160 };

function areaChart(points) {
	// points: [{t,o,h,l,c,v}] ascending. Pure SVG, theme-aware via currentColor.
	// Volume bars rendered in a 40px panel at the bottom, price line above.
	const w = 720;
	const h = 270;
	const volH = 40;  // height of volume bar panel
	const priceH = h - volH;
	const pad = { t: 14, r: 8, b: 4, l: 8 };
	const closes = points.map((p) => p.c);
	const vols = points.map((p) => p.v || 0);
	const min = Math.min(...closes);
	const max = Math.max(...closes);
	const span = max - min || max || 1;
	const maxVol = Math.max(...vols) || 1;
	const innerW = w - pad.l - pad.r;
	const innerH = priceH - pad.t - pad.b;
	const x = (i) => pad.l + (i / Math.max(1, points.length - 1)) * innerW;
	const y = (v) => pad.t + innerH - ((v - min) / span) * innerH;

	const up = points.length > 1 && closes[closes.length - 1] >= closes[0];
	const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.c).toFixed(1)}`).join(' ');
	const area = `${line} L${x(points.length - 1).toFixed(1)} ${(priceH - pad.b).toFixed(1)} L${x(0).toFixed(1)} ${(priceH - pad.b).toFixed(1)} Z`;

	// Volume bars — each candle gets a bar in the lower panel. Buy-dominant
	// candles (close > open) are tinted green, sell-dominant tinted red.
	const barW = Math.max(1, (innerW / points.length) * 0.65);
	const volBars = points.map((p, i) => {
		const barH = (p.v / maxVol) * (volH - 6);
		const isUp = p.c >= p.o;
		const bx = x(i) - barW / 2;
		const by = h - barH - 2;
		return svg('rect', {
			x: bx.toFixed(1),
			y: by.toFixed(1),
			width: barW.toFixed(1),
			height: Math.max(1, barH).toFixed(1),
			class: `ld-vol-bar ${isUp ? 'ld-vol-up' : 'ld-vol-dn'}`,
			rx: '1',
		});
	});

	const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: `ld-chart-svg ${up ? 'ld-chart-up' : 'ld-chart-down'}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Price history chart with volume' });
	const gradId = 'ldchartgrad';
	const defs = svg('defs', {});
	const grad = svg('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
	grad.append(
		svg('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': '0.28' }),
		svg('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': '0' }),
	);
	defs.append(grad);
	// Divider between price and volume panels.
	const divider = svg('line', { x1: pad.l, y1: priceH, x2: w - pad.r, y2: priceH, class: 'ld-vol-divider' });
	node.append(defs, ...volBars, divider);
	node.append(
		svg('path', { d: area, fill: `url(#${gradId})`, stroke: 'none' }),
		svg('path', { d: line, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
	);
	return node;
}

function chartIntervalBar() {
	return el(
		'div',
		{ class: 'ld-chart-bar', role: 'tablist', 'aria-label': 'Chart interval' },
		INTERVALS.map(([label, value]) =>
			el('button', {
				class: `ld-int-btn${state.chartInterval === value ? ' active' : ''}`,
				type: 'button',
				role: 'tab',
				'aria-selected': String(state.chartInterval === value),
				text: label,
				onclick: () => {
					if (state.chartInterval === value) return;
					state.chartInterval = value;
					renderChart();
				},
			}),
		),
	);
}

// View switch — the fast native area chart vs. the full interactive DexScreener
// terminal (price + depth + trades). Both read the same on-chain mint; the embed
// is loaded only when chosen so the default view stays lightweight.
const CHART_VIEWS = [
	['Native', 'native'],
	['DexScreener', 'dexscreener'],
];

function chartViewBar() {
	return el(
		'div',
		{ class: 'ld-chart-views', role: 'tablist', 'aria-label': 'Chart source' },
		CHART_VIEWS.map(([label, value]) =>
			el('button', {
				class: `ld-int-btn${state.chartView === value ? ' active' : ''}`,
				type: 'button',
				role: 'tab',
				'aria-selected': String(state.chartView === value),
				text: label,
				onclick: () => {
					if (state.chartView === value) return;
					state.chartView = value;
					writeChartView(value);
					renderChart();
				},
			}),
		),
	);
}

// DexScreener serves a TradingView-grade embeddable terminal keyed by the Solana
// mint — it resolves the most-liquid pair itself, so no pair lookup is needed.
function dexEmbedUrl() {
	const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
	const params = new URLSearchParams({
		embed: '1',
		loadChartSettings: '0',
		theme,
		chartTheme: theme,
		chartType: 'usd',
		interval: '15',
		info: '0',
	});
	return `https://dexscreener.com/solana/${encodeURIComponent(state.mint)}?${params}`;
}

function dexLink() {
	return el('a', {
		class: 'ld-chart-open',
		href: `https://dexscreener.com/solana/${encodeURIComponent(state.mint)}`,
		target: '_blank',
		rel: 'noopener',
		text: 'Open in DexScreener ↗',
	});
}

function renderDexChart(target) {
	clearTimeout(state.dexFrameTimer);
	const controls = el('div', { class: 'ld-chart-controls' }, [chartViewBar(), dexLink()]);
	const wrap = el('div', { class: 'ld-dex-wrap' });
	const iframe = el('iframe', {
		class: 'ld-dex-frame',
		src: dexEmbedUrl(),
		title: 'DexScreener live chart',
		loading: 'lazy',
		onload: () => {
			clearTimeout(state.dexFrameTimer);
			wrap.classList.add('ld-dex-ready');
		},
	});
	wrap.replaceChildren(el('div', { class: 'ld-skel ld-skel-chart' }), iframe);
	section(target, 'Price', el('div', { class: 'ld-chart' }, [controls, wrap]), { tag: 'DexScreener · live' });

	// Watchdog: if the embed never loads (blocked, offline, sandbox), don't leave a
	// dead skeleton — surface a recoverable error with a retry and a direct link.
	state.dexFrameTimer = setTimeout(() => {
		if (wrap.classList.contains('ld-dex-ready')) return;
		wrap.replaceChildren(
			el('div', { class: 'ld-empty ld-empty-sm' }, [
				el('p', { text: "DexScreener's chart didn't load. It may be blocked or still indexing this coin." }),
				el('div', { class: 'ld-dex-fallback-actions' }, [
					el('button', { class: 'ld-btn ld-btn-ghost', type: 'button', text: 'Retry', onclick: () => renderChart() }),
					dexLink(),
				]),
			]),
		);
	}, 9000);
}

async function renderChart() {
	const target = $('ld-chart');
	if (state.network !== 'mainnet') {
		section(target, 'Price', el('div', { class: 'ld-empty' }, [el('p', { text: 'No price history for devnet coins.' })]));
		return;
	}
	if (state.chartView === 'dexscreener') {
		renderDexChart(target);
		return;
	}
	const controls = el('div', { class: 'ld-chart-controls' }, [chartViewBar(), chartIntervalBar()]);
	const canvas = el('div', { class: 'ld-chart-canvas' }, [el('div', { class: 'ld-skel ld-skel-chart' })]);
	section(target, 'Price', el('div', { class: 'ld-chart' }, [controls, canvas]), { tag: 'Birdeye OHLCV' });

	const interval = state.chartInterval;
	const to = Math.floor(Date.now() / 1000);
	const from = to - (WINDOW_HOURS[interval] || 36) * 3600;
	try {
		const body = await fetchJson(
			`/api/pump/price-history?mint=${encodeURIComponent(state.mint)}&interval=${interval}&from=${from}&to=${to}`,
		);
		const pts = (body.data || []).filter((p) => Number.isFinite(p.c));
		if (pts.length < 2) {
			canvas.replaceChildren(el('div', { class: 'ld-empty ld-empty-sm' }, [el('p', { text: 'Not enough trade history at this interval yet.' })]));
			return;
		}
		const first = pts[0].c;
		const last = pts[pts.length - 1].c;
		const changePct = first ? ((last - first) / first) * 100 : 0;
		const readout = [
			el('span', { class: 'ld-chart-price', text: fmtPrice(last) }),
			el('span', { class: `ld-chart-change ${pnlClass(changePct)}`, text: fmtPct(changePct, { sign: true }) }),
		];
		// The API serves its last real candles when both price sources are briefly
		// unreachable. Say so rather than passing off old prices as live.
		if (body.stale) {
			readout.push(
				el('span', {
					class: 'ld-chart-stale',
					text: 'delayed',
					title: 'The live price feed is briefly unreachable — showing the most recent candles we hold.',
				}),
			);
		}
		canvas.replaceChildren(el('div', { class: 'ld-chart-readout' }, readout), areaChart(pts));
	} catch (err) {
		// A coin with no liquidity pool has no chart to draw — that is an answer,
		// not a failure, so it gets its own copy and no Retry button.
		if (err?.status === 404 && err?.code === 'no_market') {
			canvas.replaceChildren(
				el('div', { class: 'ld-empty ld-empty-sm' }, [
					el('p', { text: 'No liquidity pool yet — this coin has no price history to chart.' }),
				]),
			);
			return;
		}
		canvas.replaceChildren(
			el('div', { class: 'ld-empty ld-empty-sm' }, [
				el('p', { text: 'Price history is unavailable right now.' }),
				el('button', { class: 'ld-btn ld-btn-ghost', type: 'button', text: 'Retry', onclick: () => renderChart() }),
			]),
		);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// HOLDER DISTRIBUTION
// ════════════════════════════════════════════════════════════════════════════

async function renderDistribution() {
	const target = $('ld-distribution');
	const intel = state.detail.intel;

	let overview = null;
	try {
		overview = await fetchJson(`/api/coin/${encodeURIComponent(state.mint)}/cohorts`);
	} catch {
		/* not an indexed agent token — fall back to intel concentration below */
	}

	const rows = [];
	let holderCount = overview?.holderCount ?? null;
	let top1 = overview?.concentration?.top1Share ?? null;
	let top10 = overview?.concentration?.top10Share ?? (intel?.concentration_top10 ?? null);
	const label = overview?.concentration?.label || null;

	if (holderCount == null && top10 == null) {
		section(
			target,
			'Holders',
			el('div', { class: 'ld-empty ld-empty-sm' }, [
				el('p', { text: 'Holder distribution is not indexed for this coin yet.' }),
			]),
		);
		return;
	}

	const metric = (k, v, tone = '') =>
		el('div', { class: 'ld-metric' }, [
			el('span', { class: 'ld-metric-label', text: k }),
			el('span', { class: `ld-metric-val ${tone}`, text: v }),
		]);

	const concTone = top10 == null ? '' : top10 > 0.5 ? 'ld-danger' : top10 > 0.3 ? 'ld-warn' : 'ld-good';
	const metrics = el('div', { class: 'ld-metrics' }, [
		holderCount != null ? metric('Holders', compact(holderCount)) : null,
		top1 != null ? metric('Top holder', pctText(top1)) : null,
		top10 != null ? metric('Top 10', pctText(top10), concTone) : null,
		label ? metric('Spread', label) : null,
	]);

	// Concentration bar — top10 vs the rest.
	let bar = null;
	if (top10 != null) {
		const t10 = Math.max(0, Math.min(100, top10 * 100));
		bar = el('div', { class: 'ld-conc' }, [
			el('div', { class: 'ld-conc-track', title: `Top 10 wallets hold ${Math.round(t10)}%` }, [
				el('div', { class: `ld-conc-top ${concTone}`, style: `width:${t10}%` }),
			]),
			el('div', { class: 'ld-conc-legend' }, [
				el('span', { text: `Top 10 · ${Math.round(t10)}%` }),
				el('span', { text: `Everyone else · ${Math.round(100 - t10)}%` }),
			]),
		]);
	}

	const cohorts = (overview?.cohorts || []).filter((c) => c.count != null && c.count > 0);
	const cohortChips = cohorts.length
		? el(
				'div',
				{ class: 'ld-cohorts' },
				cohorts.map((c) =>
					el('span', { class: 'ld-cohort', title: c.description || '' }, [
						el('b', { text: compact(c.count) }),
						el('span', { text: c.name }),
					]),
				),
			)
		: null;

	section(target, 'Holders', el('div', { class: 'ld-dist' }, [metrics, bar, cohortChips]), {
		tag: overview?.source === 'live' ? 'live · Helius' : overview ? 'snapshot' : 'engine',
	});
}

// ════════════════════════════════════════════════════════════════════════════
// BUYBACK / BURN ECONOMICS
// ════════════════════════════════════════════════════════════════════════════

function renderEconomics() {
	const target = $('ld-economics');
	const econ = state.detail.economics;
	const reg = state.detail.registry;
	const buybackBps = Number(reg?.buyback_bps || 0);

	if (!state.detail.found) {
		target.hidden = true;
		return;
	}

	const creatorFees = econ?.creator_fees;
	const hasCreatorFees = !!creatorFees && Number(creatorFees.earned_sol) > 0;

	if (buybackBps <= 0 && (!econ || econ.confirmed_payments === 0) && !hasCreatorFees) {
		section(
			target,
			'Economics',
			el('div', { class: 'ld-empty ld-empty-sm' }, [
				el('p', { text: 'This launch has no buyback-and-burn loop configured.' }),
				el('a', { class: 'ld-btn ld-btn-ghost', href: '/launchpad', text: 'How buyback coins work →' }),
			]),
		);
		return;
	}

	const burned = Number(econ?.burns?.total_burned || 0);
	const metric = (k, v, sub = null) =>
		el('div', { class: 'ld-econ-metric' }, [
			el('span', { class: 'ld-econ-val', text: v }),
			el('span', { class: 'ld-econ-label', text: k }),
			sub ? el('span', { class: 'ld-econ-sub', text: sub }) : null,
		]);

	const body = el('div', { class: 'ld-econ' }, [
		el('p', { class: 'ld-econ-lede', text: `Every agent payment routes ${(buybackBps / 100).toFixed(1)}% into an automated buyback that burns supply — paying users fund a deflationary loop.` }),
		el('div', { class: 'ld-econ-grid' }, [
			metric('Buyback rate', `${(buybackBps / 100).toFixed(1)}%`),
			metric('Paid calls', compact(econ?.confirmed_payments || 0), `${compact(econ?.unique_payers || 0)} payers`),
			metric('Burn runs', compact(econ?.burns?.runs || 0)),
			burned > 0 ? metric('Supply burned', compact(burned / 1e6)) : null,
			hasCreatorFees
				? metric(
						'Creator earned',
						fmtSol(Number(creatorFees.earned_sol), { sign: false }),
						creatorFees.earned_usd != null ? fmtUsd(Number(creatorFees.earned_usd), { sign: false }) : null,
					)
				: null,
		]),
	]);

	// Recent burn proofs — each links to its Solana transaction.
	const feed = (econ?.burns_feed || []).slice(0, 5);
	if (feed.length) {
		body.appendChild(
			el('div', { class: 'ld-burn-feed' }, [
				el('span', { class: 'ld-burn-feed-title', text: 'Recent burns' }),
				...feed.map((b) => {
					const cells = [
						el('span', { class: 'ld-burn-amt', text: `🔥 ${compact(Number(b.burn_amount || 0) / 1e6)}` }),
						el('span', { class: 'ld-burn-time', text: relTime(b.created_at) }),
					];
					// Only render a clickable tx link when the burn has a signature —
					// otherwise show a plain, non-linking row (no dead href="#").
					if (b.tx_signature) {
						cells.push(el('span', { class: 'ld-burn-link', text: 'tx ↗' }));
						return el('a', {
							class: 'ld-burn-row',
							href: `https://solscan.io/tx/${b.tx_signature}`,
							target: '_blank',
							rel: 'noopener noreferrer',
						}, cells);
					}
					return el('div', { class: 'ld-burn-row' }, cells);
				}),
			]),
		);
	}

	section(target, 'Economics', body, { tag: 'on-chain' });
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT BEHIND THE COIN
// ════════════════════════════════════════════════════════════════════════════

// Lazy-load the first-party <agent-3d> web component. Tries the CDN, then the
// same-origin mirror, then the dev bundle — robust across prod and local dev.
// Resolved once and shared, so a second mount never re-imports.
let agent3DLibPromise = null;
function ensureAgent3DLib() {
	if (customElements.get('agent-3d')) return Promise.resolve(true);
	if (agent3DLibPromise) return agent3DLibPromise;
	const candidates = [
		'https://three.ws/agent-3d/latest/agent-3d.js',
		'/agent-3d/latest/agent-3d.js',
		'/dist-lib/agent-3d.js',
	];
	agent3DLibPromise = (async () => {
		for (const url of candidates) {
			try {
				await import(/* @vite-ignore */ url);
				if (customElements.get('agent-3d')) return true;
			} catch {
				/* try next candidate */
			}
		}
		return false;
	})();
	return agent3DLibPromise;
}

// The launching agent rendered as its real, interactive 3D avatar. Every agent
// resolves to a loadable model — its own GLB when public, else the shared
// mannequin (agentAvatarGlb) — so the stage is never an empty hole. The WebGL
// context is paid only once the card scrolls into view, and a failed/slow load
// degrades to the labelled fallback instead of a blank canvas.
function buildAgentStage(agent) {
	// resolveDevR2Url is a no-op in production; on localhost / Codespaces it
	// rewrites the r2.dev GLB to the same-origin Vite proxy so the cross-origin
	// fetch isn't blocked by CORS. The mannequin fallback is a local path, so it
	// passes through untouched either way.
	const glb = resolveDevR2Url(agentAvatarGlb(agent));
	const custom = hasCustomAvatar(agent);
	const label = `${agent.name || 'Agent'} — interactive 3D avatar`;

	const stage = el('div', {
		class: 'ld-agent-stage',
		'data-state': 'idle',
		role: 'img',
		'aria-label': label,
	});

	// A blurred thumbnail backdrop fills the stage while the model streams in, so
	// the loading state reads as "this avatar, arriving" rather than an empty box.
	// It fades out once the GLB is framed. Falls back to the CSS gradient alone
	// when the agent has no thumbnail.
	if (agent.avatar_thumbnail_url) {
		stage.appendChild(
			el('div', {
				class: 'ld-agent-stage-poster',
				'aria-hidden': 'true',
				style: `background-image:url('${encodeURI(agent.avatar_thumbnail_url)}')`,
			}),
		);
	}

	const loadEl = el('div', { class: 'ld-agent-stage-load' }, [
		el('span', { class: 'ld-agent-stage-spin', 'aria-hidden': 'true' }),
		el('span', { class: 'ld-agent-stage-msg', text: 'Loading 3D…' }),
	]);
	stage.appendChild(loadEl);

	const setMsg = (text) => {
		const m = stage.querySelector('.ld-agent-stage-msg');
		if (m) m.textContent = text;
	};

	let mounted = false;
	const mount = async () => {
		if (mounted) return;
		mounted = true;
		const ok = await ensureAgent3DLib();
		if (!ok) {
			stage.dataset.state = 'error';
			setMsg("Couldn't load the 3D viewer.");
			return;
		}
		const a3d = el('agent-3d', { class: 'ld-agent-3d', alt: label });
		a3d.setAttribute('controls', 'orbit');
		a3d.setAttribute('src', glb);
		// A slow R2/CDN read shouldn't leave the spinner spinning forever with no
		// explanation — after 15s, tell the user it's a big model or slow link.
		const slowTimer = setTimeout(() => {
			if (stage.dataset.state === 'idle') setMsg('Still loading — large model or slow connection.');
		}, 15_000);
		a3d.addEventListener('load', () => {
			clearTimeout(slowTimer);
			stage.dataset.state = 'ready';
			loadEl.remove();
		}, { once: true });
		a3d.addEventListener('error', () => {
			clearTimeout(slowTimer);
			stage.dataset.state = 'error';
			setMsg("Couldn't load the 3D model.");
		}, { once: true });
		stage.appendChild(a3d);
		stage.appendChild(
			el('div', { class: 'ld-agent-stage-bar' }, [
				el('span', { class: 'ld-agent-stage-hint', text: custom ? 'Drag to orbit · scroll to zoom' : 'Base avatar · drag to orbit' }),
				el('a', {
					class: 'ld-agent-stage-world',
					href: seeInWorldHref(agent),
					text: 'See in world →',
					'aria-label': `See ${agent.name || 'this agent'} in the $THREE world`,
				}),
			]),
		);
	};

	// Pay for the WebGL context only when the card is actually near the viewport,
	// and tear the observer down once mounted so it can't fire twice.
	if ('IntersectionObserver' in window) {
		const io = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (e.isIntersecting) {
					io.disconnect();
					mount();
				}
			}
		}, { rootMargin: '240px' });
		io.observe(stage);
	} else {
		mount();
	}

	return stage;
}

function renderAgent() {
	const target = $('ld-agent');
	const agent = state.detail.agent;
	const trader = state.detail.trader;

	if (!agent) {
		target.hidden = true;
		return;
	}

	const head = el('a', { class: 'ld-agent-head', href: agent.url, 'aria-label': `View agent ${agent.name}` }, [
		el('div', { class: 'ld-agent-id' }, [
			el('span', { class: 'ld-agent-name', text: agent.name || 'Agent' }),
			el('span', { class: 'ld-agent-role', text: 'Launching agent' }),
		]),
		el('span', { class: 'ld-agent-go', text: '→' }),
	]);

	const body = el('div', { class: 'ld-agent-body' }, [buildAgentStage(agent), head]);

	// The launching agent's custodial Solana wallet — vanity-aware, copyable,
	// read-only for visitors. agent_authority (the on-chain signer) backstops the
	// agent record's own solana_address. Owner-only actions live in the wallet hub.
	const walletChip = walletChipEl(
		{
			...agent,
			id: agent.id,
			solana_address:
				agent.solana_address || agent.meta?.solana_address || state.detail.agent_authority || null,
		},
		{ isOwner: false, showPending: false, link: true },
	);
	if (walletChip) body.appendChild(walletChip);

	if (agent.description) {
		body.appendChild(el('p', { class: 'ld-agent-desc', text: agent.description }));
	}

	if (trader) {
		const tone = scoreTone(trader.score);
		const scoreEl = el('div', { class: 'ld-trader' }, [
			el('div', { class: `ld-trader-score ld-quality-${tone}` }, [
				el('span', { class: 'ld-trader-num', text: trader.score != null ? String(Math.round(trader.score)) : '—' }),
				el('span', { class: 'ld-trader-max', text: 'TraderScore' }),
			]),
			el('div', { class: 'ld-trader-stats' }, [
				trader.verified ? el('span', { class: 'ld-verified', html: verifiedBadge(true) }) : null,
				el('div', { class: 'ld-trader-row' }, [
					el('span', { class: 'ld-tl', text: 'Realized P&L' }),
					el('span', { class: `ld-tv ${pnlClass(trader.realized_pnl_sol)}`, text: fmtSol(trader.realized_pnl_sol) }),
				]),
				el('div', { class: 'ld-trader-row' }, [
					el('span', { class: 'ld-tl', text: 'Win rate' }),
					el('span', { class: 'ld-tv', text: trader.win_rate != null ? fmtPct(trader.win_rate * 100) : '—' }),
				]),
				el('div', { class: 'ld-trader-row' }, [
					el('span', { class: 'ld-tl', text: 'Closed trades' }),
					el('span', { class: 'ld-tv', text: compact(trader.closed_count || 0) }),
				]),
			]),
		]);
		body.appendChild(scoreEl);
		const ctaRow = el('div', { class: 'ld-agent-ctas' }, [
			el('a', { class: 'ld-btn ld-btn-ghost ld-btn-sm', href: `/trader/${agent.id}`, text: 'Track record →' }),
			el('a', { class: 'ld-btn ld-btn-accent ld-btn-sm', href: `/trader/${agent.id}#tp-copy-panel`, text: 'Copy trades ⚡' }),
		]);
		body.appendChild(ctaRow);
	} else {
		body.appendChild(
			el('p', { class: 'ld-agent-note', text: 'No public trading track record yet for this agent.' }),
		);
	}

	section(target, 'The agent', body);
}

// ════════════════════════════════════════════════════════════════════════════
// LIVE TRADE TAPE  (SSE with a polling fallback)
// ════════════════════════════════════════════════════════════════════════════

function tapeRow(t) {
	const isBuy = t.is_buy ?? (String(t.txType || t.type || '').toLowerCase() === 'buy');
	const sol = Number(t.sol_amount ?? (t.lamports != null ? t.lamports / 1e9 : t.solAmount));
	const who = t.user || t.buyer || t.seller || t.traderPublicKey || null;
	return el('div', { class: `ld-trade ${isBuy ? 'ld-buy' : 'ld-sell'}` }, [
		el('span', { class: 'ld-trade-side', text: isBuy ? 'BUY' : 'SELL' }),
		el('span', { class: 'ld-trade-amt', text: Number.isFinite(sol) ? fmtSol(sol, { sign: false }) : '—' }),
		el('span', { class: 'ld-trade-who', text: who ? shortAddr(who) : '' }),
	]);
}

function pushTrade(listEl, t) {
	const row = tapeRow(t);
	if (!REDUCED_MOTION) row.classList.add('ld-trade-in');
	listEl.insertBefore(row, listEl.firstChild);
	// Directional tint pulse on the freshest trade — buys read success-green, sells
	// danger-red, matching the swarms feed vocabulary on top of the slide-in.
	flashValue(row, row.classList.contains('ld-buy') ? 'up' : 'down');
	while (listEl.children.length > 24) listEl.removeChild(listEl.lastChild);
}

async function seedTape(listEl) {
	try {
		const body = await fetchJson(`/api/pump/coin-trades?mint=${encodeURIComponent(state.mint)}&limit=20`);
		const trades = body.trades || [];
		if (!trades.length) {
			listEl.appendChild(el('div', { class: 'ld-tape-empty', text: 'Waiting for the next trade…' }));
			return;
		}
		trades.forEach((t) => listEl.appendChild(tapeRow(t)));
	} catch {
		listEl.appendChild(el('div', { class: 'ld-tape-empty', text: 'Trade feed is quiet right now.' }));
	}
}

function startTape(listEl, dot) {
	// Live SSE stream caps at 90s server-side; reconnect transparently so the
	// tape stays live for as long as the page is open and visible.
	let es = null;
	let pollTimer = 0;
	let closed = false;

	const setLive = (live) => {
		setLiveDot(dot, live ? 'live' : 'connecting', live ? 'live' : 'reconnecting');
	};

	const connect = () => {
		if (closed || document.hidden) return;
		try {
			es = new EventSource(`/api/pump/trades-stream?mint=${encodeURIComponent(state.mint)}`);
		} catch {
			startPolling();
			return;
		}
		const onTrade = (e) => {
			setLive(true);
			try {
				const d = JSON.parse(e.data);
				if (d && (d.mint === state.mint || !d.mint)) {
					const empty = listEl.querySelector('.ld-tape-empty');
					if (empty) empty.remove();
					pushTrade(listEl, d);
				}
			} catch {
				/* ignore malformed frame */
			}
		};
		es.addEventListener('open', () => setLive(true));
		es.addEventListener('buy', onTrade);
		es.addEventListener('sell', onTrade);
		es.addEventListener('trade', onTrade);
		es.addEventListener('close', () => {
			es?.close();
			if (!closed) setTimeout(connect, 600); // server hit its duration cap — reconnect
		});
		es.onerror = () => {
			setLive(false);
			es?.close();
			if (!closed) setTimeout(connect, 2500);
		};
	};

	const startPolling = () => {
		// Last-resort fallback if EventSource is unavailable.
		setLive(false);
		const seen = new Set();
		const tick = async () => {
			if (closed || document.hidden) return;
			try {
				const body = await fetchJson(`/api/pump/coin-trades?mint=${encodeURIComponent(state.mint)}&limit=10`);
				for (const t of (body.trades || []).reverse()) {
					if (t.tx && !seen.has(t.tx)) {
						seen.add(t.tx);
						const empty = listEl.querySelector('.ld-tape-empty');
						if (empty) empty.remove();
						pushTrade(listEl, t);
					}
				}
			} catch {
				/* keep polling */
			}
		};
		pollTimer = setInterval(tick, 5000);
	};

	if ('EventSource' in window) connect();
	else startPolling();

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			es?.close();
			clearInterval(pollTimer);
		} else if (!closed) {
			if ('EventSource' in window) connect();
		}
	});

	return {
		destroy() {
			closed = true;
			es?.close();
			clearInterval(pollTimer);
		},
	};
}

async function renderTape() {
	const target = $('ld-tape');
	if (state.network !== 'mainnet') {
		target.hidden = true;
		return;
	}
	// Shared live-state indicator (connecting → live) for the SSE trade tape.
	const dot = el('span', { class: 'ld-tape-live', html: liveDot('connecting', { label: 'live' }) });
	const list = el('div', { class: 'ld-tape-list' });
	const head = el('div', { class: 'ld-sec-head' }, [
		el('h2', { class: 'ld-sec-title' }, [el('span', { text: 'Live trades' }), dot]),
	]);
	target.replaceChildren(head, list);
	target.classList.add('ld-revealed');

	await seedTape(list);
	state.tape = startTape(list, dot);
}

// ════════════════════════════════════════════════════════════════════════════
// COMMUNITY
// ════════════════════════════════════════════════════════════════════════════

async function renderCommunity() {
	const target = $('ld-community');
	if (state.network !== 'mainnet') {
		target.hidden = true;
		return;
	}
	const symbol = (state.coin?.symbol || state.detail.registry?.symbol || '').toUpperCase();

	const sentWrap = el('div', { class: 'ld-sentiment-wrap' }, [
		el('div', { class: 'ld-skel', style: 'height:64px;margin-bottom:10px' }),
	]);

	const body = el('div', { class: 'ld-community' }, [
		sentWrap,
		el('p', { style: 'font-size:12.5px;color:var(--ld-muted)', text: `Every coin gets a live chat and a walkable 3D world. Meet the holders of ${symbol ? `$${symbol}` : 'this coin'}.` }),
		el('div', { class: 'ld-community-ctas', style: 'margin-top:10px' }, [
			el('a', { class: 'ld-btn ld-btn-ghost', href: `/communities/${state.mint}`, text: 'Open chat & world →' }),
		]),
	]);
	section(target, 'Community', body, { tag: 'pump.fun sentiment' });

	// Async: fetch pump.fun comment sentiment
	try {
		const res = await fetch('/api/social/sentiment-pulse', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: state.mint }),
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) { sentWrap.replaceChildren(); return; }
		const d = await res.json();
		if (!d.ok || !d.overall || d.overall.count < 3) { sentWrap.replaceChildren(); return; }
		const o = d.overall;
		const scoreColor = o.score >= 60 ? 'var(--ld-good)' : o.score <= 40 ? 'var(--ld-bad)' : 'var(--ld-muted)';
		const sentLabel = o.score >= 60 ? 'bullish' : o.score <= 40 ? 'bearish' : 'mixed';

		const bars = [
			['Positive', Math.round(o.posPct), 'var(--ld-good)'],
			['Negative', Math.round(o.negPct), 'var(--ld-bad)'],
			['Neutral',  Math.round(o.neuPct), 'var(--ld-muted)'],
		].map(([label, pct, color]) =>
			el('div', { class: 'ld-oracle-pillar' }, [
				el('span', { class: 'ld-oracle-pillar-label', text: label }),
				el('div', { class: 'ld-oracle-pillar-bar' }, [
					el('div', { class: 'ld-oracle-pillar-fill', style: `width:${pct}%;background:${color}` }),
				]),
				el('span', { class: 'ld-oracle-pillar-val', text: `${pct}%` }),
			])
		);

		const examples = (o.examples || []).slice(0, 1).map((ex) =>
			el('p', { class: 'ld-sent-example', style: 'font-size:11px;color:var(--ld-muted);margin-top:6px;font-style:italic;line-height:1.5' }, [
				document.createTextNode(`"${ex}"`)
			])
		);

		sentWrap.replaceChildren(
			el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, [
				el('span', { style: `font:600 12px var(--font-mono,monospace);color:${scoreColor}` }, [document.createTextNode(sentLabel)]),
				el('span', { style: 'font:10px var(--font-mono,monospace);color:var(--ld-muted)' }, [document.createTextNode(`${o.count} comments`)]),
			]),
			el('div', { class: 'ld-oracle-pillars' }, bars),
			...examples,
		);
	} catch {
		sentWrap.replaceChildren();
	}
}

// ════════════════════════════════════════════════════════════════════════════
// ACTIONS  (buy / 3D / watch / share)
// ════════════════════════════════════════════════════════════════════════════

const WATCH_KEY = 'ld_watchlist';

function readWatchlist() {
	try {
		return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
	} catch {
		return [];
	}
}

function isWatched() {
	return readWatchlist().includes(state.mint);
}

function toggleWatch(btn) {
	const list = readWatchlist();
	const i = list.indexOf(state.mint);
	if (i >= 0) list.splice(i, 1);
	else list.unshift(state.mint);
	try {
		localStorage.setItem(WATCH_KEY, JSON.stringify(list.slice(0, 200)));
	} catch {
		/* storage full / blocked — non-fatal */
	}
	paintWatch(btn);
}

function paintWatch(btn) {
	const on = isWatched();
	btn.classList.toggle('ld-watch-on', on);
	btn.setAttribute('aria-pressed', String(on));
	btn.replaceChildren(
		el('span', { text: on ? '★' : '☆' }),
		el('span', { text: on ? 'Watching' : 'Watch' }),
	);
}

function renderActions() {
	const target = $('ld-actions');
	const isDevnet = state.network === 'devnet';
	const symbol = (state.coin?.symbol || state.detail.registry?.symbol || '').toUpperCase();
	const mint = state.mint;

	const watchBtn = el('button', { class: 'ld-btn ld-watch', type: 'button', 'aria-pressed': 'false' });
	paintWatch(watchBtn);
	watchBtn.addEventListener('click', () => toggleWatch(watchBtn));

	const shareBtn = el('button', {
		class: 'ld-btn ld-btn-ghost',
		type: 'button',
		text: 'Share',
		onclick: async (e) => {
			const url = `${location.origin}/launches/${mint}`;
			const title = `${symbol ? `$${symbol}` : 'This coin'} on three.ws`;
			if (navigator.share) {
				try {
					await navigator.share({ title, url });
					return;
				} catch {
					/* user cancelled or unsupported — fall through to copy */
				}
			}
			try {
				await navigator.clipboard.writeText(url);
				const btn = e.currentTarget;
				const old = btn.textContent;
				btn.textContent = 'Link copied';
				setTimeout(() => (btn.textContent = old), 1400);
			} catch {
				window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener');
			}
		},
	});

	const buttons = [];

	if (isDevnet) {
		buttons.push(
			el('a', { class: 'ld-btn ld-btn-primary', href: `https://explorer.solana.com/address/${mint}?cluster=devnet`, target: '_blank', rel: 'noopener noreferrer', text: 'View on explorer ↗' }),
		);
	} else {
		// Primary: in-platform Jupiter Terminal swap — keeps traders on three.ws.
		buttons.push(
			el('button', {
				class: 'ld-btn ld-btn-primary ld-btn-buy',
				type: 'button',
				text: `Buy ${symbol ? `$${symbol}` : 'token'}`,
				onclick: () => openSwapModal(mint, symbol),
			}),
		);
		// Secondary: pump.fun direct link for power users who prefer it.
		buttons.push(
			el('a', { class: 'ld-btn ld-btn-ghost', href: `https://pump.fun/${mint}`, target: '_blank', rel: 'noopener noreferrer', text: 'pump.fun ↗' }),
		);
		buttons.push(el('a', { class: 'ld-btn ld-btn-ghost', href: `/coin3d?mint=${encodeURIComponent(mint)}`, text: 'View in 3D' }));
	}

	buttons.push(watchBtn, shareBtn);

	const body = el('div', { class: 'ld-action-grid' }, buttons);
	const foot = el('a', { class: 'ld-actions-foot', href: '/watchlist', text: 'View your watchlist →' });
	section(target, 'Take action', el('div', {}, [body, foot]));
}

// ════════════════════════════════════════════════════════════════════════════
// AMBIENT FIELD  (shared visual language with /launches)
// ════════════════════════════════════════════════════════════════════════════

function startParticleField() {
	const canvas = $('ld-field');
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	let width = 0;
	let height = 0;
	let particles = [];
	let inkRGB = '232,232,232';
	let raf = 0;

	const readInk = () => {
		const scheme = getComputedStyle(document.documentElement).getPropertyValue('color-scheme');
		inkRGB = scheme.includes('light') ? '20,24,34' : '232,232,232';
	};
	const resize = () => {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		width = window.innerWidth;
		height = window.innerHeight;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const target = Math.min(70, Math.floor((width * height) / 30000));
		particles = Array.from({ length: target }, () => ({
			x: Math.random() * width,
			y: Math.random() * height,
			vx: (Math.random() - 0.5) * 0.1,
			vy: (Math.random() - 0.5) * 0.1,
			r: 0.6 + Math.random() * 1,
		}));
	};
	const draw = () => {
		ctx.clearRect(0, 0, width, height);
		for (const p of particles) {
			p.x += p.vx;
			p.y += p.vy;
			if (p.x < -10) p.x = width + 10;
			if (p.x > width + 10) p.x = -10;
			if (p.y < -10) p.y = height + 10;
			if (p.y > height + 10) p.y = -10;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${inkRGB},0.14)`;
			ctx.fill();
		}
		for (let i = 0; i < particles.length; i++) {
			for (let j = i + 1; j < particles.length; j++) {
				const a = particles[i];
				const b = particles[j];
				const dx = a.x - b.x;
				const dy = a.y - b.y;
				const d2 = dx * dx + dy * dy;
				if (d2 < 12100) {
					const alpha = 0.045 * (1 - Math.sqrt(d2) / 110);
					ctx.beginPath();
					ctx.moveTo(a.x, a.y);
					ctx.lineTo(b.x, b.y);
					ctx.strokeStyle = `rgba(${inkRGB},${alpha.toFixed(3)})`;
					ctx.lineWidth = 0.6;
					ctx.stroke();
				}
			}
		}
	};
	const loop = () => {
		draw();
		raf = requestAnimationFrame(loop);
	};
	readInk();
	resize();
	window.addEventListener('resize', resize, { passive: true });
	new MutationObserver(readInk).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	if (REDUCED_MOTION) {
		draw();
		return;
	}
	loop();
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) cancelAnimationFrame(raf);
		else loop();
	});
}

// ════════════════════════════════════════════════════════════════════════════
// STATES
// ════════════════════════════════════════════════════════════════════════════

function renderSkeleton() {
	$('ld-hero').replaceChildren(
		el('div', { class: 'ld-hero-top' }, [
			el('div', { class: 'ld-skel ld-skel-avatar' }),
			el('div', { class: 'ld-skel-stack' }, [
				el('div', { class: 'ld-skel', style: 'width:55%;height:26px' }),
				el('div', { class: 'ld-skel', style: 'width:35%;height:16px' }),
			]),
		]),
		el('div', { class: 'ld-hero-stats' }, Array.from({ length: 4 }, () => el('div', { class: 'ld-skel', style: 'height:46px' }))),
	);
	for (const id of ['ld-verdict', 'ld-chart', 'ld-agent', 'ld-oracle']) {
		$(id).replaceChildren(el('div', { class: 'ld-skel', style: 'height:120px' }));
	}
}

function renderFatal(message) {
	const shell = $('ld-shell');
	shell.setAttribute('aria-busy', 'false');
	shell.querySelectorAll('.ld-section, .ld-hero, .ld-body').forEach((n) => (n.hidden = true));
	$('ld-state').replaceChildren(
		el('div', { class: 'ld-fatal' }, [
			el('h1', { text: message.title }),
			el('p', { text: message.body }),
			el('div', { class: 'ld-fatal-ctas' }, [
				el('a', { class: 'ld-btn ld-btn-primary', href: '/launches', text: 'Browse all launches' }),
				message.retry ? el('button', { class: 'ld-btn ld-btn-ghost', type: 'button', text: 'Retry', onclick: () => location.reload() }) : null,
			]),
		]),
	);
}

// ── Launch Copilot — autonomous market-maker panel ──────────────────────────
// Only coins launched through three.ws (which have an agent wallet) can run a
// market-maker, so the panel renders for those. The copilot handles owner vs.
// public (read-only, transparent) views itself.
let _copilot = null;
function renderCopilot() {
	const target = $('ld-copilot');
	if (!target) return;
	if (!state.detail?.found) { target.remove(); return; }
	const reg = state.detail.registry || {};
	const intel = state.detail.intel || {};
	import('./launch-copilot.js')
		.then(({ mountLaunchCopilot }) => {
			if (_copilot) _copilot.destroy();
			_copilot = mountLaunchCopilot(target, {
				mint: state.mint,
				network: state.network,
				symbol: (reg.symbol || intel.symbol || '').toUpperCase(),
				coinName: reg.name || intel.name || '',
			});
		})
		.catch(() => { target.remove(); });
}

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

async function boot() {
	startParticleField();

	state.chartView = readChartView();
	state.mint = resolveMint();
	if (!state.mint) {
		renderFatal({
			title: 'No coin selected',
			body: 'This page needs a Solana mint address. Pick a coin from the launch feed to see its full profile.',
		});
		return;
	}

	renderSkeleton();

	let detail;
	try {
		detail = await loadDetail();
	} catch {
		renderFatal({
			title: "Couldn't load this coin",
			body: 'The launch API did not respond. Check your connection and try again.',
			retry: true,
		});
		return;
	}
	state.detail = detail;
	state.coin = await loadCoin();

	// Update page-level meta tags so JS-capable crawlers (X, Telegram, Discord)
	// see coin-specific OG data instead of the static placeholder in HTML.
	const regName = detail.registry?.name || detail.intel?.name || '';
	const regSym = detail.registry?.symbol || detail.intel?.symbol || '';
	const pageTitle = [regSym ? `$${regSym}` : '', regName, 'three.ws'].filter(Boolean).join(' · ');
	const pageDesc = `${regSym ? `$${regSym} ` : ''}on three.ws — live price, intelligence score, smart money, and trade history.`;
	const ogImg = `https://three.ws/api/pump/launch-og?mint=${state.mint}`;
	document.title = pageTitle;
	setMeta('og:title', pageTitle);
	setMeta('og:description', pageDesc);
	setMeta('og:image', ogImg);
	setMeta('twitter:title', pageTitle);
	setMeta('twitter:description', pageDesc);
	setMeta('twitter:image', ogImg);

	$('ld-shell').setAttribute('aria-busy', 'false');

	// Paint everything. Each section owns its own empty/error state, so one
	// missing data source never blanks the page.
	renderHero();
	renderMetrics();
	renderVerdict();
	renderOracleConviction();
	renderSmartMoney();
	renderChart();
	renderDistribution();
	renderEconomics();
	renderAgent();
	renderTape();
	renderCommunity();
	renderActions();
	renderCopilot();

	// Refresh the live market every 30s so price / mcap / graduation stay fresh.
	state.priceTimer = setInterval(async () => {
		if (document.hidden) return;
		const prev = state.coin;
		const fresh = await loadCoin();
		if (fresh) {
			state.coin = fresh;
			renderHero();
			// Real-value deltas across the 30s poll drive the game-feel beats: tint the
			// market-cap stat in the direction it moved, and fire a single ripple the
			// moment a coin graduates — a genuine "it shipped" milestone, not a timer.
			const prevMcap = Number(prev?.usd_market_cap);
			const nextMcap = Number(fresh?.usd_market_cap);
			if (Number.isFinite(prevMcap) && Number.isFinite(nextMcap) && nextMcap !== prevMcap) {
				flashValue($('ld-hero')?.querySelector('.ld-stat-mcap dd'), nextMcap > prevMcap ? 'up' : 'down');
			}
			if (prev && prev.complete !== true && fresh.complete === true) {
				rippleOnce($('ld-hero')?.querySelector('.ld-grad'));
			}
		}
	}, 30_000);
}

window.addEventListener('beforeunload', () => {
	state.tape?.destroy?.();
	clearInterval(state.priceTimer);
});

boot();
