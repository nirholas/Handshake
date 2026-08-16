// api/og-leaderboard.js — dynamic Open Graph / share image for the $THREE
// holder leaderboard. Renders a real 1200×630 PNG (not SVG: X, Facebook,
// LinkedIn and iMessage do not preview image/svg+xml cards) via @vercel/og's
// ImageResponse on the Node runtime — the same proven path as api/page-og.js.
//
// Two modes, both fed by real data:
//   • Board card   /api/og-leaderboard
//       Top $THREE holders by on-chain balance + live price/market cap.
//   • Holder card  /api/og-leaderboard?wallet=<base58>
//       A single holder's rank, balance, tier and % of supply — the "I'm a
//       Diamond holder, ranked #12" flex that drives the share flywheel.
//
// Data sources (real, server-side, cached at the edge):
//   • Holder set + ranks → /api/leaderboard (Helius DAS scan)
//   • Live price / market cap → token market module (Birdeye → Dexscreener → Gecko)
//
// Cached aggressively (s-maxage=1h) so the card is generated at most once per
// hour per variant rather than per crawl.

import { ImageResponse } from '@vercel/og';
import { method } from './_lib/http.js';
import { TOKEN_MINT as THREE_MINT } from './_lib/token/config.js';
import { fetchTokenMarketData } from './_lib/market/token-market.js';
import { threeHolderBalances } from './_lib/coin/three-holders.js';

const WIDTH = 1200;
const HEIGHT = 630;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const HOLDER_TIERS = [
	{ id: 'genesis', label: 'Genesis', min: 10_000_000, accent: '#f5d0a9' },
	{ id: 'diamond', label: 'Diamond', min: 1_000_000, accent: '#7dd3fc' },
	{ id: 'platinum', label: 'Platinum', min: 100_000, accent: '#c4b5fd' },
	{ id: 'gold', label: 'Gold', min: 10_000, accent: '#fbbf24' },
	{ id: 'silver', label: 'Silver', min: 1_000, accent: '#cbd5e1' },
	{ id: 'bronze', label: 'Bronze', min: 1, accent: '#d8a07a' },
	{ id: 'none', label: 'Not holding', min: 0, accent: '#6b7280' },
];
function tierForBalance(amount) {
	const n = Number(amount) || 0;
	for (const t of HOLDER_TIERS) if (n >= t.min && t.min > 0) return t;
	return HOLDER_TIERS[HOLDER_TIERS.length - 1];
}

function shortWallet(addr) {
	const s = String(addr || '');
	return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}
function fmtAmount(n) {
	const v = Number(n) || 0;
	if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
	if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
	if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
	return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return null;
	if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
	if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
	if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
	if (v < 0.01) return `$${v.toPrecision(2)}`;
	return `$${v.toFixed(2)}`;
}

// Build the ranked holder list + market context once, shared by both card modes.
async function loadBoard() {
	const [balances, market] = await Promise.all([
		// Cached snapshot (three-holders-snapshot cron) — no per-render Helius walk,
		// which also removes the crawler-amplified DAS burn on this OG card.
		threeHolderBalances().catch(() => new Map()),
		fetchTokenMarketData(THREE_MINT).catch(() => null),
	]);
	const decimals = Number(market?.decimals ?? 6);
	const per = 10 ** decimals;
	const supply = market?.supply != null ? Number(market.supply) : null;
	const ranked = [...balances.entries()]
		.filter(([, a]) => a > 0n)
		.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
		.map(([wallet, atomic], i) => {
			const amount = Number(atomic) / per;
			return { rank: i + 1, wallet, amount, pct: supply ? amount / supply : null };
		});
	return { ranked, market, supply };
}

