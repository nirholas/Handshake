/**
 * GET /api/embed/resolve?id=<spec>
 *
 * Resolves a flexible ID spec to the minimal payload an embed needs to render
 * an agent: { glbUrl, name, poster, kind, ...minimal metadata }.
 *
 * Supported ID specs (kept tiny on purpose):
 *   - "<chainId>:<agentId>"         → on-chain ERC-8004 agent  e.g. "8453:42"
 *   - "eip155:<chainId>:<agentId>"  → same, namespaced form    e.g. "eip155:8453:42"
 *   - "avatar:<uuid>"               → public avatar            e.g. "avatar:8e3...c1"
 *
 * Cross-origin by design (Access-Control-Allow-Origin: *). Cached aggressively
 * at the edge so an embed loading in 10k pages doesn't hammer the DB.
 */

import { sql } from '../_lib/db.js';
import { cors, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { CHAIN_BY_ID } from '../_lib/erc8004-chains.js';
import { publicUrl } from '../_lib/r2.js';
import { DEMO_AVATARS } from '../_lib/demo-avatars.js';

const ONCHAIN_RE = /^(?:eip155:)?(\d{1,9})[:/](\d{1,12})$/;
const AVATAR_RE = /^avatar:([a-zA-Z0-9_-]{3,64})$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const id = (url.searchParams.get('id') || '').trim();
	if (!id) return error(res, 400, 'validation_error', 'id is required');

	const onchain = id.match(ONCHAIN_RE);
	if (onchain) {
		const chainId = parseInt(onchain[1], 10);
		const agentId = parseInt(onchain[2], 10);
		const rows = await sql`
			SELECT chain_id, agent_id, name, description, image, glb_url, has_3d, x402_support
			FROM erc8004_agents_index
			WHERE active = true AND chain_id = ${chainId} AND agent_id = ${agentId}
			LIMIT 1
		`;
		if (!rows.length) return error(res, 404, 'not_found', 'agent not found');

		const r = rows[0];
		const chain = CHAIN_BY_ID[r.chain_id];
		return embedJson(res, {
			kind: 'onchain',
			id: `${r.chain_id}:${r.agent_id}`,
			chainId: r.chain_id,
			chainName: chain?.name || `Chain ${r.chain_id}`,
			agentId: r.agent_id,
			name: r.name || `Agent #${r.agent_id}`,
			description: r.description || '',
			glbUrl: r.glb_url || null,
			poster: r.image || null,
			has3d: !!r.has_3d,
			x402: !!r.x402_support,
			passportUrl: `/discover/a/${r.chain_id}/${r.agent_id}`,
		});
	}

	const avatar = id.match(AVATAR_RE);
	if (avatar) {
		const avatarId = avatar[1];
		const demo = DEMO_AVATARS.find((a) => String(a.avatarId) === String(avatarId));
		if (demo) {
			return embedJson(res, {
				kind: 'avatar',
				id: `avatar:${demo.avatarId}`,
				name: demo.name,
				description: demo.description || '',
				glbUrl: demo.glbUrl || null,
				poster: demo.image || null,
				has3d: true,
				x402: false,
				passportUrl: `/discover/avatar/${demo.avatarId}`,
			});
		}

		const rows = await sql`
			SELECT id, name, description, storage_key, thumbnail_key
			FROM avatars
			WHERE deleted_at IS NULL AND visibility = 'public' AND id = ${avatarId}
			LIMIT 1
		`;
		if (!rows.length) return error(res, 404, 'not_found', 'avatar not found');

		const r = rows[0];
		return embedJson(res, {
			kind: 'avatar',
			id: `avatar:${r.id}`,
			name: r.name,
			description: r.description || '',
			glbUrl: publicUrl(r.storage_key),
			poster: r.thumbnail_key ? publicUrl(r.thumbnail_key) : null,
			has3d: true,
			x402: false,
			passportUrl: `/discover/avatar/${r.id}`,
		});
	}

	return error(
		res,
		400,
		'validation_error',
		'id must be "<chainId>:<agentId>", "eip155:<chainId>:<agentId>", or "avatar:<uuid>"',
	);
});

function embedJson(res, payload) {
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('cross-origin-resource-policy', 'cross-origin');
	res.setHeader(
		'cache-control',
		'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
	);
	res.end(JSON.stringify(payload));
}
