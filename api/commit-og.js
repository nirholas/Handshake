// api/commit-og.js: social-share landing for a single commit in the
// auto-posted commit feed (api/_lib/commit-feed-push.js). Its only job is to
// carry per-commit Open Graph tags so Telegram, X, and iMessage render a
// branded three.ws poster card for each commit post instead of GitHub's
// generic repo social card. Humans who click the preview are redirected
// straight to the commit on GitHub; crawlers read the OG tags and stop.
//
// Params (all supplied by the commit-feed cron, but the endpoint is public so
// every value is validated / escaped):
//   ?sha=<full or short commit sha>   the only source of the redirect target
//   ?t=<headline>  ?d=<description>  ?date=<YYYY-MM-DD>  ?author=<login>
//
// The poster itself is the existing api/page-og.js renderer, driven with the
// `commit` section so every commit card shares one accent family.

const REPO = 'nirholas/three.ws';
const BASE = 'https://three.ws';

// Escape for HTML text nodes and double-quoted attribute values. OG content
// lives in attributes, so " and ' must both be neutralised.
function esc(s) {
  return String(s || '').replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function clamp(s, n) {
  s = String(s || '').trim();
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

export default function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;

  // The redirect target is derived ONLY from a validated sha, never from a
  // caller-supplied URL, so this page can't be turned into an open redirect.
  const rawSha = String(q.get('sha') || '').toLowerCase();
  const sha = /^[0-9a-f]{7,40}$/.test(rawSha) ? rawSha : '';
  const commitUrl = sha
    ? `https://github.com/${REPO}/commit/${sha}`
    : `https://github.com/${REPO}/commits/main`;

  const headline = clamp(q.get('t') || 'New commit', 60);
  const body = clamp(q.get('d') || '', 140);
  const date = clamp(q.get('date') || '', 10);
  const author = clamp(q.get('author') || '', 40);

  // Branded poster: reuse the generic OG renderer with the commit section.
  const poster =
    `${BASE}/api/page-og?s=commit` +
    `&t=${encodeURIComponent(headline)}` +
    `&d=${encodeURIComponent(body)}` +
    `&p=${encodeURIComponent('/changelog')}`;

  const title = esc(headline);
  const descParts = [body, [date, author].filter(Boolean).join(' · ')].filter(Boolean);
  const description = esc(descParts.join(' · '));

  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400');
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · three.ws</title>
<meta name="description" content="${description}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="three.ws">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${esc(commitUrl)}">
<meta property="og:image" content="${esc(poster)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${esc(poster)}">
<meta http-equiv="refresh" content="0; url=${esc(commitUrl)}">
<link rel="canonical" href="${esc(commitUrl)}">
<style>
  html,body{margin:0;height:100%;background:#050507;color:#ebebf5;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{min-height:100%;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;text-align:center;padding:24px}
  a{color:#818cf8;font-weight:600;text-decoration:none}
  a:hover{text-decoration:underline}
  p{color:rgba(235,235,245,.55);margin:0}
</style>
</head>
<body>
<main>
  <h1 style="margin:0;font-size:28px">${title}</h1>
  <p>Opening the commit on GitHub…</p>
  <a href="${esc(commitUrl)}">${esc(commitUrl.replace('https://', ''))}</a>
</main>
<script>location.replace(${JSON.stringify(commitUrl)});</script>
</body>
</html>`);
}