const FOOTER = (accent) => ({
	type: 'div',
	props: {
		style: {
			position: 'absolute', left: 0, right: 0, bottom: 0, height: 56,
			display: 'flex', alignItems: 'center', justifyContent: 'space-between',
			padding: '0 56px', background: '#030305',
			borderTop: '1px solid rgba(255,255,255,0.06)',
		},
		children: [
			{ type: 'div', props: { style: { display: 'flex', alignItems: 'center', fontSize: 20, fontWeight: 700, color: 'rgba(235,235,245,0.55)', letterSpacing: '0.04em' }, children: [
				{ type: 'div', props: { style: { width: 10, height: 10, borderRadius: 10, background: accent, marginRight: 14 } } },
				{ type: 'div', props: { children: 'THREE.WS · $THREE HOLDER LEADERBOARD' } },
			] } },
			{ type: 'div', props: { style: { fontSize: 20, fontWeight: 600, color: 'rgba(235,235,245,0.35)' }, children: 'three.ws/leaderboard' } },
		],
	},
});

function baseShell(accent, children) {
	return {
		type: 'div',
		props: {
			style: {
				width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
				position: 'relative', background: '#06060b', color: '#f5f5fa',
				fontFamily: 'ui-sans-serif, system-ui, sans-serif',
			},
			children: [
				{ type: 'div', props: { style: { position: 'absolute', top: 0, left: 0, width: 520, height: 520, background: `radial-gradient(circle at 0% 0%, ${accent}33, transparent 70%)`, display: 'flex' } } },
				{ type: 'div', props: { style: { position: 'absolute', top: 0, left: 0, width: 6, height: '100%', background: accent, display: 'flex' } } },
				...children,
				FOOTER(accent),
			],
		},
	};
}

function statPill(label, value, accent) {
	return {
		type: 'div',
		props: {
			style: { display: 'flex', flexDirection: 'column', gap: 6 },
			children: [
				{ type: 'div', props: { style: { fontSize: 22, color: 'rgba(235,235,245,0.45)', letterSpacing: '0.04em', textTransform: 'uppercase' }, children: label } },
				{ type: 'div', props: { style: { fontSize: 40, fontWeight: 800, color: value === '—' ? 'rgba(235,235,245,0.4)' : accent }, children: value } },
			],
		},
	};
}

function holderCard(holder, market) {
	const tier = tierForBalance(holder?.amount || 0);
	const accent = tier.accent;
	const price = fmtUsd(market?.price_usd);
	const usdValue = market?.price_usd ? fmtUsd((holder?.amount || 0) * market.price_usd) : null;
	return baseShell(accent, [
		{ type: 'div', props: { style: { display: 'flex', flexDirection: 'column', padding: '64px 64px 0', flex: 1 }, children: [
			{ type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: 18, marginBottom: 8 }, children: [
				{ type: 'div', props: { style: { fontSize: 24, fontWeight: 700, letterSpacing: '0.16em', color: 'rgba(235,235,245,0.5)' }, children: '$THREE HOLDER' } },
				{ type: 'div', props: { style: { display: 'flex', alignItems: 'center', padding: '6px 18px', borderRadius: 999, fontSize: 24, fontWeight: 800, color: '#06060b', background: accent }, children: tier.label.toUpperCase() } },
			] } },
			{ type: 'div', props: { style: { display: 'flex', alignItems: 'baseline', gap: 24, marginTop: 18 }, children: [
				{ type: 'div', props: { style: { fontSize: 150, fontWeight: 900, lineHeight: 1, color: accent }, children: holder?.rank ? `#${holder.rank}` : '—' } },
				{ type: 'div', props: { style: { fontSize: 40, fontWeight: 600, color: 'rgba(235,235,245,0.55)' }, children: shortWallet(holder?.wallet) } },
			] } },
			{ type: 'div', props: { style: { display: 'flex', gap: 64, marginTop: 56 }, children: [
				statPill('Balance', `${fmtAmount(holder?.amount || 0)} $THREE`, accent),
				statPill('Value', usdValue || '—', accent),
				statPill('% of supply', holder?.pct != null ? `${(holder.pct * 100).toFixed(holder.pct < 0.001 ? 4 : 2)}%` : '—', accent),
				statPill('$THREE price', price || '—', accent),
			] } },
		] } },
	]);
}

