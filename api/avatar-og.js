/**
 * Avatar OG image endpoint
 * ------------------------
 * GET /api/avatar/:id/og
 *
 * Strategy, in order:
 *   1. If the avatar has a cached thumbnail in R2 (set by the customizer-save
 *      snapshot flow or by a previous server render), 302 to its public URL.
 *   2. Otherwise, if the avatar's GLB is publicly reachable, render a PNG
 *      preview via headless chromium, cache it in R2, write back the
 *      thumbnail_key, and stream the PNG response.
 *   3. Demo avatars (avatar_demo_*) and not-found IDs get the SVG card.
 *   4. Any failure of the renderer (timeout, too-large GLB, private avatar,
 *      unreachable model URL) falls through to the site OG logo. CLAUDE.md
 *      forbids placeholder data — the logo is a real, branded image, not a
 *      synthetic "no preview" SVG.
 *
 * The renderer is amortized: only the first crawl of an avatar pays the
 * chromium cost. Every subsequent crawl hits step (1) and 302s out.
 */

import { sql } from './_lib/db.js';
import { getAvatar } from './_lib/avatars.js';
import { cors, method, wrap } from './_lib/http.js';
import { putObject } from './_lib/r2.js';
import { renderGlbToPng } from './_lib/render-glb.js';
import { thumbBackdropFor } from './_lib/avatar-thumbs.js';

const CACHE_CARD_OK = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
const CACHE_CARD_404 = 'public, max-age=60';
const CACHE_REDIR = 'public, max-age=3600';
const CACHE_RENDERED = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800';
const CACHE_FALLBACK = 'public, max-age=300';

// Anything bigger than this would dominate the 15s render budget — and
// Vercel's 30s function ceiling means a single oversized GLB risks killing
// the request. Falls back to the named avatar card instead. Set at 12 MB:
// comfortably renders typical photoreal GLBs (which cluster just above 10 MB)
// while still kicking the genuinely huge ones to the card before chromium.
const MAX_GLB_BYTES = 12 * 1024 * 1024;

// Per-avatar lock so two simultaneous crawls don't both spin up chromium.
// In-memory only — multiple lambda containers may each render once, but
// they settle to the same cached R2 object via the DB write-back.
const _renderLocks = new Map();

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	// A crawler only ever GETs (or HEADs, which method() folds into GET). Gate the
	// rest: the miss path launches chromium and writes to R2, so an unguarded POST
	// is a free way to make the origin do the most expensive work it has.
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const avatarId = url.searchParams.get('id') || extractIdFromPath(url.pathname);

	if (!avatarId) {
		return sendCardSvg(res, 404, CACHE_CARD_404, {
			name: 'Avatar not found',
			description: '',
		});
	}

	const avatar = await getAvatar({ id: avatarId });
	if (!avatar) {
		return sendCardSvg(res, 404, CACHE_CARD_404, {
			name: 'Avatar not found',
			description: '',
		});
	}

	// Cached thumbnail, either client-uploaded (customizer save) or a previous
	// server render. Either way it's a real R2 object; redirect.
	//
	// Legacy poisoned keys (absolute, origin-pointing `*_og.png`, written by the
	// pre-fix ogKeyFor) never reach this branch: `thumbnailUrl()` in
	// api/_lib/r2.js already refuses to resolve them and hands back null. Do NOT
	// re-run that check against `thumbnail_url` here: it is a bucket URL, so a
	// perfectly good server-rendered thumbnail (`.../u/uid/x/abc_og.png`) matches
	// the poisoned-key shape too, and the endpoint ends up wiping its own cache
	// on every crawl. The healing write for a genuinely poisoned key lives in
	// renderAndCache's write-back guard instead.
	if (avatar.thumbnail_url) {
		res.statusCode = 302;
		res.setHeader('location', avatar.thumbnail_url);
		res.setHeader('cache-control', CACHE_REDIR);
		res.end();
		return;
	}

	// Private avatars have no public model_url, so headless chromium can't
	// fetch the GLB. Serve the SVG card with whatever name/desc/tags exist.
	if (!avatar.model_url) {
		return sendCardSvg(res, 200, CACHE_CARD_OK, {
			name: avatar.name || 'Avatar',
			description: avatar.description || 'A 3D avatar on three.ws',
			tags: avatar.tags || [],
		});
	}

	// Server render path. Anything that goes wrong falls back to the site
	// logo — a 200/302 with the brand logo is strictly better than a 500
	// to a Twitter/Slack/Discord crawler, which would cache the failure.
	try {
		const png = await renderAndCache({ avatar });
		res.statusCode = 200;
		res.setHeader('content-type', 'image/png');
		res.setHeader('cache-control', CACHE_RENDERED);
		res.end(png);
		return;
	} catch (err) {
		console.warn('[avatar-og] render fallback', { avatarId, err: err?.message });
		// Render failed (oversized GLB, timeout, unreachable model). We still hold
		// the avatar's real metadata, so serve the branded, *named* card — strictly
		// better for a Twitter/Slack/Discord crawler than the anonymous site logo,
		// and the crawler caches a card that actually identifies the avatar.
		return sendCardSvg(res, 200, CACHE_FALLBACK, {
			name: avatar.name || 'Avatar',
			description: avatar.description || 'A 3D avatar on three.ws',
			tags: avatar.tags || [],
		});
	}
});

