/**
 * oEmbed endpoint for agent + Forge creation URLs
 * ------------------------------------------------
 * GET /api/oembed?url=<agent-or-forge-share-url>[&format=json|xml]
 *
 * Implements https://oembed.com with type=rich. The html payload is a
 * sandboxed iframe — /agent/:id/embed for agents, /forge/embed?src=<glb> for
 * Forge creations — so consumers (Notion, Discord, etc.) can render the model
 * inline just by pasting the shareUrl.
 */

import { sql } from './_lib/db.js';
import { env } from './_lib/env.js';
import { cors, method, wrap, error } from './_lib/http.js';
import { resolveOnChainAgent, SERVER_CHAIN_META } from './_lib/onchain.js';
import { isUuid } from './_lib/validate.js';
import {
	buildEmbedIframe,
	clampEmbedDim,
	agentEmbedTarget,
	onchainEmbedTarget,
	forgeEmbedTarget,
	EMBED_THUMB,
} from './_lib/embed.js';

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 520;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	// oEmbed is a read. Without this, a POST/PUT/DELETE ran the whole lookup and
	// answered 200, contradicting the Allow set the CORS preflight advertises.
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const target = url.searchParams.get('url');
	const format = (url.searchParams.get('format') || 'json').toLowerCase();

	const width  = clampEmbedDim(url.searchParams.get('maxwidth'),  DEFAULT_WIDTH,  100, 2000);
	const height = clampEmbedDim(url.searchParams.get('maxheight'), DEFAULT_HEIGHT, 100, 2000);

	if (!target) return error(res, 400, 'invalid_request', 'url parameter required');

	const onchain = extractOnChain(target);
	if (onchain) return sendOnChain(res, format, { ...onchain, width, height });

	const forgeId = extractForgeId(target);
	if (forgeId) return sendForge(res, format, { id: forgeId, width, height });

	const agentId = extractAgentId(target);
	if (!agentId) return error(res, 404, 'not_found', 'url is not a recognised agent url');

	const [agent] = await sql`
		SELECT id, name, description, avatar_id
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const origin = env.APP_ORIGIN;
	const { embedUrl, shareUrl, thumbnailUrl } = agentEmbedTarget(origin, agent.id);
	const title = agent.name || 'Agent';

	const payload = {
		type: 'rich',
		version: '1.0',
		provider_name: 'three.ws',
		provider_url: origin,
		title,
		author_name: title,
		author_url: shareUrl,
		html: buildEmbedIframe({ src: embedUrl, width, height, title }),
		width,
		height,
		thumbnail_url: thumbnailUrl,
		thumbnail_width: EMBED_THUMB.width,
		thumbnail_height: EMBED_THUMB.height,
	};

	res.setHeader('cache-control', 'public, max-age=900');

	if (format === 'xml') {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/xml; charset=utf-8');
		res.end(toXml(payload));
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'application/json+oembed; charset=utf-8');
	res.end(JSON.stringify(payload));
});

function extractAgentId(target) {
	let parsed;
	try {
		parsed = new URL(target);
	} catch {
		return null;
	}

	const originStr = `${parsed.protocol}//${parsed.host}`;
	const okOrigin =
		originStr === env.APP_ORIGIN || /^https?:\/\/localhost(:\d+)?$/.test(originStr);
	if (!okOrigin) return null;

	const match = parsed.pathname.match(/^\/agent\/([A-Za-z0-9_-]+)\/?$/);
	const id = match ? match[1] : null;
	// agent_identities.id is a uuid column, so a non-uuid slug reached Postgres as
	// an uncastable literal and came back as an unhandled 500. Treat it the same
	// way the Forge branch below already does: not a recognised agent url.
	return id && isUuid(id) ? id : null;
}

