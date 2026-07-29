// GET /api/agents/ens/:name
// Resolves an ENS name → address, then looks up agents registered to that address.
// Public, rate-limited 60/min per IP. ENS → address cached 5 min in-memory.

import { ensResolveAddress } from '../../_lib/evm/ens.js';
import { sql } from '../../_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';

// Validates "foo.eth", "sub.foo.eth", etc. — each label [a-z0-9-]+, must end with .eth
const ENS_RE = /^(?:[a-z0-9-]+\.)+eth$/;

// In-memory ENS → address cache. Entry: { address, expiresAt }
const ensCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(name) {
	const entry = ensCache.get(name);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		ensCache.delete(name);
		return null;
	}
	return entry.address;
}

function setCached(name, address) {
	ensCache.set(name, { address, expiresAt: Date.now() + CACHE_TTL_MS });
}

// 3s used to be too tight to be reachable: the old ethers resolveName walk cost
// 9.7-12.4s on the keyless endpoints, so this lookup timed out on every name.
// One Universal Resolver eth_call lands in ~270ms, so the budget is now real.
async function resolveEns(name) {
	return ensResolveAddress(name, { timeoutMs: 3000 });
}

async function agentsByAddress(address) {
	// Note: /api/agents/by-address/[addr].js exists but returns a minimal NFT-style
	// shape ({id, chainId, agentURI, manifestUrl, onChain, source}) with chain
	// enumeration fallback. This endpoint returns the full agent profile for ENS
	// → identity resolution. The two queries differ enough that extracting a
	// shared helper would add abstraction without removing real duplication.
	const rows = await sql`
		SELECT id, name, description, avatar_id, home_url,
		       erc8004_agent_id, erc8004_registry, chain_id,
		       wallet_address, created_at
		FROM agent_identities
		WHERE lower(wallet_address) = ${address.toLowerCase()}
		  AND deleted_at IS NULL
		ORDER BY created_at ASC`;

	return rows.map((r) => ({
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
	}));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.ensResolve(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const name = (req.query?.name || '').trim().toLowerCase();

	if (!name || !ENS_RE.test(name)) {
		return error(res, 400, 'validation_error', 'name must be a valid ENS label ending in .eth');
	}

	// Cache hit
	let address = getCached(name);

	if (!address) {
		let resolved;
		try {
			resolved = await resolveEns(name);
		} catch (err) {
			if (err.message === 'ens-timeout') {
				return error(res, 503, 'ens_timeout', 'ENS resolution timed out');
			}
			return error(res, 503, 'ens_error', 'ENS resolution failed');
		}

		if (!resolved)
			return error(res, 404, 'not_found', `${name} does not resolve to an address`);

		address = resolved.toLowerCase();
		setCached(name, address);
	}

	const agents = await agentsByAddress(address);

	return json(res, 200, { name, address, agents });
});
