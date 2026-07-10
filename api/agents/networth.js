// GET /api/agents/networth?ids=<uuid,uuid,…>&network=mainnet
// -----------------------------------------------------------
// Public, read-only batch net-worth lookup that powers wealth legibility in the
// 3D galaxy (and anywhere a list of agents needs their tiers at once). For each
// requested agent it resolves the custodial Solana address and returns the real
// USD net worth of that wallet and the tier it maps to.
//
// All real on-chain data: net worth comes from api/_lib/balances.getBalances()
// — the SAME priced-balance path the wallet uses elsewhere — so a star's tier in
// the galaxy matches the avatar's aura on its detail page. Balances are cached
// (Redis when configured), so a galaxy of N agents collapses to mostly cache
// hits and at most one DAS read per address per cache window. Token balances are
// public chain data, so no auth is required.
//
// Returns { data: { network, items: [{ id, address, usd, tier, level, wealth,
// hasThree }] } } — agents without a wallet (or whose balance read fails) are
// simply omitted, so the caller degrades to the clean baseline for them.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, rateLimited, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getBalances, walletUsdTotal } from '../_lib/balances.js';
import { tierForUsd, THREE_MINT } from '../../src/shared/wallet-networth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 150;
const CONCURRENCY = 8;

// Resolve net worth for one agent address, mapped to its tier. Never throws —
// a failed balance read degrades to a null result the caller can skip.
async function networthForAddress(address) {
	try {
		const balances = await getBalances({ chain: 'solana', address });
		const usd = walletUsdTotal(balances);
		const tier = tierForUsd(usd);
		const hasThree = (balances?.tokens || []).some((t) => t.mint === THREE_MINT && (t.amount || 0) > 0);
		return { usd, tier: tier.key, level: tier.level, wealth: tier.level / 5, hasThree };
	} catch {
		return null;
	}
}

// Run `fn` over `items` with bounded concurrency so a large galaxy never opens
// hundreds of RPC sockets at once.
async function mapPool(items, limit, fn) {
	const out = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (i < items.length) {
			const idx = i++;
			out[idx] = await fn(items[idx], idx);
		}
	});
	await Promise.all(workers);
	return out;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.agentProfileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const idsRaw = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
	const ids = [...new Set(idsRaw)].filter((id) => UUID_RE.test(id)).slice(0, MAX_IDS);

	if (!ids.length) return json(res, 200, { data: { network, items: [] } });

	// Net worth is denominated in USD across every chain, but the wallet welded to
	// each agent here is its Solana custodial wallet (the avatar's primary wallet),
	// so we read Solana balances. Devnet has no priced market, so devnet requests
	// return addresses with a dormant (0) tier rather than a misleading value.
	let rows;
	try {
		rows = await sql`
			SELECT id, meta->>'solana_address' AS address
			FROM agent_identities
			WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
		`;
	} catch {
		return error(res, 500, 'db_error', 'could not resolve agents');
	}

	const withWallets = rows.filter((r) => r.address);
	if (network === 'devnet') {
		// Honest: we don't price devnet. Surface the wallet but as dormant tier.
		return json(res, 200, {
			data: {
				network,
				items: withWallets.map((r) => ({
					id: r.id, address: r.address, usd: 0, tier: 'dormant', level: 0, wealth: 0, hasThree: false,
				})),
			},
		});
	}

	const results = await mapPool(withWallets, CONCURRENCY, async (r) => {
		const nw = await networthForAddress(r.address);
		return nw ? { id: r.id, address: r.address, ...nw } : null;
	});

	return json(res, 200, { data: { network, items: results.filter(Boolean) } });
});
