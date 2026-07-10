/**
 * /launches — public feed of every coin launched by a three.ws agent.
 *
 * Data flow:
 *   GET /api/pump/launches?network=&offset=&limit=[&agent_id=]   registry rows
 *   GET /api/pump/coin?mint=                                     live market data
 *   GET /api/agents/:id                                          agent-filter chip label
 *
 * Registry rows render immediately; market data (price, image, graduation)
 * streams in per card afterwards so the feed never blocks on pump.fun.
 *
 * Visual systems (all decorative, all real-data-driven):
 *   · generative identicon per coin, seeded from its mint address — the coin's
 *     visual fingerprint until pump.fun art crossfades in over it
 *   · ambient particle field on a fixed canvas behind the page
 *   · marquee ticker built from the first page of real launches
 *   · cursor-tracked light on each card (--mx/--my custom properties)
 *   · 60s live refresh that prepends genuinely new launches in place
 */

import { mountCoinStatus, formatMcap } from './pump/coin-status-card.js';
import { walletChipEl } from './shared/agent-wallet-chip.js';
import { createLogger } from './shared/log.js';
import { countUp, updateValue, enterStagger, rippleOnce, liveDot, setLiveDot } from './ui-juice.js';

const log = createLogger('launches');

const PAGE_SIZE = 24;
const ORACLE_TIER_COLOR = { prime: '#c084fc', strong: '#34d399', lean: '#fbbf24', watch: '#94a3b8', avoid: '#f87171' };
const LIVE_REFRESH_MS = 60_000;

const state = {
	network: 'mainnet',
	agentId: null,
	oracleTier: '',   // '' = all, 'prime' | 'strong' | 'lean'
	offset: 0,
	hasMore: false,
	loading: false,
	count: 0,
	seenMints: new Set(),
	latestCreatedAt: null,
	// Live market data keyed by mint, fed by each card's coin-status widget as it
	// loads/refreshes — the source for the feed's aggregate data points.
	marketByMint: new Map(),
};

const feedEl = document.getElementById('lx-feed');
const footerEl = document.getElementById('lx-footer-state');
const countEl = document.getElementById('lx-count');
const agentFilterEl = document.getElementById('lx-agent-filter');
const tickerEl = document.getElementById('lx-ticker');
const tickerTrackEl = document.getElementById('lx-ticker-track');
const statCountEl = document.getElementById('lx-stat-count');
const statLatestEl = document.getElementById('lx-stat-latest');
const statNetworkEl = document.getElementById('lx-stat-network');
const statMcapEl = document.getElementById('lx-stat-mcap');
const statGradEl = document.getElementById('lx-stat-grad');

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Live-feed status dot — the feed re-polls /api/pump/launches every minute, so
// this honestly mirrors the request lifecycle (syncing → live → offline) of a
// real backing feed rather than a decorative pulse.
let liveStatusEl = null;
if (countEl) {
	countEl.insertAdjacentHTML('afterend', liveDot('connecting', { label: 'syncing' }));
	liveStatusEl = countEl.nextElementSibling;
}
function setFeedLive(stateName) {
	if (!liveStatusEl) return;
	const label = stateName === 'live' ? 'live feed' : stateName === 'connecting' ? 'syncing' : 'offline';
	setLiveDot(liveStatusEl, stateName, label);
}

// ── watchlist helpers (mirrors launch-detail.js & watchlist.js) ──────────────

const WATCH_KEY = 'ld_watchlist';

function watchedMints() {
	try { return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || '[]')); } catch { return new Set(); }
}

