/**
 * GET /api/trade-og?id=<position uuid>
 *
 * Dynamic OG image for a SINGLE closed pump.fun trade. SVG 1200x630, rendered
 * entirely from the real `agent_sniper_positions` row, so the picture that
 * unfurls on X is the same set of numbers the linked page shows.
 *
 * The trader-level card (api/trader-og.js) answers "is this trader any good?".
 * THIS card answers "what just happened?" and is the one worth posting the
 * moment a position closes.
 *
 * Card anatomy (1200x630, dark):
 *   top       - three.ws wordmark + PAPER / LIVE stamp
 *   left      - agent avatar circle + agent name
 *   center    - $SYMBOL and the outcome, huge (e.g. "+312%" with a "4.1x" chip)
 *   metrics   - In, Out, Realized, Held
 *   chips     - exit reason, moon-bag, paper
 *   footer    - "verify on solscan" + three.ws/trade
 *
 * A loss renders exactly like a win, only red. Nothing here hides a red card:
 * survivorship theater is what makes copy-trading platforms untrustworthy.
 */

import { cors, wrap } from './_lib/http.js';
import { loadTradeCard } from './_lib/trade-card-store.js';
import { env } from './_lib/env.js';

const CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=600';

function x(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function trunc(s, n) {
	const v = String(s ?? '');
	return v.length <= n ? v : v.slice(0, n - 1) + '…';
}

/** Shrink the headline as it gets longer so a "+12,480%" never overflows. */
function headlineSize(text) {
	const len = String(text || '').length;
	if (len <= 6) return 128;
	if (len <= 8) return 108;
	if (len <= 10) return 92;
	return 76;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const id = (url.searchParams.get('id') || '').trim();
	const origin = env.APP_ORIGIN || 'https://three.ws';

	const card = await loadTradeCard(id, { origin });
	if (!card) return fallback(res);

	// Embed the agent portrait so the card is self-contained. A slow or dead
	// avatar host degrades to the initial monogram, never to a broken unfurl.
	let avatar = null;
	if (card.agentImage && /^https?:\/\//.test(card.agentImage)) {
		try {
			const resp = await fetch(card.agentImage, { signal: AbortSignal.timeout(3000) });
			if (resp.ok) {
				const ct = resp.headers.get('content-type') || 'image/jpeg';
				const b64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
				avatar = { ct, b64 };
			}
		} catch { /* non-fatal: monogram fallback below */ }
	}

	const accent = card.accent;
	const initial = (card.agentName[0] || 'A').toUpperCase();
	const hSize = headlineSize(card.headline);

	const chips = [];
	if (card.paper) chips.push({ label: 'PAPER FILL', color: '#fbbf24' });
	chips.push({ label: card.exitLabel.toUpperCase(), color: '#94a3b8' });
	if (card.moonbag) chips.push({ label: 'MOON-BAG RIDING', color: '#c084fc' });

	let chipX = 72;
	const chipSvg = chips.map((c) => {
		const w = 22 + c.label.length * 9.2;
		const g = chipRect(chipX, 486, w, c.label, c.color);
		chipX += w + 14;
		return g;
	}).join('\n\t');

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${x(card.title)}">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#0f0f13"/>
			<stop offset="1" stop-color="#08080b"/>
		</linearGradient>
		<radialGradient id="glow" cx="0.72" cy="0.42" r="0.62">
			<stop offset="0" stop-color="${x(accent)}" stop-opacity=".16"/>
			<stop offset="1" stop-color="${x(accent)}" stop-opacity="0"/>
		</radialGradient>
		${avatar ? '<clipPath id="avClip"><circle cx="106" cy="128" r="34"/></clipPath>' : ''}
	</defs>

	<rect width="1200" height="630" fill="url(#bg)"/>
	<rect width="1200" height="630" fill="url(#glow)"/>
	<rect x="0" y="0" width="6" height="630" fill="${x(accent)}" opacity=".75"/>

	<text x="72" y="62" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700"
		letter-spacing=".14em" fill="#6b7280">THREE.WS &#183; ARENA</text>
	<text x="1128" y="62" font-family="Inter,system-ui,sans-serif" font-size="12" font-weight="600"
		letter-spacing=".1em" fill="${card.paper ? '#fbbf24' : '#4b5563'}" text-anchor="end">${card.paper ? 'SIMULATE MODE' : 'LIVE &#183; MAINNET ON-CHAIN'}</text>
	<line x1="72" y1="80" x2="1128" y2="80" stroke="#1f2937" stroke-width="1"/>

	${avatar
		? `<image href="data:${avatar.ct};base64,${avatar.b64}" x="72" y="94" width="68" height="68" clip-path="url(#avClip)" preserveAspectRatio="xMidYMid slice"/>`
		: `<circle cx="106" cy="128" r="34" fill="#1e293b"/>
	<text x="106" y="140" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="28" font-weight="700" fill="#475569">${x(initial)}</text>`}
	<circle cx="106" cy="128" r="34" fill="none" stroke="${x(accent)}" stroke-width="2" opacity=".55"/>

	<text x="158" y="120" font-family="Inter,system-ui,sans-serif" font-size="30" font-weight="800"
		fill="#f9fafb">${x(trunc(card.agentName, 30))}</text>
	<text x="158" y="148" font-family="Inter,system-ui,sans-serif" font-size="15" fill="#6b7280">autonomous pump.fun trader</text>

	<text x="72" y="252" font-family="Inter,system-ui,sans-serif" font-size="40" font-weight="700"
		fill="#9ca3af">$${x(trunc(card.symbol, 14))}</text>
	<text x="72" y="284" font-family="Inter,system-ui,sans-serif" font-size="15" fill="#4b5563"
		letter-spacing=".04em">${x(card.mintShort)}</text>

	<!-- Headline and multiple share ONE text element: the renderer advances the
	     tspan past the real glyph width, so a "+2112%" can never be overlapped
	     by its own "22x" the way a guessed x-offset would. -->
	<text x="72" y="${300 + hSize * 0.78}" font-family="Inter,system-ui,sans-serif" font-size="${hSize}"
		font-weight="900" fill="${x(accent)}">${x(card.headline)}${card.multipleLabel
		? `<tspan dx="${Math.round(hSize * 0.18)}" font-size="${Math.round(hSize * 0.36)}" font-weight="800"
			fill="#e5e7eb" fill-opacity=".82">${x(card.multipleLabel)}</tspan>`
		: ''}</text>

	${metric(716, 118, 'IN', card.entrySolStr || 'n/a', '#e5e7eb')}
	${metric(716, 214, 'OUT', card.exitSolStr || 'n/a', '#e5e7eb')}
	${metric(946, 118, 'REALIZED', card.pnlSolStr || 'n/a', accent)}
	${metric(946, 214, 'HELD', card.holdLabel || 'n/a', '#e5e7eb')}

	${chipSvg}

	<rect x="0" y="566" width="1200" height="64" fill="#050507"/>
	<text x="72" y="605" font-family="Inter,system-ui,sans-serif" font-size="14" fill="#4b5563"
		letter-spacing=".06em">${card.paper ? 'PAPER TRADE &#183; LABELED, NEVER COUNTED AS LIVE' : 'EVERY LEG VERIFIABLE ON SOLSCAN'}</text>
	<text x="1128" y="605" font-family="Inter,system-ui,sans-serif" font-size="14" font-weight="600"
		fill="#6b7280" text-anchor="end">three.ws/arena</text>
</svg>`;

	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(svg);
});

function metric(x0, y0, label, value, color) {
	return `<g>
		<rect x="${x0}" y="${y0}" width="210" height="82" rx="10" fill="#0e1015" stroke="#1f2937" stroke-width="1"/>
		<text x="${x0 + 16}" y="${y0 + 26}" font-family="Inter,system-ui,sans-serif" font-size="10"
			font-weight="700" letter-spacing=".12em" fill="#4b5563">${x(label)}</text>
		<text x="${x0 + 16}" y="${y0 + 62}" font-family="Inter,system-ui,sans-serif" font-size="27"
			font-weight="800" fill="${x(color)}">${x(value)}</text>
	</g>`;
}

function chipRect(x0, y0, w, label, color) {
	return `<g>
		<rect x="${x0}" y="${y0}" width="${w.toFixed(0)}" height="34" rx="17" fill="${x(color)}" fill-opacity=".12"
			stroke="${x(color)}" stroke-opacity=".38" stroke-width="1"/>
		<text x="${(x0 + w / 2).toFixed(0)}" y="${y0 + 22}" text-anchor="middle" font-family="Inter,system-ui,sans-serif"
			font-size="12" font-weight="700" letter-spacing=".08em" fill="${x(color)}">${x(label)}</text>
	</g>`;
}

/** Unknown / open / deleted: fall back to the site card rather than a broken image. */
function fallback(res) {
	res.statusCode = 302;
	res.setHeader('location', 'https://three.ws/og-image.png');
	res.setHeader('cache-control', 'no-cache');
	res.end();
}
