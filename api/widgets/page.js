/**
 * Server-rendered widget metadata page
 * ------------------------------------
 * GET /api/widgets/page?id=<widget-id>
 *
 * Wired to /w/:id via vercel.json. Returns an HTML page with proper Open Graph
 * + Twitter card + oEmbed link tags so social crawlers (Slack, Discord, X,
 * WordPress, Ghost) get a rich preview. Real browsers run the inline script
 * and replace into the slim viewer at /widget#widget=<id> (legacy
 * /app#widget=<id> still works for any embedders that copied the old URL).
 */

import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { cors, wrap } from '../_lib/http.js';
import { isDemoWidgetId, getDemoWidget } from './_demo-fixtures.js';

// ── inline embed-policy helpers (prompt 02 / api/_lib/embed-policy.js not yet shipped) ──

function _defaultPolicy() {
	return {
		version: 1,
		origins: { mode: 'allowlist', hosts: [] },
		surfaces: { script: true, iframe: true, widget: true, mcp: true },
	};
}

function _parsePolicy(p) {
	if (!p) return null;
	if (!('version' in p) && ('mode' in p || 'hosts' in p)) {
		// Old flat shape — only origins were configured; all surfaces allowed.
		return {
			..._defaultPolicy(),
			origins: { mode: p.mode || 'allowlist', hosts: p.hosts ?? [] },
		};
	}
	return { ..._defaultPolicy(), ...p };
}

