/**
 * Money Pulse — the shared, embeddable live wallet-activity component.
 *
 * One component, three variants, every row a REAL event from /api/pulse (the
 * real agent_custody_events ledger + real launch records). There are no
 * synthetic events: a quiet platform shows an honest empty state, never a fake
 * scroll.
 *
 *   variant: 'full'    — the /pulse page feed (filters + load-more + live)
 *   variant: 'agent'   — one wallet's public story (scoped to agentId)
 *   variant: 'ticker'  — a compact horizontal marquee for home/launches/galaxy
 *
 * Live updates poll a cheap delta (`?since=<cursor>`) and PAUSE when the tab is
 * hidden (visibilitychange) or the component scrolls offscreen
 * (IntersectionObserver) — no runaway intervals, no fabricated cadence. New
 * events animate in; an opt-in "money sound" chimes on arrival.
 *
 * Usage:
 *   import { mountMoneyPulse } from './shared/money-pulse.js';
 *   const handle = mountMoneyPulse({ mount, variant: 'full', network: 'mainnet' });
 *   // handle.destroy(), handle.setType('tips'), handle.setNetwork('devnet')
 */

import { walletChipEl } from './agent-wallet-chip.js';

const POLL_MS = 15_000;          // delta poll cadence when live + visible
const TICKER_POLL_MS = 30_000;
const MAX_RENDERED = 200;        // hard cap on DOM rows (virtualization floor)

const KIND_META = {
	tip:     { glyph: '◎', label: 'Tip',     verb: 'received a tip',  cls: 'mp-k-tip' },
	trade:   { glyph: '⇄', label: 'Trade',   verb: 'traded',          cls: 'mp-k-trade' },
	snipe:   { glyph: '⚡', label: 'Snipe',   verb: 'sniped',          cls: 'mp-k-snipe' },
	payment: { glyph: '→', label: 'Payment', verb: 'paid',            cls: 'mp-k-pay' },
	purchase:{ glyph: '⊕', label: 'Purchase',verb: 'bought a skill',  cls: 'mp-k-purchase' },
	launch:  { glyph: '✦', label: 'Launch',  verb: 'launched',        cls: 'mp-k-launch' },
};

const FILTERS = [
	{ id: 'all', label: 'All' },
	{ id: 'tips', label: 'Tips' },
	{ id: 'launches', label: 'Launches' },
	{ id: 'trades', label: 'Trades' },
	{ id: 'payments', label: 'Payments' },
	{ id: 'purchases', label: 'Purchases' },
];

