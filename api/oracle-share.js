/**
 * Full Oracle conviction page + social share card
 * ------------------------------------------------
 * GET /api/oracle-share?mint=<mint>   (wired via vercel.json: /oracle/coin/<mint>)
 *
 * Server-renders a real, standalone conviction page for one coin — the same
 * verdict the in-feed drawer on /oracle shows, laid out as a full page instead
 * of a slide-over. The persisted verdict (score, tier, four pillars, category,
 * smart-wallet count) is baked into the hero above the fold from the database,
 * so the page paints instantly and social crawlers (X/Twitter, Telegram,
 * Discord, Slack, iMessage, WhatsApp, LinkedIn, Farcaster) get a rich preview
 * with real numbers. The deep + live sections — why-this-score reasons, wallet
 * structure, narrative, community pulse, who's-in, ground-truth outcome, full
 * market intel, conviction history, agent exits, related coins, and a live
 * trade tape — hydrate client-side via /public/oracle-coin.js.
 *
 * OG image: /api/oracle/og?mint=<mint> (SVG conviction card).
 */

import { sql } from './_lib/db.js';
import { cors, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { terminalLinks } from '../src/shared/trading-terminals.js';
import { hitRateFor } from './_lib/oracle/conviction.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUMP_V3 = 'https://frontend-api-v3.pump.fun';
const PUMP_CURVE_INITIAL_REAL_TOKENS = 793_100_000 * 1e6; // matches api/_lib/oracle/market.js

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url    = new URL(req.url, 'http://x');
	const mint   = (url.searchParams.get('mint') || '').trim();
	const origin = env.APP_ORIGIN || 'https://three.ws';

	if (!MINT_RE.test(mint)) return redirect(res, `${origin}/oracle`);

	let row = null;
	try {
		// The outcome joins in here, not just in the client hydration, because the
		// hero is what a share preview and a first paint show. A 100/prime dial on a
		// coin the market already resolved is the single most misleading thing this
		// page can render, and it rendered it for as long as the ground truth lived
		// only in a chip below the fold.
		[row] = await sql`
			select c.symbol, c.name, c.image_uri, c.score, c.tier,
			       c.pedigree, c.structure, c.narrative, c.momentum,
			       c.smart_wallet_count, c.category, c.scored_at, c.coin_first_seen_at,
			       o.graduated, o.rugged, o.ath_multiple, o.last_market_cap_usd
			from oracle_conviction c
			left join pump_coin_outcomes o on o.mint = c.mint
			where c.mint = ${mint} and c.network = 'mainnet'
			limit 1
		`;
	} catch {
		// DB degraded — still serve the page shell; the client lazy-scores via
		// /api/oracle/coin, which is the resilient path.
		row = null;
	}

	// Not scored yet (a brand-new launch Oracle hasn't observed) — pull the coin's
	// real identity + bonding-curve state straight from pump.fun so the hero, the
	// social card, and the client's market fallback are all rich from the first
	// paint, not a generic placeholder. Best-effort: a pump outage degrades to the
	// generic hero, never a broken page.
	let pump = null;
	if (!row) pump = await fetchPumpIdentity(mint);

	const pageUrl = `${origin}/oracle/coin/${mint}`;
	const ogImage = `${origin}/api/oracle/og?mint=${encodeURIComponent(mint)}`;

	let meta;
	if (row) {
		const sym    = row.symbol ? `$${row.symbol}` : shortMint(mint);
		const score  = Number(row.score ?? 0);
		const tier   = row.tier || 'unscored';
		const tierUp = tier.charAt(0).toUpperCase() + tier.slice(1);
		meta = {
			title: `${sym} — ${score}/100 ${tierUp} conviction · Oracle · three.ws`,
			desc: buildDesc({
				sym, name: row.name || sym, score, tier, cat: row.category || '',
				swCount: Number(row.smart_wallet_count || 0),
				pedigree: Number(row.pedigree || 0), structure: Number(row.structure || 0),
				narrative: Number(row.narrative || 0), momentum: Number(row.momentum || 0),
				outcome: row,
			}),
			ogAlt: `${sym} Oracle conviction score ${score}`,
		};
	} else if (pump) {
		const sym = pump.symbol ? `$${pump.symbol}` : shortMint(mint);
		const curve = pump.complete
			? 'graduated to DEX'
			: (pump.bonding_curve_pct != null ? `${Math.round(pump.bonding_curve_pct)}% along the bonding curve` : 'live on pump.fun');
		meta = {
			title: `${sym}${pump.name ? ` (${pump.name})` : ''} — Oracle · three.ws`,
			desc: `${sym}${pump.name ? ` — ${pump.name}` : ''} · ${curve}. Oracle is reading who's buying, how, what it is, and how it's moving into one live conviction score. proof.not.promises — three.ws Oracle`,
			ogAlt: `${sym} on three.ws Oracle`,
		};
	} else {
		meta = {
			title: `${shortMint(mint)} — Oracle conviction · three.ws`,
			desc: 'Oracle fuses who\'s buying, how they\'re buying, what the coin is, and how it\'s moving into one live conviction score for every pump.fun launch. proof.not.promises — three.ws Oracle',
			ogAlt: 'three.ws Oracle conviction',
		};
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=30, s-maxage=300, stale-while-revalidate=3600');
	res.end(renderHtml({ mint, row, pump, meta, pageUrl, ogImage, origin }));
});

