/**
 * GET /api/agents/by-wallet?address=0x...&chain_id=84532
 *
 * Lists agents registered in our DB whose wallet_address matches the query.
 * Unauthenticated; returns only public fields (no user_id, no raw meta).
 * Pair with on-chain enumeration (balanceOf + tokenOfOwnerByIndex) on the
 * client to also surface agents minted outside this app.
 */

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const raw = (url.searchParams.get('address') || '').trim();
	if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
		return error(res, 400, 'validation_error', 'invalid wallet address');
	}
	const address = raw.toLowerCase();
	const chainId = Number(url.searchParams.get('chain_id')) || null;

	const rows = chainId
		? await sql`
			SELECT id, name, description, avatar_id, home_url,
			       erc8004_agent_id, erc8004_registry, chain_id,
			       wallet_address, created_at
			FROM agent_identities
			WHERE lower(wallet_address) = ${address}
			  AND chain_id = ${chainId}
			  AND deleted_at IS NULL
			ORDER BY created_at ASC`
		: await sql`
			SELECT id, name, description, avatar_id, home_url,
			       erc8004_agent_id, erc8004_registry, chain_id,
			       wallet_address, created_at
			FROM agent_identities
			WHERE lower(wallet_address) = ${address}
			  AND deleted_at IS NULL
			ORDER BY created_at ASC`;

	return json(res, 200, {
		agents: rows.map((r) => ({
			id: r.id,
			name: r.name,
			description: r.description,
			avatar_id: r.avatar_id,
			home_url: r.home_url || `/agent/${r.id}`,
			erc8004_agent_id: r.erc8004_agent_id != null ? String(r.erc8004_agent_id) : null,
			erc8004_registry: r.erc8004_registry,
			chain_id: r.chain_id,
			wallet_address: r.wallet_address,
			created_at: r.created_at,
		})),
	});
});
