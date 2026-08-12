// GET /api/demo/coin/og?mint=<mint>&draw=<draw_id>
// 1200×630 PNG card for sharing a three.ws lottery + reflection draw outcome.
//
// Modes:
//   • ?mint + ?draw → winner card (drand round, winner wallet, pot amount)
//   • ?mint only    → state card (live pot, eligible holders, next draw eta)
//   • no params     → generic branding card
//
// Rendered via @vercel/og's ImageResponse. The node-runtime entry point is used
// (this file is a plain Vercel function, not an Edge function), so the worker
// runs inside the same lambda as other /api/demo/coin/* handlers.
//
// Caching: PNGs are deterministic for resolved draws (status ∈ {resolved, paid}),
// so we set a long-lived cache header for those. State-only cards are short-lived
// so they pick up new pot values.

import { ImageResponse } from '@vercel/og';

import { sql } from '../../_lib/db.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { setRateLimitHeaders, wrap } from '../../_lib/http.js';
import { loadCoinByMint, listActiveCoins } from '../../_lib/coin/index.js';

const WIDTH = 1200;
const HEIGHT = 630;

// Inlined design tokens — kept in sync with public/demo/coin/index.html.
const COLOR = {
	bg: '#0a0a0f',
	bgGradient: 'linear-gradient(135deg, #0a0a0f 0%, #14141c 60%, #1a1426 100%)',
	panel: '#14141c',
	border: '#1f1f29',
	muted: '#8a8a99',
	text: '#eee',
	textBright: '#fff',
	accent: '#6a5cff',
	accentLottery: '#ffba2e',
	accentReflection: '#6a5cff',
	demo: '#ffba2e',
};

function shortWallet(w) {
	if (!w) return '—';
	return `${w.slice(0, 6)}…${w.slice(-6)}`;
}

function lamportsToSolDisplay(v) {
	if (v == null) return '0';
	const big = typeof v === 'bigint' ? v : BigInt(String(v));
	const whole = big / 1_000_000_000n;
	const frac = big % 1_000_000_000n;
	const fracStr = frac.toString().padStart(9, '0').slice(0, 4).replace(/0+$/, '');
	return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}

async function resolveCoin(mint) {
	if (mint) return loadCoinByMint(mint);
	const list = await listActiveCoins();
	return list.length === 1 ? list[0] : null;
}

async function loadDraw(coinId, drawId) {
	if (!coinId || !drawId) return null;
	const [row] = await sql`
		select draw_id, drand_round, pot_lamports::text as pot,
		       winner_wallet, drand_randomness, status, created_at, paid_at
		from coin_draws
		where coin_id = ${coinId} and draw_id = ${drawId}
		limit 1
	`;
	return row || null;
}

function brandHeader(label) {
	return {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				alignItems: 'center',
				gap: 16,
				fontSize: 22,
				color: COLOR.muted,
				letterSpacing: 4,
				textTransform: 'uppercase',
				fontWeight: 600,
			},
			children: [
				{
					type: 'div',
					props: {
						style: {
							color: COLOR.text,
							fontWeight: 800,
							letterSpacing: 0,
							textTransform: 'none',
							fontSize: 26,
						},
						children: 'three.ws',
					},
				},
				{
					type: 'div',
					props: {
						style: {
							width: 6,
							height: 6,
							borderRadius: 3,
							background: COLOR.muted,
						},
						children: '',
					},
				},
				{ type: 'div', props: { children: label } },
				{
					type: 'div',
					props: {
						style: {
							marginLeft: 'auto',
							padding: '6px 14px',
							background: 'rgba(255,186,46,0.12)',
							border: '1px solid rgba(255,186,46,0.4)',
							color: COLOR.demo,
							borderRadius: 999,
							fontSize: 18,
							letterSpacing: 4,
							fontWeight: 700,
						},
						children: 'DEMO',
					},
				},
			],
		},
	};
}

