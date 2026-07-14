// Launchpad landing — the front door to three.ws/launchpad.
//
// Before this module, /launchpad dropped a cold visitor straight into a 3-pane
// CMS editor with no context and no live data. This module makes the surface
// "make sense": it opens with a real value prop, LIVE launches minted by
// three.ws agents, social proof (a gallery of pages people actually built), and
// a template chooser — then mounts the existing Launchpad Studio *in place* the
// moment the visitor chooses to build. Deep links that target the editor
// directly (?slug=, ?template=, ?wallet=, ?avatar=, ?build=, ?studio=) skip the
// landing entirely so CMS edit + create-flow handoffs keep working unchanged.
//
// Public API: import { mountLaunchpadLanding } from '/src/launchpad/landing.js';
//             mountLaunchpadLanding(document.getElementById('root'));

import { log } from '../shared/log.js';

const TEMPLATES = [
	{
		id: 'token-launchpad',
		label: 'Token Launchpad',
		tagline: 'White-label Pump.fun launcher with a 3D avatar host',
		blurb: 'A hosted landing page for your coin with a 3D agent host. Launch it through three.ws; once live, visitors trade it in one click — creator fees route straight to your wallet.',
		icon: '◎',
		accent: '#22c55e',
		cta: 'Build a token page',
	},
	{
		id: 'paid-concierge',
		label: 'Paid Concierge',
		tagline: '3D agent that answers questions for x402 USDC',
		blurb: 'Charge per question. Visitors pay in USDC, settled instantly to you; the agent replies on the page.',
		icon: '✦',
		accent: '#6366f1',
		cta: 'Build a concierge',
	},
	{
		id: 'gated-showroom',
		label: 'Gated 3D Showroom',
		tagline: 'Pay-to-enter glTF gallery with an avatar greeter',
		blurb: 'A one-time USDC pass unlocks a private 3D scene. For product reveals, premium models, NFT preview rooms.',
		icon: '◆',
		accent: '#ec4899',
		cta: 'Build a showroom',
	},
];

const TEMPLATE_BADGE = {
	'token-launchpad': { label: 'Token', accent: '#22c55e' },
	'paid-concierge': { label: 'Concierge', accent: '#6366f1' },
	'gated-showroom': { label: 'Showroom', accent: '#ec4899' },
};

