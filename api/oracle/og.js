/**
 * GET /api/oracle/og?mint=<mint>
 *
 * Dynamic OG image for /oracle?mint=<mint> — conviction-focused social card.
 * Shows the coin's Oracle score, tier, pillar breakdown, and smart-wallet signal
 * so every shared conviction link previews with real data.
 *
 * Card anatomy (1200×630, dark):
 *   top         — three.ws wordmark + "Oracle conviction"
 *   hero left   — coin image (120×120 circle)
 *   hero right  — name, symbol, category
 *   center      — conviction score (large), tier badge
 *   pillars     — four labeled bars (Who / How / What / Move)
 *   right lower — market cap (live for an unresolved coin, last recorded once
 *                 it graduated or rugged)
 *   bottom-right — smart wallet count, graduated/live pill
 *   footer      — "proof.not.promises"
 */

import { cors, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { isQuoteMint } from '../_lib/quote-mints.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUMP_FRONTEND_V3 = 'https://frontend-api-v3.pump.fun';
const CACHE = 'public, max-age=120, s-maxage=900, stale-while-revalidate=60';

function x(s) {
	return String(s || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function trunc(s, n) {
	s = String(s || '');
	return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function shortMint(m) {
	return `${m.slice(0, 6)}…${m.slice(-4)}`;
}

/** Compact USD for the card: $1.2M / $845K / $912. Null for anything unusable. */
function fmtUsd(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return null;
	if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
	return `$${Math.round(n)}`;
}

function tierColor(tier) {
	if (tier === 'prime')  return '#c084fc';
	if (tier === 'strong') return '#34d399';
	if (tier === 'lean')   return '#fbbf24';
	if (tier === 'watch')  return '#94a3b8';
	if (tier === 'avoid')  return '#f87171';
	return '#94a3b8';
}

function tierLabel(tier) {
	if (tier === 'prime')  return 'PRIME';
	if (tier === 'strong') return 'STRONG';
	if (tier === 'lean')   return 'LEAN';
	if (tier === 'watch')  return 'WATCH';
	if (tier === 'avoid')  return 'AVOID';
	return tier ? tier.toUpperCase() : '';
}

async function fetchLogoBase64(imageUri) {
	if (!imageUri) return null;
	const url = imageUri.startsWith('ipfs://')
		? `https://ipfs.io/ipfs/${imageUri.slice(7)}`
		: imageUri;
	try {
		const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
		if (!resp.ok) return null;
		const ct = resp.headers.get('content-type') || 'image/png';
		const buf = await resp.arrayBuffer();
		const b64 = Buffer.from(buf).toString('base64');
		return `data:${ct};base64,${b64}`;
	} catch {
		return null;
	}
}

async function buildCardData(mint) {
	const [convRows, outcomeRows] = await Promise.all([
		sql`
			select c.score, c.tier, c.symbol, c.name, c.image_uri, c.category,
			       c.pedigree, c.structure, c.narrative, c.momentum,
			       c.smart_wallet_count, c.scored_at
			from oracle_conviction c
			where c.mint = ${mint} and c.network = 'mainnet'
			limit 1
		`,
		sql`
			select graduated, rugged, ath_multiple, last_market_cap_usd
			from pump_coin_outcomes
			where mint = ${mint}
			limit 1
		`,
	]);

	const cv      = convRows[0]   || null;
	const outcome = outcomeRows[0] || null;

	// Fallback: try to get name/symbol from coin_intel if oracle has no row
	let name = cv?.name || '';
	let symbol = cv?.symbol || '';
	let imageUri = cv?.image_uri || null;
	let category = cv?.category || '';

	if (!name || !symbol) {
		try {
			const intelRows = await sql`
				select name, symbol, image_uri, category
				from pump_coin_intel
				where mint = ${mint}
				limit 1
			`;
			const intel = intelRows[0];
			if (intel) {
				name     = name || intel.name || '';
				symbol   = symbol || intel.symbol || '';
				imageUri = imageUri || intel.image_uri || null;
				category = category || intel.category || '';
			}
		} catch { /* non-fatal */ }
	}

	// Live market cap, but only while the coin is still on the curve: a graduated
	// or rugged coin reads its number off the recorded outcome instead.
	const wantsLiveMcap = !outcome?.graduated && !outcome?.rugged;

	// Two independent 3s-bounded round-trips, so the card costs one of them,
	// not both in series.
	const [logoBase64, liveMcap] = await Promise.all([
		fetchLogoBase64(imageUri),
		wantsLiveMcap ? fetchLiveMarketCap(mint) : Promise.resolve(null),
	]);

	return { cv, outcome, name, symbol, logoBase64, category, liveMcap };
}

// Live USD market cap for a coin still on the curve. pump.fun emits
// `usd_market_cap` (with `market_cap_usd` as the v2 alias); this card used to ask
// for a `market_cap_in_usd` key that does not exist, so the number was fetched on
// every render and always came back null. Any failure returns null and the card
// falls back to the recorded outcome cap, or omits the block.
async function fetchLiveMarketCap(mint) {
	try {
		const r = await fetch(`${PUMP_FRONTEND_V3}/coins-v2/${mint}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(3000),
		});
		if (!r.ok) return null;
		const d = await r.json();
		const mcap = Number(d?.usd_market_cap ?? d?.market_cap_usd);
		return Number.isFinite(mcap) && mcap > 0 ? mcap : null;
	} catch {
		return null;
	}
}

function pillarBar(label, val, color, x0, y0) {
	const v    = val != null ? Math.round(Number(val)) : null;
	const barW = 230;
	const fill = v != null ? Math.round((v / 100) * barW) : 0;
	const txt  = v != null ? String(v) : '?';
	return `
	<text x="${x0}" y="${y0}" fill="rgba(229,229,229,0.35)" font-size="13" letter-spacing="2">${x(label)}</text>
	<rect x="${x0}" y="${y0 + 8}" width="${barW}" height="8" rx="4" fill="rgba(255,255,255,0.07)"/>
	<rect x="${x0}" y="${y0 + 8}" width="${fill}" height="8" rx="4" fill="${color}"/>
	<text x="${x0 + barW + 12}" y="${y0 + 17}" fill="${color}" font-size="14" font-weight="700">${x(txt)}</text>`;
}

export function renderCard(mint, d) {
	const { cv, outcome, name, symbol, logoBase64, category, liveMcap } = d;

	const score   = cv?.score != null ? Math.round(Number(cv.score)) : null;
	const tier    = cv?.tier || '';
	const tc      = tierColor(tier);
	const tl      = tierLabel(tier);
	const pillar  = (k) => cv?.[k] != null ? Math.round(Number(cv[k])) : null;
	const smCount = cv?.smart_wallet_count ?? null;

	const displayName = trunc(name || 'Unknown coin', 34);
	const displaySym  = symbol ? `$${symbol.toUpperCase()}` : '';

	// Outcome pill
	let outcomePill = '';
	if (outcome?.graduated) {
		outcomePill = `
		<rect x="930" y="536" width="190" height="52" rx="10" fill="#16a34a22"/>
		<text x="945" y="570" fill="#22c55e" font-size="20" font-weight="600" font-family="Inter,-apple-system,system-ui,sans-serif">GRADUATED ✓</text>`;
	} else if (outcome?.rugged) {
		outcomePill = `
		<rect x="930" y="536" width="190" height="52" rx="10" fill="#dc262622"/>
		<text x="945" y="570" fill="#ef4444" font-size="20" font-weight="600" font-family="Inter,-apple-system,system-ui,sans-serif">RUGGED ✕</text>`;
	} else {
		outcomePill = `
		<circle cx="942" cy="562" r="6" fill="#22c55e"/>
		<text x="958" y="568" fill="#22c55e" font-size="18" font-weight="500" font-family="Inter,-apple-system,system-ui,sans-serif">LIVE</text>`;
	}

	// Logo block
	const imgBlock = logoBase64
		? `<image href="${logoBase64}" x="80" y="148" width="112" height="112" clip-path="url(#imgCircle)"/>`
		: `<rect x="80" y="148" width="112" height="112" rx="56" fill="#1a1d2e"/>
		   <text x="136" y="225" text-anchor="middle" fill="#4b5563" font-size="44">${x((displaySym || displayName)[0] || '?')}</text>`;

	// Market cap. A live coin gets the price the pump.fun frontend reports right
	// now; a graduated/rugged one gets the last cap the outcome tracker recorded,
	// which is the only honest figure once the curve is gone.
	const mcapValue = fmtUsd(liveMcap) || fmtUsd(outcome?.last_market_cap_usd);
	const mcapLabel = liveMcap != null ? 'MARKET CAP' : 'LAST MARKET CAP';
	const mcapBlock = mcapValue
		? `<text x="730" y="424" fill="rgba(229,229,229,0.35)"
		      font-family="Inter,-apple-system,system-ui,sans-serif"
		      font-size="13" letter-spacing="2">${x(mcapLabel)}</text>
		<text x="730" y="466" fill="#e5e5e5"
		      font-family="Inter,-apple-system,system-ui,sans-serif"
		      font-size="36" font-weight="600" letter-spacing="-0.5">${x(mcapValue)}</text>`
		: '';

	// Smart wallet count badge
	const smBadge = smCount != null
		? `<rect x="80" y="468" width="${String(smCount).length * 14 + 120}" height="34" rx="8" fill="rgba(192,132,252,0.12)"/>
		   <text x="94" y="491" fill="${tc}" font-size="15" font-weight="500" font-family="Inter,-apple-system,system-ui,sans-serif">🧠 ${smCount} smart wallet${smCount !== 1 ? 's' : ''}</text>`
		: '';

	// Score block — centered anchor
	const scoreStr  = score != null ? String(score) : '—';
	const scoreBlock = score != null ? `
	<!-- Score circle -->
	<circle cx="640" cy="310" r="110" fill="rgba(${tier === 'prime' ? '192,132,252' : tier === 'strong' ? '52,211,153' : tier === 'lean' ? '251,191,36' : tier === 'avoid' ? '248,113,113' : '148,163,184'},0.06)" stroke="${tc}" stroke-width="2" stroke-opacity="0.5"/>
	<text x="640" y="360" text-anchor="middle" fill="${tc}"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="100" font-weight="800" letter-spacing="-3">${x(scoreStr)}</text>
	<text x="640" y="395" text-anchor="middle" fill="rgba(229,229,229,0.25)"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="18" letter-spacing="1">/ 100</text>
	<!-- Tier badge -->
	${tl ? `<rect x="${640 - tl.length * 9 - 24}" y="415" width="${tl.length * 18 + 48}" height="38" rx="8" fill="${tc}18"/>
	<text x="640" y="441" text-anchor="middle" fill="${tc}"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="20" font-weight="700" letter-spacing="3">${x(tl)} CONVICTION</text>` : ''}
	` : `
	<text x="640" y="330" text-anchor="middle" fill="rgba(229,229,229,0.3)"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="28" font-weight="400">Not yet scored</text>`;

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="1200" height="630" viewBox="0 0 1200 630" role="img"
     aria-label="${x(displayName)} Oracle conviction card">
	<defs>
		<clipPath id="imgCircle"><circle cx="136" cy="204" r="56"/></clipPath>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0%" stop-color="#08090d"/>
			<stop offset="100%" stop-color="#0d1018"/>
		</linearGradient>
	</defs>

	<!-- Background -->
	<rect width="1200" height="630" fill="url(#bg)"/>
	<!-- Top accent line (tier-colored) -->
	<rect x="0" y="0" width="1200" height="3" fill="${tc}" opacity="0.8"/>

	<!-- Header row -->
	<text x="80" y="88" fill="rgba(229,229,229,0.9)"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="24" font-weight="600" letter-spacing="1.5">three.ws</text>
	<text x="152" y="85" fill="rgba(229,229,229,0.22)"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="18" font-weight="400"> / Oracle</text>
	<text x="1140" y="88" text-anchor="end" fill="rgba(229,229,229,0.22)"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="17" font-weight="400">${x(shortMint(mint))}</text>

	<!-- Horizontal rule under header -->
	<line x1="80" y1="108" x2="1120" y2="108" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

	<!-- Coin logo -->
	${imgBlock}

	<!-- Coin identity -->
	<text x="220" y="190" fill="#e5e5e5"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="46" font-weight="300" letter-spacing="-0.5">${x(displayName)}</text>
	<text x="220" y="234" fill="rgba(229,229,229,0.45)"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="26" font-weight="400" letter-spacing="1">${x(displaySym)}</text>
	${category ? `<rect x="220" y="246" width="${category.length * 10 + 24}" height="28" rx="6" fill="rgba(255,255,255,0.05)"/>
	<text x="232" y="265" fill="rgba(229,229,229,0.35)" font-size="14" font-family="Inter,-apple-system,system-ui,sans-serif">${x(category)}</text>` : ''}

	<!-- Horizontal divider -->
	<line x1="80" y1="300" x2="540" y2="300" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

	<!-- Conviction score block (center) -->
	${scoreBlock}

	<!-- Pillar bars (right column) -->
	${pillarBar('WHO · PEDIGREE', pillar('pedigree'), '#a78bfa', 730, 148)}
	${pillarBar('HOW · STRUCTURE', pillar('structure'), '#22d3ee', 730, 210)}
	${pillarBar('WHAT · NARRATIVE', pillar('narrative'), '#fbbf24', 730, 272)}
	${pillarBar('MOVE · MOMENTUM', pillar('momentum'), '#f472b6', 730, 334)}

	<!-- Market cap -->
	${mcapBlock}

	<!-- Smart wallet count -->
	${smBadge}

	<!-- Outcome pill -->
	${outcomePill}

	<!-- Footer -->
	<text x="80" y="594" fill="rgba(229,229,229,0.15)"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="16" letter-spacing="5">PROOF.NOT.PROMISES</text>
	<text x="1140" y="594" text-anchor="end" fill="rgba(229,229,229,0.15)"
	      font-family="Inter,-apple-system,system-ui,sans-serif"
	      font-size="16" letter-spacing="2">THREE.WS / ORACLE</text>
</svg>`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url  = new URL(req.url, 'http://x');
	const mint = (url.searchParams.get('mint') || '').trim();

	if (!MINT_RE.test(mint) || isQuoteMint(mint)) {
		// Quote/stablecoin/LST mints are not coins — no conviction card for them.
		res.statusCode = 400;
		res.setHeader('content-type', 'text/plain');
		res.end('bad mint');
		return;
	}

	let data;
	try {
		data = await buildCardData(mint);
	} catch {
		data = { cv: null, outcome: null, name: '', symbol: '', logoBase64: null, category: '', liveMcap: null };
	}

	const svg = renderCard(mint, data);
	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(svg);
});
