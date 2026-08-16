/**
 * On-chain agent OG image
 * -----------------------
 * GET /api/a-og?chain=<chainId>&id=<agentId>
 *
 * Happy path: 302 to the manifest's image (IPFS/HTTPS thumbnail).
 * Fallback: server-rendered SVG card — Slack, X, Discord, Farcaster all
 * accept image/svg+xml for OG images, so we avoid canvas/sharp at edge.
 */

import { env } from './_lib/env.js';
import { cors, method, wrap, error } from './_lib/http.js';
import { resolveOnChainAgent, shortenAddr, isTokenId, SERVER_CHAIN_META } from './_lib/onchain.js';

const CACHE_CARD = 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_REDIR = 'public, max-age=600, s-maxage=3600';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const chainRaw = url.searchParams.get('chain');
	const chainId = Number(chainRaw);
	const agentId = url.searchParams.get('id');
	const format = (url.searchParams.get('format') || '').toLowerCase();

	// `Number(null)` is 0, so a bare `?id=…` used to sail past a Number.isFinite
	// check and resolve against chain 0. Require the param, then require it to
	// name a chain we actually have a registry for.
	if (!chainRaw || !Number.isInteger(chainId) || !agentId) {
		return error(res, 400, 'invalid_request', 'chain and id required');
	}
	if (!SERVER_CHAIN_META[chainId]) {
		return error(res, 400, 'unsupported_chain', `chain ${chainId} is not supported`);
	}
	// An ERC-721 id is a uint256. Reject anything else here rather than letting
	// the resolver report it, so the caller gets a specific message.
	if (!isTokenId(agentId)) {
		return error(res, 400, 'invalid_request', 'id must be a token id (decimal digits)');
	}

	const agent = await resolveOnChainAgent({ chainId, agentId });

	// A resolve error at this point is never the caller's fault (bad chain and
	// bad id both 400'd above): either the RPC read failed, or the manifest host
	// did. Both are transient, and both used to hard-404 the card, so an agent
	// that exists on chain lost its social image for as long as the edge cached
	// that 404, and /api/oembed happily returned a thumbnail_url pointing at it.
	// Serve the card either way (api/a-page.js degrades identically) and just cut
	// the cache short so the next crawl re-resolves.
	const degraded = !!agent.error;
	const cache = degraded ? 'public, max-age=60' : CACHE_CARD;

	if (format === 'json') {
		// Anchor on env.APP_ORIGIN. A previous version honored an `origin` query
		// param, which let a caller inject arbitrary URLs into `url` and `image`
		// in the returned JSON. Consumers of this oEmbed-style endpoint trust
		// those fields, so we never echo a caller-supplied origin.
		const origin = env.APP_ORIGIN;
		const pageUrl = `${origin}/a/${chainId}/${agentId}`;
		const imageUrl = `${origin}/api/a-og?chain=${chainId}&id=${encodeURIComponent(agentId)}`;
		res.statusCode = 200;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('cache-control', cache);
		res.end(
			JSON.stringify({
				title: (agent.name || `Agent #${agentId}`) + ' — three.ws',
				description: agent.description || 'An embodied three.ws.',
				image: imageUrl,
				url: pageUrl,
				type: 'profile',
				agent: {
					name: agent.name || null,
					slug: `${chainId}/${agentId}`,
					thumbnailUrl: agent.image || null,
					chainId: agent.chainId,
					onChain: true,
				},
			}),
		);
		return;
	}

	// If the manifest has a raw image URL, redirect so the crawler caches
	// an actual PNG/JPG (better social preview than SVG text card).
	// Only redirect for http(s) URLs — crawlers won't follow ipfs:// or
	// gateway URLs from random hosts reliably.
	//
	// Route through our same-origin image proxy (api/img) rather than 302-ing
	// straight to the manifest host. agent.image comes from on-chain metadata an
	// attacker controls, so a direct redirect is an open redirect (phishing under
	// our domain) and an unguarded fetch target. /api/img re-fetches through the
	// SSRF-pinned fetcher and only serves responses whose content-type is image/*,
	// so the browser only ever lands on three.ws and never on an arbitrary host.
	if (agent.image && /^https?:\/\//i.test(agent.image)) {
		res.statusCode = 302;
		res.setHeader('location', `/api/img?url=${encodeURIComponent(agent.image)}`);
		res.setHeader('cache-control', CACHE_REDIR);
		res.end();
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
	res.setHeader('cache-control', cache);
	res.end(renderCard(agent));
});

function renderCard(agent) {
	const name = agent.name || `Agent #${agent.agentId}`;
	const desc = agent.description || 'An embodied three.ws on-chain.';
	const chain = agent.chainName || `Chain ${agent.chainId}`;
	const short = agent.chainShort || '';
	const owner = agent.owner ? shortenAddr(agent.owner) : '';
	const testnet = agent.testnet;
	const accent = testnet ? '#f59e0b' : '#8b5cf6';

	const safeName = escapeXml(truncate(name, 48));
	const safeDesc = escapeXml(truncate(desc, 160));
	const safeChain = escapeXml(truncate(chain, 20));
	const safeShort = escapeXml(truncate(short, 12));
	const safeOwner = escapeXml(owner);
	const safeId = escapeXml(agent.agentId);

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${safeName} on ${safeChain}">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#0b0d10"/>
			<stop offset="1" stop-color="#141722"/>
		</linearGradient>
		<radialGradient id="glow" cx="0.85" cy="0.15" r="0.6">
			<stop offset="0" stop-color="${accent}" stop-opacity="0.35"/>
			<stop offset="1" stop-color="${accent}" stop-opacity="0"/>
		</radialGradient>
	</defs>
	<rect width="1200" height="630" fill="url(#bg)"/>
	<rect width="1200" height="630" fill="url(#glow)"/>

	<!-- Chain badge top-left -->
	<g transform="translate(80, 70)">
		<rect x="0" y="0" rx="18" ry="18" width="${Math.max(140, safeChain.length * 13 + 40)}" height="40" fill="rgba(255,255,255,0.06)" stroke="${accent}" stroke-opacity="0.5" stroke-width="1"/>
		<circle cx="24" cy="20" r="6" fill="${accent}"/>
		<text x="42" y="27" fill="#e5e5e5" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="16" font-weight="500" letter-spacing="0.5">${safeChain}${testnet ? ' · TESTNET' : ''}</text>
	</g>

	<!-- Agent # top-right -->
	<text x="1120" y="95" text-anchor="end" fill="rgba(229,229,229,0.4)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="22" font-weight="400" letter-spacing="2">#${safeId}</text>

	<!-- Main title -->
	<text x="80" y="340" fill="#f5f5f5" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="84" font-weight="300" letter-spacing="-3">${safeName}</text>

	<!-- Description -->
	<text x="80" y="410" fill="rgba(229,229,229,0.6)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="28" font-weight="400">${safeDesc}</text>

	<!-- Owner footer -->
	${safeOwner ? `<text x="80" y="495" fill="rgba(229,229,229,0.35)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20">owner ${safeOwner}</text>` : ''}

	<!-- Brand footer -->
	<g transform="translate(80, 550)">
		<circle cx="12" cy="12" r="10" fill="none" stroke="${accent}" stroke-width="2"/>
		<text x="34" y="19" fill="rgba(229,229,229,0.45)" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="18" font-weight="500" letter-spacing="3">three.ws</text>
	</g>
	<text x="1120" y="569" text-anchor="end" fill="rgba(229,229,229,0.3)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="16">eip155:${agent.chainId}${safeShort ? ` · ${safeShort}` : ''}</text>
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
