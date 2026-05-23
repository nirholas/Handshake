/**
 * User-profile OG image endpoint
 * ------------------------------
 * GET /api/u-og?username=<u>
 *
 * Renders an SVG OG card for /u/<username>. If the user has claimed
 * <username>.threews.sol, the SVG carries a verified-on-Solana badge so the
 * preview in Slack/X/Discord/Telegram advertises the on-chain handle.
 *
 * SVG instead of @vercel/og: cheap (no canvas / no chrome), instantly
 * cacheable, and all major link unfurlers accept image/svg+xml.
 */

import { sql } from './_lib/db.js';
import { cors, wrap } from './_lib/http.js';
import { PARENT_LABEL } from './_lib/threews-sns.js';

const CACHE_OK = 'public, max-age=300, s-maxage=3600';
const CACHE_404 = 'public, max-age=60';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const raw = (url.searchParams.get('username') || '').trim().toLowerCase();
	if (!raw || !/^[a-z0-9_-]{3,30}$/.test(raw)) {
		return send(res, 400, CACHE_404, {
			handle: '',
			display: 'Invalid username',
			subdomain: null,
			stats: null,
		});
	}

	const [user] = await sql`
		SELECT id, username, display_name
		FROM users
		WHERE lower(username) = ${raw} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!user) {
		return send(res, 404, CACHE_404, {
			handle: raw,
			display: 'User not found',
			subdomain: null,
			stats: null,
		});
	}

	const [claimRow] = await sql`
		SELECT label FROM user_subdomains
		WHERE user_id = ${user.id} AND parent = ${PARENT_LABEL}
		LIMIT 1
	`;
	const subdomain = claimRow ? `${claimRow.label}.${PARENT_LABEL}.sol` : null;

	// Lightweight stat strip — same numbers the showcase shows.
	const [statRow] = await sql`
		SELECT
			(SELECT count(*) FROM avatars         WHERE owner_id = ${user.id} AND visibility = 'public' AND deleted_at IS NULL) AS avatars,
			(SELECT count(*) FROM agent_identities WHERE user_id = ${user.id} AND is_public = true AND deleted_at IS NULL)        AS agents
	`;
	const stats = {
		avatars: Number(statRow?.avatars || 0),
		agents: Number(statRow?.agents || 0),
	};

	return send(res, 200, CACHE_OK, {
		handle: user.username,
		display: user.display_name || user.username,
		subdomain,
		stats,
	});
});

function send(res, status, cacheControl, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', cacheControl);
	res.end(renderCard(payload));
}

function renderCard({ handle, display, subdomain, stats }) {
	const name = escapeXml(truncate(display || handle, 36));
	const at = handle ? `@${escapeXml(truncate(handle, 30))}` : '';
	const sub = subdomain ? escapeXml(subdomain) : null;
	const counts = stats
		? [
				stats.avatars ? `${stats.avatars} avatar${stats.avatars === 1 ? '' : 's'}` : null,
				stats.agents ? `${stats.agents} agent${stats.agents === 1 ? '' : 's'}` : null,
			].filter(Boolean).join('  ·  ')
		: '';

	// Verified badge — six-pointed star + subdomain. Only drawn when the user
	// has actually claimed `<handle>.threews.sol`.
	const badge = sub
		? `
		<g transform="translate(80, 460)">
			<rect x="0" y="0" rx="999" ry="999" width="${28 + sub.length * 14}" height="44" fill="rgba(105,225,111,0.08)" stroke="rgba(105,225,111,0.4)"/>
			<path transform="translate(14, 22) scale(.9)" fill="#69e16f" d="M0 -12 L3.6 -3.6 L12 -2.4 L6 4 L7.2 12 L0 8 L-7.2 12 L-6 4 L-12 -2.4 L-3.6 -3.6 Z"/>
			<text x="34" y="29" fill="#69e16f" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="20" font-weight="500" letter-spacing="-.2">${sub}</text>
		</g>`
		: '';

	const handlePill = at
		? `
		<g transform="translate(80, 380)">
			<text fill="rgba(229,229,229,0.55)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="34" font-weight="300">${at}</text>
		</g>`
		: '';

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${name} on three.ws">
	<defs>
		<radialGradient id="bg" cx="80%" cy="20%" r="80%">
			<stop offset="0%" stop-color="rgba(255,215,0,0.12)"/>
			<stop offset="100%" stop-color="rgba(0,0,0,0)"/>
		</radialGradient>
	</defs>
	<rect width="1200" height="630" fill="#0b0d10"/>
	<rect width="1200" height="630" fill="url(#bg)"/>

	<text x="80" y="140" fill="rgba(255,215,0,0.55)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="56" font-weight="300">◎</text>

	<text x="80" y="320" fill="#f5f5f5" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="86" font-weight="300" letter-spacing="-3">${name}</text>
	${handlePill}
	${badge}

	<text x="80" y="558" fill="rgba(229,229,229,0.4)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="22" font-weight="400">${escapeXml(counts)}</text>
	<text x="1120" y="570" text-anchor="end" fill="rgba(229,229,229,0.3)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="20" font-weight="400" letter-spacing="4">three.ws</text>
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