// Render + upload + DB write-back, sharing in-flight work across concurrent
// crawls. The returned PNG buffer is what every caller receives.
async function renderAndCache({ avatar }) {
	const existing = _renderLocks.get(avatar.id);
	if (existing) return existing;

	const promise = (async () => {
		// Size precheck. A 50 MB GLB would blow the render budget and risk
		// OOM; kick those out to the fallback before launching chromium.
		const head = await fetch(avatar.model_url, { method: 'HEAD' }).catch(() => null);
		const contentLength = Number(head?.headers?.get('content-length') || 0);
		if (head?.ok && contentLength > MAX_GLB_BYTES) {
			throw Object.assign(new Error(`glb too large: ${contentLength} bytes`), {
				code: 'glb_too_large',
			});
		}
		// Don't blow up on a missing content-length — some R2 deployments
		// omit it; we lose the precheck and rely on the render timeout.

		const png = await renderGlbToPng({
			glbUrl: avatar.model_url,
			width: 1200,
			height: 630,
			background: '#0a0a0a',
			backdrop: thumbBackdropFor(avatar.id),
		});

		const ogKey = ogKeyFor(avatar);
		await putObject({
			key: ogKey,
			body: png,
			contentType: 'image/png',
			metadata: { source: 'server-render', avatar_id: avatar.id },
		});
		// Single UPDATE — bypasses ownership/visibility checks in
		// updateAvatar() because this is an internal cache write, not a
		// user-initiated edit. Guarded so a concurrent customizer-save snapshot
		// isn't clobbered: it only writes over an empty slot, or over a legacy
		// poisoned key (an absolute, origin-pointing `*_og.png` from the pre-fix
		// ogKeyFor). Without that second arm a poisoned row could never be
		// repaired, so it would re-render through chromium on every single crawl.
		await sql`
			update avatars set thumbnail_key = ${ogKey}, updated_at = now()
			where id = ${avatar.id} and deleted_at is null
			  and (thumbnail_key is null or thumbnail_key ~* '^https?://.*_og[.]png$')
		`;
		return png;
	})();

	_renderLocks.set(avatar.id, promise);
	try {
		return await promise;
	} finally {
		_renderLocks.delete(avatar.id);
	}
}

// OG cache key. For bucket-backed avatars (the `u/{owner}/…/file.glb` form) it
// lives alongside the GLB so it shares lifetime + deletion semantics; the
// `_og.png` suffix distinguishes it from `_thumb.jpg` (the client-uploaded
// customizer snapshot).
//
// First-party / externally-hosted avatars store an ABSOLUTE URL in
// `storage_key` (e.g. https://three.ws/avatars/michelle.glb). That is not a
// writable bucket key — deriving `_og.png` from it yields a URL-shaped "key"
// (https://three.ws/avatars/michelle_og.png) that putObject can't serve and
// that 404s the instant it's surfaced as a thumbnail. Cache those under a
// deterministic bucket path keyed by the avatar id instead.
function ogKeyFor(avatar) {
	if (/^https?:\/\//i.test(avatar.storage_key || '')) {
		return `og/avatar/${avatar.id}.png`;
	}
	return avatar.storage_key.replace(/\.glb$/i, '') + '_og.png';
}

