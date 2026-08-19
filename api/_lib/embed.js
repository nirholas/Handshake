// Shared embed-snippet builders.
//
// Both the oEmbed provider (api/agent-oembed.js) and the get_embed_code MCP tool
// hand callers a copy-paste <iframe> that unfurls a three.ws 3D viewer inline in
// Notion / Webflow / Framer / a blog. They render that iframe through THESE
// helpers so the markup and the canonical URL shapes never drift between the two
// surfaces. Nothing here touches the database or the network — pure URL/string
// assembly — so it's cheap to import from a serverless handler.

// Social-card dimensions every three.ws OG endpoint emits (agent/og, a-og,
// forge-og). Exposed so oEmbed payloads can advertise a correct thumbnail size.
export const EMBED_THUMB = { width: 1200, height: 630 };

// Clamp a caller-supplied width/height to sane bounds, falling back to a default
// for missing or nonsensical input. Embeds clamp rather than error so a too-big
// number still yields a usable snippet (see the get_embed_code contract).
export function clampEmbedDim(raw, fallback, min, max) {
	const n = raw === null || raw === undefined || raw === '' ? NaN : parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.max(min, Math.min(max, n));
}

function escapeAttr(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// The single canonical embed iframe used everywhere three.ws hands out a snippet:
// sandboxed, lazy-loaded, responsive (max-width:100%), AR/XR + fullscreen capable.
// autorotate/ar default on; when either is turned off it's appended as a query
// hint the embed page can honor (and which is harmless to pages that don't).
export function buildEmbedIframe({ src, width, height, title, autorotate = true, ar = true }) {
	const hints = [];
	if (autorotate === false) hints.push('autorotate=0');
	if (ar === false) hints.push('ar=0');
	const url = hints.length ? `${src}${src.includes('?') ? '&' : '?'}${hints.join('&')}` : src;
	const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
	return (
		`<iframe src="${escapeAttr(url)}" width="${width}" height="${height}"${titleAttr} ` +
		`loading="lazy" style="border:0;border-radius:12px;max-width:100%" ` +
		`allow="autoplay; fullscreen; xr-spatial-tracking" allowfullscreen ` +
		`sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`
	);
}

// ── Canonical URL shapes per target ──────────────────────────────────────────
// embedUrl    → the iframe src (renders the 3D viewer standalone)
// shareUrl    → the human-facing page to link/share
// thumbnailUrl→ the Open Graph social card

export function agentEmbedTarget(origin, id) {
	return {
		embedUrl: `${origin}/agents/${id}/embed`,
		shareUrl: `${origin}/agents/${id}`,
		thumbnailUrl: `${origin}/api/agents/${id}/og`,
	};
}

export function onchainEmbedTarget(origin, chainId, agentId) {
	const enc = encodeURIComponent(String(agentId));
	return {
		embedUrl: `${origin}/a/${chainId}/${enc}/embed`,
		shareUrl: `${origin}/a/${chainId}/${enc}`,
		thumbnailUrl: `${origin}/api/a-og?chain=${chainId}&id=${enc}`,
	};
}

// glbUrl/title are optional so callers that only have the id (e.g. building a
// shareUrl before the row is loaded) still get a valid, if generic, target.
// When glbUrl is supplied, embedUrl points at the lightweight, zero-dependency
// /forge/embed viewer (orbit + AR + branding) — the same route
// src/forge-embed-snippets.js hands out in copy-paste snippets — rather than the
// full Forge app, so an <iframe src="embedUrl"> stays small and AR-capable.
export function forgeEmbedTarget(origin, id, glbUrl, title) {
	const enc = encodeURIComponent(String(id));
	const embedUrl = glbUrl
		? `${origin}/forge/embed?${new URLSearchParams({
				src: glbUrl,
				...(title ? { title: String(title).slice(0, 120) } : {}),
			})}`
		: `${origin}/forge?share=${enc}`;
	return {
		embedUrl,
		shareUrl: `${origin}/forge/share/${id}`,
		thumbnailUrl: `${origin}/api/forge-og?id=${enc}`,
	};
}

// oEmbed discovery URL for a target the /api/oembed provider resolves (agents and
// on-chain agents). Returns the endpoint that yields the oEmbed JSON for shareUrl.
export function oembedUrl(origin, shareUrl) {
	return `${origin}/api/oembed?url=${encodeURIComponent(shareUrl)}`;
}
