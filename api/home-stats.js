/**
 * Public marketing stats for the home page.
 *
 * GET /api/home-stats
 *
 * Returns real counts pulled from Neon. Used by the SaaS prologue strip on
 * the home page to render live "trusted by" numbers. No auth, edge-cached for
 * 60s at the CDN. If the DB is unreachable the response is { available: false }
 * and the home page hides the metrics strip — we never serve fabricated numbers.
 */

import { sql } from './_lib/db.js';
import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';

const TTL_SECONDS = 60;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const [agentsRow, onchainRow, widgetsRow, chainsRow, attRow, forgeRow] = await Promise.all([
			sql`SELECT COUNT(*)::int AS n FROM agent_identities WHERE deleted_at IS NULL`,
			sql`SELECT COUNT(*)::int AS n FROM erc8004_agents_index WHERE active = true`,
			sql`SELECT COUNT(*)::int AS n FROM widgets WHERE deleted_at IS NULL`,
			sql`SELECT COUNT(DISTINCT chain_id)::int AS n FROM erc8004_agents_index WHERE active = true`,
			sql`SELECT COUNT(*)::int AS n FROM solana_attestations`,
			sql`SELECT COUNT(*)::int AS n FROM forge_creations WHERE status = 'done' AND glb_url IS NOT NULL AND (outcome IS NULL OR outcome != 'rejected')`,
		]);

		const stats = {
			available: true,
			agents: agentsRow[0]?.n ?? 0,
			onchain_agents: onchainRow[0]?.n ?? 0,
			widgets: widgetsRow[0]?.n ?? 0,
			chains: chainsRow[0]?.n ?? 0,
			attestations: attRow[0]?.n ?? 0,
			forge_models: forgeRow[0]?.n ?? 0,
			updated_at: new Date().toISOString(),
		};

		return json(res, 200, stats, {
			'cache-control': `public, s-maxage=${TTL_SECONDS}, stale-while-revalidate=${TTL_SECONDS * 5}`,
		});
	} catch (err) {
		console.warn('[home-stats] db_unavailable', err?.message || err);
		return json(
			res,
			200,
			{ available: false, reason: 'db_unavailable' },
			{ 'cache-control': 'public, s-maxage=15' },
		);
	}
});
