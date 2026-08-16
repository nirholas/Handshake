/**
 * GET /api/trader-og?agent_id=<uuid>          — three.ws agent card
 * GET /api/trader-og?wallet=<base58>          — claimed/external wallet card
 * (a base58 value in agent_id is treated as a wallet, matching the
 *  /trader/<id>/share rewrite which passes either kind of id)
 *
 * Dynamic OG image for /trader/<id>/share — provable track record social card.
 * SVG 1200×630. Agent cards read agent_sniper_positions; wallet cards read the
 * Oracle wallet_reputation ledger + pump_coin_wallets aggregates, so every
 * shared trader link — agent or claimed wallet — previews with real data.
 *
 * Card anatomy (1200×630, dark):
 *   top        — three.ws wordmark + "proof.not.promises"
 *   left       — agent avatar circle (120×120)
 *   center     — agent name (large), handle hint
 *   score arc  — SVG arc gauge showing composite score
 *   metrics    — Win rate, Realized P&L, Trades closed, Best trade
 *   footer     — "Provable track record · three.ws"
 */

import { cors, wrap } from './_lib/http.js';
import { sql } from './_lib/db.js';
import { isUuid } from './_lib/validate.js';
import { fetchOgImage } from './_lib/og-avatar.js';
import { env } from './_lib/env.js';

const LAMPORTS  = 1e9;
const CACHE     = 'public, max-age=120, s-maxage=900, stale-while-revalidate=60';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** wallet_reputation stores win_rate as a 0–1 fraction; normalize to 0–100. */
function pct(v) {
	if (v == null) return null;
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return Math.round(n <= 1 ? n * 100 : n);
}

