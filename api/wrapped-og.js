/**
 * GET /api/wrapped-og?agent=<uuid>[&window=7d|30d|all]
 *
 * The social card for a Trader Wrapped recap. SVG 1200x630, cut from the same
 * deck /wrapped renders, so the preview can never claim a number the page does
 * not show.
 *
 * Card anatomy:
 *   top      three.ws wordmark + the window this season covers
 *   left     agent portrait, name, and the honest one-line headline
 *   center   realized P&L, huge, colored by sign (a red season previews red)
 *   right    best trade, win rate, rank against the field
 *   bottom   the season's cumulative realized-P&L curve
 *
 * A trader without enough settled history gets the "no season yet" card rather
 * than a poster full of zeroes.
 */

import { cors, wrap } from './_lib/http.js';
import { isUuid } from './_lib/validate.js';
import { fetchOgImage } from './_lib/og-avatar.js';
import { env } from './_lib/env.js';
import { WRAPPED_WINDOWS, getWrapped } from './_lib/wrapped.js';

const CACHE = 'public, max-age=300, s-maxage=1800, stale-while-revalidate=600';
const WINDOW_LABEL = { '24h': 'LAST 24 HOURS', '7d': 'LAST 7 DAYS', '30d': 'LAST 30 DAYS', all: 'ALL TIME' };

function x(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function trunc(s, n) {
	const v = String(s || '');
	return v.length <= n ? v : `${v.slice(0, n - 1)}…`;
}
const dash = '-';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const agentId = (url.searchParams.get('agent') || url.searchParams.get('agent_id') || '').trim();
	const windowParam = url.searchParams.get('window');
	const window = WRAPPED_WINDOWS.has(windowParam) ? windowParam : '30d';
	const origin = env.APP_ORIGIN || 'https://three.ws';

	if (!isUuid(agentId)) return fallback(res, origin);

	let deck = null;
	try {
		deck = await getWrapped({ agentId, network: 'mainnet', window });
	} catch {
		return fallback(res, origin);
	}
	if (!deck) return fallback(res, origin);

	const name = trunc(deck.agent.name || 'Trader', 26);
	const initial = (deck.agent.name || 'T')[0].toUpperCase();
	const avatarData = await fetchOgImage(deck.agent.image);

	if (!deck.enough_history) {
		return send(res, thinCard({ name, initial, avatarData, window, closed: deck.closed_count, min: deck.min_closed }));
	}

	const slides = Object.fromEntries(deck.slides.map((s) => [s.kind, s]));
	const score = slides.scoreboard || {};
	const best = slides.best_trade?.trade || null;
	const rank = slides.rank || null;

	const pnl = Number(score.realized_pnl_sol ?? 0);
	const pnlColor = pnl > 0 ? '#34d399' : pnl < 0 ? '#fb7185' : '#94a3b8';
	const pnlStr = `${pnl > 0 ? '+' : ''}${pnl.toFixed(3).replace(/\.?0+$/, '') || '0'} SOL`;
	const winStr = score.win_rate != null ? `${Math.round(score.win_rate * 100)}%` : dash;
	const bestStr = best?.multiple != null && best.multiple >= 1
		? `${best.multiple.toFixed(2)}x`
		: best?.pnl_pct != null ? `${best.pnl_pct > 0 ? '+' : ''}${Math.round(best.pnl_pct)}%` : dash;
	const bestSub = best ? trunc(best.symbol ? `$${best.symbol}` : best.name || 'one coin', 16) : 'no closed winner';
	const rankStr = rank?.rank != null ? `#${rank.rank}` : dash;
	const rankSub = rank?.sample != null ? `of ${rank.sample} traders` : 'field too small';

	return send(res, `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#141018"/>
			<stop offset="1" stop-color="#08080a"/>
		</linearGradient>
		<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="#f472b6"/>
			<stop offset="1" stop-color="#a78bfa"/>
		</linearGradient>
		${avatarData ? '<clipPath id="avClip"><circle cx="80" cy="128" r="36"/></clipPath>' : ''}
	</defs>

	<rect width="1200" height="630" fill="url(#bg)"/>
	<rect x="0" y="0" width="1200" height="5" fill="url(#accent)"/>

	<text x="44" y="52" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700"
		letter-spacing=".16em" fill="#f472b6">THREE.WS · TRADER WRAPPED</text>
	<text x="1156" y="52" font-family="Inter,system-ui,sans-serif" font-size="12" font-weight="600"
		letter-spacing=".14em" fill="#5b5b66" text-anchor="end">${x(WINDOW_LABEL[window] || window)}</text>
	<line x1="44" y1="70" x2="1156" y2="70" stroke="#232329" stroke-width="1"/>

	${avatarData
		? `<image href="data:${avatarData.ct};base64,${avatarData.b64}" x="44" y="92" width="72" height="72" clip-path="url(#avClip)"/>`
		: `<circle cx="80" cy="128" r="36" fill="#1e1e26"/>
		   <text x="80" y="140" text-anchor="middle" font-family="Inter,system-ui,sans-serif"
			font-size="30" font-weight="800" fill="#4a4a56">${x(initial)}</text>`}
	<circle cx="80" cy="128" r="36" fill="none" stroke="#f472b6" stroke-width="2" opacity=".5"/>

	<text x="136" y="122" font-family="Inter,system-ui,sans-serif" font-size="40" font-weight="800"
		fill="#f6f6f8">${x(name)}</text>
	<text x="136" y="152" font-family="Inter,system-ui,sans-serif" font-size="15" fill="#7a7a86">${x(trunc(deck.headline, 92))}</text>

	<text x="44" y="238" font-family="Inter,system-ui,sans-serif" font-size="12" font-weight="700"
		letter-spacing=".14em" fill="#5b5b66">REALIZED PROFIT AND LOSS</text>
	<text x="44" y="322" font-family="Inter,system-ui,sans-serif" font-size="84" font-weight="800"
		letter-spacing="-.03em" fill="${x(pnlColor)}">${x(pnlStr)}</text>

	${metricCard(688, 208, 'BEST TRADE', bestStr, '#34d399', bestSub)}
	${metricCard(688, 316, 'WIN RATE', winStr, '#f6f6f8', `${score.wins || 0} won, ${score.losses || 0} lost`)}
	${metricCard(940, 208, 'RANK', rankStr, '#a78bfa', rankSub)}
	${metricCard(940, 316, 'ROUND-TRIPS', String(deck.closed_count), '#f6f6f8', `${slides.intro?.unique_coins || 0} coins`)}

	${curve(score.pnl_series, 44, 380, 600, 120, pnlColor)}

	<rect x="0" y="574" width="1200" height="56" fill="#050506"/>
	<text x="44" y="608" font-family="Inter,system-ui,sans-serif" font-size="13" fill="#4a4a56"
		letter-spacing=".08em">EVERY NUMBER TRACED TO A CLOSED ON-CHAIN ROUND-TRIP</text>
	<text x="1156" y="608" font-family="Inter,system-ui,sans-serif" font-size="13" fill="#4a4a56"
		text-anchor="end">three.ws/wrapped</text>
</svg>`);
});