let _stylesInjected = false;
function injectStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const css = `
.mp { --mp-accent: var(--wallet-accent, #c4b5fd); --mp-accent-soft: var(--wallet-accent-soft, rgba(139,92,246,.16));
	font-family: var(--font-body, system-ui, sans-serif); color: var(--ink, #e8e8e8); }
.mp-toolbar { display: flex; flex-wrap: wrap; gap: var(--space-xs, 8px); align-items: center; margin-bottom: var(--space-md, 16px); }
.mp-filters { display: flex; gap: 4px; flex-wrap: wrap; }
.mp-filter { appearance: none; font: inherit; font-size: var(--text-sm, .8rem); font-weight: 500; color: var(--ink-dim, #888);
	background: var(--surface-1, rgba(255,255,255,.03)); border: 1px solid var(--stroke, rgba(255,255,255,.08));
	border-radius: var(--radius-pill, 999px); padding: 6px 13px; cursor: pointer;
	transition: color var(--duration-fast,140ms) ease, background var(--duration-fast,140ms) ease, border-color var(--duration-fast,140ms) ease; }
.mp-filter:hover { color: var(--ink, #e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); }
.mp-filter[aria-pressed="true"] { color: var(--ink-bright, #fff); background: var(--mp-accent-soft); border-color: var(--mp-accent); }
.mp-filter:focus-visible { outline: 2px solid var(--mp-accent); outline-offset: 2px; }
.mp-spacer { flex: 1 1 auto; }
.mp-livedot { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-2xs, .68rem); letter-spacing: .08em;
	text-transform: uppercase; color: var(--ink-dim, #888); }
.mp-livedot::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--success, #4ade80);
	box-shadow: 0 0 0 0 rgba(74,222,128,.6); animation: mp-pulse 2.4s var(--ease-standard, ease) infinite; }
.mp-livedot[data-state="paused"]::before { background: var(--ink-faint, #555); animation: none; box-shadow: none; }
.mp-livedot[data-state="error"]::before { background: var(--warn, #fbbf24); animation: none; }
@keyframes mp-pulse { 0% { box-shadow: 0 0 0 0 rgba(74,222,128,.5);} 70% { box-shadow: 0 0 0 7px rgba(74,222,128,0);} 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0);} }
.mp-sound { appearance: none; background: transparent; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-pill,999px);
	color: var(--ink-dim,#888); cursor: pointer; font-size: var(--text-xs,.72rem); padding: 5px 11px; transition: color .14s ease, border-color .14s ease; }
.mp-sound:hover { color: var(--ink,#e8e8e8); border-color: var(--mp-accent); }
.mp-sound[aria-pressed="true"] { color: var(--mp-accent); border-color: var(--mp-accent); }

.mp-list { display: flex; flex-direction: column; gap: 6px; list-style: none; margin: 0; padding: 0; }
.mp-row { display: flex; align-items: center; gap: var(--space-sm, 12px); padding: 11px 13px; border-radius: var(--radius-md, 10px);
	background: var(--surface-1, rgba(255,255,255,.03)); border: 1px solid var(--stroke, rgba(255,255,255,.06));
	text-decoration: none; color: inherit; transition: background .14s ease, border-color .14s ease, transform .14s ease; }
.mp-row:hover { background: var(--surface-2, rgba(255,255,255,.05)); border-color: var(--stroke-strong, rgba(255,255,255,.14)); }
.mp-row:focus-visible { outline: 2px solid var(--mp-accent); outline-offset: 1px; }
.mp-row.mp-new { animation: mp-land .6s var(--ease-standard, cubic-bezier(.2,.8,.2,1)); }
@keyframes mp-land { 0% { opacity: 0; transform: translateY(-8px) scale(.99); background: var(--mp-accent-soft); }
	100% { opacity: 1; transform: none; } }
.mp-av { width: 36px; height: 36px; border-radius: 50%; flex: 0 0 auto; object-fit: cover; background: var(--surface-3, rgba(255,255,255,.08));
	border: 1px solid var(--stroke, rgba(255,255,255,.08)); display: grid; place-items: center; font-weight: 600; color: var(--ink-dim,#888); font-size: .8rem; overflow: hidden; }
.mp-glyph { position: relative; flex: 0 0 auto; width: 20px; text-align: center; font-size: 1rem; }
.mp-k-tip .mp-glyph { color: var(--success, #4ade80); }
.mp-k-launch .mp-glyph { color: var(--mp-accent); }
.mp-k-snipe .mp-glyph { color: var(--warn, #fbbf24); }
.mp-k-trade .mp-glyph, .mp-k-pay .mp-glyph { color: var(--ink-dim, #9aa); }
.mp-k-purchase .mp-glyph { color: var(--mp-accent); }
.mp-body { flex: 1 1 auto; min-width: 0; }
.mp-line { font-size: var(--text-md, .84rem); line-height: 1.3; color: var(--ink, #e8e8e8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-name { font-weight: 600; color: var(--ink-bright, #fff); }
.mp-amount { font-family: var(--font-mono, ui-monospace, monospace); color: var(--ink-bright, #fff); }
.mp-usd { color: var(--ink-dim, #888); }
.mp-token { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 600; color: var(--mp-accent, #8b7cff); }
.mp-token-mint { font-weight: 500; color: var(--ink, #e8e8e8); opacity: .82; }
.mp-tick .mp-token { color: inherit; }
.mp-meta { display: flex; align-items: center; gap: 8px; margin-top: 3px; font-size: var(--text-2xs, .68rem); color: var(--ink-faint, #666); }
.mp-chip-slot { display: inline-flex; }
.mp-time { white-space: nowrap; }
.mp-explore { color: var(--ink-faint, #666); text-decoration: none; }
.mp-explore:hover { color: var(--mp-accent); }
.mp-right { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.mp-kindtag { font-size: var(--text-2xs,.66rem); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint,#666); }

.mp-skeleton { height: 60px; border-radius: var(--radius-md,10px); background: linear-gradient(90deg, var(--surface-1,rgba(255,255,255,.03)) 25%, var(--surface-2,rgba(255,255,255,.06)) 37%, var(--surface-1,rgba(255,255,255,.03)) 63%); background-size: 400% 100%; animation: mp-shimmer 1.4s ease infinite; }
@keyframes mp-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
.mp-empty, .mp-error { text-align: center; padding: var(--space-xl, 40px) var(--space-md,16px); color: var(--ink-dim, #888); border: 1px dashed var(--stroke, rgba(255,255,255,.1)); border-radius: var(--radius-lg,14px); }
.mp-empty-icon { font-size: 2rem; opacity: .6; }
.mp-empty-title { color: var(--ink-bright, #fff); font-weight: 600; margin: 10px 0 4px; }
.mp-empty-sub { font-size: var(--text-sm, .8rem); }
.mp-empty-sub a { color: var(--mp-accent); }
.mp-empty-switch { margin-top: 14px; }
.mp-empty-cta { appearance: none; font: inherit; font-size: var(--text-sm, .8rem); font-weight: 600; cursor: pointer;
	color: var(--ink-bright, #fff); background: var(--mp-accent-soft); border: 1px solid var(--mp-accent);
	border-radius: var(--radius-pill, 999px); padding: 8px 16px; transition: background .14s ease, transform .14s ease; }
.mp-empty-cta:hover { background: var(--wallet-accent, #c4b5fd); color: #1a1320; transform: translateY(-1px); }
.mp-empty-cta:focus-visible { outline: 2px solid var(--mp-accent); outline-offset: 2px; }
.mp-more { display: block; width: 100%; margin-top: var(--space-md,16px); appearance: none; font: inherit; font-weight: 600;
	background: var(--surface-1, rgba(255,255,255,.03)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); color: var(--ink, #e8e8e8);
	border-radius: var(--radius-md,10px); padding: 11px; cursor: pointer; transition: background .14s ease; }
.mp-more:hover { background: var(--surface-2, rgba(255,255,255,.05)); }
.mp-more[disabled] { opacity: .5; cursor: default; }

/* Ticker variant */
.mp-ticker { --mp-accent: var(--wallet-accent, #c4b5fd); position: relative; overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent); -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent); }
.mp-ticker-track { display: inline-flex; gap: 26px; white-space: nowrap; will-change: transform; animation: mp-marquee var(--mp-dur, 60s) linear infinite; }
.mp-ticker:hover .mp-ticker-track { animation-play-state: paused; }
@keyframes mp-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.mp-tick { display: inline-flex; align-items: center; gap: 7px; font-size: var(--text-sm,.8rem); color: var(--ink-dim,#9aa); text-decoration: none; }
.mp-tick:hover { color: var(--ink-bright,#fff); }
.mp-tick .mp-glyph { width: auto; }
.mp-tick b { color: var(--ink-bright,#fff); font-weight: 600; }
.mp-tick .mp-amount { color: var(--ink, #e8e8e8); }
@media (prefers-reduced-motion: reduce) {
	.mp-row.mp-new, .mp-livedot::before, .mp-skeleton { animation: none; }
	.mp-ticker-track { animation: none; }
}
@media (max-width: 560px) { .mp-line { white-space: normal; } .mp-kindtag { display: none; } }
`;
	const tag = document.createElement('style');
	tag.id = 'mp-styles';
	tag.textContent = css;
	document.head.appendChild(tag);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 5) return 'just now';
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	return `${d}d ago`;
}