function extractForgeId(target) {
	let parsed;
	try {
		parsed = new URL(target);
	} catch {
		return null;
	}

	const originStr = `${parsed.protocol}//${parsed.host}`;
	const okOrigin =
		originStr === env.APP_ORIGIN || /^https?:\/\/localhost(:\d+)?$/.test(originStr);
	if (!okOrigin) return null;

	const match = parsed.pathname.match(/^\/forge\/share\/([A-Za-z0-9-]+)\/?$/);
	const id = match ? match[1] : null;
	return id && isUuid(id) ? id : null;
}

async function sendForge(res, format, { id, width, height }) {
	const [creation] = await sql`
		SELECT id, prompt, status, glb_url
		FROM forge_creations
		WHERE id = ${id}
		LIMIT 1
	`;
	if (!creation || creation.status !== 'done' || !creation.glb_url) {
		return error(res, 404, 'not_found', 'forge creation not found or not ready');
	}

	const origin = env.APP_ORIGIN;
	const title = creation.prompt ? String(creation.prompt).slice(0, 80) : 'Forged creation';
	const { embedUrl, shareUrl, thumbnailUrl } = forgeEmbedTarget(origin, creation.id, creation.glb_url, title);

	const payload = {
		type: 'rich',
		version: '1.0',
		provider_name: 'three.ws',
		provider_url: origin,
		title,
		author_name: 'three.ws Forge',
		author_url: `${origin}/forge`,
		html: buildEmbedIframe({ src: embedUrl, width, height, title }),
		width,
		height,
		thumbnail_url: thumbnailUrl,
		thumbnail_width: EMBED_THUMB.width,
		thumbnail_height: EMBED_THUMB.height,
	};

	res.setHeader('cache-control', 'public, max-age=900');

	if (format === 'xml') {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/xml; charset=utf-8');
		res.end(toXml(payload));
		return;
	}
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json+oembed; charset=utf-8');
	res.end(JSON.stringify(payload));
}

function extractOnChain(target) {
	let parsed;
	try {
		parsed = new URL(target);
	} catch {
		return null;
	}

	const originStr = `${parsed.protocol}//${parsed.host}`;
	const okOrigin =
		originStr === env.APP_ORIGIN || /^https?:\/\/localhost(:\d+)?$/.test(originStr);
	if (!okOrigin) return null;

	const match = parsed.pathname.match(/^\/a\/(\d+)\/(\d+)\/?$/);
	if (!match) return null;
	const chainId = Number(match[1]);
	const agentId = match[2];
	if (!SERVER_CHAIN_META[chainId]) return null;
	return { chainId, agentId };
}

async function sendOnChain(res, format, { chainId, agentId, width, height }) {
	const agent = await resolveOnChainAgent({ chainId, agentId });
	if (agent.error && agent.error.startsWith('chain_read')) {
		return error(res, 404, 'not_found', `agent #${agentId} not found on chain ${chainId}`);
	}

	const origin = env.APP_ORIGIN;
	const { embedUrl, shareUrl, thumbnailUrl } = onchainEmbedTarget(origin, chainId, agentId);
	const title = agent.name || `Agent #${agentId}`;

	const payload = {
		type: 'rich',
		version: '1.0',
		provider_name: 'three.ws',
		provider_url: origin,
		title,
		author_name: title,
		author_url: shareUrl,
		html: buildEmbedIframe({ src: embedUrl, width, height, title }),
		width,
		height,
		thumbnail_url: thumbnailUrl,
		thumbnail_width: EMBED_THUMB.width,
		thumbnail_height: EMBED_THUMB.height,
	};

	res.setHeader('cache-control', 'public, max-age=900');

	if (format === 'xml') {
		res.statusCode = 200;
		res.setHeader('content-type', 'text/xml; charset=utf-8');
		res.end(toXml(payload));
		return;
	}
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json+oembed; charset=utf-8');
	res.end(JSON.stringify(payload));
}

function toXml(payload) {
	const lines = Object.entries(payload).map(([k, v]) => `  <${k}>${escapeXml(String(v))}</${k}>`);
	return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<oembed>\n${lines.join('\n')}\n</oembed>`;
}

function escapeXml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}
