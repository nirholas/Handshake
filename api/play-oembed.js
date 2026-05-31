// api/play-oembed — oEmbed provider for /play Coin Communities worlds.
// Returns rich oEmbed JSON so a coin-world link (three.ws/play?coin=<mint>)
// unfurls as an interactive 3D world on platforms that resolve oEmbed
// (WordPress, Ghost, Discord, dev.to, Notion) and, once three.ws is
// registered as a provider, on iframely/embed.ly-backed editors such as the
// AWS Builder Center.
//
// Spec: https://oembed.com/  —  ?url=<coin world url>&format=json&maxwidth=&maxheight=

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=300');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.end(JSON.stringify(body));
}

function esc(s = '') {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function origin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

// Pull a pump.fun mint out of the pasted url (?coin= / ?mint= or a /play/<mint> path).
function extractMint(urlParam) {
  if (!urlParam) return '';
  try {
    const u = new URL(urlParam);
    const q = u.searchParams.get('coin') || u.searchParams.get('mint');
    if (q) return q;
    const m = u.pathname.match(/\/play\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m) return m[1];
  } catch {
    const m = String(urlParam).match(/[?&](?:coin|mint)=([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m) return m[1];
  }
  return '';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const u = new URL(req.url, 'http://localhost');
  const urlParam = u.searchParams.get('url') || '';
  const format = (u.searchParams.get('format') || 'json').toLowerCase();
  const maxwidth = clampInt(u.searchParams.get('maxwidth'), 240, 1920, 720);
  const maxheight = clampInt(u.searchParams.get('maxheight'), 160, 1080, 460);
  if (format !== 'json') return send(res, 501, { error: 'only json supported' });
  if (!urlParam) return send(res, 400, { error: 'url parameter required' });

  const proto = origin(req);
  const mint = extractMint(urlParam);

  const embedUrl = mint
    ? `${proto}/play?coin=${encodeURIComponent(mint)}&embed=1`
    : `${proto}/play?embed=1`;
  const thumbnail = mint
    ? `${proto}/api/play-og?coin=${encodeURIComponent(mint)}`
    : `${proto}/api/play-og`;
  const title = mint ? `three.ws · coin world ${mint.slice(0, 4)}…${mint.slice(-4)}` : 'three.ws · Coin Communities';

  const iframeHtml =
    `<iframe src="${esc(embedUrl)}" width="${maxwidth}" height="${maxheight}" ` +
    `frameborder="0" loading="lazy" ` +
    `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; microphone; xr-spatial-tracking; fullscreen" ` +
    `allowfullscreen style="border:none;border-radius:16px;overflow:hidden;max-width:100%;"></iframe>`;

  return send(res, 200, {
    version: '1.0',
    type: 'rich',
    provider_name: 'three.ws',
    provider_url: proto,
    title,
    html: iframeHtml,
    width: maxwidth,
    height: maxheight,
    thumbnail_url: thumbnail,
    thumbnail_width: 1200,
    thumbnail_height: 630,
    cache_age: 300,
  });
}