function x(s) {
	return String(s || '')
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function trunc(s, n) {
	s = String(s || '');
	return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;

	const url         = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const agentId     = (url.searchParams.get('agent_id') || '').trim();
	const walletParam = (url.searchParams.get('wallet') || '').trim();
	const origin      = env.APP_ORIGIN || 'https://three.ws';
	const wallet      = BASE58_RE.test(walletParam) ? walletParam
		: (!isUuid(agentId) && BASE58_RE.test(agentId)) ? agentId
		: '';

	if (!isUuid(agentId) && !wallet) {
		return fallback(res, origin);
	}

	// Unified card shape, filled by whichever identity we were given.
	let name, subtitle, initial, avatarUrl = null, footerPath;
	let total, winRate, pnlSol, bestPct, gaugeVal, gaugeLabel, totalLabel;

	if (wallet) {
		let rep, agg;
		try {
			[rep] = await sql`
				select coins_traded, wins, win_rate, smart_money_score, label
				from wallet_reputation
				where wallet = ${wallet} and network = 'mainnet'
				limit 1
			`;
			[agg] = await sql`
				select
					sum(sell_lamports - buy_lamports)                                   as pnl_lam,
					max(case when buy_lamports > 0
						then (sell_lamports - buy_lamports) * 100.0 / buy_lamports end) as best_pct
				from pump_coin_wallets
				where wallet = ${wallet}
			`;
		} catch {
			return fallback(res, origin);
		}
		if (!rep) return fallback(res, origin);

		name       = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
		initial    = wallet[0].toUpperCase();
		total      = Number(rep.coins_traded || 0);
		winRate    = pct(rep.win_rate);
		gaugeVal   = rep.smart_money_score != null ? Math.round(Number(rep.smart_money_score)) : null;
		gaugeLabel = 'SMART SCORE';
		totalLabel = 'COINS TRADED';
		pnlSol     = agg?.pnl_lam != null ? Number(agg.pnl_lam) / LAMPORTS : null;
		bestPct    = agg?.best_pct != null ? Number(agg.best_pct) : null;
		subtitle   = `Claimed Solana wallet · ${rep.label ? String(rep.label).replace(/_/g, ' ') : 'trader'} · ${total || '—'} coins traded`;
		footerPath = 'three.ws/claim-wallet';
	} else {
		let agent, stats;
		try {
			[agent] = await sql`
				select id, name, profile_image_url, avatar_url
				from agent_identities
				where id = ${agentId} and deleted_at is null
				limit 1
			`;
			if (!agent) return fallback(res, origin);

			[stats] = await sql`
				select
					count(*) filter (where status = 'closed')                           as total,
					count(*) filter (where status = 'closed' and realized_pnl_pct >= 0) as wins,
					sum(realized_pnl_lamports) filter (where status = 'closed')         as pnl_lam,
					max(realized_pnl_pct)                                               as best_pct,
					avg(realized_pnl_pct) filter (where status = 'closed')              as avg_pct
				from agent_sniper_positions
				where agent_id = ${agentId} and network = 'mainnet'
			`;
		} catch {
			return fallback(res, origin);
		}

		name       = trunc(agent.name || 'Agent', 28);
		initial    = (agent.name || 'A')[0].toUpperCase();
		avatarUrl  = agent.profile_image_url || agent.avatar_url;
		total      = Number(stats?.total || 0);
		const wins = Number(stats?.wins || 0);
		winRate    = total > 0 ? Math.round((wins / total) * 100) : null;
		gaugeVal   = winRate;
		gaugeLabel = 'WIN RATE';
		totalLabel = 'CLOSED TRADES';
		pnlSol     = stats?.pnl_lam != null ? Number(BigInt(stats.pnl_lam)) / LAMPORTS : null;
		bestPct    = stats?.best_pct != null ? Number(stats.best_pct) : null;
		subtitle   = `Provable pump.fun track record · ${total > 0 ? total : '—'} trades closed`;
		footerPath = 'three.ws/leaderboard';
	}

	const winRateStr = winRate != null ? `${winRate}%` : '—';
	const pnlStr     = pnlSol   != null
		? (pnlSol >= 0 ? `+${pnlSol.toFixed(2)}` : pnlSol.toFixed(2)) + ' SOL'
		: '—';
	const bestStr    = bestPct  != null ? `+${Math.round(bestPct)}%` : '—';
	const totalStr   = total > 0 ? String(total) : '—';
	const gaugeStr   = gaugeVal != null
		? (gaugeLabel === 'WIN RATE' ? `${gaugeVal}%` : String(gaugeVal))
		: '—';

	const scoreColor = winRate == null ? '#94a3b8'
		: winRate >= 60 ? '#34d399'
		: winRate >= 45 ? '#fbbf24'
		: '#f87171';

	// SVG gauge arc: 140° sweep, radius 52, center 156,180
	const arcScore = gaugeVal ?? 0;
	const ARC_START_DEG = -200;
	const ARC_SWEEP_DEG = 220;
	const r = 52;
	const cx = 156, cy = 182;
	function polarPt(deg, radius) {
		const rad = (deg - 90) * Math.PI / 180;
		return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
	}
	const s0 = polarPt(ARC_START_DEG, r);
	const s1 = polarPt(ARC_START_DEG + ARC_SWEEP_DEG, r);
	const frac = Math.max(0, Math.min(100, arcScore)) / 100;
	const sweepAngle = ARC_SWEEP_DEG * frac;
	const s2 = polarPt(ARC_START_DEG + sweepAngle, r);
	const largeArcTrack = 1;
	const largeArcFill  = sweepAngle > 180 ? 1 : 0;

	// Inline the portrait so the card is self-contained. A dead, slow, or
	// oversized host degrades to the monogram below (see _lib/og-avatar.js).
	const avatarData = await fetchOgImage(avatarUrl);

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
		width="1200" height="630" viewBox="0 0 1200 630">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#0f0f13"/>
			<stop offset="1" stop-color="#0a0a0e"/>
		</linearGradient>
		<linearGradient id="gfill" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="${x(scoreColor)}" stop-opacity=".7"/>
			<stop offset="1" stop-color="${x(scoreColor)}"/>
		</linearGradient>
		${avatarData ? `<clipPath id="avClip"><circle cx="${cx}" cy="72" r="44"/></clipPath>` : ''}
	</defs>

	<!-- background -->
	<rect width="1200" height="630" fill="url(#bg)"/>
	<rect x="0" y="0" width="4" height="630" fill="${x(scoreColor)}" opacity=".6"/>

	<!-- top bar -->
	<text x="24" y="34" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="600"
		letter-spacing=".12em" fill="#6b7280" text-anchor="start">THREE.WS · ORACLE</text>
	<text x="1176" y="34" font-family="Inter,system-ui,sans-serif" font-size="12" font-weight="500"
		fill="#4b5563" text-anchor="end">proof.not.promises</text>

	<!-- divider -->
	<line x1="24" y1="48" x2="1176" y2="48" stroke="#1f2937" stroke-width="1"/>

	<!-- avatar -->
	${avatarData
		? `<image href="data:${avatarData.ct};base64,${avatarData.b64}"
			x="${cx - 44}" y="28" width="88" height="88" clip-path="url(#avClip)"/>`
		: `<circle cx="${cx}" cy="72" r="44" fill="#1e293b"/>
		   <text x="${cx}" y="80" text-anchor="middle" font-family="Inter,system-ui,sans-serif"
			font-size="36" font-weight="700" fill="#374151">${x(initial)}</text>`}
	<circle cx="${cx}" cy="72" r="44" fill="none" stroke="${x(scoreColor)}" stroke-width="2" opacity=".5"/>

	<!-- score arc track -->
	<path d="M ${s0.x.toFixed(1)} ${s0.y.toFixed(1)} A ${r} ${r} 0 ${largeArcTrack} 1 ${s1.x.toFixed(1)} ${s1.y.toFixed(1)}"
		fill="none" stroke="#1f2937" stroke-width="7" stroke-linecap="round"/>
	${frac > 0
		? `<path d="M ${s0.x.toFixed(1)} ${s0.y.toFixed(1)} A ${r} ${r} 0 ${largeArcFill} 1 ${s2.x.toFixed(1)} ${s2.y.toFixed(1)}"
			fill="none" stroke="url(#gfill)" stroke-width="7" stroke-linecap="round"/>`
		: ''}
	<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-family="Inter,system-ui,sans-serif"
		font-size="28" font-weight="800" fill="${x(scoreColor)}">${x(gaugeStr)}</text>
	<text x="${cx}" y="${cy + 10}" text-anchor="middle" font-family="Inter,system-ui,sans-serif"
		font-size="10" font-weight="600" fill="#6b7280" letter-spacing=".1em">${x(gaugeLabel)}</text>

	<!-- agent name -->
	<text x="308" y="116" font-family="Inter,system-ui,sans-serif" font-size="44" font-weight="800"
		fill="#f9fafb">${x(name)}</text>
	<text x="308" y="146" font-family="Inter,system-ui,sans-serif" font-size="15" fill="#6b7280">
		${x(subtitle)}
	</text>

	<!-- metric cards -->
	${metricCard(308, 188, 'REALIZED P&amp;L', pnlStr, pnlSol != null && pnlSol >= 0 ? '#34d399' : pnlSol != null ? '#f87171' : '#6b7280')}
	${metricCard(568, 188, 'WIN RATE', winRateStr, scoreColor)}
	${metricCard(828, 188, totalLabel, totalStr, '#94a3b8')}
	${metricCard(1048, 188, 'BEST TRADE', bestStr, '#c084fc')}

	<!-- separator -->
	<line x1="24" y1="282" x2="1176" y2="282" stroke="#1f2937" stroke-width="1"/>

	<!-- the standing claim under every number on this card -->
	<text x="308" y="316" font-family="Inter,system-ui,sans-serif" font-size="14" fill="#374151">
		Every number is traceable to its on-chain transaction.
	</text>

	<!-- footer -->
	<rect x="0" y="594" width="1200" height="36" fill="#070709"/>
	<text x="24" y="618" font-family="Inter,system-ui,sans-serif" font-size="12" fill="#374151"
		letter-spacing=".08em">PROVABLE TRACK RECORD</text>
	<text x="1176" y="618" font-family="Inter,system-ui,sans-serif" font-size="12" fill="#374151"
		text-anchor="end">${x(footerPath)}</text>
</svg>`;

	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(svg);
});

function metricCard(x0, y0, label, value, color) {
	return `<g>
		<rect x="${x0}" y="${y0}" width="220" height="80" rx="8"
			fill="#0f1117" stroke="#1f2937" stroke-width="1"/>
		<text x="${x0 + 14}" y="${y0 + 22}" font-family="Inter,system-ui,sans-serif"
			font-size="9" font-weight="600" letter-spacing=".1em" fill="#4b5563">${label}</text>
		<text x="${x0 + 14}" y="${y0 + 55}" font-family="Inter,system-ui,sans-serif"
			font-size="26" font-weight="800" fill="${color}">${value}</text>
	</g>`;
}

function fallback(res, origin) {
	res.statusCode = 302;
	res.setHeader('location', `${origin}/og-image.png`);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}
