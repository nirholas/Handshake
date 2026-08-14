// GET /api/x402-pay/og?tx=<signature>
// Dynamic 1200×630 SVG card for /pay/calls/<tx> permalinks. When pasted into
// X / Slack / Discord / iMessage, the link expands to a branded summary of the
// paid x402 call (tool, amount, payer, timestamp).

import { getRedis as _getSharedRedis } from '../_lib/redis.js';
import { cors, wrap } from '../_lib/http.js';
import { logger } from '../_lib/usage.js';
import {
	NETWORK_SOLANA_MAINNET,
	NETWORK_SOLANA_DEVNET,
} from '../_lib/x402/solana-networks.js';

const log = logger('x402-og');

const FALLBACK_TITLE = 'three.ws · pay-per-call (x402)';
const FALLBACK_SUB = 'Live demo: agent pays $0.001 USDC per MCP tool call.';
const UNKNOWN = 'n/a';

// A settled record is immutable, so it caches for an hour at the edge. A
// well-formed tx we could NOT resolve (Redis down, or the card was shared in
// the seconds before persistCall landed) must not be cached that long: an
// hour of CDN-cached generic card on a real permalink is how a transient
// outage turns into a whole afternoon of blank share previews.
const CACHE_RESOLVED = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_UNRESOLVED = 'public, max-age=60, s-maxage=60';

// Base58 Solana signature. 64 to 90 chars covers every real 64-byte signature.
const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

function redis() { return _getSharedRedis(); }

function isRecord(v) {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

async function readCall(tx) {
	const r = redis();
	if (!r) return null;
	try {
		const row = await r.get(`x402:pay:call:${tx}`);
		if (typeof row === 'string') {
			try {
				const parsed = JSON.parse(row);
				// A row that parses to a scalar or an array is corrupt, not a
				// record. Treating it as one renders a card of blank fields.
				if (isRecord(parsed)) return parsed;
				log.warn('og_row_not_object', { tx, type: Array.isArray(parsed) ? 'array' : typeof parsed });
			} catch (parseErr) {
				log.warn('og_row_parse_failed', { tx, message: parseErr?.message });
			}
		} else if (isRecord(row)) return row;
	} catch (err) {
		log.warn('og_row_read_failed', { tx, message: err?.message });
	}
	return null;
}

function escapeSvg(s) {
	return String(s).replace(/[<>&"']/g, (c) => ({
		'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
	}[c]));
}

