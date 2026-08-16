/**
 * Agent OG image endpoint
 * -----------------------
 * GET /api/agent/:id/og
 *
 * Happy path: 302 to the avatar's thumbnail_url so Slack/X/Discord cache
 * a real PNG of the avatar. Fallback: a server-rendered SVG card — Slack,
 * X, and Discord all accept image/svg+xml for OG images, so we avoid
 * pulling in canvas/imagemagick on the serverless side.
 */

import { sql } from './_lib/db.js';
import { getAvatar } from './_lib/avatars.js';
import { cors, wrap } from './_lib/http.js';
import { isUuid } from './_lib/validate.js';

const CACHE_CARD = 'public, max-age=3600, s-maxage=86400';
const CACHE_REDIR = 'public, max-age=3600';

// agent_identities.id is a uuid column. Crawlers and broken share links hit this
// public route with a literal ":id" placeholder (when a page template forgets to
// interpolate the real id) or other junk; passing that straight to Postgres throws
// `invalid input syntax for type uuid` (22P02) and 500s. Validate the shape up
// front so any non-uuid degrades to a clean 404 instead of an unhandled error.
export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('id');

	if (!agentId || !isUuid(agentId)) return sendNotFound(res);

	const [agent] = await sql`
		SELECT id, name, description, avatar_id
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!agent) return sendNotFound(res);

	if (agent.avatar_id) {
		// getAvatar() derives its urls through env.S3_PUBLIC_DOMAIN, which THROWS when
		// object storage isn't configured on a deployment. That must degrade to the SVG
		// card this handler already promises, never to a 503 in a crawler's face: the
		// same rule api/og/agent.js follows for the identical hazard.
		const avatar = await getAvatar({ id: agent.avatar_id }).catch(() => null);
		if (avatar?.thumbnail_url) {
			res.statusCode = 302;
			res.setHeader('location', avatar.thumbnail_url);
			res.setHeader('cache-control', CACHE_REDIR);
			res.end();
			return;
		}
	}

	sendCardSvg(res, 200, CACHE_CARD, {
		name: agent.name || 'Agent',
		description: agent.description || 'An embodied three.ws.',
	});
});

function sendNotFound(res) {
	sendCardSvg(res, 404, 'public, max-age=60', {
		name: 'Agent not found',
		description: '',
	});
}

function sendCardSvg(res, status, cacheControl, { name, description }) {
	res.statusCode = status;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', cacheControl);
	res.end(renderCardSvg({ name, description }));
}

function renderCardSvg({ name, description }) {
	const safeName = escapeXml(truncate(name, 60));
	const safeDesc = escapeXml(truncate(description, 140));
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${safeName}">
	<rect width="1200" height="630" fill="#0b0d10"/>
	<text x="80" y="140" fill="#e5e5e5" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="56" font-weight="300">◎</text>
	<text x="80" y="320" fill="#e5e5e5" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="76" font-weight="300" letter-spacing="-2">${safeName}</text>
	<text x="80" y="390" fill="rgba(229,229,229,0.55)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="28" font-weight="400">${safeDesc}</text>
	<text x="80" y="570" fill="rgba(229,229,229,0.3)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="20" font-weight="400" letter-spacing="4">three.ws</text>
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
