/**
 * GET /api/og/sealed-drop?id=<dropId>
 *
 * Dynamic Open Graph share card for a sealed wallet drop — the image that
 * previews wherever a /drop/:id link is posted (X, Telegram, Discord, iMessage,
 * Farcaster). Mirrors api/og/three-token-badge.js: a 1200×630 SVG returned with
 * image/svg+xml + a CDN cache header, no satori/canvas deps in the bundle.
 *
 * The card shows ONLY public, secret-free fields from the drop's public
 * projection: the (vanity) address, the funded amount + asset, the theme, who
 * it's from, and the sealed/E2E badge. It NEVER renders the sealed envelope, the
 * claim token, or any secret. A missing/unknown id still renders a valid,
 * branded card (a generic "sealed gift") rather than 5xx — crawlers must always
 * get an image.
 */

import { cors, wrap } from '../_lib/http.js';
import { getDrop } from '../_lib/sealed-drop-store.js';
import { isValidDropId } from '../../src/solana/vanity/drop-protocol.js';

const CACHE = 'public, max-age=60, s-maxage=600, stale-while-revalidate=120';

// three.ws brand gradient.
const C1 = '#8b5cf6';
const C2 = '#06b6d4';

// Per-theme accent + glyph, coin-agnostic.
const THEME_STYLE = {
	default: { accent: '#8b5cf6', glyph: '🎁', label: 'A sealed gift' },
	birthday: { accent: '#ff5db1', glyph: '🎂', label: 'Happy birthday' },
	congrats: { accent: '#ffb020', glyph: '🎉', label: 'Congratulations' },
	thanks: { accent: '#4ade80', glyph: '🙏', label: 'Thank you' },
	welcome: { accent: '#38bdf8', glyph: '👋', label: 'Welcome' },
	tip: { accent: '#fbbf24', glyph: '⚡', label: 'A tip for you' },
};

function x(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function shortAddr(addr) {
	const s = String(addr || '');
	return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

function assetLabel(asset) {
	if (asset === 'THREE') return '$THREE';
	return String(asset || '');
}

function buildCard({ status, amount, asset, address, theme, senderLabel, vanity }) {
	const t = THEME_STYLE[theme] || THEME_STYLE.default;
	const claimed = status === 'claimed';
	const reclaimed = status === 'reclaimed';
	const statusLabel = claimed ? 'CLAIMED' : reclaimed ? 'RECLAIMED' : 'SEALED · UNCLAIMED';
	const statusColor = claimed ? '#4ade80' : reclaimed ? '#888' : t.accent;
	const amountStr = amount != null ? `${amount} ${assetLabel(asset)}` : 'Sealed wallet';
	const addr = shortAddr(address);
	const from = senderLabel ? `from ${senderLabel}` : 'A pre-funded wallet, sealed end-to-end';
	const vanityNote = vanity?.prefix || vanity?.suffix
		? `vanity ${vanity.prefix ? vanity.prefix + '…' : ''}${vanity.suffix ? '…' + vanity.suffix : ''}`
		: 'end-to-end encrypted';

	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${x(t.label)} — a sealed wallet drop on three.ws">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#0a0a0f"/><stop offset="1" stop-color="#05050a"/>
		</linearGradient>
		<linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="${C1}"/><stop offset="1" stop-color="${C2}"/>
		</linearGradient>
		<radialGradient id="glow" cx="0.8" cy="0.2" r="0.9">
			<stop offset="0" stop-color="${t.accent}" stop-opacity="0.22"/>
			<stop offset="1" stop-color="${t.accent}" stop-opacity="0"/>
		</radialGradient>
	</defs>
	<rect width="1200" height="630" fill="url(#bg)"/>
	<rect width="1200" height="630" fill="url(#glow)"/>
	<rect x="0" y="0" width="1200" height="6" fill="url(#brand)"/>

	<text x="64" y="86" font-family="'Space Grotesk',Inter,system-ui,sans-serif" font-size="30" font-weight="700" fill="#fff">three.ws</text>
	<text x="64" y="86" font-family="Inter,system-ui,sans-serif" font-size="20" font-weight="600" fill="#777" dx="150">SEALED DROP</text>

	<text x="1136" y="86" text-anchor="end" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="800" letter-spacing="1" fill="${statusColor}">${x(statusLabel)}</text>

	<text x="64" y="240" font-family="Inter,system-ui,sans-serif" font-size="44">${t.glyph}</text>
	<text x="130" y="240" font-family="'Space Grotesk',Inter,system-ui,sans-serif" font-size="40" font-weight="800" fill="#fff">${x(t.label)}</text>

	<text x="64" y="360" font-family="'Space Grotesk',Inter,system-ui,sans-serif" font-size="92" font-weight="800" fill="url(#brand)">${x(amountStr)}</text>

	<text x="64" y="430" font-family="'Space Grotesk',monospace" font-size="30" font-weight="700" fill="#cbd5e1">${x(addr)}</text>
	<text x="64" y="470" font-family="Inter,system-ui,sans-serif" font-size="22" fill="#94a3b8">${x(from)}</text>

	<g>
		<rect x="64" y="520" width="430" height="54" rx="27" fill="rgba(139,92,246,0.12)" stroke="${t.accent}" stroke-opacity="0.5"/>
		<text x="92" y="555" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="${t.accent}">🔒 ${x(vanityNote)}</text>
	</g>

	<text x="1136" y="600" text-anchor="end" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="600" fill="#64748b">three.ws/drop</text>
</svg>`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, `http://${req.headers.host || 'three.ws'}`);
	const id = (url.searchParams.get('id') || '').trim();

	let drop = null;
	if (isValidDropId(id)) {
		try {
			drop = await getDrop(id);
		} catch {
			drop = null;
		}
	}

	const svg = buildCard({
		status: drop?.status || 'funded',
		amount: drop?.amount ?? null,
		asset: drop?.asset || null,
		address: drop?.address || null,
		theme: drop?.theme || 'default',
		senderLabel: drop?.senderLabel || null,
		vanity: drop?.vanity || null,
	});

	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', CACHE);
	res.end(svg);
});

// Exposed for unit tests: renders the card from fixed fields so a test can assert
// the SVG shape (and that no secret ever reaches it) without Redis or a network.
export const __testInternals = { buildCard, shortAddr, assetLabel, THEME_STYLE };