function fmtAmount(ev) {
	if (ev.kind === 'launch') return '';
	if (ev.sol != null && (ev.asset === 'SOL' || !ev.asset)) {
		const v = ev.sol;
		const s = v >= 1 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
		return `◎${s}`;
	}
	if (ev.amount_raw != null) {
		// $THREE-denominated rows (skill purchases) show the token amount, compacted.
		if (ev.asset === 'THREE' || ev.kind === 'purchase') {
			const t = Number(ev.amount_raw) / 1e6;
			const s = t >= 1000 ? `${(t / 1000).toFixed(1)}k` : (t >= 1 ? String(Math.round(t)) : t.toFixed(2));
			return `${s} $THREE`;
		}
		// USDC (6dp) is the only other non-SOL asset we price; show $ when priced.
		if (ev.usd != null) return `$${Number(ev.usd).toFixed(2)}`;
		return `${(Number(ev.amount_raw) / 1e6).toFixed(2)}`;
	}
	return '';
}

function usdLabel(ev) {
	if (ev.usd == null || ev.kind === 'launch') return '';
	// Don't double-print $ for a USDC payment we already showed as $.
	if (ev.amount_raw != null && (ev.sol == null)) return '';
	return ` · $${Number(ev.usd).toFixed(2)}`;
}

