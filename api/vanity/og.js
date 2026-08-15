// api/vanity/og.js — dynamic 1200×630 PNG rarity share card for a ground vanity
// address. Real ImageResponse (@vercel/og) on the Node runtime — the same proven
// path as api/og-leaderboard.js — because X/Facebook/LinkedIn/iMessage do not
// preview SVG cards.
//
//   /api/vanity/og?address=<base58>
//     Renders the address's rarity tier, score, the highlighted pattern, and the
//     honest expected-attempts. Prefers the PUBLISHED gallery entry (provably-fair,
//     receipt-bound); if the address isn't published, falls back to an honest
//     APPRAISAL of the address so any address still gets a card. The card states
//     which mode it is so an appraisal is never passed off as a verified grind.
//
// No secrets are read or rendered — only the public address + rarity math.

import { ImageResponse } from '@vercel/og';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getEntry } from '../_lib/vanity-gallery-store.js';
import { appraiseAddress, RARITY_TIERS } from '../../src/solana/vanity/rarity.js';

const WIDTH = 1200;
const HEIGHT = 630;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function tierMeta(id) {
	return RARITY_TIERS.find((t) => t.id === id) || RARITY_TIERS[RARITY_TIERS.length - 1];
}

function fmtAttempts(n) {
	const v = Number(n) || 0;
	if (v >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
	if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
	if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
	if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
	return v.toLocaleString('en-US');
}

// Render the address with prefix + suffix highlighted in the tier accent.
function addressNode(address, pattern, accent) {
	const pre = pattern?.prefix || '';
	const suf = pattern?.suffix || '';
	const preLen = pre && address.startsWith(pre) ? pre.length : 0;
	const sufLen = suf && address.endsWith(suf) ? suf.length : 0;
	const head = address.slice(0, preLen);
	const midStart = preLen;
	const midEnd = address.length - sufLen;
	const mid = address.slice(midStart, midEnd);
	const tail = sufLen ? address.slice(midEnd) : '';
	const seg = (text, color, weight) => ({ type: 'span', props: { style: { color, fontWeight: weight }, children: text } });
	return {
		type: 'div',
		props: {
			style: {
				display: 'flex', flexWrap: 'wrap', fontFamily: 'monospace', fontSize: 34,
				letterSpacing: '0.01em', lineHeight: 1.25, color: 'rgba(235,235,245,0.5)', fontWeight: 600,
			},
			children: [
				head ? seg(head, accent, 800) : null,
				seg(mid, 'rgba(235,235,245,0.5)', 600),
				tail ? seg(tail, accent, 800) : null,
			].filter(Boolean),
		},
	};
}

function statPill(label, value, accent) {
	return {
		type: 'div',
		props: {
			style: { display: 'flex', flexDirection: 'column', gap: 4 },
			children: [
				{ type: 'div', props: { style: { fontSize: 20, color: 'rgba(235,235,245,0.45)', letterSpacing: '0.05em', textTransform: 'uppercase' }, children: label } },
				{ type: 'div', props: { style: { fontSize: 40, fontWeight: 800, color: accent }, children: value } },
			],
		},
	};
}

function card({ address, pattern, tier, rarityScore, expectedAttempts, mode }) {
	const t = tierMeta(tier);
	const accent = t.accent;
	const patternLabel = [pattern?.prefix && `${pattern.prefix}…`, pattern?.suffix && `…${pattern.suffix}`].filter(Boolean).join(' ') || 'no fixed pattern';
	const verifiedBadge = mode === 'verified';
	return {
		type: 'div',
		props: {
			style: {
				width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
				position: 'relative', background: '#06060b', color: '#f5f5fa',
				fontFamily: 'ui-sans-serif, system-ui, sans-serif',
			},
			children: [
				{ type: 'div', props: { style: { position: 'absolute', top: 0, right: 0, width: 640, height: 640, background: `radial-gradient(circle at 100% 0%, ${accent}40, transparent 70%)`, display: 'flex' } } },
				{ type: 'div', props: { style: { position: 'absolute', top: 0, left: 0, width: 8, height: '100%', background: accent, display: 'flex' } } },
				{ type: 'div', props: { style: { display: 'flex', flexDirection: 'column', padding: '60px 64px 0', flex: 1 }, children: [
					{ type: 'div', props: { style: { display: 'flex', alignItems: 'center', gap: 18, marginBottom: 6 }, children: [
						{ type: 'div', props: { style: { fontSize: 22, fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(235,235,245,0.5)' }, children: 'GROUND ON THREE.WS' } },
						verifiedBadge
							? { type: 'div', props: { style: { display: 'flex', alignItems: 'center', padding: '5px 16px', borderRadius: 999, fontSize: 20, fontWeight: 800, color: '#06060b', background: '#4ade80' }, children: '✓ VERIFIED' } }
							: { type: 'div', props: { style: { display: 'flex', alignItems: 'center', padding: '5px 16px', borderRadius: 999, fontSize: 20, fontWeight: 700, color: 'rgba(235,235,245,0.6)', border: '1px solid rgba(235,235,245,0.25)' }, children: 'APPRAISAL' } },
					] } },
					{ type: 'div', props: { style: { display: 'flex', alignItems: 'baseline', gap: 24, marginTop: 10 }, children: [
						{ type: 'div', props: { style: { fontSize: 116, fontWeight: 900, lineHeight: 1, color: accent }, children: t.label } },
					] } },
					{ type: 'div', props: { style: { display: 'flex', marginTop: 30, marginBottom: 8 }, children: [addressNode(address, pattern, accent)] } },
					{ type: 'div', props: { style: { display: 'flex', gap: 64, marginTop: 'auto', marginBottom: 92 }, children: [
						statPill('Rarity score', String(rarityScore), accent),
						statPill('Pattern', patternLabel, accent),
						statPill('Expected work', `${fmtAttempts(expectedAttempts)} tries`, accent),
					] } },
				] } },
				{ type: 'div', props: { style: {
					position: 'absolute', left: 0, right: 0, bottom: 0, height: 56,
					display: 'flex', alignItems: 'center', justifyContent: 'space-between',
					padding: '0 64px', background: '#030305', borderTop: '1px solid rgba(255,255,255,0.06)',
				}, children: [
					{ type: 'div', props: { style: { display: 'flex', alignItems: 'center', fontSize: 20, fontWeight: 700, color: 'rgba(235,235,245,0.55)', letterSpacing: '0.04em' }, children: [
						{ type: 'div', props: { style: { width: 10, height: 10, borderRadius: 10, background: accent, marginRight: 14 } } },
						{ type: 'div', props: { children: 'PROOF-OF-GRIND · PROVABLY-FAIR VANITY' } },
					] } },
					{ type: 'div', props: { style: { fontSize: 20, fontWeight: 600, color: 'rgba(235,235,245,0.35)' }, children: 'three.ws/vanity/gallery' } },
				] } },
			],
		},
	};
}

async function loadCardData(address) {
	const published = await getEntry(address).catch(() => null);
	if (published) {
		return {
			address,
			pattern: published.pattern,
			tier: published.tier,
			rarityScore: published.rarityScore,
			expectedAttempts: published.expectedAttempts,
			bonuses: published.bonuses || [],
			mode: 'verified',
		};
	}
	const a = appraiseAddress(address);
	return {
		address,
		pattern: { prefix: a.prefix, suffix: a.suffix, ignoreCase: a.ignoreCase },
		tier: a.tier,
		rarityScore: a.rarityScore,
		expectedAttempts: a.expectedAttempts,
		bonuses: a.bonuses || [],
		mode: 'appraisal',
	};
}

export default async function handler(req, res) {
	if (req.method === 'OPTIONS') {
		res.setHeader('access-control-allow-origin', '*');
		res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
		res.statusCode = 204;
		res.end();
		return;
	}
	if (req.method !== 'GET') {
		res.statusCode = 405;
		res.setHeader('allow', 'GET, OPTIONS');
		res.end('method not allowed');
		return;
	}

	// Each card is a store read plus a real PNG render, and the CDN only absorbs
	// repeats of the SAME address, so a walk over made-up addresses would render one
	// image per request. Cap it per IP. On the cap we fall back to the static share
	// image rather than a 429 body: a crawler that got a card is what matters, and
	// no-cache means the next request renders the real one.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return fallbackCard(res);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const address = (url.searchParams.get('address') || '').trim();
	if (!BASE58_RE.test(address)) return fallbackCard(res);

	try {
		const data = await loadCardData(address);
		const img = new ImageResponse(card(data), {
			width: WIDTH,
			height: HEIGHT,
			headers: {
				'cache-control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
				'access-control-allow-origin': '*',
			},
		});
		for (const [k, v] of img.headers.entries()) res.setHeader(k, v);
		const ab = await img.arrayBuffer();
		res.statusCode = img.status;
		res.end(Buffer.from(ab));
	} catch (err) {
		console.error('[vanity/og]', err?.message || err);
		fallbackCard(res);
	}
}

// Every path that cannot render a real card sends the crawler to the static site
// share image, uncached so the next attempt re-renders.
function fallbackCard(res) {
	res.statusCode = 302;
	res.setHeader('location', 'https://three.ws/og-image.png');
	res.setHeader('cache-control', 'no-cache');
	res.end();
}