function metricCard(x0, y0, label, value, color, sub) {
	return `<g>
		<rect x="${x0}" y="${y0}" width="216" height="92" rx="12" fill="#131318" stroke="#232329" stroke-width="1"/>
		<text x="${x0 + 16}" y="${y0 + 26}" font-family="Inter,system-ui,sans-serif"
			font-size="10" font-weight="700" letter-spacing=".12em" fill="#5b5b66">${x(label)}</text>
		<text x="${x0 + 16}" y="${y0 + 62}" font-family="Inter,system-ui,sans-serif"
			font-size="30" font-weight="800" fill="${x(color)}">${x(value)}</text>
		<text x="${x0 + 16}" y="${y0 + 80}" font-family="Inter,system-ui,sans-serif"
			font-size="11" fill="#5b5b66">${x(trunc(sub, 26))}</text>
	</g>`;
}

/** The season's cumulative realized-P&L curve, with the break-even line drawn. */
function curve(series, x0, y0, w, h, color) {
	const pts = (series || []).map(Number).filter(Number.isFinite);
	if (pts.length < 2) return '';
	const min = Math.min(0, ...pts);
	const max = Math.max(0, ...pts);
	const span = max - min || 1;
	const px = (i) => x0 + (i / (pts.length - 1)) * w;
	const py = (v) => y0 + h - ((v - min) / span) * h;
	const d = pts.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
	return `<g>
		<line x1="${x0}" y1="${py(0).toFixed(1)}" x2="${x0 + w}" y2="${py(0).toFixed(1)}"
			stroke="#2a2a31" stroke-width="1" stroke-dasharray="4 4"/>
		<path d="${d}" fill="none" stroke="${x(color)}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
		<text x="${x0}" y="${y0 - 12}" font-family="Inter,system-ui,sans-serif" font-size="10"
			font-weight="700" letter-spacing=".12em" fill="#5b5b66">CUMULATIVE REALIZED P&amp;L</text>
	</g>`;
}

function thinCard({ name, initial, avatarData, window, closed, min }) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#141018"/><stop offset="1" stop-color="#08080a"/>
		</linearGradient>
		${avatarData ? '<clipPath id="avClip"><circle cx="600" cy="238" r="52"/></clipPath>' : ''}
	</defs>
	<rect width="1200" height="630" fill="url(#bg)"/>
	<rect x="0" y="0" width="1200" height="5" fill="#f472b6"/>
	<text x="600" y="120" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="13"
		font-weight="700" letter-spacing=".16em" fill="#f472b6">THREE.WS · TRADER WRAPPED</text>
	${avatarData
		? `<image href="data:${avatarData.ct};base64,${avatarData.b64}" x="548" y="186" width="104" height="104" clip-path="url(#avClip)"/>`
		: `<circle cx="600" cy="238" r="52" fill="#1e1e26"/>
		   <text x="600" y="256" text-anchor="middle" font-family="Inter,system-ui,sans-serif"
			font-size="42" font-weight="800" fill="#4a4a56">${x(initial)}</text>`}
	<text x="600" y="352" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="46"
		font-weight="800" fill="#f6f6f8">${x(name)} has no season yet</text>
	<text x="600" y="398" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="19" fill="#7a7a86">
		${closed === 0 ? 'Nothing settled' : `Only ${closed} round-trip${closed === 1 ? '' : 's'} settled`} in ${x((WINDOW_LABEL[window] || window).toLowerCase())}.
	</text>
	<text x="600" y="430" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="19" fill="#7a7a86">
		A recap needs ${min} before its numbers would mean anything.
	</text>
	<text x="600" y="576" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="13"
		fill="#4a4a56" letter-spacing=".08em">three.ws/wrapped</text>
</svg>`;
}

function send(res, svg) {
	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(svg);
}

function fallback(res, origin) {
	res.statusCode = 302;
	res.setHeader('location', `${origin}/og-image.png`);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}
