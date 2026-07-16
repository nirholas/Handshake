/**
 * GET /api/irl/share/[token] — the unfurl page for a minted IRL share link
 * (see ../share.js for how a token is created). Exposed to browsers/crawlers
 * at the pretty path /irl/s/:token via a vercel.json rewrite.
 *
 * Renders the user's own AR capture full-bleed with real og:image/twitter:image
 * tags (so pasting the link into X/Discord/iMessage unfurls the actual photo,
 * not a generic logo) and a single "Place your own agent" CTA back to /irl —
 * the growth loop this whole feature exists for.
 *
 * Privacy: the page title/description ever renders the pin's caption or the
 * agent's name — NEVER coordinates, NEVER the owner's identity. Same rule the
 * rest of /api/irl/pins already enforces on every public projection.
 */

import { wrap, cors, error } from '../../_lib/http.js';
import { sql } from '../../_lib/db.js';
import { recordShareView, ensureIrlAnalyticsSchema } from '../../_lib/irl-analytics.js';

function esc(s) {
	return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function originFrom(req) {
	const host = req.headers['x-forwarded-host'] || req.headers.host || 'three.ws';
	const proto = req.headers['x-forwarded-proto'] || (/^localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https');
	return `${proto}://${host}`;
}

function notFoundPage() {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>Share link expired · three.ws</title>
<meta name="robots" content="noindex"/>
<style>:root{color-scheme:dark}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:radial-gradient(130% 130% at 50% 0%,#14161c,#08090c);color:#e8eaf0;text-align:center;padding:28px}
.c{max-width:38ch}.h{font-size:16px;font-weight:600;margin-bottom:10px}.m{color:#9aa3b2;font-size:13px;line-height:1.5}
a{display:inline-block;margin-top:16px;color:#0b0c10;background:#6ea8fe;border-radius:10px;padding:11px 18px;text-decoration:none;font-weight:700;font-size:13px}</style></head>
<body><div class="c"><div class="h">This share link isn't available anymore</div><div class="m">The agent may have moved, or the link expired.</div>
<a href="/irl">Open IRL</a></div></body></html>`;
}

function sharePage({ imageUrl, name, caption, pageUrl, origin }) {
	const t = name ? esc(name) : 'An agent';
	const desc = caption ? esc(caption).slice(0, 160) : 'Someone placed a living 3D agent in the real world with three.ws.';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>${t} · IRL · three.ws</title>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="three.ws"/>
<meta property="og:title" content="${t} was placed in the real world"/>
<meta property="og:description" content="${desc}"/>
<meta property="og:image" content="${esc(imageUrl)}"/>
<meta property="og:url" content="${esc(pageUrl)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${t} was placed in the real world"/>
<meta name="twitter:description" content="${desc}"/>
<meta name="twitter:image" content="${esc(imageUrl)}"/>
<style>:root{color-scheme:dark;--accent:#6ea8fe}*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#08090c;color:#e8eaf0}
.wrap{display:flex;flex-direction:column;min-height:100dvh}
.stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#000}
.stage img{max-width:100%;max-height:100dvh;object-fit:contain}
.name{position:absolute;top:14px;left:50%;transform:translateX(-50%);max-width:min(86vw,48ch);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cdd3de;font-size:13px;font-weight:600;background:rgba(10,11,14,.55);border:1px solid rgba(255,255,255,.08);border-radius:999px;padding:6px 14px;backdrop-filter:blur(8px)}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:center;padding:14px 16px;border-top:1px solid rgba(255,255,255,.07);background:rgba(10,11,14,.65);backdrop-filter:blur(8px)}
a.cta{appearance:none;cursor:pointer;text-decoration:none;font-size:14px;font-weight:700;color:#0b0c10;background:var(--accent);border:0;border-radius:12px;padding:12px 20px;display:inline-flex;align-items:center;gap:8px}
a.alt{color:#aeb6c4;font-size:12.5px;text-decoration:underline;align-self:center}</style></head>
<body><div class="wrap"><div class="stage">
<img src="${esc(imageUrl)}" alt="${t} placed in the real world" />
<div class="name">${t}${caption ? ' · ' + esc(caption).slice(0, 60) : ''}</div>
</div>
<div class="bar">
<a class="cta" href="${esc(origin)}/irl" aria-label="Place your own AI agent in augmented reality">📍 Place your own agent</a>
<a class="alt" href="${esc(origin)}/irl">What is this?</a>
</div></div></body></html>`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (req.method?.toUpperCase() !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const token = String(req.query?.token || '').trim();
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600');

	if (!token) {
		res.statusCode = 404;
		return res.end(notFoundPage());
	}

	// Self-provisioning schema (matches api/irl/share.js's create path): on a
	// fresh database no share has ever been created, so irl_pin_shares may not
	// exist yet. Without this guard the SELECT below 500s with a bare Postgres
	// "relation does not exist" instead of the designed not-found page —
	// exactly the failure this endpoint exists to never show a visitor.
	await ensureIrlAnalyticsSchema();

	const [row] = await sql`
		SELECT s.image_url, p.avatar_name, p.caption, p.published, p.hidden_at
		FROM irl_pin_shares s
		JOIN irl_pins p ON p.id = s.pin_id
		WHERE s.token = ${token}
	`;

	if (!row || row.published === false || row.hidden_at) {
		res.statusCode = 404;
		return res.end(notFoundPage());
	}

	// Best-effort view counter; never blocks the render on a DB hiccup.
	recordShareView(token).catch(() => {});

	const origin = originFrom(req);
	res.statusCode = 200;
	return res.end(
		sharePage({
			imageUrl: row.image_url,
			name: row.avatar_name,
			caption: row.caption,
			pageUrl: `${origin}/irl/s/${token}`,
			origin,
		}),
	);
});