function statCard({ label, value, sub, color }) {
	return {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				flexDirection: 'column',
				padding: '24px 28px',
				border: `1px solid ${COLOR.border}`,
				borderRadius: 14,
				background: COLOR.panel,
				gap: 8,
				minWidth: 320,
			},
			children: [
				{
					type: 'div',
					props: {
						style: {
							fontSize: 18,
							color: COLOR.muted,
							textTransform: 'uppercase',
							letterSpacing: 3,
							fontWeight: 600,
						},
						children: label,
					},
				},
				{
					type: 'div',
					props: {
						style: {
							fontSize: 56,
							color: color || COLOR.text,
							fontWeight: 800,
							lineHeight: 1.05,
						},
						children: value,
					},
				},
				sub
					? {
							type: 'div',
							props: {
								style: { fontSize: 20, color: COLOR.muted },
								children: sub,
							},
						}
					: null,
			].filter(Boolean),
		},
	};
}

function frame(children) {
	return {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				flexDirection: 'column',
				width: '100%',
				height: '100%',
				padding: 56,
				background: COLOR.bgGradient,
				color: COLOR.text,
				fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
			},
			children,
		},
	};
}

function winnerCard({ coin, draw }) {
	const headerLabel = draw.status === 'paid' ? 'Lottery payout' : 'Lottery winner';
	return frame([
		brandHeader(headerLabel),
		{
			type: 'div',
			props: {
				style: {
					display: 'flex',
					flexDirection: 'column',
					marginTop: 40,
					gap: 28,
				},
				children: [
					{
						type: 'div',
						props: {
							style: {
								fontSize: 90,
								fontWeight: 900,
								color: COLOR.textBright,
								lineHeight: 1.05,
								letterSpacing: -2,
							},
							children: `${lamportsToSolDisplay(draw.pot)} SOL`,
						},
					},
					{
						type: 'div',
						props: {
							style: {
								fontSize: 28,
								color: COLOR.muted,
							},
							children: `paid to ${shortWallet(draw.winner_wallet)} · ${coin.symbol}`,
						},
					},
				],
			},
		},
		{
			type: 'div',
			props: {
				style: {
					marginTop: 'auto',
					display: 'flex',
					gap: 20,
					alignItems: 'center',
				},
				children: [
					statCard({
						label: 'Drand round',
						value: `#${Number(draw.drand_round)}`,
						sub: 'verifiable randomness',
						color: COLOR.accent,
					}),
					statCard({
						label: 'Status',
						value: draw.status,
						sub: draw.paid_at ? new Date(draw.paid_at).toUTCString() : '',
						color: draw.status === 'paid' ? COLOR.accentLottery : COLOR.text,
					}),
				],
			},
		},
	]);
}

function stateCard({ coin, lottery, reflection, eligible }) {
	return frame([
		brandHeader(`Lottery + Reflection · ${coin.symbol}`),
		{
			type: 'div',
			props: {
				style: {
					display: 'flex',
					flexDirection: 'column',
					marginTop: 40,
					gap: 12,
				},
				children: [
					{
						type: 'div',
						props: {
							style: {
								fontSize: 36,
								color: COLOR.muted,
								fontWeight: 500,
							},
							children: 'Every holder is a ticket',
						},
					},
					{
						type: 'div',
						props: {
							style: {
								fontSize: 76,
								color: COLOR.textBright,
								fontWeight: 900,
								lineHeight: 1.05,
								letterSpacing: -2,
							},
							children: `${lamportsToSolDisplay(lottery)} SOL`,
						},
					},
					{
						type: 'div',
						props: {
							style: {
								fontSize: 26,
								color: COLOR.muted,
							},
							children: 'in the lottery pot, drawn hourly',
						},
					},
				],
			},
		},
		{
			type: 'div',
			props: {
				style: {
					marginTop: 'auto',
					display: 'flex',
					gap: 20,
				},
				children: [
					statCard({
						label: 'Reflection pot',
						value: `${lamportsToSolDisplay(reflection)} SOL`,
						sub: 'pro-rata to holders',
						color: COLOR.accentReflection,
					}),
					statCard({
						label: 'Eligible holders',
						value: String(eligible),
						sub: 'sharing every drip',
						color: COLOR.accentLottery,
					}),
				],
			},
		},
	]);
}

