/**
 * GET /api/og/three-token-badge
 *
 * Dynamic Open Graph image for the $THREE token, a shareable badge that
 * previews with live market data wherever the link is posted (X, Telegram,
 * Discord, Slack, iMessage, Farcaster).
 *
 * Mirrors the conventions of api/og/agent.js: an SVG 1200×630 card returned
 * with image/svg+xml + a CDN cache header, no heavy canvas/satori deps in the
 * serverless bundle. Social crawlers accept image/svg+xml for og:image.
 *
 * Every figure on the card is real, and read from the same three sources that
 * back GET /api/three-token/stats (what the /three-token page renders), so the
 * card and the page can never disagree:
 *   market data, fetchTokenMarketData() (Birdeye → DexScreener → GeckoTerminal
 *                  failover with a stale cache)
 *   holders,     threeHolderCount() (our own snapshot, then a keyless rung),
 *                  because the market sources that answer without a Birdeye key
 *                  carry no holder count at all
 *   agent count, the same agent_identities count the stats endpoint runs
 * Nothing is hardcoded. $THREE is the only coin this card ever references.
 *
 * The card degrades gracefully: if the stats fetch fails or a field is missing
 * we render the figure as "-" and still emit a valid, branded 1200×630 card,
 * we never 5xx and never redirect to a static fallback over missing enrichment.
 *
 * Card anatomy (1200×630, dark):
 *   top, three.ws wordmark + "TOKEN"
 *   hero, $THREE glyph mark + symbol + truncated mint
 *   price, large USD price + 24h change pill (green up / red down)
 *   stats, market cap · holders · 24h volume · on-chain agents grid
 *   footer, contract address + "three.ws/three-token"
 */

import { cors, wrap } from '../_lib/http.js';
import { TOKEN_MINT as THREE_MINT } from '../_lib/token/config.js';
import { fetchTokenMarketData } from '../_lib/market/token-market.js';
import { threeHolderCount } from '../_lib/coin/three-holders.js';
import { sql } from '../_lib/db.js';

// Edge-cache the card: 60s fresh, 10m at the CDN, serve-stale-while-revalidate.
// A token price is fine to be a minute stale and this keeps crawlers (which hit
// the OG URL repeatedly) off the lambda and off the market-data providers.
const CACHE = 'public, max-age=60, s-maxage=600, stale-while-revalidate=120';

// $THREE brand gradient, the violet→cyan pair used across the platform.
const C1 = '#8b5cf6';
const C2 = '#06b6d4';
const UP = '#10b981';
const DOWN = '#ef4444';