// Short, base58-safe mint elision for when we have a mint but no resolved symbol.
function shortMint(mint) {
	if (!mint || mint.length <= 10) return mint || '';
	return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

// The traded-token chip: "$SYMBOL" when the mint resolves to a known token,
// otherwise the elided mint (e.g. "4h3K…9xQr"). Empty when no token is known
// (generic SOL spends), so the sentence gracefully reads "traded ◎0.012".
// Rendered as a span, never a nested <a> — the whole row is already an anchor.
function tokenLabelHTML(ev) {
	if (ev.symbol) {
		const title = ev.coin_name ? ` title="${esc(ev.coin_name)}"` : '';
		return `<span class="mp-token"${title}>$${esc(ev.symbol)}</span>`;
	}
	if (ev.mint) {
		return `<span class="mp-token mp-token-mint" title="${esc(ev.mint)}">${esc(shortMint(ev.mint))}</span>`;
	}
	return '';
}

// Build the human sentence fragment (the part after the avatar). Returns HTML.
function sentenceHTML(ev) {
	const k = KIND_META[ev.kind] || KIND_META.trade;
	const name = esc(ev.agent?.name || 'An agent');
	const amt = fmtAmount(ev);
	const amtHTML = amt ? ` <span class="mp-amount">${esc(amt)}</span>` : '';
	const usd = usdLabel(ev);
	const usdHTML = usd ? `<span class="mp-usd">${esc(usd)}</span>` : '';
	switch (ev.kind) {
		case 'tip':
			return `<span class="mp-name">${name}</span> received a${amtHTML} tip${usdHTML}`;
		case 'launch':
			return `<span class="mp-name">${name}</span> launched ${ev.symbol ? `$${esc(ev.symbol)}` : esc(ev.coin_name || 'a coin')}`;
		case 'snipe': {
			const tok = tokenLabelHTML(ev);
			return `<span class="mp-name">${name}</span> sniped${tok ? ` ${tok}` : ''}${amtHTML}${usdHTML}`;
		}
		case 'payment':
			return `<span class="mp-name">${name}</span> paid${amtHTML}${usdHTML}`;
		case 'purchase': {
			const skill = ev.skill ? `<span class="mp-amount">${esc(ev.skill)}</span>` : 'a skill';
			return `<span class="mp-name">${name}</span> bought ${skill}${amtHTML ? ` for${amtHTML}` : ''}`;
		}
		case 'trade':
		default: {
			const tok = tokenLabelHTML(ev);
			return `<span class="mp-name">${name}</span> traded${tok ? ` ${tok}` : ''}${amtHTML}${usdHTML}`;
		}
	}
}

// Avatar element: image when available, else a monogram.
function avatarEl(agent) {
	const url = agent?.avatar_thumbnail_url;
	if (url) {
		const img = document.createElement('img');
		img.className = 'mp-av';
		img.src = url;
		img.alt = '';
		img.loading = 'lazy';
		img.onerror = () => { img.replaceWith(monogram(agent)); };
		return img;
	}
	return monogram(agent);
}
function monogram(agent) {
	const d = document.createElement('div');
	d.className = 'mp-av';
	d.setAttribute('aria-hidden', 'true');
	d.textContent = (agent?.name || '?').trim().charAt(0).toUpperCase();
	return d;
}

// One full feed row (anchor → agent profile).
function rowEl(ev) {
	const k = KIND_META[ev.kind] || KIND_META.trade;
	const a = document.createElement('a');
	a.className = `mp-row ${k.cls}`;
	a.href = ev.agent?.url || (ev.mint ? `/oracle/coin/${ev.mint}` : '#');
	a.dataset.id = ev.id;
	a.setAttribute('aria-label', `${ev.agent?.name || 'Agent'} ${k.verb} — ${timeAgo(ev.ts)}`);

	a.appendChild(avatarEl(ev.agent));

	const glyph = document.createElement('span');
	glyph.className = 'mp-glyph';
	glyph.setAttribute('aria-hidden', 'true');
	glyph.textContent = k.glyph;
	a.appendChild(glyph);

	const body = document.createElement('div');
	body.className = 'mp-body';
	const line = document.createElement('div');
	line.className = 'mp-line';
	line.innerHTML = sentenceHTML(ev);
	body.appendChild(line);

	const meta = document.createElement('div');
	meta.className = 'mp-meta';
	// Wallet chip (link:false so the chip's own links don't nest inside the row anchor).
	if (ev.agent?.solana_address) {
		const chip = walletChipEl(
			{
				name: ev.agent.name,
				meta: {
					solana_address: ev.agent.solana_address,
					solana_vanity_prefix: ev.agent.solana_vanity_prefix,
					solana_vanity_suffix: ev.agent.solana_vanity_suffix,
				},
			},
			// Lean inline chip — just the vanity-aware address. No live-balance
			// hydration or popover per row (one feed can show dozens of chips; we
			// never want a balance request storm here).
			{ link: false, tip: false, showPending: false, balance: false, popover: false },
		);
		if (chip) {
			const slot = document.createElement('span');
			slot.className = 'mp-chip-slot';
			slot.appendChild(chip);
			meta.appendChild(slot);
		}
	}
	const time = document.createElement('span');
	time.className = 'mp-time';
	time.textContent = timeAgo(ev.ts);
	time.dateTime = ev.ts;
	meta.appendChild(time);

	if (ev.explorer || ev.mint_explorer) {
		const ex = document.createElement('a');
		ex.className = 'mp-explore';
		ex.href = ev.explorer || ev.mint_explorer;
		ex.target = '_blank';
		ex.rel = 'noopener noreferrer';
		ex.textContent = ev.kind === 'launch' ? 'mint ↗' : 'tx ↗';
		ex.addEventListener('click', (e) => e.stopPropagation());
		meta.appendChild(ex);
	}
	body.appendChild(meta);
	a.appendChild(body);

	const right = document.createElement('div');
	right.className = 'mp-right';
	const tag = document.createElement('span');
	tag.className = 'mp-kindtag';
	tag.textContent = k.label;
	right.appendChild(tag);
	a.appendChild(right);

	return a;
}

// Compact ticker item.
function tickEl(ev) {
	const k = KIND_META[ev.kind] || KIND_META.trade;
	const a = document.createElement('a');
	a.className = `mp-tick ${k.cls}`;
	a.href = ev.agent?.url || (ev.mint ? `/oracle/coin/${ev.mint}` : '/pulse');
	const amt = fmtAmount(ev);
	// Name the token on trade/snipe ticks too, mirroring the full feed row.
	const tradeTok = (ev.kind === 'trade' || ev.kind === 'snipe') && (ev.symbol || ev.mint)
		? ` <span class="mp-token">${ev.symbol ? `$${esc(ev.symbol)}` : esc(shortMint(ev.mint))}</span>`
		: '';
	a.innerHTML =
		`<span class="mp-glyph" aria-hidden="true">${k.glyph}</span>` +
		`<b>${esc(ev.agent?.name || 'Agent')}</b> ${esc(k.verb)}` +
		tradeTok +
		(amt ? ` <span class="mp-amount">${esc(amt)}</span>` : '') +
		(ev.kind === 'launch' && ev.symbol ? ` <span class="mp-amount">$${esc(ev.symbol)}</span>` : '');
	return a;
}

// A tiny, opt-in "money sound": a soft two-note chime synthesized on the fly.
// No audio files, no autoplay — only fires after the user toggles it on.
function makeChime() {
	let ctx = null;
	return {
		play() {
			try {
				ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
				if (ctx.state === 'suspended') ctx.resume();
				const now = ctx.currentTime;
				[880, 1320].forEach((freq, i) => {
					const o = ctx.createOscillator();
					const g = ctx.createGain();
					o.type = 'sine';
					o.frequency.value = freq;
					const t = now + i * 0.07;
					g.gain.setValueAtTime(0, t);
					g.gain.linearRampToValueAtTime(0.06, t + 0.02);
					g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
					o.connect(g).connect(ctx.destination);
					o.start(t);
					o.stop(t + 0.24);
				});
			} catch { /* audio unavailable — silent, never throws */ }
		},
	};
}

async function fetchPulse(params) {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, v);
	const res = await fetch(`/api/pulse?${qs.toString()}`, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const e = new Error(`pulse ${res.status}`);
		e.status = res.status;
		throw e;
	}
	const json = await res.json();
	return json.data;
}

