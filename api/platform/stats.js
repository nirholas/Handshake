// GET /api/platform/stats
// ────────────────────────────────────────────────────────────────────────────
// Returns aggregate public-safe platform metrics for the marketing homepage
// and any unauthenticated surface that wants to display traction figures.
//
// All figures are counts that don't expose individual user data.
// Cache: 5 minutes CDN + 5 minutes server-side to avoid hammering the DB on
// every homepage hit. A read that fails is never cached and never rounded down
// to zero: the response says `available: false` instead, the same contract
// /api/home-stats uses, so a database outage can't park a fabricated all-zero
// traction payload on the CDN for the next five minutes.

import { sql } from '../_lib/db.js';
import { CHAIN_BY_ID } from '../_lib/erc8004-chains.js';
import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

export const config = { runtime: 'nodejs' };

const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_SECONDS = 15;

let _cache = { value: null, expiresAt: 0 };
let _inflight = null;

export function _resetStatsCache() {
	_cache = { value: null, expiresAt: 0 };
	_inflight = null;
}

/**
 * Chains the platform can honestly claim: every mainnet that carries at least
 * one active ERC-8004 agent record, plus Solana (the home chain) whenever it
 * carries at least one attestation.
 *
 * Two rows are deliberately not counted. Testnet chain ids (Sepolia, Base
 * Sepolia, Amoy, Fuji…) are real index entries but not networks anyone
 * transacts on, and a chain id absent from the registry in
 * api/_lib/erc8004-chains.js is one we can't confirm is a mainnet at all. Both
 * would only inflate a number the homepage prints as traction.
 *
 * @param {Array<{ chain_id: number|string }>} chainRows distinct active chain ids
 * @param {Array<unknown>} solanaRows non-empty when Solana carries attestations
 * @returns {number}
 */
export function countChains(chainRows, solanaRows) {
	const mainnets = new Set();
	for (const row of chainRows ?? []) {
		const chain = CHAIN_BY_ID[Number(row.chain_id)];
		if (chain && !chain.testnet) mainnets.add(chain.id);
	}
	return mainnets.size + ((solanaRows?.length ?? 0) > 0 ? 1 : 0);
}

async function queryStats() {
	const [agents, views, chats, avatars, countries, widgets, chains, solana] = await Promise.all([
		// Total published agents with wallets or 3D avatars
		sql`
			select count(*)::int as n
			from agent_identities
			where deleted_at is null
		`,
		// All-time widget view count
		sql`
			select count(*)::bigint as n
			from widget_views
		`,
		// All-time chat conversation count
		sql`
			select count(*)::bigint as n
			from widget_chat_threads
		`,
		// Total avatars uploaded (GLBs)
		sql`
			select count(*)::int as n
			from avatars
			where deleted_at is null
		`,
		// Countries reached via widget views
		sql`
			select count(distinct country)::int as n
			from widget_views
			where country is not null and country <> ''
		`,
		// Active widgets (published + visible)
		sql`
			select count(*)::int as n
			from widgets
			where deleted_at is null
		`,
		// Chains carrying an indexed agent, classified against the chain registry
		sql`
			select distinct chain_id
			from erc8004_agents_index
			where active = true
		`,
		// Solana presence: one row is enough, so never count the whole table
		sql`
			select 1
			from solana_attestations
			limit 1
		`,
	]);

	const count = (rows) => Number(rows?.[0]?.n ?? 0);

	return {
		available: true,
		agents:    count(agents),
		views:     count(views),
		chats:     count(chats),
		avatars:   count(avatars),
		countries: count(countries),
		widgets:   count(widgets),
		chains:    countChains(chains, solana),
		generated: new Date().toISOString(),
	};
}

async function computeStats() {
	if (_cache.value && _cache.expiresAt > Date.now()) return _cache.value;
	// Single-flight: the homepage fans in on every TTL expiry, and without this
	// each concurrent miss fires its own eight queries at the same instant.
	if (!_inflight) {
		_inflight = queryStats().then(
			(stats) => {
				_cache = { value: stats, expiresAt: Date.now() + CACHE_TTL_MS };
				_inflight = null;
				return stats;
			},
			(err) => {
				_inflight = null;
				throw err;
			},
		);
	}
	return _inflight;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let stats;
	try {
		stats = await computeStats();
	} catch (err) {
		console.warn('[platform-stats] db_unavailable', err?.message || err);
		return json(
			res,
			200,
			{ available: false, reason: 'db_unavailable' },
			{ 'cache-control': `public, s-maxage=${FAILURE_TTL_SECONDS}` },
		);
	}

	return json(res, 200, stats, {
		'cache-control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
	});
});