const STUDIO_TRIGGER_PARAMS = ['slug', 'template', 'wallet', 'avatar', 'website', 'build', 'studio'];

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function monogram(s) {
	const t = String(s || '?').replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase();
	return t || '?';
}
function timeAgo(iso) {
	if (!iso) return '';
	const then = new Date(iso).getTime();
	if (!isFinite(then)) return '';
	const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
function fmtCount(n) {
	const v = Number(n) || 0;
	if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
	return String(v);
}

async function getJson(url, { timeout = 9000 } = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeout);
	try {
		const r = await fetch(url, { signal: ctrl.signal, credentials: 'include' });
		if (!r.ok) throw new Error(`${url} → ${r.status}`);
		return await r.json();
	} finally {
		clearTimeout(t);
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────────
const STYLE = `
	.lp-land { --bg:#0b0d10; --panel:#0f1216; --line:#1c2128; --line2:#262b32;
		--fg:#f4f4f5; --muted:#a1a1aa; --dim:#71717a; --accent:#ec4899;
		min-height:100vh; background:var(--bg); color:var(--fg);
		font:15px/1.5 system-ui,-apple-system,sans-serif; }
	.lp-wrap { max-width:1160px; margin:0 auto; padding:0 24px; }

	/* Hero */
	.lp-hero { position:relative; overflow:hidden; padding:64px 0 44px; border-bottom:1px solid var(--line); }
	.lp-hero::before { content:''; position:absolute; inset:-40% 0 auto 0; height:520px; pointer-events:none;
		background:radial-gradient(60% 80% at 70% 0%, rgba(236,72,153,0.16), transparent 70%),
			radial-gradient(50% 70% at 20% 10%, rgba(99,102,241,0.14), transparent 70%); }
	.lp-eyebrow { display:inline-flex; align-items:center; gap:8px; padding:5px 12px; border-radius:999px;
		font-size:12px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; color:#fbcfe8;
		background:rgba(236,72,153,0.1); border:1px solid rgba(236,72,153,0.25); }
	.lp-eyebrow .pulse { width:7px; height:7px; border-radius:50%; background:#ec4899; box-shadow:0 0 0 0 rgba(236,72,153,0.6);
		animation:lp-pulse 1.8s infinite; }
	@keyframes lp-pulse { 0%{box-shadow:0 0 0 0 rgba(236,72,153,0.5)} 70%{box-shadow:0 0 0 8px rgba(236,72,153,0)} 100%{box-shadow:0 0 0 0 rgba(236,72,153,0)} }
	.lp-hero h1 { margin:18px 0 14px; font-size:clamp(34px,5vw,56px); line-height:1.04; letter-spacing:-0.03em; font-weight:800; }
	.lp-hero h1 em { font-style:normal; background:linear-gradient(120deg,#fff,#ec4899 70%); -webkit-background-clip:text; background-clip:text; color:transparent; }
	.lp-hero p.sub { margin:0 auto 26px; font-size:18px; line-height:1.55; color:var(--muted); max-width:600px; }
	.lp-btn { display:inline-flex; align-items:center; gap:8px; padding:13px 22px; font:inherit; font-size:15px; font-weight:600;
		border-radius:12px; cursor:pointer; text-decoration:none; border:1px solid transparent; transition:transform .12s,filter .12s,background .12s,border-color .12s; }
	.lp-btn:active { transform:translateY(1px); }
	.lp-btn.primary { color:#0b0d10; background:linear-gradient(120deg,#fff,#fce7f3); box-shadow:0 10px 30px -12px rgba(236,72,153,0.5); }
	.lp-btn.primary:hover { filter:brightness(1.04); transform:translateY(-1px); }
	.lp-btn.ghost { color:var(--fg); background:#16191f; border-color:var(--line2); }
	.lp-btn.ghost:hover { background:#1c2027; border-color:#39414c; }
	.lp-stats { display:flex; gap:26px; margin-top:30px; flex-wrap:wrap; }
	.lp-stat .n { font-size:26px; font-weight:800; letter-spacing:-0.02em; }
	.lp-stat .n .skl { display:inline-block; width:46px; height:24px; border-radius:6px; background:#1a1e24; vertical-align:middle; }
	.lp-stat .l { font-size:12px; color:var(--dim); text-transform:uppercase; letter-spacing:0.05em; margin-top:2px; }

	/* Live launches board */
	.lp-feed { display:grid; grid-template-columns:repeat(2,1fr); gap:6px 16px; }
	@media (max-width:640px) { .lp-feed { grid-template-columns:1fr; } }
	.lp-coin { display:flex; align-items:center; gap:11px; padding:9px 10px; border-radius:11px; text-decoration:none; color:inherit;
		border:1px solid transparent; transition:background .12s,border-color .12s; }
	.lp-coin:hover { background:#16191f; border-color:var(--line2); }
	.lp-coin .mono { flex:0 0 auto; width:38px; height:38px; border-radius:10px; display:grid; place-items:center;
		font-size:13px; font-weight:800; letter-spacing:-0.02em; color:#0b0d10; background:linear-gradient(135deg,#e2e8f0,#94a3b8); overflow:hidden; }
	.lp-coin .mono img { width:100%; height:100%; object-fit:cover; }
	.lp-coin .meta { min-width:0; flex:1; }
	.lp-coin .nm { font-weight:650; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
	.lp-coin .nm .tk { color:var(--dim); font-weight:500; }
	.lp-coin .by { font-size:12px; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
	.lp-coin .rt { flex:0 0 auto; font-size:11px; color:var(--dim); text-align:right; }
	.lp-tier { display:inline-block; font-size:10px; font-weight:700; padding:2px 6px; border-radius:6px; text-transform:uppercase; letter-spacing:0.04em; }
	.lp-tier.prime { color:#fde68a; background:rgba(245,158,11,0.16); }
	.lp-tier.strong { color:#86efac; background:rgba(34,197,94,0.14); }
	.lp-tier.lean { color:#93c5fd; background:rgba(59,130,246,0.14); }
	.lp-skel-row { height:56px; border-radius:11px; background:linear-gradient(90deg,#14171c 25%,#1b1f26 50%,#14171c 75%); background-size:200% 100%; animation:lp-sh 1.2s infinite; }
	@keyframes lp-sh { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

	/* Section scaffolding */
	.lp-sec { padding:56px 0; border-bottom:1px solid var(--line); }
	.lp-sec-head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:26px; flex-wrap:wrap; }
	.lp-sec-head h2 { margin:0; font-size:26px; font-weight:750; letter-spacing:-0.02em; }
	.lp-sec-head p { margin:6px 0 0; color:var(--muted); font-size:15px; max-width:560px; }
	.lp-sec-head a.more { font-size:14px; color:var(--muted); text-decoration:none; white-space:nowrap; }
	.lp-sec-head a.more:hover { color:var(--fg); }

	/* Template chooser */
	.lp-tpl-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
	.lp-tpl { text-align:left; display:flex; flex-direction:column; gap:10px; padding:22px; border-radius:16px; cursor:pointer;
		background:var(--panel); border:1px solid var(--line); color:inherit; font:inherit; transition:transform .14s,border-color .14s,background .14s; }
	.lp-tpl:hover { transform:translateY(-3px); border-color:var(--accent); background:#13161b; }
	.lp-tpl .ic { width:44px; height:44px; border-radius:12px; display:grid; place-items:center; font-size:20px; color:#0b0d10; font-weight:800; }
	.lp-tpl .lab { font-size:18px; font-weight:700; letter-spacing:-0.01em; }
	.lp-tpl .tag { font-size:13px; color:var(--muted); font-weight:500; }
	.lp-tpl .blurb { font-size:13px; color:var(--dim); line-height:1.5; flex:1; }
	.lp-tpl .go { font-size:13px; font-weight:600; color:var(--fg); display:inline-flex; align-items:center; gap:6px; }
	.lp-tpl .go .arrow { transition:transform .14s; }
	.lp-tpl:hover .go .arrow { transform:translateX(3px); }

	/* Showcase gallery */
	.lp-gal { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
	.lp-card { display:flex; flex-direction:column; border-radius:16px; overflow:hidden; text-decoration:none; color:inherit;
		background:var(--panel); border:1px solid var(--line); transition:transform .14s,border-color .14s; }
	.lp-card:hover { transform:translateY(-3px); border-color:var(--line2); }
	.lp-card .top { position:relative; height:128px; display:grid; place-items:center; overflow:hidden; }
	.lp-card .top img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
	.lp-card .top .glyph { font-size:34px; font-weight:800; color:rgba(255,255,255,0.92); text-shadow:0 2px 12px rgba(0,0,0,0.35); }
	.lp-card .tbadge { position:absolute; top:10px; left:10px; font-size:10px; font-weight:700; padding:3px 8px; border-radius:999px;
		text-transform:uppercase; letter-spacing:0.04em; color:#fff; background:rgba(0,0,0,0.45); backdrop-filter:blur(6px); }
	.lp-card .views { position:absolute; top:10px; right:10px; font-size:11px; font-weight:600; padding:3px 8px; border-radius:999px;
		color:#e5e7eb; background:rgba(0,0,0,0.45); backdrop-filter:blur(6px); }
	.lp-card .body { padding:14px 15px 15px; display:flex; flex-direction:column; gap:6px; flex:1; }
	.lp-card .h { font-size:15px; font-weight:680; letter-spacing:-0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
	.lp-card .d { font-size:13px; color:var(--dim); line-height:1.5; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
	.lp-card .foot { margin-top:auto; display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; color:var(--dim); }
	.lp-card .foot .slug { font-family:ui-monospace,monospace; color:var(--muted); }
	.lp-card .foot .price { color:#86efac; font-weight:600; }
	.lp-gal-skel { height:240px; border-radius:16px; background:linear-gradient(90deg,#14171c 25%,#1b1f26 50%,#14171c 75%); background-size:200% 100%; animation:lp-sh 1.2s infinite; }
	.lp-empty { grid-column:1/-1; text-align:center; padding:40px 20px; color:var(--dim); }
	.lp-empty .em-cta { margin-top:14px; }

	/* Launch-first hero */
	.lp-hero-solo { text-align:center; max-width:780px; margin:0 auto; }
	.lp-hero-solo .lp-stats { justify-content:center; }
	.lp-launcher { position:relative; margin:30px auto 0; max-width:840px;
		background:var(--panel); border:1px solid var(--line); border-radius:18px;
		padding:20px 16px; box-shadow:0 30px 60px -30px rgba(0,0,0,0.7); }
	.lp-launcher-skel { color:var(--dim); text-align:center; padding:56px 16px; font-size:14px; }
	.lp-launcher-skel .pulse { display:inline-block; width:8px; height:8px; border-radius:50%;
		background:#22c55e; margin-right:8px; animation:lp-pulse 1.8s infinite; }

	@media (max-width:880px) {
		.lp-tpl-grid, .lp-gal { grid-template-columns:1fr; }
	}
	@media (max-width:480px) {
		.lp-wrap { padding:0 16px; }
		.lp-hero { padding:44px 0 32px; }
		.lp-sec { padding:40px 0; }
	}

	/* Keyboard focus — every interactive element gets a visible ring */
	.lp-btn:focus-visible, .lp-coin:focus-visible, .lp-card:focus-visible,
	.lp-sec-head a.more:focus-visible, .lp-cta-row a:focus-visible {
		outline:2px solid #ec4899; outline-offset:2px;
	}
	.lp-tpl:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

	.lp-cta-row { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-top:22px; }

	/* Studio handoff states (shown while the editor module loads, or if it fails) */
	.lp-studio-wait { min-height:100vh; display:flex; flex-direction:column; gap:16px;
		align-items:center; justify-content:center; text-align:center; padding:24px;
		background:#0b0d10; color:#a1a1aa; font:15px/1.5 system-ui,-apple-system,sans-serif; }
	.lp-studio-wait .spin { width:30px; height:30px; border-radius:50%;
		border:3px solid #262b32; border-top-color:#f4f4f5; animation:lp-spin .8s linear infinite; }
	@keyframes lp-spin { to { transform:rotate(360deg); } }
	.lp-studio-wait h2 { margin:0; font-size:18px; color:#f4f4f5; letter-spacing:-0.01em; }
	.lp-studio-wait .fail-actions { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; }

	@media (prefers-reduced-motion: reduce) {
		.lp-land *, .lp-land *::before, .lp-studio-wait * {
			animation:none !important; transition:none !important;
		}
	}
`;

// ──────────────────────────────────────────────────────────────────────────
// Render pieces
// ──────────────────────────────────────────────────────────────────────────
function coinRowHTML(c) {
	const sym = c.symbol || c.name || '—';
	const tier = c.oracle?.tier;
	const tierHtml = tier && ['prime', 'strong', 'lean'].includes(tier)
		? `<span class="lp-tier ${tier}">${esc(tier)}</span>` : '';
	const agentName = c.agent?.name || 'three.ws agent';
	const thumb = c.agent?.avatar_thumbnail_url;
	const monoInner = thumb ? `<img loading="lazy" alt="" src="${esc(thumb)}" />` : esc(monogram(sym));
	return `
		<a class="lp-coin" href="/oracle/coin/${esc(c.mint)}" title="${esc(c.name || sym)} — view coin">
			<span class="mono">${monoInner}</span>
			<span class="meta">
				<span class="nm">${esc(c.name || sym)}${c.symbol ? ` <span class="tk">$${esc(c.symbol)}</span>` : ''}</span>
				<span class="by">by ${esc(agentName)}</span>
			</span>
			<span class="rt">${tierHtml || esc(timeAgo(c.created_at))}</span>
		</a>`;
}

function galleryCardHTML(p) {
	const badge = TEMPLATE_BADGE[p.template] || { label: p.template, accent: '#71717a' };
	const top = p.image
		? `<img loading="lazy" alt="" src="${esc(p.image)}" />`
		: `<span class="glyph">${esc(monogram(p.headline))}</span>`;
	const priceTxt = p.price ? `${p.price.amount} ${esc(p.price.currency || '')}`.trim() : '';
	// Studio's default brand is #ffffff, so blend the brand toward near-black —
	// the glyph stays legible on light brand colors while keeping the tint. The
	// leading solid is a fallback for engines without color-mix().
	const topBg = `#16181d; background:linear-gradient(150deg, color-mix(in srgb, ${esc(p.brand)} 50%, #0b0d10), #16181d)`;
	return `
		<a class="lp-card" href="${esc(p.url)}" title="Open /p/${esc(p.slug)}">
			<span class="top" style="background:${topBg}">
				${top}
				<span class="tbadge" style="background:${esc(badge.accent)}">${esc(badge.label)}</span>
				${p.viewCount ? `<span class="views">${esc(fmtCount(p.viewCount))} views</span>` : ''}
			</span>
			<span class="body">
				<span class="h">${esc(p.headline)}</span>
				<span class="d">${esc(p.tagline || (p.token ? `Launching ${p.token.name || p.token.ticker}` : 'A hosted 3D page on three.ws'))}</span>
				<span class="foot">
					<span class="slug">/p/${esc(p.slug)}</span>
					${priceTxt ? `<span class="price">${esc(priceTxt)}</span>` : ''}
				</span>
			</span>
		</a>`;
}

function shellHTML() {
	const tpls = TEMPLATES.map((t) => `
		<button class="lp-tpl" type="button" data-tpl="${t.id}" style="--accent:${t.accent}">
			<span class="ic" style="background:linear-gradient(135deg, ${t.accent}, #fff)">${t.icon}</span>
			<span class="lab">${esc(t.label)}</span>
			<span class="tag">${esc(t.tagline)}</span>
			<span class="blurb">${esc(t.blurb)}</span>
			<span class="go">${esc(t.cta)} <span class="arrow">→</span></span>
		</button>`).join('');

	return `
	<div class="lp-land">
		<section class="lp-hero">
			<div class="lp-wrap lp-hero-solo">
				<span class="lp-eyebrow"><span class="pulse"></span> three.ws launchpad</span>
				<h1>Launch your coin — <em>hosted by a 3D agent</em>.</h1>
				<p class="sub">Mint a Pump.fun coin in one flow, right here. Pick your agent, set the name, ticker, and image, then launch straight from your wallet. Creator fees route to you.</p>
				<div class="lp-stats" data-stats>
					<div class="lp-stat"><div class="n"><span class="skl" aria-hidden="true"></span></div><div class="l">Coins launched</div></div>
					<div class="lp-stat"><div class="n"><span class="skl" aria-hidden="true"></span></div><div class="l">Pages live</div></div>
					<div class="lp-stat"><div class="n">∞</div><div class="l">Your wallet, your fees</div></div>
				</div>
				<div class="lp-cta-row">
					<a class="lp-btn ghost" href="#lp-templates">Build a hosted page ↓</a>
					<a class="lp-btn ghost" href="#lp-showcase">See live examples ↓</a>
				</div>
			</div>
			<div class="lp-wrap">
				<div class="lp-launcher" data-launcher>
					<div class="lp-launcher-skel"><span class="pulse"></span> Loading the launcher…</div>
				</div>
			</div>
		</section>

		<section class="lp-sec">
			<div class="lp-wrap">
				<div class="lp-sec-head">
					<div>
						<h2>Launching now</h2>
						<p>Coins minted by three.ws agents — live.</p>
					</div>
					<a class="more" href="/launches">All launches →</a>
				</div>
				<div class="lp-feed" data-live-feed aria-busy="true" aria-label="Live coin launches">
					${Array.from({ length: 5 }).map(() => '<div class="lp-skel-row" aria-hidden="true"></div>').join('')}
				</div>
			</div>
		</section>

		<section class="lp-sec" id="lp-templates">
			<div class="lp-wrap">
				<div class="lp-sec-head">
					<div>
						<h2>Want a hosted page for your coin?</h2>
						<p>Optional. Build a white-label landing page, a paid concierge, or a gated 3D showroom — each ships with a working monetization flow and an x402 agent skill.</p>
					</div>
				</div>
				<div class="lp-tpl-grid">${tpls}</div>
			</div>
		</section>

		<section class="lp-sec" id="lp-showcase">
			<div class="lp-wrap">
				<div class="lp-sec-head">
					<div>
						<h2>Built on three.ws</h2>
						<p>Real pages published through the launchpad. Click any to see it live.</p>
					</div>
					<a class="more" href="#" data-action="build">Build yours →</a>
				</div>
				<div class="lp-gal" data-gallery aria-busy="true" aria-label="Published launchpad pages">
					${Array.from({ length: 6 }).map(() => '<div class="lp-gal-skel" aria-hidden="true"></div>').join('')}
				</div>
			</div>
		</section>
	</div>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Data wiring
// ──────────────────────────────────────────────────────────────────────────
// Mount the real, production coin launcher (the same flow as /launch) as the
// centerpiece — a launchpad's whole job is to launch a coin. launch.js lives in
// /public and is loaded by URL at runtime; the @vite-ignore + string-var keeps
// Vite from trying to resolve a public-dir asset at build time.
async function mountRealLauncher(root) {
	const host = root.querySelector('[data-launcher]');
	if (!host) return;
	try {
		const spec = '/launch/launch.js';
		const { mountLaunchCoin } = await import(/* @vite-ignore */ spec);
		host.innerHTML = '';
		mountLaunchCoin(host);
	} catch (err) {
		log.warn('[launchpad-landing] launcher failed:', err.message);
		host.innerHTML = `<div class="lp-launcher-skel">Couldn't load the launcher here — <a href="/launch" style="color:var(--fg)">open it on /launch →</a></div>`;
	}
}

async function loadLiveFeed(root) {
	const feed = root.querySelector('[data-live-feed]');
	if (!feed) return;
	try {
		const data = await getJson('/api/pump/launches?limit=7');
		const launches = data?.data?.launches || [];
		if (!launches.length) {
			feed.innerHTML = `<div class="lp-empty" style="padding:24px">No launches yet — be the first.</div>`;
			return;
		}
		feed.innerHTML = launches.map(coinRowHTML).join('');
	} catch (err) {
		log.warn('[launchpad-landing] live feed failed:', err.message);
		feed.innerHTML = `<a class="lp-empty" href="/launches" style="padding:24px;display:block;text-decoration:none">Live feed unavailable — see all launches →</a>`;
	} finally {
		feed.removeAttribute('aria-busy');
	}
}

async function loadStats(root, galleryTotalRef) {
	const stats = root.querySelector('[data-stats]');
	if (!stats) return;
	const nodes = stats.querySelectorAll('.lp-stat .n');
	const set = (i, val) => { if (nodes[i]) nodes[i].textContent = val; };
	try {
		// The launches feed has no count(*) — over-fetch a page and report the real
		// floor (e.g. "50+") rather than inventing a precise total.
		const launches = await getJson('/api/pump/launches?limit=50&offset=0');
		const arr = launches?.data?.launches || [];
		set(0, arr.length ? `${fmtCount(arr.length)}${launches?.data?.has_more ? '+' : ''}` : '0');
	} catch {
		set(0, '—');
	}
	// Pages-live comes from the gallery total (set once that resolves).
	if (galleryTotalRef.value != null) set(1, fmtCount(galleryTotalRef.value));
	else galleryTotalRef.onResolve = (n) => set(1, fmtCount(n));
}

async function loadGallery(root, galleryTotalRef) {
	const gal = root.querySelector('[data-gallery]');
	if (!gal) return;
	try {
		const data = await getJson('/api/launchpad/list?limit=6');
		if (data?.total != null) {
			galleryTotalRef.value = data.total;
			galleryTotalRef.onResolve?.(data.total);
		}
		const pages = data?.pages || [];
		if (!pages.length) {
			gal.innerHTML = `
				<div class="lp-empty">
					<div>No launchpads published yet — yours could be the first.</div>
					<button class="lp-btn primary em-cta" type="button" data-action="build">Build the first one →</button>
				</div>`;
			return;
		}
		gal.innerHTML = pages.map(galleryCardHTML).join('');
	} catch (err) {
		log.warn('[launchpad-landing] gallery failed:', err.message);
		gal.innerHTML = `
			<div class="lp-empty">
				<div>Couldn't load the showcase right now.</div>
				<button class="lp-btn primary em-cta" type="button" data-action="build">Build yours anyway →</button>
			</div>`;
	} finally {
		gal.removeAttribute('aria-busy');
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Studio handoff
// ──────────────────────────────────────────────────────────────────────────
function urlTargetsStudio(url) {
	return STUDIO_TRIGGER_PARAMS.some((p) => url.searchParams.has(p));
}

function studioOptionsFromUrl(url) {
	return {
		template: url.searchParams.get('template') || 'token-launchpad',
		slug: url.searchParams.get('slug') || '',
		wallet: url.searchParams.get('wallet') || '',
		website: url.searchParams.get('website') || '',
		avatarSrc: url.searchParams.get('avatar') || '',
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Mount
// ──────────────────────────────────────────────────────────────────────────
export function mountLaunchpadLanding(root) {
	if (!root) throw new Error('mountLaunchpadLanding: root element required');

	const styleEl = document.createElement('style');
	styleEl.textContent = STYLE;
	document.head.appendChild(styleEl);

	function renderLanding() {
		document.title = 'Launchpad — three.ws';
		root.innerHTML = shellHTML();
		const galleryTotalRef = { value: null, onResolve: null };
		mountRealLauncher(root);
		loadLiveFeed(root);
		loadStats(root, galleryTotalRef);
		loadGallery(root, galleryTotalRef);
	}

	let lastStudioOpts = null;
	async function mountStudio(opts) {
		lastStudioOpts = opts;
		document.title = 'Launchpad Studio — three.ws';
		// Real loading state while the (heavy) editor module loads — a blank
		// screen here reads as a broken page on slow connections.
		root.innerHTML = `
			<div class="lp-studio-wait" role="status" aria-live="polite">
				<div class="spin" aria-hidden="true"></div>
				<div>Opening the studio${opts.slug ? ` for /p/${esc(opts.slug)}` : ''}…</div>
			</div>`;
		try {
			const { mountLaunchpadStudio } = await import('../editor/launchpad-studio.js');
			root.innerHTML = '';
			mountLaunchpadStudio(root, opts);
		} catch (err) {
			log.warn('[launchpad-landing] studio failed to load:', err.message);
			root.innerHTML = `
				<div class="lp-studio-wait" role="alert">
					<h2>The studio didn't load</h2>
					<div>${esc(err.message || 'Network error while loading the editor module.')}</div>
					<div class="fail-actions">
						<button class="lp-btn primary" type="button" data-action="studio-retry">Try again</button>
						<button class="lp-btn ghost" type="button" data-action="studio-home">Back to the launchpad</button>
					</div>
				</div>`;
		}
	}

	function enterStudio(opts = {}) {
		const url = new URL(location.href);
		if (opts.template) url.searchParams.set('template', opts.template);
		if (!urlTargetsStudio(url)) url.searchParams.set('build', '1');
		history.pushState({ studio: true }, '', url);
		mountStudio({ template: opts.template || 'token-launchpad', slug: '', wallet: '', website: '', avatarSrc: '' });
	}

	// Delegated clicks for landing CTAs + template cards.
	root.addEventListener('click', (e) => {
		const tpl = e.target.closest('[data-tpl]');
		if (tpl) {
			e.preventDefault();
			enterStudio({ template: tpl.dataset.tpl });
			return;
		}
		const act = e.target.closest('[data-action="build"]');
		if (act) {
			e.preventDefault();
			enterStudio({});
			return;
		}
		if (e.target.closest('[data-action="studio-retry"]')) {
			e.preventDefault();
			mountStudio(lastStudioOpts || studioOptionsFromUrl(new URL(location.href)));
			return;
		}
		if (e.target.closest('[data-action="studio-home"]')) {
			e.preventDefault();
			history.pushState({}, '', '/launchpad');
			renderLanding();
		}
	});

	// Back/forward between landing and studio. A studio that's already been
	// mounted persists its own draft; returning to it just re-mounts from URL.
	window.addEventListener('popstate', () => {
		const url = new URL(location.href);
		if (urlTargetsStudio(url)) mountStudio(studioOptionsFromUrl(url));
		else renderLanding();
	});

	// Initial route: deep links to the editor skip the landing entirely.
	const url = new URL(location.href);
	if (urlTargetsStudio(url)) mountStudio(studioOptionsFromUrl(url));
	else renderLanding();
}
