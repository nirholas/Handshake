// api/play-oembed: oEmbed provider for /play Coin Communities worlds.
// Returns rich oEmbed JSON (or XML) so a coin-world link
// (three.ws/play?coin=<mint>) unfurls as an interactive 3D world on platforms
// that resolve oEmbed (WordPress, Ghost, Discord, dev.to, Notion) and, once
// three.ws is registered as a provider, on iframely/embed.ly-backed editors
// such as the AWS Builder Center.
//
// Spec: https://oembed.com/ (?url=<coin world url>&format=json|xml&maxwidth=&maxheight=)
//
// Discovery: pages/play.html carries the <link rel="alternate"
// type="application/json+oembed"> pair that points consumers here.

import { cors, error, method, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';

// The embed target is ALWAYS the canonical app origin, never the request's Host
// header. A crawler-supplied Host (or X-Forwarded-Host) used to be echoed
// straight into the returned iframe src and provider_url, so a single crafted
// request handed any consumer an oEmbed payload that framed an attacker's site
// under the three.ws provider name. Mirrors api/widgets/oembed.js.
const ORIGIN = env.APP_ORIGIN;

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const THUMB_W = 1200;
const THUMB_H = 630;

function esc(s = '') {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

// An oEmbed provider answers only for URLs in its OWN scheme; anything else is a
// 404 per the spec. Accept our canonical origin and a localhost dev server, and
// only the /play surface within it.
function resolveWorld(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  const originStr = `${parsed.protocol}//${parsed.host}`;
  const okOrigin = originStr === ORIGIN || /^https?:\/\/localhost(:\d+)?$/.test(originStr);
  if (!okOrigin) return null;

  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  // /play/<mint> (path form) and /play?coin=|mint=<mint> (canonical share link).
  const pathMint = path.match(/^\/play\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (pathMint) return { mint: pathMint[1] };
  if (path !== '/play') return null;

  const q = parsed.searchParams.get('coin') || parsed.searchParams.get('mint') || '';
  return { mint: MINT_RE.test(q) ? q : '' };
}

function buildPayload(mint, maxwidth, maxheight) {
  const embedUrl = mint
    ? `${ORIGIN}/play?coin=${encodeURIComponent(mint)}&embed=1`
    : `${ORIGIN}/play?embed=1`;
  const thumbnail = mint
    ? `${ORIGIN}/api/play-og?coin=${encodeURIComponent(mint)}`
    : `${ORIGIN}/api/play-og`;
  const title = mint
    ? `three.ws · coin world ${mint.slice(0, 4)}…${mint.slice(-4)}`
    : 'three.ws · Coin Communities';

  const html =
    `<iframe src="${esc(embedUrl)}" width="${maxwidth}" height="${maxheight}" ` +
    `frameborder="0" loading="lazy" ` +
    `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; microphone; xr-spatial-tracking; fullscreen" ` +
    `allowfullscreen style="border:none;border-radius:16px;overflow:hidden;max-width:100%;"></iframe>`;

  return {
    version: '1.0',
    type: 'rich',
    provider_name: 'three.ws',
    provider_url: ORIGIN,
    title,
    html,
    width: maxwidth,
    height: maxheight,
    thumbnail_url: thumbnail,
    thumbnail_width: THUMB_W,
    thumbnail_height: THUMB_H,
    cache_age: 300,
  };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toXml(payload) {
  const lines = Object.entries(payload).map(([k, v]) => `  <${k}>${escapeXml(String(v))}</${k}>`);
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<oembed>\n${lines.join('\n')}\n</oembed>`;
}

export default wrap(async (req, res) => {
  if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
  if (!method(req, res, ['GET'])) return;

  const u = new URL(req.url, 'http://x');
  const target = u.searchParams.get('url') || '';
  const format = (u.searchParams.get('format') || 'json').toLowerCase();
  const maxwidth = clampInt(u.searchParams.get('maxwidth'), 240, 1920, 720);
  const maxheight = clampInt(u.searchParams.get('maxheight'), 160, 1080, 460);

  if (!target) return error(res, 400, 'invalid_request', 'url parameter required');
  // oembed.com: a provider that cannot answer in the requested format returns
  // 501 rather than quietly serving a different one.
  if (format !== 'json' && format !== 'xml')
    return error(res, 501, 'unsupported_format', 'format must be json or xml');

  const world = resolveWorld(target);
  if (!world) return error(res, 404, 'not_found', 'url is not a three.ws coin world url');

  const payload = buildPayload(world.mint, maxwidth, maxheight);

  res.statusCode = 200;
  res.setHeader('cache-control', 'public, max-age=300');
  if (format === 'xml') {
    res.setHeader('content-type', 'text/xml; charset=utf-8');
    res.end(toXml(payload));
    return;
  }
  res.setHeader('content-type', 'application/json+oembed; charset=utf-8');
  res.end(JSON.stringify(payload));
});