/**
 * Mount a Money Pulse surface.
 * @param {object} o
 * @param {HTMLElement} o.mount
 * @param {'full'|'agent'|'ticker'} [o.variant='full']
 * @param {string} [o.agentId]
 * @param {string} [o.network='mainnet']
 * @param {string} [o.type='all']
 * @param {boolean} [o.live=true]
 * @param {boolean} [o.controls]   show the filter/sound toolbar (default: full only)
 * @param {number} [o.pageSize=30]
 * @param {string} [o.emptyHint]   override empty-state CTA copy
 * @param {(n:string)=>void} [o.onRequestNetwork]  host-owned network switch (empty-state self-heal)
 * @param {(t:string)=>void} [o.onRequestType]     host-owned filter switch (empty-state self-heal)
 * @returns {{ destroy(): void, setType(t:string): void, setNetwork(n:string): void, refresh(): void }}
 */
export function mountMoneyPulse({
	mount,
	variant = 'full',
	agentId = null,
	network = 'mainnet',
	type = 'all',
	live = true,
	controls,
	pageSize = 30,
	emptyHint,
	onRequestNetwork = null,
	onRequestType = null,
} = {}) {
	if (!mount) throw new Error('mountMoneyPulse requires { mount }');
	injectStyles();
	const showControls = controls ?? variant === 'full';

	const state = {
		type,
		network,
		events: [],
		seen: new Set(),
		headCursor: null,
		nextCursor: null,
		hasMore: false,
		loading: false,
		errored: false,
		paused: false,
		destroyed: false,
	};
	const chime = makeChime();
	let soundOn = false;
	let pollTimer = null;

	mount.classList.add('mp');
	if (variant === 'ticker') mount.classList.add('mp-ticker');

	// ── scaffold ──
	let listEl, moreBtn, liveDot, statusHost;
	function scaffold() {
		mount.innerHTML = '';
		if (variant === 'ticker') {
			const track = document.createElement('div');
			track.className = 'mp-ticker-track';
			track.setAttribute('role', 'list');
			mount.appendChild(track);
			listEl = track;
			return;
		}
		if (showControls) {
			const bar = document.createElement('div');
			bar.className = 'mp-toolbar';
			const filters = document.createElement('div');
			filters.className = 'mp-filters';
			filters.setAttribute('role', 'group');
			filters.setAttribute('aria-label', 'Filter activity by type');
			for (const f of FILTERS) {
				const b = document.createElement('button');
				b.type = 'button';
				b.className = 'mp-filter';
				b.textContent = f.label;
				b.dataset.type = f.id;
				b.setAttribute('aria-pressed', String(f.id === state.type));
				b.addEventListener('click', () => api.setType(f.id));
				filters.appendChild(b);
			}
			bar.appendChild(filters);
			const spacer = document.createElement('div');
			spacer.className = 'mp-spacer';
			bar.appendChild(spacer);
			liveDot = document.createElement('span');
			liveDot.className = 'mp-livedot';
			liveDot.textContent = live ? 'Live' : 'Paused';
			bar.appendChild(liveDot);
			if (live) {
				const sound = document.createElement('button');
				sound.type = 'button';
				sound.className = 'mp-sound';
				sound.setAttribute('aria-pressed', 'false');
				sound.textContent = '🔇 Sound';
				sound.addEventListener('click', () => {
					soundOn = !soundOn;
					sound.setAttribute('aria-pressed', String(soundOn));
					sound.textContent = soundOn ? '🔊 Sound' : '🔇 Sound';
					if (soundOn) chime.play();
				});
				bar.appendChild(sound);
			}
			mount.appendChild(bar);
		}
		statusHost = document.createElement('div');
		mount.appendChild(statusHost);
		listEl = document.createElement('ul');
		listEl.className = 'mp-list';
		listEl.setAttribute('role', 'feed');
		listEl.setAttribute('aria-busy', 'true');
		mount.appendChild(listEl);
		// Load-more works for both full and agent variants (a wallet's story can be
		// long); it stays hidden until the API reports another page.
		moreBtn = document.createElement('button');
		moreBtn.type = 'button';
		moreBtn.className = 'mp-more';
		moreBtn.textContent = 'Load more';
		moreBtn.hidden = true;
		moreBtn.addEventListener('click', loadMore);
		mount.appendChild(moreBtn);
	}

	function setLiveState(s) {
		if (liveDot) {
			liveDot.dataset.state = s;
			liveDot.textContent = s === 'error' ? 'Reconnecting…' : s === 'paused' ? 'Paused' : 'Live';
		}
	}

	function renderSkeletons() {
		if (variant === 'ticker') return;
		listEl.innerHTML = '';
		for (let i = 0; i < 5; i++) {
			const li = document.createElement('li');
			li.className = 'mp-skeleton';
			li.style.animationDelay = `${i * 0.08}s`;
			listEl.appendChild(li);
		}
	}

	function renderEmpty() {
		if (variant === 'ticker') { mount.style.display = 'none'; return; }
		listEl.innerHTML = '';
		const onDevnet = state.network === 'devnet';
		const filtered = !agentId && state.type !== 'all';
		const typeLabel = (FILTERS.find((f) => f.id === state.type)?.label || 'activity').toLowerCase();
		// A filtered view that's empty is NOT "all quiet" — the platform may be busy
		// with other kinds of money. Tell the honest truth for the active filter; the
		// self-heal probe below adds the right one-click escape (clear filter / switch
		// network) once it confirms where the activity actually is.
		const title = filtered ? `No ${typeLabel} yet` : 'No money moving — yet';
		const hint = emptyHint
			|| (agentId
				? 'This wallet has no public activity yet.'
				: filtered
					? `No ${typeLabel} on ${onDevnet ? 'devnet' : 'three.ws'} in this window.`
					: onDevnet
						? 'Devnet is a test network — most live money moves on mainnet. Switch to see the real feed.'
						: 'All quiet on three.ws right now. <a href="/agents">Tip an agent</a> and be the first beat.');
		statusHost.innerHTML =
			`<div class="mp-empty"><div class="mp-empty-icon" aria-hidden="true">◎</div>` +
			`<div class="mp-empty-title">${esc(title)}</div>` +
			`<div class="mp-empty-sub">${hint}</div>` +
			`<div class="mp-empty-switch" hidden></div></div>`;
		// Self-heal: a quiet feed shouldn't look like a broken one. If activity exists
		// just behind a filter or on the other network, surface a one-click escape
		// instead of a dead end. Scoped to the global feed (an agent's own story is
		// genuinely per-network and per-type).
		if (!agentId) probeForActivity();
	}

	// Add the self-heal escape button to the empty state. Re-validates we're still
	// empty before touching the DOM (the live poll may have landed a row meanwhile).
	function addEmptyCta(label, onClick) {
		if (state.destroyed || state.events.length) return;
		const slot = statusHost.querySelector('.mp-empty-switch');
		if (!slot) return;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'mp-empty-cta';
		btn.textContent = label;
		btn.addEventListener('click', onClick);
		slot.appendChild(btn);
		slot.hidden = false;
	}

	// Cheap "is there anything here?" probe (limit 1). Never throws.
	async function hasActivity(params) {
		try {
			const data = await fetchPulse({ ...params, limit: 1 });
			return (data.events?.length || 0) > 0;
		} catch { return false; }
	}

	// Background self-heal for the global feed. Prefers clearing an empty FILTER (the
	// platform is busy, just not with this kind) over switching NETWORK, because the
	// active network is the one the user chose. Falls back to the network switch when
	// even the unfiltered feed on this network is quiet.
	async function probeForActivity() {
		// 1. Empty filter, but this network's full feed has activity → offer to clear it.
		if (state.type !== 'all' && await hasActivity({ network: state.network, type: 'all' })) {
			addEmptyCta('View all activity →', () => {
				if (typeof onRequestType === 'function') onRequestType('all');
				else api.setType('all');
			});
			return;
		}
		// 2. This network is quiet (with the active filter); the OTHER network isn't.
		const other = state.network === 'devnet' ? 'mainnet' : 'devnet';
		if (await hasActivity({ network: other, type: state.type })) {
			addEmptyCta(other === 'mainnet' ? 'See live activity on mainnet →' : 'View devnet activity →', () => {
				// Defer to the host page when it owns the network toggle (so its stat
				// panels follow too); otherwise switch this component directly.
				if (typeof onRequestNetwork === 'function') onRequestNetwork(other);
				else api.setNetwork(other);
			});
		}
	}

	function renderError(keepRows) {
		if (variant === 'ticker') { if (!state.events.length) mount.style.display = 'none'; return; }
		setLiveState('error');
		if (keepRows && state.events.length) return; // degrade to last-known; banner via livedot
		statusHost.innerHTML =
			`<div class="mp-error">Couldn’t reach the pulse. <button class="mp-filter" data-retry>Retry</button></div>`;
		statusHost.querySelector('[data-retry]')?.addEventListener('click', () => api.refresh());
	}

	function clearStatus() { if (statusHost) statusHost.innerHTML = ''; }

	function renderAll() {
		if (!state.events.length) { renderEmpty(); return; }
		clearStatus();
		listEl.innerHTML = '';
		if (variant === 'ticker') {
			// Duplicate the sequence so the marquee loops seamlessly (-50% keyframe).
			const items = state.events.slice(0, 20);
			for (const ev of [...items, ...items]) listEl.appendChild(tickEl(ev));
			mount.style.removeProperty('display');
			const track = listEl;
			track.style.setProperty('--mp-dur', `${Math.max(30, items.length * 4)}s`);
			return;
		}
		for (const ev of state.events.slice(0, MAX_RENDERED)) listEl.appendChild(rowEl(ev));
		listEl.setAttribute('aria-busy', 'false');
		if (moreBtn) moreBtn.hidden = !state.hasMore;
	}

	// Prepend newly-arrived events with a landing animation + optional chime.
	function prepend(newEvents) {
		const fresh = newEvents.filter((e) => !state.seen.has(e.id));
		if (!fresh.length) return;
		for (const e of fresh) state.seen.add(e.id);
		state.events = [...fresh, ...state.events].slice(0, MAX_RENDERED + 50);
		if (!state.events.length) return;
		if (variant === 'ticker') { renderAll(); return; }
		clearStatus();
		// Insert at the top with animation.
		const frag = document.createDocumentFragment();
		for (const ev of fresh) {
			const node = rowEl(ev);
			node.classList.add('mp-new');
			frag.appendChild(node);
		}
		listEl.prepend(frag);
		// Trim overflow rows from the bottom (virtualization floor).
		while (listEl.children.length > MAX_RENDERED) listEl.lastElementChild?.remove();
		if (soundOn) chime.play();
	}

	async function loadInitial() {
		state.loading = true;
		state.errored = false;
		renderSkeletons();
		try {
			const data = await fetchPulse({
				network: state.network, type: state.type, agent_id: agentId, limit: pageSize,
			});
			if (state.destroyed) return;
			state.events = data.events || [];
			state.seen = new Set(state.events.map((e) => e.id));
			state.headCursor = data.head_cursor;
			state.nextCursor = data.next_cursor;
			state.hasMore = data.has_more;
			renderAll();
			setLiveState(state.paused ? 'paused' : 'live');
		} catch (e) {
			if (state.destroyed) return;
			state.errored = true;
			renderError(false);
		} finally {
			state.loading = false;
		}
	}

	async function loadMore() {
		if (!state.nextCursor || state.loading) return;
		state.loading = true;
		if (moreBtn) { moreBtn.disabled = true; moreBtn.textContent = 'Loading…'; }
		try {
			const data = await fetchPulse({
				network: state.network, type: state.type, agent_id: agentId,
				limit: pageSize, cursor: state.nextCursor,
			});
			if (state.destroyed) return;
			const fresh = (data.events || []).filter((e) => !state.seen.has(e.id));
			for (const e of fresh) state.seen.add(e.id);
			state.events = [...state.events, ...fresh];
			state.nextCursor = data.next_cursor;
			state.hasMore = data.has_more;
			for (const ev of fresh) listEl.appendChild(rowEl(ev));
		} catch { /* keep last-known; user can retry */ }
		finally {
			state.loading = false;
			if (moreBtn) { moreBtn.disabled = false; moreBtn.textContent = 'Load more'; moreBtn.hidden = !state.hasMore; }
		}
	}

	async function pollDelta() {
		if (state.paused || state.destroyed || !state.headCursor) return;
		try {
			const data = await fetchPulse({
				network: state.network, type: state.type, agent_id: agentId,
				since: state.headCursor, limit: pageSize,
			});
			if (state.destroyed) return;
			if (data.events?.length) {
				prepend(data.events);
				if (data.head_cursor) state.headCursor = data.head_cursor;
			}
			setLiveState('live');
		} catch {
			setLiveState('error'); // degrade to last-known, keep polling
		}
	}

	// ── live scheduling: pause when hidden or offscreen ──
	const interval = variant === 'ticker' ? TICKER_POLL_MS : POLL_MS;
	function startPolling() {
		if (!live || pollTimer) return;
		pollTimer = setInterval(() => { if (!document.hidden && !state.paused) pollDelta(); }, interval);
	}
	function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

	function onVisibility() {
		if (document.hidden) { setLiveState('paused'); }
		else { setLiveState(state.paused ? 'paused' : 'live'); pollDelta(); }
	}
	document.addEventListener('visibilitychange', onVisibility);

	// Offscreen pause via IntersectionObserver.
	let io = null;
	if (live && 'IntersectionObserver' in window) {
		io = new IntersectionObserver((entries) => {
			const visible = entries.some((e) => e.isIntersecting);
			state.paused = !visible;
			setLiveState(state.paused ? 'paused' : (state.errored ? 'error' : 'live'));
			if (!state.paused) pollDelta();
		}, { rootMargin: '120px' });
		io.observe(mount);
	}

	const api = {
		setType(t) {
			if (t === state.type) return;
			state.type = t;
			if (showControls) {
				for (const b of mount.querySelectorAll('.mp-filter[data-type]')) {
					b.setAttribute('aria-pressed', String(b.dataset.type === t));
				}
			}
			loadInitial();
		},
		setNetwork(n) {
			const net = n === 'devnet' ? 'devnet' : 'mainnet';
			if (net === state.network) return;
			state.network = net;
			loadInitial();
		},
		refresh() { loadInitial(); },
		destroy() {
			state.destroyed = true;
			stopPolling();
			document.removeEventListener('visibilitychange', onVisibility);
			io?.disconnect();
			mount.innerHTML = '';
		},
	};

	scaffold();
	loadInitial().then(() => { if (!state.destroyed) startPolling(); });

	return api;
}

if (typeof window !== 'undefined') {
	window.twsMoneyPulse = { mountMoneyPulse };
}