// Vercel routes /api/avatar/:id/og → here. Read the id from the URL path
// when the rewrite leaves it as a path segment instead of a query param.
function extractIdFromPath(pathname) {
	const m = pathname.match(/\/api\/avatar(?:s)?\/([^/]+)\/og$/);
	return m ? m[1] : null;
}

function sendCardSvg(res, status, cacheControl, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', cacheControl);
	res.end(renderCardSvg(payload));
}

function renderCardSvg({ name, description, attribution, tags = [] }) {
	const safeName = escapeXml(truncate(name, 60));
	const safeDesc = escapeXml(truncate(description, 160));
	const safeAttr = attribution ? escapeXml(truncate(attribution, 40)) : '';
	const tagPills = tags.slice(0, 4).map((t, i) => {
		const x = 80 + i * 120;
		const w = Math.min(110, 24 + escapeXml(t).length * 11);
		return `
			<rect x="${x}" y="450" width="${w}" height="36" rx="18" fill="rgba(125,211,252,0.12)" stroke="rgba(125,211,252,0.3)" stroke-width="1.2"/>
			<text x="${x + w / 2}" y="475" text-anchor="middle" fill="#7dd3fc" font-family="Inter, sans-serif" font-size="16" font-weight="600">${escapeXml(t).slice(0, 14)}</text>`;
	}).join('');
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${safeName}">
	<defs>
		<radialGradient id="bg-cyan" cx="85%" cy="20%" r="60%">
			<stop offset="0%" stop-color="rgba(125,211,252,0.18)"/>
			<stop offset="100%" stop-color="rgba(125,211,252,0)"/>
		</radialGradient>
		<radialGradient id="bg-purple" cx="15%" cy="80%" r="55%">
			<stop offset="0%" stop-color="rgba(167,139,250,0.14)"/>
			<stop offset="100%" stop-color="rgba(167,139,250,0)"/>
		</radialGradient>
		<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0%" stop-color="#7dd3fc"/>
			<stop offset="100%" stop-color="#a78bfa"/>
		</linearGradient>
	</defs>
	<rect width="1200" height="630" fill="#0a0a0a"/>
	<rect width="1200" height="630" fill="url(#bg-cyan)"/>
	<rect width="1200" height="630" fill="url(#bg-purple)"/>
	<rect x="0" y="0" width="6" height="630" fill="url(#accent)"/>
	<text x="80" y="120" fill="#7dd3fc" font-family="Inter, sans-serif" font-size="14" font-weight="600" letter-spacing="3">COMMUNITY · 3D AVATAR</text>
	<text x="80" y="270" fill="#fafafa" font-family="'Space Grotesk', Inter, sans-serif" font-size="92" font-weight="700" letter-spacing="-2">${safeName}</text>
	<text x="80" y="340" fill="rgba(250,250,250,0.65)" font-family="Inter, sans-serif" font-size="26" font-weight="400">${safeDesc}</text>
	${tagPills}
	${safeAttr ? `<text x="80" y="555" fill="rgba(250,250,250,0.4)" font-family="Inter, sans-serif" font-size="18" font-weight="400">by ${safeAttr}</text>` : ''}
	<text x="1120" y="585" text-anchor="end" fill="rgba(250,250,250,0.35)" font-family="Inter, sans-serif" font-size="20" font-weight="500" letter-spacing="3">three.ws</text>
</svg>`;
}

function truncate(s, n) {
	s = String(s || '');
	return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function escapeXml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

// Test seam — let suites assert against the in-memory render lock map.
export const __testInternals = { renderAndCache, ogKeyFor, _renderLocks };
