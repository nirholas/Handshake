/**
 * GET /api/arena-og?id=<tournament uuid>
 *
 * The Arena's share card. SVG 1200x630, rendered from the live standings, so the
 * picture that unfurls on X is the same board the linked page is showing.
 *
 * Why this exists as its own card: a tournament link used to unfurl the generic
 * page-og strip, which says the route's name and nothing about the competition.
 * The thing worth posting about a live board is the board: who is on the podium,
 * by how much, and how long is left. That is the artifact people screenshot in
 * this category, and a link that reproduces it is a link worth sharing.
 *
 * Card anatomy (1200x630, dark):
 *   top      three.ws wordmark + LIVE / FINAL / OPENS state stamp
 *   left     tournament name, window label, entrant and trade counts
 *   podium   top three agents: place, name, in-window P&L, trade count
 *   footer   "every row verifiable on solscan" + the deep link
 *
 * A losing board renders exactly like a winning one, only red. Nothing here
 * hides a red podium: the Arena ranks on realized P&L and a day where every
 * agent finished down is a real result, not one to be dressed up.
 */

import { cors, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { getTournament, listEntries, derivedStatus } from './_lib/tournament-store.js';
import { loadStandings } from './_lib/tournament-engine.js';

const CACHE = 'public, max-age=60, s-maxage=120, stale-while-revalidate=600';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POS = '#34d399';
const NEG = '#f87171';
const FLAT = '#94a3b8';

function x(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function trunc(s, n) {
	const v = String(s ?? '');
	return v.length <= n ? v : v.slice(0, n - 1) + '…';
}

/** Shrink the title as it lengthens so a long tournament name never overflows. */
export function titleSize(text) {
	const len = String(text || '').length;
	if (len <= 18) return 58;
	if (len <= 26) return 48;
	if (len <= 34) return 40;
	return 34;
}

export function fmtSol(n) {
	if (n == null || !Number.isFinite(Number(n))) return 'n/a';
	const v = Number(n);
	const digits = v !== 0 && Math.abs(v) < 1 ? 3 : 2;
	return `${v > 0 ? '+' : ''}${v.toFixed(digits)} SOL`;
}

/** Human window label: how long is left, or how long it ran. */
export function windowLabel(t, status, now) {
	const end = new Date(t.ends_at).getTime();
	const start = new Date(t.starts_at).getTime();
	if (status === 'upcoming' || status === 'draft') return `Opens ${relative(start - now)}`;
	if (status === 'live') return `Closes in ${duration(Math.max(0, end - now))}`;
	return `Window closed ${relative(end - now)}`;
}

function duration(ms) {
	const m = Math.floor(ms / 60000);
	const hrs = Math.floor(m / 60);
	if (hrs >= 24) return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
	if (hrs >= 1) return `${hrs}h ${m % 60}m`;
	return `${m}m`;
}

function relative(deltaMs) {
	const label = duration(Math.abs(deltaMs));
	return deltaMs > 0 ? `in ${label}` : `${label} ago`;
}

export function stateStamp(status) {
	if (status === 'live') return { label: 'LIVE · MAINNET ON-CHAIN', color: POS };
	if (status === 'upcoming' || status === 'draft') return { label: 'ENTRIES OPEN', color: '#fbbf24' };
	if (status === 'cancelled') return { label: 'CANCELLED', color: FLAT };
	return { label: 'FINAL STANDINGS', color: '#a78bfa' };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const id = (url.searchParams.get('id') || '').trim();
	if (!UUID_RE.test(id)) return fallback(res);

	const tournament = await getTournament(id).catch(() => null);
	if (!tournament) return fallback(res);

	const now = Date.now();
	const status = derivedStatus(tournament, now);

	// Finished boards read their frozen result; live ones recompute. Both go
	// through the same standings layer, so the card can never disagree with the
	// page or with what was attested on-chain.
	let standings = [];
	let entrants = 0;
	try {
		const view = await loadStandings(tournament, { now });
		standings = view.standings || [];
		entrants = standings.length;
	} catch {
		entrants = await listEntries(id)
			.then((rows) => rows.filter((r) => r.status !== 'withdrawn').length)
			.catch(() => 0);
	}

	const podium = standings.filter((s) => s.rank != null).slice(0, 3);
	const trades = standings.reduce((a, s) => a + (s.metrics?.closed_count ?? s.in_window_trades ?? 0), 0);
	const stamp = stateStamp(status);
	const tSize = titleSize(tournament.name);
	const decimals = env.THREE_TOKEN_DECIMALS;
	const pool = poolToThree(tournament.prize_pool_three, decimals);

	const rows = podium.length
		? podium.map((s, i) => podiumRow(s, i)).join('\n\t')
		: `<text x="72" y="392" font-family="Inter,system-ui,sans-serif" font-size="22" fill="#4b5563">${
				status === 'live'
					? 'No ranked trades yet. First closed position takes the lead.'
					: 'No ranked entrants on this board.'
			}</text>`;

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${x(
		tournament.name,
	)} standings">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#0f0f13"/>
			<stop offset="1" stop-color="#08080b"/>
		</linearGradient>
		<radialGradient id="glow" cx="0.78" cy="0.2" r="0.7">
			<stop offset="0" stop-color="${x(stamp.color)}" stop-opacity=".14"/>
			<stop offset="1" stop-color="${x(stamp.color)}" stop-opacity="0"/>
		</radialGradient>
	</defs>

	<rect width="1200" height="630" fill="url(#bg)"/>
	<rect width="1200" height="630" fill="url(#glow)"/>
	<rect x="0" y="0" width="6" height="630" fill="${x(stamp.color)}" opacity=".75"/>

	<text x="72" y="62" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700"
		letter-spacing=".14em" fill="#6b7280">THREE.WS &#183; THE ARENA</text>
	<text x="1128" y="62" font-family="Inter,system-ui,sans-serif" font-size="12" font-weight="700"
		letter-spacing=".1em" fill="${x(stamp.color)}" text-anchor="end">${x(stamp.label)}</text>
	<line x1="72" y1="80" x2="1128" y2="80" stroke="#1f2937" stroke-width="1"/>

	<text x="72" y="${118 + tSize * 0.4}" font-family="Inter,system-ui,sans-serif" font-size="${tSize}"
		font-weight="900" fill="#f9fafb">${x(trunc(tournament.name, 44))}</text>
	<text x="72" y="196" font-family="Inter,system-ui,sans-serif" font-size="17" fill="#6b7280">${x(
		windowLabel(tournament, status, now),
	)} &#183; ranked on realized P&amp;L from trades opened inside the window</text>

	${metric(72, 226, 'AGENTS', String(entrants), '#e5e7eb')}
	${metric(302, 226, 'TRADES IN WINDOW', trades.toLocaleString(), '#e5e7eb')}
	${metric(532, 226, 'PRIZE POOL', pool > 0 ? `${fmtThree(pool)} $THREE` : 'Bragging rights', pool > 0 ? '#fbbf24' : '#94a3b8')}

	${rows}

	<rect x="0" y="566" width="1200" height="64" fill="#050507"/>
	<text x="72" y="605" font-family="Inter,system-ui,sans-serif" font-size="14" fill="#4b5563"
		letter-spacing=".06em">EVERY ROW VERIFIABLE ON SOLSCAN</text>
	<text x="1128" y="605" font-family="Inter,system-ui,sans-serif" font-size="14" font-weight="600"
		fill="#6b7280" text-anchor="end">three.ws/arena</text>
</svg>`;

	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(svg);
});

const MEDALS = ['1st', '2nd', '3rd'];

/**
 * One podium row, on a fixed 72px rhythm from y=342, so three rows finish at 546
 * and clear the 566 footer bar rather than tucking under it.
 */
function podiumRow(s, i) {
	const y = 342 + i * 72;
	const pnl = s.metrics?.realized_pnl_sol;
	const color = pnl > 0 ? POS : pnl < 0 ? NEG : FLAT;
	const closed = s.metrics?.closed_count ?? s.in_window_trades ?? 0;
	return `<g>
		<rect x="72" y="${y}" width="1056" height="62" rx="12" fill="#0e1015" stroke="${
			i === 0 ? '#334155' : '#1f2937'
		}" stroke-width="1"/>
		<text x="96" y="${y + 39}" font-family="Inter,system-ui,sans-serif" font-size="18" font-weight="800"
			fill="${i === 0 ? '#fbbf24' : '#6b7280'}">${x(MEDALS[i] || `#${s.rank}`)}</text>
		<text x="168" y="${y + 39}" font-family="Inter,system-ui,sans-serif" font-size="26" font-weight="700"
			fill="#f9fafb">${x(trunc(s.agent_name || 'Agent', 28))}</text>
		<text x="760" y="${y + 39}" font-family="Inter,system-ui,sans-serif" font-size="17"
			fill="#4b5563" text-anchor="end">${closed} trade${closed === 1 ? '' : 's'}</text>
		<text x="1104" y="${y + 40}" font-family="Inter,system-ui,sans-serif" font-size="28" font-weight="800"
			fill="${x(color)}" text-anchor="end">${x(fmtSol(pnl))}</text>
	</g>`;
}

function metric(x0, y0, label, value, color) {
	return `<g>
		<rect x="${x0}" y="${y0}" width="210" height="82" rx="10" fill="#0e1015" stroke="#1f2937" stroke-width="1"/>
		<text x="${x0 + 16}" y="${y0 + 26}" font-family="Inter,system-ui,sans-serif" font-size="10"
			font-weight="700" letter-spacing=".12em" fill="#4b5563">${x(label)}</text>
		<text x="${x0 + 16}" y="${y0 + 62}" font-family="Inter,system-ui,sans-serif" font-size="${
			String(value).length > 12 ? 19 : 25
		}" font-weight="800" fill="${x(color)}">${x(value)}</text>
	</g>`;
}

export function poolToThree(atomics, decimals) {
	try {
		const a = BigInt(atomics || 0);
		if (a === 0n) return 0;
		const div = 10n ** BigInt(decimals);
		return Number(`${a / div}.${(a % div).toString().padStart(decimals, '0')}`);
	} catch {
		return 0;
	}
}

export function fmtThree(v) {
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
	if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
	return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Unfurl-safe fallback. A bad id or a missing tournament still has to return an
 * image: an unfurl that 404s renders as a broken card on every client, which is
 * worse than a plain branded one.
 */
function fallback(res) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="The Arena">
	<rect width="1200" height="630" fill="#0b0b0f"/>
	<rect x="0" y="0" width="6" height="630" fill="#34d399" opacity=".7"/>
	<text x="72" y="62" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700"
		letter-spacing=".14em" fill="#6b7280">THREE.WS &#183; THE ARENA</text>
	<text x="72" y="316" font-family="Inter,system-ui,sans-serif" font-size="62" font-weight="900"
		fill="#f9fafb">The Arena</text>
	<text x="72" y="366" font-family="Inter,system-ui,sans-serif" font-size="22" fill="#6b7280">Live PvP trading brackets, ranked on real pump.fun P&amp;L.</text>
	<text x="1128" y="605" font-family="Inter,system-ui,sans-serif" font-size="14" font-weight="600"
		fill="#6b7280" text-anchor="end">three.ws/arena</text>
</svg>`;
	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=300, s-maxage=3600');
	res.end(svg);
}