async function _readPolicyForAgent(agentId) {
	try {
		const [row] =
			await sql`SELECT embed_policy FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
		if (!row) return null;
		return _parsePolicy(row.embed_policy);
	} catch (err) {
		if (/column .* does not exist/i.test(String(err?.message))) return null;
		throw err;
	}
}

function _originAllowed(refererHeader, policy, appOriginHost) {
	if (!refererHeader) return true; // no referer → allow (bots, direct)
	let host;
	try {
		host = new URL(refererHeader).hostname.toLowerCase();
	} catch {
		return true;
	}
	if (host === appOriginHost || host === 'localhost' || host.endsWith('.localhost')) return true;
	const hosts = policy?.origins?.hosts ?? [];
	const mode = policy?.origins?.mode ?? 'allowlist';
	const matched = hosts.some((h) => {
		const lower = h.toLowerCase();
		if (lower.startsWith('*.')) return host.endsWith(lower.slice(1)) && host !== lower.slice(2);
		return host === lower;
	});
	return mode === 'allowlist' ? matched : !matched;
}

const TYPE_LABEL = {
	turntable: 'Turntable Showcase',
	'animation-gallery': 'Animation Gallery',
	'talking-agent': 'Talking Agent',
	passport: 'ERC-8004 Passport',
	'hotspot-tour': 'Hotspot Tour',
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const widgetId = url.searchParams.get('id');
	if (!widgetId) return notFound(res);

	const widget = await loadWidget(widgetId);
	if (!widget) return notFound(res);

	// Agent embed-policy gate — only when widget is tied to an agent identity.
	if (widget.agent_id) {
		const agentPolicy = await _readPolicyForAgent(widget.agent_id);
		if (agentPolicy) {
			if (agentPolicy.surfaces?.widget === false) {
				return forbidden(res, "This widget's embed is disabled by the agent owner.");
			}
			const appHost = new URL(env.APP_ORIGIN).hostname.toLowerCase();
			if (!_originAllowed(req.headers['referer'], agentPolicy, appHost)) {
				return forbidden(res, 'This widget is not permitted on the requesting origin.');
			}
		}
	}

	const origin = env.APP_ORIGIN;
	const pageUrl = `${origin}/w/${widget.id}`;
	const ogUrl = `${origin}/api/widgets/${widget.id}/og`;

	if (widget.is_public === false) {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.setHeader('cache-control', 'private, max-age=60');
		res.end(renderPrivateHtml({ pageUrl, ogUrl }));
		return;
	}

	const embedUrl = `${origin}/widget#widget=${widget.id}&kiosk=true`;
	const oembedJs = `${origin}/api/widgets/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;
	const title = widget.name || 'Widget';
	const typeLbl = TYPE_LABEL[widget.type] || 'Widget';
	const desc = `${typeLbl} · embeddable 3D, no code. Powered by three.ws.`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=300, s-maxage=900');
	res.end(renderHtml({ title, desc, pageUrl, embedUrl, ogUrl, oembedJs, widgetId: widget.id }));
});

async function loadWidget(id) {
	if (isDemoWidgetId(id)) {
		const demo = getDemoWidget(id);
		if (!demo) return null;
		return {
			id: demo.id,
			name: demo.name,
			type: demo.type,
			avatar_id: null,
			agent_id: null,
			is_public: true,
		};
	}
	try {
		const [row] = await sql`
			select id, name, type, avatar_id, agent_id, is_public
			from widgets
			where id = ${id} and deleted_at is null
			limit 1
		`;
		return row || null;
	} catch (err) {
		if (/column .* does not exist/i.test(err?.message || '')) {
			// agent_id column not yet migrated — fall back without it
			const [row] = await sql`
				select id, name, type, avatar_id, is_public
				from widgets
				where id = ${id} and deleted_at is null
				limit 1
			`;
			return row || null;
		}
		if (/relation .* does not exist/i.test(err?.message || '')) return null;
		throw err;
	}
}

function forbidden(res, msg) {
	res.statusCode = 403;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60');
	const m = escapeHtml(msg || 'Access denied.');
	res.end(`<!doctype html><meta charset="utf-8"><title>Access denied</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:2rem}a{color:#8b5cf6}</style>
<main><h1>Access denied</h1><p>${m}</p><p><a href="/">Open three.ws</a></p></main>`);
}

function notFound(res) {
	res.statusCode = 404;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60');
	res.end(`<!doctype html><meta charset="utf-8"><title>Widget not found</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:2rem}a{color:#8b5cf6}</style>
<main><h1>Widget not found</h1><p>This widget may have been deleted, or the link is wrong.</p><p><a href="/widgets">Browse the gallery</a> · <a href="/">Open viewer</a></p></main>`);
}

function renderHtml({ title, desc, pageUrl, embedUrl, ogUrl, oembedJs, widgetId }) {
	const t = escapeHtml(title);
	const d = escapeHtml(desc);
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="X-UA-Compatible" content="IE=edge">
	<title>${t} — three.ws</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#0a0a0a">

	<meta property="og:type" content="website">
	<meta property="og:site_name" content="three.ws">
	<meta property="og:title" content="${t}">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${escapeAttr(pageUrl)}">
	<meta property="og:image" content="${escapeAttr(ogUrl)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="${t}">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${escapeAttr(ogUrl)}">

	<link rel="canonical" href="${escapeAttr(pageUrl)}">
	<link rel="alternate" type="application/json+oembed" href="${escapeAttr(oembedJs)}" title="${t}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#0a0a0a;color:#e0e0e0;font-family:Inter,system-ui,sans-serif;height:100%;overflow:hidden}
		.shell{display:grid;place-items:center;height:100vh;text-align:center;padding:2rem;gap:1rem}
		.shell a{color:#8b5cf6;text-decoration:none}
		.shell a:hover{text-decoration:underline}
		.spinner{width:32px;height:32px;border:2px solid rgba(255,255,255,0.1);border-top-color:#8b5cf6;border-radius:50%;animation:spin 1s linear infinite}
		@keyframes spin{to{transform:rotate(360deg)}}
		@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
	</style>
</head>
<body>
	<noscript>
		<div class="shell">
			<h1>${t}</h1>
			<p>${d}</p>
			<p><a href="${escapeAttr(embedUrl)}">Open viewer</a></p>
		</div>
	</noscript>
	<div class="shell" id="loading" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Loading ${t}…</p>
	</div>
	<script>
		// Real browsers: replace into the SPA so back-button doesn't loop.
		// Crawlers / bots: ignored, they parse the OG tags above.
		(function () {
			var target = ${JSON.stringify(embedUrl)};
			try {
				var u = new URL(window.location.href);
				if (u.searchParams.get('embed') === '0') return;  // escape hatch for debugging
			} catch (e) {}
			window.location.replace(target);
		})();
	</script>
	<script type="application/ld+json">
${escapeJsonLd({
	'@context': 'https://schema.org',
	'@type': 'CreativeWork',
	name: title,
	description: desc,
	url: pageUrl,
	image: ogUrl,
	identifier: widgetId,
	provider: { '@type': 'Organization', name: 'three.ws', url: 'https://three.ws/' },
})}
	</script>
</body>
</html>`;
}

function renderPrivateHtml({ pageUrl, ogUrl }) {
	const title = 'Private widget';
	const desc = 'This widget is private.';
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>${title} — three.ws</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name="description" content="${desc}">
	<meta name="robots" content="noindex, nofollow">
	<meta name="theme-color" content="#0a0a0a">

	<meta property="og:type" content="website">
	<meta property="og:site_name" content="three.ws">
	<meta property="og:title" content="${title}">
	<meta property="og:description" content="${desc}">
	<meta property="og:url" content="${escapeAttr(pageUrl)}">
	<meta property="og:image" content="${escapeAttr(ogUrl)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="${title}">
	<meta name="twitter:description" content="${desc}">
	<meta name="twitter:image" content="${escapeAttr(ogUrl)}">

	<link rel="canonical" href="${escapeAttr(pageUrl)}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#0a0a0a;color:#e0e0e0;font-family:Inter,system-ui,sans-serif;height:100%}
		main{display:grid;place-items:center;height:100vh;text-align:center;padding:2rem;gap:1rem}
		a{color:#8b5cf6;text-decoration:none}
		a:hover{text-decoration:underline}
	</style>
</head>
<body>
	<main>
		<h1>${title}</h1>
		<p>${desc} The owner hasn't shared it publicly.</p>
		<p><a href="/">Open three.ws</a></p>
	</main>
</body>
</html>`;
}

function escapeHtml(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
function escapeAttr(s) {
	return escapeHtml(s);
}
function escapeJsonLd(obj) {
	return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}