function toggleWatch(mint) {
	try {
		const list = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
		const idx = list.indexOf(mint);
		if (idx >= 0) list.splice(idx, 1);
		else list.unshift(mint);
		localStorage.setItem(WATCH_KEY, JSON.stringify(list.slice(0, 200)));
		return idx < 0; // true = now watched
	} catch { return false; }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const c of [].concat(children || [])) {
		if (c == null) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

function shortAddr(s, head = 4, tail = 4) {
	const str = String(s || '');
	if (str.length <= head + tail + 1) return str;
	return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

function timeAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
	return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── generative identicons ────────────────────────────────────────────────────
// Every mint address deterministically produces its own orbital glyph: ring
// radii, dash rhythms, satellite positions and rotation all derive from a
// seeded PRNG over the address. Monochrome via currentColor so themes remap.

function hashString(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function mulberry32(seed) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	return node;
}

function mintIdenticon(mint) {
	const rand = mulberry32(hashString(String(mint)));
	const svg = svgEl('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' });
	svg.style.color = 'var(--ink-dim)';

	const cx = 32;
	const cy = 32;
	const rings = 3 + Math.floor(rand() * 2);
	for (let i = 0; i < rings; i++) {
		const r = 8 + i * (20 / rings) + rand() * 4;
		const circumference = 2 * Math.PI * r;
		const dashOn = circumference * (0.18 + rand() * 0.55);
		const ring = svgEl('circle', {
			cx,
			cy,
			r: r.toFixed(1),
			fill: 'none',
			stroke: 'currentColor',
			'stroke-width': (0.7 + rand() * 0.9).toFixed(2),
			'stroke-dasharray': `${dashOn.toFixed(1)} ${(circumference - dashOn).toFixed(1)}`,
			'stroke-linecap': 'round',
			opacity: (0.3 + rand() * 0.45).toFixed(2),
			transform: `rotate(${Math.floor(rand() * 360)} ${cx} ${cy})`,
		});
		svg.appendChild(ring);

		// One satellite riding this orbit.
		if (rand() > 0.35) {
			const theta = rand() * Math.PI * 2;
			svg.appendChild(
				svgEl('circle', {
					cx: (cx + Math.cos(theta) * r).toFixed(1),
					cy: (cy + Math.sin(theta) * r).toFixed(1),
					r: (1 + rand() * 1.8).toFixed(1),
					fill: 'currentColor',
					opacity: (0.5 + rand() * 0.5).toFixed(2),
				}),
			);
		}
	}

	// Bright nucleus.
	svg.appendChild(
		svgEl('circle', {
			cx,
			cy,
			r: (2.2 + rand() * 1.6).toFixed(1),
			fill: 'currentColor',
			opacity: '0.9',
			style: 'color: var(--ink-bright)',
		}),
	);
	return svg;
}

// ── ambient particle field ───────────────────────────────────────────────────
// Slow constellation drift behind the page. Pure decoration: pauses when the
// tab hides, renders a single static frame under prefers-reduced-motion, and
// re-reads ink colour when the theme flips.

function startParticleField() {
	const canvas = document.getElementById('lx-field');
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;

	let width = 0;
	let height = 0;
	let particles = [];
	let inkRGB = '255,255,255';
	let raf = 0;

	const readInk = () => {
		const probe = getComputedStyle(document.documentElement).getPropertyValue('color-scheme');
		inkRGB = probe.includes('light') ? '20,24,34' : '232,232,232';
	};

	const resize = () => {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		width = window.innerWidth;
		height = window.innerHeight;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const target = Math.min(90, Math.floor((width * height) / 26000));
		particles = Array.from({ length: target }, () => ({
			x: Math.random() * width,
			y: Math.random() * height,
			vx: (Math.random() - 0.5) * 0.12,
			vy: (Math.random() - 0.5) * 0.12,
			r: 0.6 + Math.random() * 1.1,
		}));
	};

	const draw = () => {
		ctx.clearRect(0, 0, width, height);
		const linkDist = 110;
		for (const p of particles) {
			p.x += p.vx;
			p.y += p.vy;
			if (p.x < -10) p.x = width + 10;
			if (p.x > width + 10) p.x = -10;
			if (p.y < -10) p.y = height + 10;
			if (p.y > height + 10) p.y = -10;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${inkRGB},0.16)`;
			ctx.fill();
		}
		for (let i = 0; i < particles.length; i++) {
			for (let j = i + 1; j < particles.length; j++) {
				const a = particles[i];
				const b = particles[j];
				const dx = a.x - b.x;
				const dy = a.y - b.y;
				const d2 = dx * dx + dy * dy;
				if (d2 < linkDist * linkDist) {
					const alpha = 0.05 * (1 - Math.sqrt(d2) / linkDist);
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
	new MutationObserver(readInk).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});

	if (REDUCED_MOTION) {
		draw(); // one calm static frame
		return;
	}
	loop();
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) cancelAnimationFrame(raf);
		else loop();
	});
}

// ── cursor light ─────────────────────────────────────────────────────────────
// One delegated listener; each card's ::before radial light follows --mx/--my.

feedEl.addEventListener('pointermove', (e) => {
	const card = e.target.closest?.('.lx-card');
	if (!card) return;
	const rect = card.getBoundingClientRect();
	card.style.setProperty('--mx', `${(((e.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`);
	card.style.setProperty('--my', `${(((e.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`);
});

// ── entrance reveal ──────────────────────────────────────────────────────────

const revealObserver = REDUCED_MOTION
	? null
	: new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					entry.target.classList.add('lx-in');
					revealObserver.unobserve(entry.target);
				}
			},
			{ rootMargin: '0px 0px -8% 0px' },
		);

function reveal(card, index) {
	if (!revealObserver) {
		card.classList.add('lx-in');
		return;
	}
	card.style.transitionDelay = `${(index % 12) * 45}ms`;
	card.addEventListener(
		'transitionend',
		() => {
			card.style.transitionDelay = '';
		},
		{ once: true },
	);
	revealObserver.observe(card);
}

// ── market enrichment (mainnet only) ─────────────────────────────────────────
// Live price / market cap / graduation now stream in through the shared
// coin-status widget (src/pump/coin-status-card.js) — one fetch to
// /api/pump/coin per card, field-mapped and formatted in one place. Each card
// keeps a handle so its refresh timer is torn down when the feed is rebuilt.

const cardStatusHandles = new Set();

function teardownStatusHandles() {
	for (const h of cardStatusHandles) {
		try {
			h.destroy();
		} catch {
			/* ignore */
		}
	}
	cardStatusHandles.clear();
}

// ── live aggregate data points ───────────────────────────────────────────────
// Each card's coin-status widget already fetches /api/pump/coin for its own
// render; its onData callback hands that same payload up here so the hero can
// tally a combined market cap and a graduated count across every loaded coin —
// real on-chain numbers, no extra requests. Recompute is rAF-coalesced so a
// page of ~24 widgets resolving in a burst repaints the hero once, not 24×.

let aggregateRaf = 0;

function recordMarket(coin) {
	if (!coin || !coin.mint) return;
	state.marketByMint.set(coin.mint, coin);
	if (aggregateRaf) return;
	aggregateRaf = requestAnimationFrame(() => {
		aggregateRaf = 0;
		recomputeAggregates();
	});
}

function recomputeAggregates() {
	let totalMcap = 0;
	let priced = 0;
	let graduated = 0;
	for (const coin of state.marketByMint.values()) {
		if (Number.isFinite(coin.mcap)) {
			totalMcap += coin.mcap;
			priced += 1;
		}
		if (coin.graduated) graduated += 1;
	}
	// Count between real aggregates so a page of widgets resolving (or a live
	// launch landing) ticks the hero up instead of snapping. The placeholder
	// state clears the tracked value so the first real number counts from 0.
	if (statMcapEl) {
		if (priced) updateValue(statMcapEl, totalMcap, formatMcap, { flash: false });
		else { statMcapEl.textContent = '—'; delete statMcapEl.dataset.juiceVal; }
	}
	if (statGradEl) {
		if (priced) updateValue(statGradEl, graduated, (n) => String(Math.round(n)), { flash: false });
		else { statGradEl.textContent = '—'; delete statGradEl.dataset.juiceVal; }
	}
}

function resetAggregates() {
	if (aggregateRaf) {
		cancelAnimationFrame(aggregateRaf);
		aggregateRaf = 0;
	}
	state.marketByMint = new Map();
	if (statMcapEl) { statMcapEl.textContent = '—'; delete statMcapEl.dataset.juiceVal; }
	if (statGradEl) { statGradEl.textContent = '—'; delete statGradEl.dataset.juiceVal; }
}

// ── Oracle conviction batch enrichment ───────────────────────────────────────
// After each page of cards renders, batch-fetch Oracle conviction for all
// visible mints (≤20 per request) and paint a tier badge on each card.
// Non-blocking: a fetch failure leaves cards untouched.

function paintOracleBadge(card, mint, data) {
	const badge = card.querySelector('.lx-oracle-badge');
	if (!badge || !data || data.score == null) return;
	const color = ORACLE_TIER_COLOR[data.tier] || '#94a3b8';
	badge.innerHTML = `<a class="lx-ob-link" href="/oracle/coin/${encodeURIComponent(mint)}" title="Oracle conviction: ${data.score} — ${data.tier || 'unscored'}" tabindex="-1" aria-hidden="true">
		<span class="lx-ob-score" style="color:${color}">${data.score}</span>
		<span class="lx-ob-tier" style="color:${color}">${data.tier || ''}</span>
	</a>`;
}

async function enrichCardsWithOracle(cards) {
	const mints = cards
		.map((c) => c.dataset.mint)
		.filter(Boolean);
	if (!mints.length) return;
	const chunks = [];
	for (let i = 0; i < mints.length; i += 20) chunks.push(mints.slice(i, i + 20));
	let results = {};
	try {
		const resps = await Promise.all(
			chunks.map((ch) =>
				fetch(`/api/oracle/batch?mints=${ch.map(encodeURIComponent).join(',')}&network=mainnet`)
					.then((r) => r.ok ? r.json() : null)
					.catch(() => null),
			),
		);
		for (const r of resps) {
			if (r?.results) Object.assign(results, r.results);
		}
	} catch { return; }

	for (const card of cards) {
		paintOracleBadge(card, card.dataset.mint, results[card.dataset.mint]);
	}
}

// ── card rendering ───────────────────────────────────────────────────────────

function agentChip(agent) {
	if (!agent) {
		return el('div', { class: 'lx-agent-row', 'aria-disabled': 'true' }, [
			el('span', { class: 'lx-agent-fallback', text: '?' }),
			el('span', { class: 'lx-agent-name', text: 'Unknown agent' }),
		]);
	}
	const avatar = agent.avatar_thumbnail_url
		? el('img', { src: agent.avatar_thumbnail_url, alt: '', loading: 'lazy' })
		: el('span', { class: 'lx-agent-fallback', text: (agent.name || '?')[0].toUpperCase() });
	return el(
		'a',
		{
			class: 'lx-agent-row',
			href: agent.url || `/agents/${agent.id}`,
			'aria-label': `View agent ${agent.name || shortAddr(agent.id)}`,
		},
		[
			avatar,
			el('span', { class: 'lx-agent-name', text: agent.name || shortAddr(agent.id) }),
			el('span', { class: 'lx-agent-hint', text: 'Agent →' }),
		],
	);
}

function launchCard(launch, index, { featured = false } = {}) {
	const isDevnet = launch.network === 'devnet';
	const tradeHref = isDevnet
		? `https://explorer.solana.com/address/${launch.mint}?cluster=devnet`
		: `https://pump.fun/${launch.mint}`;

	const badges = el('div', { class: 'lx-badges' });
	// Age leads the badge row — the at-a-glance "how fresh is this" GMGN-style
	// terminals open with. Available from the registry row immediately, before the
	// per-card market fetch resolves, so it never waits on pump.fun.
	if (launch.created_at) {
		badges.appendChild(
			el('span', {
				class: 'lx-badge lx-badge-age',
				title: `Launched ${timeAgo(launch.created_at)}`,
				text: timeAgo(launch.created_at),
			}),
		);
	}
	if (isDevnet) badges.appendChild(el('span', { class: 'lx-badge', text: 'Devnet' }));
	if (Number(launch.buyback_bps) > 0) {
		badges.appendChild(
			el('span', {
				class: 'lx-badge lx-badge-buyback',
				text: `${(Number(launch.buyback_bps) / 100).toFixed(1)}% buyback`,
				title: 'Share of agent payments auto-bought-back and burned',
			}),
		);
	}

	const watched = !isDevnet && watchedMints().has(launch.mint);
	const watchBtn = isDevnet ? null : el('button', {
		class: `lx-action lx-action-watch${watched ? ' lx-watched' : ''}`,
		type: 'button',
		'aria-label': watched ? 'Remove from watchlist' : 'Add to watchlist',
		'aria-pressed': String(watched),
		title: watched ? 'Remove from watchlist' : 'Add to watchlist',
		text: watched ? '★' : '☆',
		onclick: (e) => {
			e.preventDefault();
			e.stopPropagation();
			const nowWatched = toggleWatch(launch.mint);
			watchBtn.textContent = nowWatched ? '★' : '☆';
			watchBtn.classList.toggle('lx-watched', nowWatched);
			watchBtn.setAttribute('aria-pressed', String(nowWatched));
			watchBtn.setAttribute('aria-label', nowWatched ? 'Remove from watchlist' : 'Add to watchlist');
			watchBtn.title = nowWatched ? 'Remove from watchlist' : 'Add to watchlist';
		},
	});

	const actions = [
		el('a', {
			class: 'lx-action',
			href: tradeHref,
			target: '_blank',
			rel: 'noopener noreferrer',
			text: isDevnet ? 'Explorer ↗' : 'pump.fun ↗',
		}),
	];
	if (!isDevnet) {
		actions.push(
			el('a', {
				class: 'lx-action',
				href: `/coin3d?mint=${encodeURIComponent(launch.mint)}`,
				target: '_blank',
				rel: 'noopener noreferrer',
				text: '3D view',
				'aria-label': `View ${launch.symbol || launch.name || 'coin'} in 3D`,
			}),
		);
		actions.push(
			el('a', {
				class: 'lx-action',
				href: `/communities/${launch.mint}`,
				text: '3D world',
				'aria-label': `Visit the 3D world for ${launch.symbol || launch.name}`,
			}),
		);
		if (watchBtn) actions.push(watchBtn);
	}

	// Abstract orbital glyph seeded from the mint — the coin's deterministic
	// visual fingerprint. On mainnet it becomes the placeholder behind the real
	// pump.fun logo (the shared widget crossfades the logo over it); on devnet,
	// which has no market data, it's the standalone avatar.
	const identicon = mintIdenticon(launch.mint);

	// Live market panel. Mainnet coins stream name / logo / price / market cap /
	// graduation / time through the shared coin-status widget (single
	// /api/pump/coin fetch, mapped and formatted once). Devnet mints have no
	// pump.fun market data, so they fall back to a static identity line.
	const market = el('div', { class: 'lx-market' });
	if (isDevnet) {
		const art = el('div', { class: 'lx-coin-art' }, [identicon]);
		market.appendChild(
			el('div', { class: 'lx-market-devnet' }, [
				art,
				el('div', { class: 'lx-coin-id' }, [
					el('h3', { class: 'lx-coin-name', text: launch.name || launch.symbol || 'Unnamed coin' }),
					el('span', { class: 'lx-coin-symbol', text: launch.symbol ? `$${launch.symbol}` : shortAddr(launch.mint) }),
				]),
				el('time', { class: 'lx-time', datetime: launch.created_at, text: timeAgo(launch.created_at) }),
			]),
		);
	}

	// Whole-card stretched link to the coin's rich profile. Interactive children
	// (agent chip, external actions) are raised above it in CSS so they keep
	// their own targets; everything else opens the on-platform detail page.
	const cardLink = el('a', {
		class: 'lx-card-link',
		href: isDevnet ? `/launches/${launch.mint}?network=devnet` : `/launches/${launch.mint}`,
		'aria-label': `Open ${launch.symbol ? `$${launch.symbol}` : launch.name || 'coin'} profile`,
	});

	// The launching agent's custodial wallet, shown read-only as a vanity-aware
	// badge. agent_authority is the on-chain signer = the agent's Solana wallet,
	// so it backstops the agent record's own solana_address. link:false keeps it a
	// non-interactive badge so it never fights the stretched whole-card link above.
	const walletChip = walletChipEl(
		{
			...(launch.agent || {}),
			id: launch.agent?.id,
			solana_address:
				launch.agent?.solana_address || launch.agent?.meta?.solana_address || launch.agent_authority || null,
		},
		{ isOwner: false, showPending: false, link: false },
	);

	const card = el('article', { class: `lx-card${featured ? ' lx-card-featured' : ''}`, 'data-mint': launch.mint }, [
		cardLink,
		featured ? el('span', { class: 'lx-feat-tag', text: 'Latest' }) : null,
		featured && launch.symbol
			? el('span', { class: 'lx-feat-ghost', 'aria-hidden': 'true', text: `$${launch.symbol}` })
			: null,
		market,
		badges,
		agentChip(launch.agent),
		walletChip,
		el('div', { class: 'lx-card-actions' }, actions),
		el('span', { class: 'lx-mint', text: launch.mint, title: launch.mint }),
		el('div', { class: 'lx-oracle-badge', 'aria-hidden': 'true' }),
	]);

	reveal(card, index);
	if (!isDevnet) {
		cardStatusHandles.add(
			mountCoinStatus(market, launch.mint, {
				variant: 'card',
				placeholder: identicon,
				onData: recordMarket,
				// This feed already batch-fetches conviction for every visible mint
				// (enrichCardsWithOracle → /api/oracle/batch), so the widget's own
				// per-coin /api/oracle/coin round trip is redundant — one request per
				// card, each a 404 for any mint the Oracle hasn't observed yet.
				oracle: false,
			}),
		);
	}
	return card;
}

// ── ticker ───────────────────────────────────────────────────────────────────
// Marquee strip of the freshest launches. Content duplicated once so the
// translateX(-50%) loop is seamless. Decorative (aria-hidden) — the same data
// lives in the accessible feed below.

function buildTicker(launches) {
	if (!tickerEl || !tickerTrackEl || REDUCED_MOTION) return;
	if (!launches.length) {
		tickerEl.hidden = true;
		return;
	}
	tickerTrackEl.textContent = '';
	const items = launches.slice(0, 12);
	const renderRun = () =>
		items.map((l) =>
			el('span', { class: 'lx-tick' }, [
				el('b', { text: l.symbol ? `$${l.symbol}` : shortAddr(l.mint) }),
				el('span', { text: l.name || '' }),
				el('span', { class: 'up', text: timeAgo(l.created_at) }),
			]),
		);
	renderRun().forEach((n) => tickerTrackEl.appendChild(n));
	renderRun().forEach((n) => tickerTrackEl.appendChild(n));
	tickerTrackEl.style.setProperty('--lx-marquee-duration', `${Math.max(24, items.length * 5)}s`);
	tickerEl.hidden = false;
}

// ── hero stats ───────────────────────────────────────────────────────────────

function updateStats(firstLaunch) {
	if (statCountEl) updateValue(statCountEl, state.count, (n) => {
		const v = Math.round(n);
		return v ? `${v}${state.hasMore ? '+' : ''}` : '0';
	}, { flash: false });
	if (statLatestEl) statLatestEl.textContent = firstLaunch ? timeAgo(firstLaunch.created_at) : '—';
	if (statNetworkEl) statNetworkEl.textContent = state.network;
}

// ── states ───────────────────────────────────────────────────────────────────

function renderSkeletons(n = 8) {
	for (let i = 0; i < n; i++) {
		feedEl.appendChild(
			el('div', { class: 'lx-skel', 'aria-hidden': 'true' }, [
				el('div', { class: 'lx-skel-bar', style: 'width:48px;height:48px;border-radius:10px' }),
				el('div', { class: 'lx-skel-bar', style: 'width:70%;height:14px' }),
				el('div', { class: 'lx-skel-bar', style: 'width:45%;height:22px' }),
				el('div', { class: 'lx-skel-bar', style: 'width:100%;height:34px' }),
			]),
		);
	}
}

function clearSkeletons() {
	feedEl.querySelectorAll('.lx-skel').forEach((n) => n.remove());
}

function renderEmpty() {
	const filtered = !!state.agentId || !!state.oracleTier;
	const tierLabel = state.oracleTier
		? { prime: 'prime conviction', strong: 'strong conviction', lean: 'lean conviction' }[state.oracleTier] || state.oracleTier
		: null;
	feedEl.appendChild(
		el('div', { class: 'lx-state' }, [
			el('h2', { text: filtered ? 'No matching launches' : 'No launches yet' }),
			el('p', {
				text: tierLabel
					? `No three.ws agent launches have ${tierLabel} Oracle scores yet. Try a lower tier or clear the filter.`
					: state.agentId
						? 'This agent has not launched a coin on this network. Clear the filter to see the full feed.'
						: state.network === 'devnet'
							? 'Nothing has been launched on devnet. Switch to mainnet to see live launches.'
							: 'Be the first: create an agent, give it a coin, and it shows up here in real time.',
			}),
			filtered
				? el('button', {
						class: 'lx-btn',
						type: 'button',
						text: 'Clear filters',
						onclick: () => { setAgentFilter(null); setOracleTier(''); },
					})
				: el('div', { class: 'lx-state-ctas' }, [
						el('a', {
							class: 'lx-btn lx-btn-primary',
							href: '/create-agent',
							text: 'Create an agent',
						}),
						el('a', {
							class: 'lx-btn',
							href: '/forge',
							text: 'Forge its 3D body',
						}),
					]),
		]),
	);
}

function renderError(retry) {
	feedEl.appendChild(
		el('div', { class: 'lx-state', role: 'alert' }, [
			el('h2', { text: 'Could not load the feed' }),
			el('p', { text: 'The launches API did not respond. Check your connection and try again.' }),
			el('button', { class: 'lx-btn', type: 'button', text: 'Retry', onclick: retry }),
		]),
	);
}

function renderFooter() {
	footerEl.textContent = '';
	if (!state.hasMore) return;
	const btn = el('button', {
		class: 'lx-btn',
		type: 'button',
		text: 'Load more launches',
		onclick: () => loadPage(),
	});
	footerEl.appendChild(btn);
}

function updateCount() {
	countEl.textContent = state.count
		? `${state.count}${state.hasMore ? '+' : ''} launch${state.count === 1 ? '' : 'es'}`
		: '';
}

// ── data loading ─────────────────────────────────────────────────────────────

async function fetchLaunches(offset, limit) {
	const params = new URLSearchParams({
		network: state.network,
		offset: String(offset),
		limit: String(limit),
	});
	if (state.agentId) params.set('agent_id', state.agentId);
	if (state.oracleTier) params.set('min_tier', state.oracleTier);
	const r = await fetch(`/api/pump/launches?${params}`);
	if (!r.ok) throw new Error(`launches api ${r.status}`);
	const body = await r.json();
	return body.data || { launches: [], has_more: false };
}

async function loadPage({ reset = false } = {}) {
	if (state.loading) return;
	state.loading = true;
	if (reset) {
		state.offset = 0;
		state.count = 0;
		state.hasMore = false;
		state.seenMints = new Set();
		state.latestCreatedAt = null;
		teardownStatusHandles(); // stop refresh timers from the cards we're about to drop
		resetAggregates(); // drop stale market data so the hero tally rebuilds clean
		feedEl.textContent = '';
		footerEl.textContent = '';
		countEl.textContent = '';
	}
	const isFirstPage = state.offset === 0;
	feedEl.setAttribute('aria-busy', 'true');
	setFeedLive('connecting');
	renderSkeletons(reset ? 8 : 4);

	try {
		const { launches = [], has_more: hasMore = false } = await fetchLaunches(state.offset, PAGE_SIZE);

		clearSkeletons();
		const newCards = [];
		const cardsNeedingOracle = [];
		launches.forEach((l, i) => {
			state.seenMints.add(l.mint);
			const card = launchCard(l, i, { featured: isFirstPage && i === 0 });
			feedEl.appendChild(card);
			newCards.push(card);
			// When the API already returned Oracle data (Oracle-tier filter active),
			// paint the badge immediately — no batch fetch needed.
			if (l.oracle) {
				paintOracleBadge(card, l.mint, l.oracle);
			} else {
				cardsNeedingOracle.push(card);
			}
		});
		if (cardsNeedingOracle.length) enrichCardsWithOracle(cardsNeedingOracle);
		state.offset += launches.length;
		state.count += launches.length;
		state.hasMore = hasMore;
		if (isFirstPage) {
			state.latestCreatedAt = launches[0]?.created_at || null;
			buildTicker(launches);
			updateStats(launches[0] || null);
		} else {
			updateStats({ created_at: state.latestCreatedAt });
		}
		if (state.count === 0) renderEmpty();
		renderFooter();
		updateCount();
		setFeedLive(state.count ? 'live' : 'idle');
	} catch (err) {
		log.error('feed load failed', err);
		clearSkeletons();
		setFeedLive('error');
		if (state.count === 0) renderError(() => loadPage({ reset: true }));
		else renderFooter();
	} finally {
		state.loading = false;
		feedEl.setAttribute('aria-busy', 'false');
	}
}

// ── live refresh ─────────────────────────────────────────────────────────────
// Re-checks page zero once a minute (visible tab only) and slides genuinely
// new launches in at the top — the feed stays alive without a reload.

async function liveRefresh() {
	if (document.hidden || state.loading || state.count === 0) return;
	let data;
	try {
		data = await fetchLaunches(0, 12);
	} catch {
		setFeedLive('error');
		return; // next tick will retry
	}
	setFeedLive('live');
	const fresh = (data.launches || []).filter((l) => !state.seenMints.has(l.mint));
	if (!fresh.length) return;

	const anchor = feedEl.querySelector('.lx-card');
	const freshCards = [];
	// Newest-first: insert in reverse so the very newest ends up on top.
	for (let i = fresh.length - 1; i >= 0; i--) {
		const l = fresh[i];
		state.seenMints.add(l.mint);
		const card = launchCard(l, 0);
		feedEl.insertBefore(card, anchor || feedEl.firstChild);
		freshCards.push(card);
	}
	enrichCardsWithOracle(freshCards);
	// Slide the just-landed launches in from the top (newest first) and fire a
	// single restrained ripple on the hero count — a real "new launch shipped"
	// beat backed by the live poll, not a timer.
	enterStagger([...freshCards].reverse());
	rippleOnce(statCountEl);
	state.count += fresh.length;
	state.offset += fresh.length;
	state.latestCreatedAt = fresh[0].created_at;
	updateStats(fresh[0]);
	updateCount();
}

// ── filters ──────────────────────────────────────────────────────────────────

function syncUrl() {
	const url = new URL(location.href);
	if (state.network === 'devnet') url.searchParams.set('network', 'devnet');
	else url.searchParams.delete('network');
	if (state.agentId) url.searchParams.set('agent_id', state.agentId);
	else url.searchParams.delete('agent_id');
	if (state.oracleTier) url.searchParams.set('oracle_tier', state.oracleTier);
	else url.searchParams.delete('oracle_tier');
	history.replaceState(null, '', url);
}

function setNetwork(network) {
	if (state.network === network) return;
	state.network = network;
	document.querySelectorAll('.lx-net-btn').forEach((b) => {
		const active = b.dataset.network === network;
		b.classList.toggle('active', active);
		b.setAttribute('aria-selected', String(active));
	});
	syncUrl();
	loadPage({ reset: true });
}

function setOracleTier(tier) {
	if (state.oracleTier === tier) return;
	state.oracleTier = tier;
	document.querySelectorAll('.lx-of-btn').forEach((b) => {
		const active = b.dataset.tier === tier;
		b.classList.toggle('active', active);
		b.setAttribute('aria-pressed', String(active));
	});
	syncUrl();
	loadPage({ reset: true });
}

function setAgentFilter(agentId) {
	state.agentId = agentId;
	agentFilterEl.hidden = !agentId;
	agentFilterEl.textContent = '';
	syncUrl();
	if (agentId) renderAgentFilterChip(agentId);
	loadPage({ reset: true });
}

async function renderAgentFilterChip(agentId) {
	const chip = el('span', {}, [el('span', { text: `Agent ${shortAddr(agentId)}` })]);
	const clear = el('button', {
		type: 'button',
		'aria-label': 'Clear agent filter',
		text: '✕',
		onclick: () => setAgentFilter(null),
	});
	agentFilterEl.append(chip, clear);

	// Best-effort name + thumbnail; the chip already works without it.
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
		if (!r.ok) return;
		const body = await r.json();
		const agent = body.agent || body;
		if (state.agentId !== agentId || !agent?.name) return;
		chip.textContent = '';
		if (agent.avatar_thumbnail_url) {
			chip.appendChild(el('img', { src: agent.avatar_thumbnail_url, alt: '' }));
		}
		chip.appendChild(el('span', { text: agent.name }));
	} catch {
		/* keep the short-id chip */
	}
}

// ── boot ─────────────────────────────────────────────────────────────────────

function boot() {
	const qs = new URLSearchParams(location.search);
	state.network = qs.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const agentId = qs.get('agent_id');
	state.agentId = agentId && /^[0-9a-f-]{36}$/i.test(agentId) ? agentId : null;
	const VALID_TIERS = new Set(['prime', 'strong', 'lean']);
	const oracleTierParam = qs.get('oracle_tier') || '';
	state.oracleTier = VALID_TIERS.has(oracleTierParam) ? oracleTierParam : '';

	document.querySelectorAll('.lx-net-btn').forEach((b) => {
		const active = b.dataset.network === state.network;
		b.classList.toggle('active', active);
		b.setAttribute('aria-selected', String(active));
		b.addEventListener('click', () => setNetwork(b.dataset.network));
	});

	document.querySelectorAll('.lx-of-btn').forEach((b) => {
		const active = b.dataset.tier === state.oracleTier;
		b.classList.toggle('active', active);
		b.setAttribute('aria-pressed', String(active));
		b.addEventListener('click', () => setOracleTier(b.dataset.tier));
	});

	if (state.agentId) {
		agentFilterEl.hidden = false;
		renderAgentFilterChip(state.agentId);
	}

	updateStats(null);
	startParticleField();
	loadPage({ reset: true });
	setInterval(liveRefresh, LIVE_REFRESH_MS);
}

boot();