function brandCard() {
	return frame([
		brandHeader('Lottery + Reflection'),
		{
			type: 'div',
			props: {
				style: {
					display: 'flex',
					flexDirection: 'column',
					margin: 'auto 0',
					gap: 24,
				},
				children: [
					{
						type: 'div',
						props: {
							style: {
								fontSize: 96,
								color: COLOR.textBright,
								fontWeight: 900,
								letterSpacing: -2,
								lineHeight: 1.0,
							},
							children: 'Every holder',
						},
					},
					{
						type: 'div',
						props: {
							style: {
								fontSize: 96,
								color: COLOR.accent,
								fontWeight: 900,
								letterSpacing: -2,
								lineHeight: 1.0,
							},
							children: 'is a ticket.',
						},
					},
					{
						type: 'div',
						props: {
							style: { fontSize: 32, color: COLOR.muted, marginTop: 16 },
							children: 'Hourly lottery + passive SOL reflection · three.ws',
						},
					},
				],
			},
		},
	]);
}

function imageResponseFor(node, { immutable }) {
	const cacheControl = immutable
		? 'public, max-age=31536000, s-maxage=31536000, immutable'
		: 'public, max-age=30, s-maxage=30, stale-while-revalidate=600';
	return new ImageResponse(node, {
		width: WIDTH,
		height: HEIGHT,
		headers: { 'cache-control': cacheControl },
	});
}

async function sendImageResponse(res, imageResponse) {
	// Convert Web Response → Node ServerResponse. Render the body FIRST: satori can
	// throw mid-render, and once headers are on the wire the fallback card below can
	// no longer be substituted (ERR_HTTP_HEADERS_SENT). Buffering first keeps the
	// failure recoverable.
	const ab = await imageResponse.arrayBuffer();
	if (res.headersSent || res.writableEnded) {
		if (!res.writableEnded) res.end();
		return;
	}
	for (const [key, value] of imageResponse.headers.entries()) {
		res.setHeader(key, value);
	}
	res.statusCode = imageResponse.status;
	res.end(Buffer.from(ab));
}

export default wrap(async (req, res) => {
	// CORS for cross-origin embeds (Discord, X, etc. fetch OG images server-side
	// but a permissive header doesn't hurt and makes browser-side <img> tags work).
	if (req.method === 'OPTIONS') {
		res.setHeader('access-control-allow-origin', '*');
		res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
		res.statusCode = 204;
		res.end();
		return;
	}
	if (req.method !== 'GET') {
		res.statusCode = 405;
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ error: 'method_not_allowed' }));
		return;
	}

	// Share-card endpoints are hammered by social-card scrapers (Twitter, Slack,
	// Discord, iMessage, every preview crawler). Keep the same 60/min/IP budget
	// as the JSON endpoints so a misbehaving scraper can't OOM the function or
	// burn through downstream RPC.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) {
		const retryAfter = Math.max(1, setRateLimitHeaders(res, rl));
		res.statusCode = 429;
		res.setHeader('retry-after', String(retryAfter));
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ error: 'rate_limited', limit: rl.limit, reset: rl.reset }));
		return;
	}

	const url = new URL(req.url, 'http://x');
	const mint = url.searchParams.get('mint') || undefined;
	const drawId = url.searchParams.get('draw') || undefined;

	try {
		// resolveCoin already handles both cases (explicit mint, or the single-active-coin
		// default) and returns null when neither resolves, so it is the whole condition.
		const coin = await resolveCoin(mint);
		if (!coin) {
			return sendImageResponse(res, imageResponseFor(brandCard(), { immutable: false }));
		}

		if (drawId) {
			const draw = await loadDraw(coin.id, drawId);
			if (!draw || !draw.winner_wallet) {
				return sendImageResponse(
					res,
					imageResponseFor(brandCard(), { immutable: false }),
				);
			}
			const immutable = draw.status === 'paid';
			return sendImageResponse(res, imageResponseFor(winnerCard({ coin, draw }), { immutable }));
		}

		const [agg] = await sql`
			select count(*) filter (where balance > ${coin.min_holder_balance}::bigint) as eligible
			from coin_holders where coin_id = ${coin.id}
		`;
		const eligible = Number(agg?.eligible || 0);
		return sendImageResponse(
			res,
			imageResponseFor(
				stateCard({
					coin,
					lottery: coin.lottery_pot_lamports,
					reflection: coin.reflection_pot_lamports,
					eligible,
				}),
				{ immutable: false },
			),
		);
	} catch (err) {
		// Never let an OG image fail open — fall back to the brand card so
		// share previews still look intentional rather than broken-image grey.
		console.error('[og] render failed:', err?.message || err);
		await sendImageResponse(res, imageResponseFor(brandCard(), { immutable: false }));
	}
});