// `tool` and `argsSummary` come from the caller's own request body, so they are
// unbounded caller-controlled text. Escaping keeps them from breaking the SVG;
// clamping keeps a 400-character tool name from painting over the whole card.
function truncate(s, n) {
	const str = String(s ?? '');
	return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

function shortTx(tx) {
	const s = String(tx ?? '');
	if (!s) return UNKNOWN;
	return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

function shortAddr(a) {
	const s = String(a ?? '');
	if (!s) return UNKNOWN;
	return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function relativeAgo(ts) {
	const n = Number(ts);
	// A corrupt `ts` used to fall through every branch and render "NaNd ago".
	if (!Number.isFinite(n) || n <= 0) return '';
	const d = Math.max(0, Date.now() - n);
	if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
	if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
	if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
	return `${Math.floor(d / 86_400_000)}d ago`;
}

// Records carry the CAIP-2 network id the payment settled on. Only the mainnet
// lane persists records today, but reading the id rather than hardcoding a
// label means a devnet receipt can never be captioned "mainnet".
function networkLabel(network) {
	if (network === NETWORK_SOLANA_MAINNET) return 'Solana mainnet';
	if (network === NETWORK_SOLANA_DEVNET) return 'Solana devnet';
	return 'Solana';
}

// Persisted records always carry `amount` (base units) from accept.amount; a
// malformed row renders "unknown" rather than a fabricated $0.001 figure.
function amountLabel(amount) {
	const raw = amount != null ? Number(amount) : null;
	if (raw == null || !Number.isFinite(raw)) return 'unknown';
	return `${(raw / 1e6).toFixed(6)} USDC`;
}

function svgFor(record, txParam) {
	const tool = truncate(record?.tool || 'paid call', 38);
	const args = truncate(record?.argsSummary || '', 80);
	const tx = record?.tx || txParam || '';
	const payer = record?.payer || '';
	const amount = amountLabel(record?.amount);
	const network = networkLabel(record?.network);
	const ago = relativeAgo(record?.ts);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeSvg(tool)}, ${escapeSvg(amount)} on ${escapeSvg(network)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0b10"/>
      <stop offset="1" stop-color="#14161f"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0.18" cy="0.18" r="0.55">
      <stop offset="0" stop-color="#8b5cf6" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.85" cy="0.92" r="0.5">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="logoG" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow1)"/>
  <rect width="1200" height="630" fill="url(#glow2)"/>

  <!-- top brand row -->
  <g transform="translate(72 72)">
    <rect x="0" y="0" width="44" height="44" rx="11" fill="url(#logoG)"/>
    <text x="60" y="22" font-family="-apple-system, system-ui, Inter, Helvetica, Arial, sans-serif" font-size="18" font-weight="700" fill="#e6e8f0" letter-spacing="-0.2">three.ws</text>
    <text x="60" y="42" font-family="ui-monospace, Menlo, monospace" font-size="14" fill="#8a90a8">pay-per-call · x402</text>
  </g>

  <!-- settled badge -->
  <g transform="translate(972 80)">
    <rect x="0" y="0" width="156" height="40" rx="20" fill="#22c55e" fill-opacity="0.14" stroke="#22c55e" stroke-opacity="0.6" stroke-width="1"/>
    <circle cx="22" cy="20" r="5" fill="#22c55e"/>
    <text x="38" y="25" font-family="ui-monospace, Menlo, monospace" font-size="13" fill="#22c55e" letter-spacing="1.3">SETTLED ON-CHAIN</text>
  </g>

  <!-- main title block -->
  <g transform="translate(72 200)">
    <rect x="0" y="-36" width="6" height="56" fill="url(#accent)" rx="3"/>
    <text x="22" y="0" font-family="ui-monospace, Menlo, monospace" font-size="46" font-weight="700" fill="#e6e8f0">${escapeSvg(tool)}</text>
    ${args ? `<text x="22" y="36" font-family="-apple-system, system-ui, Inter, Helvetica, Arial, sans-serif" font-size="22" fill="#8a90a8">${escapeSvg(args)}</text>` : ''}
  </g>

  <!-- stat strip -->
  <g transform="translate(72 320)" font-family="ui-monospace, Menlo, monospace">
    <g>
      <text x="0" y="0" font-size="13" fill="#8a90a8" letter-spacing="1.6">AMOUNT</text>
      <text x="0" y="30" font-size="28" fill="#e6e8f0" font-weight="600">${escapeSvg(amount)}</text>
    </g>
    <g transform="translate(280 0)">
      <text x="0" y="0" font-size="13" fill="#8a90a8" letter-spacing="1.6">NETWORK</text>
      <text x="0" y="30" font-size="28" fill="#e6e8f0" font-weight="600">${escapeSvg(network)}</text>
    </g>
    <g transform="translate(660 0)">
      <text x="0" y="0" font-size="13" fill="#8a90a8" letter-spacing="1.6">PAYER</text>
      <text x="0" y="30" font-size="28" fill="#e6e8f0" font-weight="600">${escapeSvg(shortAddr(payer))}</text>
    </g>
    ${ago ? `<g transform="translate(900 0)">
      <text x="0" y="0" font-size="13" fill="#8a90a8" letter-spacing="1.6">WHEN</text>
      <text x="0" y="30" font-size="28" fill="#e6e8f0" font-weight="600">${escapeSvg(ago)}</text>
    </g>` : ''}
  </g>

  <!-- tx hash -->
  <g transform="translate(72 430)" font-family="ui-monospace, Menlo, monospace">
    <text x="0" y="0" font-size="13" fill="#8a90a8" letter-spacing="1.6">TX</text>
    <text x="0" y="30" font-size="22" fill="#22d3ee">${escapeSvg(shortTx(tx))}</text>
  </g>

  <!-- footer -->
  <g transform="translate(72 540)" font-family="-apple-system, system-ui, Inter, Helvetica, Arial, sans-serif">
    <text x="0" y="0" font-size="22" fill="#e6e8f0" font-weight="500">No keys. No signup. $0.001 per call, settled per request.</text>
    <text x="0" y="34" font-size="18" fill="#8a90a8">three.ws/pay  →  try it yourself</text>
  </g>
</svg>`;
}

function fallbackSvg() {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeSvg(FALLBACK_TITLE)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a0b10"/><stop offset="1" stop-color="#14161f"/></linearGradient>
    <linearGradient id="logoG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <g transform="translate(120 240)">
    <rect x="0" y="0" width="60" height="60" rx="14" fill="url(#logoG)"/>
    <text x="80" y="40" font-family="-apple-system, system-ui, sans-serif" font-size="46" font-weight="700" fill="#e6e8f0">${escapeSvg(FALLBACK_TITLE)}</text>
    <text x="80" y="78" font-family="-apple-system, system-ui, sans-serif" font-size="22" fill="#8a90a8">${escapeSvg(FALLBACK_SUB)}</text>
  </g>
  <text x="120" y="540" font-family="-apple-system, system-ui, sans-serif" font-size="20" fill="#22d3ee">three.ws/pay</text>
</svg>`;
}

export default wrap(async function handler(req, res) {
	// Same shape as the neighboring card endpoint (api/agent-og.js): an OG
	// image is read cross-origin by every unfurler, so the origin is open.
	if (cors(req, res, { origins: '*', methods: 'GET,HEAD,OPTIONS' })) return;

	// Slack, Telegram and LinkedIn all HEAD an image URL to check its type and
	// size before they fetch it; answering 405 there drops the card entirely.
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.statusCode = 405;
		res.setHeader('allow', 'GET, HEAD, OPTIONS');
		res.setHeader('content-type', 'application/json; charset=utf-8');
		return res.end(JSON.stringify({
			error: 'method_not_allowed',
			message: 'This card endpoint serves GET, HEAD and OPTIONS.',
		}));
	}

	const url = new URL(req.url, `http://${req.headers.host || 'three.ws'}`);
	const tx = url.searchParams.get('tx') || '';
	const wantsRecord = TX_RE.test(tx);

	const record = wantsRecord ? await readCall(tx) : null;
	const svg = record ? svgFor(record, tx) : fallbackSvg();

	// Serve the card as SVG directly. The previous sharp to PNG raster relied on
	// libvips' text shaping, which needs a system fontconfig that does not exist
	// on the serverless runtime, so every render logged
	// "Fontconfig error: Cannot load default config file" and produced
	// glyph-less text before falling back to SVG anyway. SVG is the right output
	// here: it is resolution-independent, needs no native font stack, and every
	// major unfurler (X, Discord, Slack, Telegram) accepts image/svg+xml OG
	// images, the same approach api/agent-og.js already uses. The SVG specifies
	// system-font fallback stacks so the consumer renders it with its own fonts.
	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('content-length', String(Buffer.byteLength(svg)));
	res.setHeader('cache-control', wantsRecord && !record ? CACHE_UNRESOLVED : CACHE_RESOLVED);
	// Every value in the card is escaped, but an SVG served from our own origin
	// is a script-execution surface if that ever regresses. Nothing in this
	// document needs a script, a fetch or a remote reference.
	res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
	if (req.method === 'HEAD') return res.end();
	return res.end(svg);
});