function x(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Truncate a base58 mint for display: "FeMb…Jpump".
function shortMint(addr) {
	const s = String(addr || '');
	return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

// USD price: keep enough significant digits for a sub-cent token without a wall
// of zeros. >= $1 → 2dp; >= $0.01 → 4dp; otherwise 6 significant figures.
function fmtPrice(n) {
	if (n == null || !Number.isFinite(n)) return '-';
	if (n >= 1) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	if (n >= 0.01) return `$${n.toFixed(4)}`;
	if (n <= 0) return '$0';
	// Sub-cent: 6 significant figures, but always in plain decimal notation.
	// toPrecision() flips to exponent form below 1e-7 ("$1.00000e-8"), which is
	// unreadable on a share card, so derive the decimal count and render fixed.
	const decimals = Math.min(20, 5 - Math.floor(Math.log10(n)));
	return `$${n.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// Approximate advance width of a string in the hero face (Inter, weight 800) so
// the layout can flow around a rendered figure. SVG has no measurement API at
// render time and the card ships no font metrics, so the widths below are the
// per-glyph em advances Inter uses: digits and "$" are tabular-wide, separators
// are narrow. Used to keep the 24h pill clear of the price at any magnitude.
const EM_ADVANCE = { '.': 0.27, ',': 0.27 };
function heroTextWidth(s, fontSize) {
	let em = 0;
	for (const ch of String(s)) em += EM_ADVANCE[ch] ?? 0.6;
	return em * fontSize;
}

// Compact USD for market cap / volume: $1.2M, $640K, $12.3B.
function fmtCompactUsd(n) {
	if (n == null || !Number.isFinite(n)) return '-';
	const abs = Math.abs(n);
	if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
	return `$${n.toFixed(0)}`;
}

function fmtInt(n) {
	if (n == null || !Number.isFinite(n)) return '-';
	return Math.round(n).toLocaleString('en-US');
}

function fmtPct(n) {
	if (n == null || !Number.isFinite(n)) return null;
	const sign = n > 0 ? '+' : '';
	return `${sign}${n.toFixed(2)}%`;
}

// Resolve every datum the card shows from real sources, each independently
// resilient so one failing provider blanks a single figure rather than the card.
async function loadBadgeData() {
	const [market, agentRow, holderCount] = await Promise.all([
		fetchTokenMarketData(THREE_MINT).catch(() => null),
		sql`SELECT count(*)::int AS total FROM agent_identities WHERE deleted_at IS NULL`
			.catch(() => [{ total: null }]),
		// Same holder source /api/three-token/stats reads, and for the same reason:
		// the keyless market rungs (DexScreener / GeckoTerminal) carry no holder
		// count, so whenever Birdeye is unkeyed or quota-benched this is the only
		// thing standing between the card and a permanently blank HOLDERS cell.
		// Omitting it here is what let the card and the page disagree.
		threeHolderCount().catch(() => null),
	]);
	return {
		price: market?.price_usd ?? null,
		change24h: market?.price_change_24h ?? null,
		marketCap: market?.market_cap ?? null,
		volume24h: market?.volume_24h ?? null,
		holders: market?.holders ?? holderCount ?? null,
		agents: agentRow?.[0]?.total ?? null,
	};
}

function statCell(xPos, label, value) {
	return (
		`<text x="${xPos}" y="470" font-family="Inter,system-ui,sans-serif" font-size="14" ` +
		`letter-spacing=".08em" fill="#6b7280">${x(label)}</text>` +
		`<text x="${xPos}" y="508" font-family="Inter,system-ui,sans-serif" font-size="30" ` +
		`font-weight="700" fill="#f9fafb">${x(value)}</text>`
	);
}

function renderCard(d) {
	const priceStr = fmtPrice(d.price);
	const pct = fmtPct(d.change24h);
	const up = (d.change24h ?? 0) >= 0;
	const changeColor = up ? UP : DOWN;
	const arrow = up ? '▲' : '▼';
	const mintShort = shortMint(THREE_MINT);

	// 24h-change pill, only when we actually have the datum. It sits to the right
	// of the price, so its x follows the price's rendered width: a hardcoded x
	// collides with the figure as soon as the price gets long (a dollar-plus
	// price, or a sub-cent one carrying six significant digits).
	const pillW = pct ? 40 + pct.length * 13 : 0;
	const pillX = Math.min(
		1128 - pillW,
		Math.round(72 + heroTextWidth(priceStr, 84) + 28),
	);
	const changePill = pct
		? `<rect x="${pillX}" y="300" width="${pillW}" height="44" rx="22"
			fill="${changeColor}" fill-opacity=".12" stroke="${changeColor}" stroke-opacity=".4" stroke-width="1.5"/>
		   <text x="${pillX + pillW / 2}" y="329" text-anchor="middle"
			font-family="Inter,system-ui,sans-serif" font-size="20" font-weight="700"
			fill="${changeColor}">${x(arrow)} ${x(pct)}</text>`
		: '';

	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#050508"/>
			<stop offset="1" stop-color="#0c0a16"/>
		</linearGradient>
		<linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="${C1}"/>
			<stop offset="1" stop-color="${C2}"/>
		</linearGradient>
		<radialGradient id="glow" cx="50%" cy="50%" r="50%">
			<stop offset="0" stop-color="${C1}" stop-opacity=".30"/>
			<stop offset="1" stop-color="${C1}" stop-opacity="0"/>
		</radialGradient>
		<linearGradient id="accent" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${C1}"/>
			<stop offset="1" stop-color="${C2}"/>
		</linearGradient>
	</defs>

	<!-- background -->
	<rect width="1200" height="630" fill="url(#bg)"/>
	<rect x="0" y="0" width="6" height="630" fill="url(#accent)"/>
	<ellipse cx="980" cy="180" rx="320" ry="280" fill="url(#glow)"/>

	<!-- top bar -->
	<text x="72" y="78" font-family="Inter,system-ui,sans-serif" font-size="15" font-weight="600"
		letter-spacing=".14em" fill="#4b5563">THREE.WS</text>
	<text x="1128" y="78" font-family="Inter,system-ui,sans-serif" font-size="15"
		letter-spacing=".14em" fill="#4b5563" text-anchor="end">TOKEN</text>
	<line x1="72" y1="100" x2="1128" y2="100" stroke="#1f2937" stroke-width="1"/>

	<!-- hero: $THREE mark + symbol -->
	<circle cx="128" cy="208" r="48" fill="url(#mark)"/>
	<text x="128" y="224" text-anchor="middle" font-family="Inter,system-ui,sans-serif"
		font-size="40" font-weight="800" fill="#ffffff">3</text>
	<text x="200" y="200" font-family="Inter,system-ui,sans-serif" font-size="64" font-weight="800"
		fill="#f9fafb">$THREE</text>
	<text x="202" y="240" font-family="ui-monospace,Menlo,monospace" font-size="20"
		fill="#6b7280">${x(mintShort)}</text>

	<!-- price -->
	<text x="72" y="332" font-family="Inter,system-ui,sans-serif" font-size="84" font-weight="800"
		fill="#ffffff">${x(priceStr)}</text>
	${changePill}

	<!-- divider -->
	<line x1="72" y1="404" x2="1128" y2="404" stroke="#1f2937" stroke-width="1"/>

	<!-- stats grid -->
	${statCell(72, 'MARKET CAP', fmtCompactUsd(d.marketCap))}
	${statCell(372, 'HOLDERS', fmtInt(d.holders))}
	${statCell(672, '24H VOLUME', fmtCompactUsd(d.volume24h))}
	${statCell(948, 'ON-CHAIN AGENTS', fmtInt(d.agents))}

	<!-- footer -->
	<rect x="0" y="566" width="1200" height="64" fill="#030305"/>
	<text x="72" y="606" font-family="ui-monospace,Menlo,monospace" font-size="14" fill="#374151">
		${x(THREE_MINT)}</text>
	<text x="1128" y="606" font-family="Inter,system-ui,sans-serif" font-size="14" fill="#4b5563"
		letter-spacing=".06em" text-anchor="end">three.ws/three-token</text>
</svg>`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;

	let data;
	try {
		data = await loadBadgeData();
	} catch {
		// Never 5xx a crawler, render the branded card with blank figures.
		data = { price: null, change24h: null, marketCap: null, volume24h: null, holders: null, agents: null };
	}

	const svg = renderCard(data);
	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(svg);
});

// Exposed for unit tests: lets a test render the card from fixed figures and
// assert the SVG shape without touching the network or DB.
export const __testInternals = {
	renderCard, fmtPrice, fmtCompactUsd, fmtPct, fmtInt, shortMint, heroTextWidth,
};