function boardCard(ranked, market) {
	const accent = '#8b5cf6';
	const top = ranked.slice(0, 5);
	const price = fmtUsd(market?.price_usd);
	const mcap = fmtUsd(market?.market_cap);
	const holderCount = market?.holders != null ? Number(market.holders).toLocaleString('en-US') : (ranked.length ? ranked.length.toLocaleString('en-US') : '—');
	return baseShell(accent, [
		{ type: 'div', props: { style: { display: 'flex', flexDirection: 'column', padding: '60px 64px 0', flex: 1 }, children: [
			{ type: 'div', props: { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }, children: [
				{ type: 'div', props: { style: { display: 'flex', flexDirection: 'column', gap: 10 }, children: [
					{ type: 'div', props: { style: { fontSize: 24, fontWeight: 700, letterSpacing: '0.16em', color: 'rgba(235,235,245,0.5)' }, children: 'ON-CHAIN · LIVE' } },
					{ type: 'div', props: { style: { fontSize: 64, fontWeight: 900, color: '#f5f5fa' }, children: '$THREE Holders' } },
				] } },
				{ type: 'div', props: { style: { display: 'flex', gap: 40 }, children: [
					statPill('Price', price || '—', accent),
					statPill('Market cap', mcap || '—', accent),
					statPill('Holders', holderCount, accent),
				] } },
			] } },
			{ type: 'div', props: { style: { display: 'flex', flexDirection: 'column', marginTop: 40, gap: 12 }, children:
				top.length
					? top.map((h) => {
							const tier = tierForBalance(h.amount);
							return { type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: 24, padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }, children: [
								{ type: 'div', props: { style: { width: 64, fontSize: 36, fontWeight: 900, color: tier.accent }, children: `#${h.rank}` } },
								{ type: 'div', props: { style: { flex: 1, fontSize: 34, fontWeight: 600, color: 'rgba(235,235,245,0.85)' }, children: shortWallet(h.wallet) } },
								{ type: 'div', props: { style: { display: 'flex', alignItems: 'center', padding: '4px 14px', borderRadius: 999, fontSize: 22, fontWeight: 800, color: '#06060b', background: tier.accent }, children: tier.label } },
								{ type: 'div', props: { style: { width: 240, textAlign: 'right', fontSize: 34, fontWeight: 800, color: '#f5f5fa' }, children: `${fmtAmount(h.amount)}` } },
							] } };
						})
					: [{ type: 'div', props: { style: { fontSize: 34, color: 'rgba(235,235,245,0.45)', paddingTop: 30 }, children: 'Holder snapshot warming up — check back shortly.' } }],
			} },
		] } },
	]);
}

function imageResponse(node) {
	return new ImageResponse(node, {
		width: WIDTH,
		height: HEIGHT,
		headers: {
			'cache-control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
			'access-control-allow-origin': '*',
		},
	});
}

async function sendImage(res, response) {
	for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
	const ab = await response.arrayBuffer();
	res.statusCode = response.status;
	res.end(Buffer.from(ab));
}

export default async function handler(req, res) {
	if (req.method === 'OPTIONS') {
		res.setHeader('access-control-allow-origin', '*');
		res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
		res.statusCode = 204;
		res.end();
		return;
	}
	// A bare `res.end('method not allowed')` sent an untyped text body that
	// consumers sniffed as HTML; every other handler here answers a rejected
	// method with the shared JSON error shape.
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const wallet = (url.searchParams.get('wallet') || '').trim();
	const wantWallet = BASE58_RE.test(wallet) ? wallet : null;

	try {
		const { ranked, market } = await loadBoard();
		let node;
		if (wantWallet) {
			const found = ranked.find((h) => h.wallet === wantWallet) || { wallet: wantWallet, rank: null, amount: 0, pct: 0 };
			node = holderCard(found, market);
		} else {
			node = boardCard(ranked, market);
		}
		await sendImage(res, imageResponse(node));
	} catch (err) {
		console.error('[og-leaderboard]', err?.message || err);
		// Never break a crawler's preview: fall back to the static brand card.
		res.statusCode = 302;
		res.setHeader('location', 'https://three.ws/og-image.png');
		res.setHeader('cache-control', 'no-cache');
		res.end();
	}
}