// Real pump.fun identity + bonding-curve snapshot for a mint. Keyless public
// endpoint; mirrors the pump branch of api/_lib/oracle/market.js. Returns null on
// any failure so the caller degrades gracefully.
async function fetchPumpIdentity(mint) {
	try {
		const r = await fetch(`${PUMP_V3}/coins-v2/${mint}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(3500),
		});
		if (!r.ok) return null;
		const d = await r.json();
		if (!d || !d.mint) return null;
		const complete = Boolean(d.complete);
		const realTok = Number(d.real_token_reserves);
		let bondingPct = complete ? 100 : null;
		if (bondingPct == null && Number.isFinite(realTok) && realTok >= 0) {
			bondingPct = Math.max(0, Math.min(100, (1 - realTok / PUMP_CURVE_INITIAL_REAL_TOKENS) * 100));
		}
		return {
			symbol: d.symbol || null,
			name: d.name || null,
			image: d.image_uri || null,
			description: d.description || null,
			creator: d.creator || null,
			created_at: d.created_timestamp ? new Date(Number(d.created_timestamp)).toISOString() : null,
			complete,
			bonding_curve_pct: bondingPct,
			real_sol_reserves: Number.isFinite(Number(d.real_sol_reserves)) ? Number(d.real_sol_reserves) / 1e9 : null,
			reply_count: Number.isFinite(Number(d.reply_count)) ? Number(d.reply_count) : null,
			is_live: Boolean(d.is_currently_live),
			market_cap_usd: Number.isFinite(Number(d.usd_market_cap)) ? Number(d.usd_market_cap) : null,
			links: { website: d.website || null, twitter: d.twitter || null, telegram: d.telegram || null },
		};
	} catch {
		return null;
	}
}

function redirect(res, to) {
	res.statusCode = 302;
	res.setHeader('location', to);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

function buildDesc({ sym, name, score, tier, cat, swCount, pedigree, structure, narrative, momentum, outcome }) {
	const parts = [`Oracle scored ${sym} ${score}/100 (${tier} conviction)`];
	if (cat) parts.push(`category: ${cat}`);
	if (swCount > 0) parts.push(`${swCount} proven wallet${swCount === 1 ? '' : 's'} in`);
	parts.push(`Who ${pedigree} · How ${structure} · What ${narrative} · Move ${momentum}`);
	// A resolved coin says so in its own share preview. Boasting a 100/prime into
	// a group chat for a launch that has since collapsed is the same stale verdict
	// the hero used to show, just travelling further.
	const since = descSince(outcome);
	if (since) parts.push(since);
	parts.push('proof.not.promises — three.ws Oracle');
	return parts.join(' · ');
}

/** One clause for what the market did after the call, or '' while it is open. */
function descSince(row) {
	if (!row) return '';
	const ath = row.ath_multiple != null ? Number(row.ath_multiple) : null;
	const peak = Number.isFinite(ath) && ath > 0 ? `${ath.toFixed(1)}x` : null;
	if (row.graduated === true) return peak ? `since: graduated, peaked ${peak}` : 'since: graduated';
	if (row.rugged === true) return peak ? `since: ran ${peak}, then rugged` : 'since: rugged';
	return peak ? `since: peaked ${peak}` : '';
}

function shortMint(m) { return `${m.slice(0, 6)}…${m.slice(-4)}`; }

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function agoServer(ts) {
	if (!ts) return '';
	const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
	if (s < 60)    return `${Math.floor(s)}s ago`;
	if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

// Token art lives on public IPFS gateways, and roughly half of pump.fun art is
// stored as a metadata JSON document rather than an image, sharing one
// `image_uri` column with the real thing. Hot-linked, both fail in the browser:
// the gateway answers without CORS headers or with `application/json`, and
// Chrome blocks it (ERR_BLOCKED_BY_ORB), leaving a broken icon on the hero.
// /api/img is the platform's answer (SSRF-hardened fetch, multi-gateway retry,
// one-hop metadata resolution, on-brand placeholder on total failure) and is
// what src/oracle.js already renders through; the server-rendered header uses
// the same lane.
function proxiedImg(url, seed = '') {
	const raw = String(url || '').trim();
	if (!raw || !/^(https?|ipfs|ar):/i.test(raw)) return raw;
	const q = new URLSearchParams({ url: raw });
	if (seed) q.set('seed', seed);
	return `/api/img?${q.toString()}`;
}

function pillarBar(kind, label, val) {
	const v = val == null ? null : Math.max(0, Math.min(100, Number(val)));
	return `<div class="pil ${kind}"><div class="lab">${label}<b>${v == null ? '—' : Math.round(v)}</b></div>
		<div class="track"><div class="fill" style="width:${v || 0}%"></div></div></div>`;
}

// Server-rendered header in the markets-hub (cv) design: icon, name, ticker,
// conviction card, meta chips, contract row, and action pills, from the DB for
// scored coins, or the coin's real pump.fun identity for a launch Oracle hasn't
// observed yet (the client patches in the score once it lazy-scores). Either way
// the header shows the real coin, never a bare placeholder. The price row is a
// hydration target the client fills from /api/oracle/market.
function heroHtml({ mint, row, pump, origin }) {
	const symRaw = row?.symbol || pump?.symbol || null;
	const sym  = symRaw ? `$${esc(symRaw)}` : shortMint(mint);
	const name = esc(row?.name || pump?.name || '');
	const score = row ? Number(row.score ?? 0) : null;
	const tier  = row?.tier || 'watch';
	const cat   = row?.category || '';
	const sw    = Number(row?.smart_wallet_count || 0);
	const imgUri = row?.image_uri || pump?.image || '';
	const img   = imgUri
		? `<img class="coin-icon" src="${esc(proxiedImg(imgUri, mint))}" alt="" width="64" height="64" loading="eager" data-no-dark-filter>`
		: `<div class="coin-icon oc-icon-letter" aria-hidden="true">${esc(((symRaw || mint)[0] || '?').toUpperCase())}</div>`;

	// Dial: the score for scored coins; a "reading" state for fresh launches that
	// the client fills in (id ocDial) once /api/oracle/coin returns a verdict.
	const dial = score == null
		? `<div class="dial t-watch" id="ocDial"><b>··</b><div class="tierpill tp-watch">reading conviction</div></div>`
		: `<div class="dial t-${esc(tier)}" id="ocDial"><b>${score}</b><div class="tierpill tp-${esc(tier)}">${esc(tier)} conviction</div></div>`;

	// The two lines that keep the dial honest, both rendered server-side so they
	// are in the first paint and in the share preview, not hydrated in late:
	//
	//   odds  - what this band of calls has actually returned, so a 100 reads as
	//           "26% of these won, 4.8x the market" instead of as a certainty.
	//   since - what the market has since done with this exact coin. The page had
	//           this fact all along and buried it in a chip below the fold, which
	//           is how a dead chart ended up next to an unqualified 100/prime.
	const oddsHtml = score == null ? '' : verdictOddsHtml(score, row?.scored_at, row?.coin_first_seen_at);
	const sinceHtml = outcomeStripHtml(row);

	const pillars = `<div class="pillars" id="ocPillars">
		${pillarBar('ped', 'Who',  row?.pedigree)}
		${pillarBar('str', 'How',  row?.structure)}
		${pillarBar('nar', 'What', row?.narrative)}
		${pillarBar('mom', 'Move', row?.momentum)}
	</div>`;

	// Pre-graduation coins carry a bonding-curve chip so the fresh-launch state is
	// still informative before any conviction or DEX price exists.
	const curvePct = pump?.bonding_curve_pct;
	const curveChip = pump
		? (pump.complete
			? '<span class="chip sm">graduated ✓</span>'
			: (curvePct != null ? `<span class="chip">curve <b>${Math.round(curvePct)}%</b></span>` : ''))
		: '';
	const metaChips = `<div class="coin-meta oc-head-chips">
		${cat ? `<span class="chip cat">${esc(cat)}</span>` : ''}
		${sw > 0 ? `<span class="chip sm">${sw} proven wallet${sw === 1 ? '' : 's'}</span>` : ''}
		${row?.scored_at ? `<span class="chip">scored <b>${esc(agoServer(row.scored_at))}</b></span>` : ''}
		${curveChip}
		${pump?.created_at ? `<span class="chip">age <b>${esc(agoServer(pump.created_at))}</b></span>` : ''}
		${pump?.is_live ? '<span class="chip sm">live now</span>' : ''}
	</div>`;

	const actions = `<div class="cv-pills oc-actions">
		<a class="cv-pill" href="${esc(pumpUrl(mint))}" target="_blank" rel="noopener">pump.fun ↗</a>
		${terminalLinks(mint).map((t) => `<a class="cv-pill" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.label)} ↗</a>`).join('\n\t\t')}
		<a class="cv-pill" href="https://solscan.io/token/${esc(mint)}" target="_blank" rel="noopener">Solscan ↗</a>
		<a class="cv-pill" href="/coin3d?mint=${encodeURIComponent(mint)}" title="Open the full 3D coin profile">View in 3D</a>
		<a class="cv-pill" href="/launches/${esc(mint)}">Launch details</a>
		<a class="cv-pill" href="/trades">Trade feed</a>
		<a class="cv-pill" href="/oracle">Oracle feed</a>
		<button class="cv-pill" id="ocWatch" type="button" aria-pressed="false">☆ Watch</button>
		<button class="cv-pill" id="ocCopyLink" type="button" title="Copy shareable link">Copy link</button>
		<a class="cv-pill" href="${esc(shareTweet(mint, row, pump, origin))}" target="_blank" rel="noopener">Share ↗</a>
	</div>`;

	// The coin's own words. Server-known only for pump-identified launches; for
	// scored coins the client fills it from /api/oracle/market identity.
	const desc = (pump?.description || '').trim().slice(0, 400);
	const descHtml = `<p class="oc-desc" id="ocDesc"${desc ? '' : ' hidden'}>${esc(desc)}</p>`;

	return `<section aria-label="Coin overview">
		<div class="cv-coin-head oc-head" id="ocHeroDynamic">
			${img}
			<div class="oc-head-main">
				<div class="title-row">
					<h1>${name || sym}</h1>
					${symRaw && name ? `<span class="ticker">${sym}</span>` : ''}
				</div>
				<div class="cv-price-row oc-price-row" id="ocPriceRow" hidden>
					<span class="cv-price cv-mono" id="ocPrice"></span>
					<div class="oc-price-chips" id="ocPriceChips"></div>
				</div>
				${descHtml}
				${metaChips}
				<div class="oc-contract-row">
					<span class="cv-contract"><span class="oc-mint-addr" title="${esc(mint)}">${esc(mint)}</span><button type="button" id="ocCopyMint" title="Copy mint address">Copy</button></span>
				</div>
				${actions}
			</div>
			<div class="oc-conv-card" aria-label="Oracle conviction">
				${dial}
				<div id="ocOdds">${oddsHtml}</div>
				${pillars}
				<div id="ocSince">${sinceHtml}</div>
			</div>
		</div>
	</section>`;
}

/**
 * What the score is worth, under the score. Reads the production calibration
 * (conviction-calibration.json: realized win rate per score band over every coin
 * Oracle scored that the market has since resolved) so the claim next to the
 * number is a measured frequency instead of an implied one.
 *
 * @param {number} score   0-100 conviction
 * @param {string} scoredAt when the verdict was written
 * @param {string} firstSeen when the coin first surfaced (the call's lead time)
 */
export function verdictOddsHtml(score, scoredAt, firstSeen) {
	const hr = hitRateFor(Number(score));
	if (!hr || hr.rate == null || !hr.n) return '';
	const rate = Math.round(hr.rate * 100);
	const base = Math.round((hr.baseRate || 0) * 100);
	const lift = hr.lift != null ? Number(hr.lift).toFixed(1) : null;
	const lead = leadSeconds(scoredAt, firstSeen);
	return `<p class="oc-odds">
		<b>${rate}%</b> of calls in the ${esc(hr.band || '')} band have won<span class="oc-odds-n"> (n=${hr.n.toLocaleString('en-US')})</span>${lift ? `, <b>${esc(lift)}x</b> the ${base}% a random launch wins` : ''}.
		<span class="oc-odds-sub">Scored ${lead ? `${lead} after this coin surfaced` : 'at launch'}, from the first ~90s of trading. It ranks the odds of a 3x run or graduation, not the odds of a safe hold.</span>
	</p>`;
}

/** Seconds/minutes between a launch first surfacing and Oracle scoring it. */
function leadSeconds(scoredAt, firstSeen) {
	if (!scoredAt || !firstSeen) return null;
	const secs = Math.round((new Date(scoredAt).getTime() - new Date(firstSeen).getTime()) / 1000);
	if (!Number.isFinite(secs) || secs < 0) return null;
	return secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

/**
 * What the market did with this coin AFTER the call. A resolved outcome outranks
 * the verdict on the page: the score is a prediction, this is the answer.
 *
 * @param {{graduated?:boolean, rugged?:boolean, ath_multiple?:number|string, last_market_cap_usd?:number|string}|null} row
 */
export function outcomeStripHtml(row) {
	if (!row) return '';
	const ath = row.ath_multiple != null ? Number(row.ath_multiple) : null;
	const mc = row.last_market_cap_usd != null ? Number(row.last_market_cap_usd) : null;
	const graduated = row.graduated === true;
	const rugged = row.rugged === true;
	if (!graduated && !rugged && !(ath > 0)) return '';
	const verdict = graduated
		? '<span class="chip sm">graduated ✓</span>'
		: rugged ? '<span class="chip flag">rugged ✕</span>' : '<span class="chip">still live</span>';
	return `<div class="oc-since ${rugged && !graduated ? 'bad' : graduated ? 'good' : ''}">
		<span class="oc-since-lbl">Since the call</span>
		${ath > 0 ? `<span class="chip" title="Peak market cap versus its market cap when Oracle scored it">peak <b>${ath.toFixed(1)}x</b></span>` : ''}
		${verdict}
		${mc != null ? `<span class="chip" title="Market cap now">now <b>${esc(fmtUsdShort(mc))}</b></span>` : ''}
	</div>`;
}

function fmtUsdShort(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return 'n/a';
	if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
	if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
	if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
	return `$${v.toFixed(0)}`;
}

function pumpUrl(mint) { return `https://pump.fun/coin/${mint}`; }

function shareTweet(mint, row, pump, origin) {
	const sym = row?.symbol || pump?.symbol || shortMint(mint);
	const shareUrl = `${origin}/oracle/coin/${mint}`;
	if (row) {
		const text = `$${sym} — ${row.score ?? '—'}/100 ${row.tier || 'watch'} conviction on @trythreews Oracle\n\nWho · How · What · Move all fused into one score.\n${shareUrl}`;
		return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
	}
	const text = `$${sym} on @trythreews Oracle — who's buying, how, what it is, and how it's moving, fused into one live conviction score.\n${shareUrl}`;
	return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

// Safe JSON for inlining into a <script> — neutralize </script> and JS line
// separators so the boot payload can't break out of the tag.
function jsonForScript(obj) {
	return JSON.stringify(obj)
		.replace(/</g, "\\u003c")
		.split(String.fromCharCode(0x2028)).join("\\u2028")
		.split(String.fromCharCode(0x2029)).join("\\u2029");
}

export function renderHtml({ mint, row, pump, meta, pageUrl, ogImage, origin }) {
	const t = esc(meta.title);
	const d = esc(meta.desc);
	const symRaw = row?.symbol || pump?.symbol || null;
	const crumb = symRaw ? `$${esc(symRaw)}` : esc(shortMint(mint));
	return `<!doctype html>
<html lang="en" class="cv-page">
<head>
	<script>/* three.ws theme boot — no-flash */(function(){try{var m=localStorage.getItem('twx_theme');var l=m==='auto'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches):m==='light';document.documentElement.setAttribute('data-theme',l?'light':'dark');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();</script>
	<meta charset="utf-8">
	<title>${t}</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#0a0a0a">

	<meta property="og:type" content="website">
	<meta property="og:site_name" content="three.ws Oracle">
	<meta property="og:title" content="${t}">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${esc(pageUrl)}">
	<meta property="og:image" content="${esc(ogImage)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${esc(meta.ogAlt)}">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:site" content="@trythreews">
	<meta name="twitter:title" content="${t}">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${esc(ogImage)}">

	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(ogImage)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="Open Oracle →">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(pageUrl)}">
	<meta property="fc:frame:button:2" content="Trade Feed">
	<meta property="fc:frame:button:2:action" content="link">
	<meta property="fc:frame:button:2:target" content="${esc(origin)}/trades">

	<link rel="canonical" href="${esc(pageUrl)}">
	<link rel="icon" href="/favicon.ico" sizes="any">
	<link rel="icon" type="image/svg+xml" href="/favicon.svg">
	<link rel="stylesheet" href="/fonts/fonts.css">
	<link rel="stylesheet" href="/nav.css">
	<link rel="stylesheet" href="/src/coin-pages.css">
	<link rel="stylesheet" href="/oracle-coin.css">
	<link rel="stylesheet" href="/footer.css">
</head>
<body>
	<header><div id="nav-container"></div></header>
	<script defer src="/nav.js"></script>

	<main class="cv-container">
		<nav class="cv-crumbs" aria-label="Breadcrumb">
			<a href="/">Home</a>
			<span class="sep" aria-hidden="true">›</span>
			<a href="/radar">Coin Radar</a>
			<span class="sep" aria-hidden="true">›</span>
			<span class="here">${crumb}</span>
		</nav>
		${heroHtml({ mint, row, pump, origin })}
		<div class="oc-body" id="ocDeep">
			<div class="oc-spinner" aria-label="Loading conviction"></div>
		</div>
	</main>

	<script>window.__OC_BOOT=${jsonForScript({ mint, pump: pump || null, hasVerdict: Boolean(row) })}</script>
	<script type="module" src="/oracle-coin.js"></script>
	<script src="/footer.js" defer></script>
</body>
</html>`;
}
