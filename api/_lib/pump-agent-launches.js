// Shared query behind the three.ws platform launch directory — every coin
// launched THROUGH three.ws (a pump_agent_mints row), joined with the agent that
// launched it. This is the "allowed runtime launch-directory surface" carved out
// by CLAUDE.md's commit-gate exception: it renders three.ws's own launch
// records at runtime, never a hardcoded third-party mint.
//
// Two doors share this one query:
//   - GET /api/pump/launches (api/pump/[action].js handleLaunches) — powers the
//     /launches page and the agent-detail "launched coins" card.
//   - GET /api/v1/pump/launches — the free, versioned /api/v1 catalog surface.
//
// Distinct from api/crypto/launches.js, which is a market-wide feed of ALL fresh
// pump.fun mints (any launchpad, any creator) — this query is scoped to coins
// launched through three.ws specifically.

import { sql } from './db.js';
import { normalizeGatewayURL } from '../../src/ipfs.js';
import { publicUrl as r2PublicUrl } from './r2.js';

// Tiers ordered by descending conviction: prime > strong > lean > watch > avoid.
export const TIER_RANK = { prime: 5, strong: 4, lean: 3, watch: 2, avoid: 1 };

/**
 * Query the three.ws agent-launch directory.
 *
 * @param {object} o
 * @param {string} [o.network]      'mainnet' | 'devnet' (default 'mainnet')
 * @param {string|null} [o.agentId] restrict to one launching agent (uuid)
 * @param {string} [o.minTierParam] oracle conviction floor: prime|strong|lean|watch|avoid
 * @param {number} [o.offset]
 * @param {number} [o.limit]
 * @returns {Promise<{ launches: object[], has_more: boolean }>}
 */
export async function queryAgentLaunches({
	network = 'mainnet',
	agentId = null,
	minTierParam = '',
	offset = 0,
	limit = 24,
} = {}) {
	const minTierRank = TIER_RANK[minTierParam] || 0;
	// All tiers at or above the requested floor.
	const tiersAbove = minTierRank > 0
		? Object.keys(TIER_RANK).filter((t) => TIER_RANK[t] >= minTierRank)
		: [];

	let rows;
	if (tiersAbove.length) {
		// Oracle-filtered: JOIN oracle_conviction and sort by score descending.
		const baseWhere = agentId
			? sql`where pam.network=${network} and pam.agent_id=${agentId} and oc.tier = any(${tiersAbove})`
			: sql`where pam.network=${network} and oc.tier = any(${tiersAbove})`;
		rows = await sql`
			select pam.mint, pam.network, pam.name, pam.symbol, pam.buyback_bps,
			       pam.metadata_uri, pam.quote_mint, pam.created_at,
			       ai.id as agent_id, ai.name as agent_name,
			       ai.meta->>'solana_address' as agent_solana_address,
			       ai.meta->>'solana_vanity_prefix' as agent_solana_vanity_prefix,
			       ai.meta->>'solana_vanity_suffix' as agent_solana_vanity_suffix,
			       a.thumbnail_key as avatar_thumbnail_key,
			       a.visibility as avatar_visibility,
			       oc.score as oracle_score, oc.tier as oracle_tier, oc.category as oracle_category
			from pump_agent_mints pam
			join oracle_conviction oc on oc.mint = pam.mint and oc.network = pam.network
			left join agent_identities ai on ai.id = pam.agent_id and ai.deleted_at is null
			left join avatars a on a.id = ai.avatar_id and a.deleted_at is null
			${baseWhere}
			order by oc.score desc, pam.created_at desc
			limit ${limit + 1} offset ${offset}
		`;
	} else {
		// Over-fetch by one row to compute has_more without a count(*) round trip.
		rows = agentId
			? await sql`
					select pam.mint, pam.network, pam.name, pam.symbol, pam.buyback_bps,
					       pam.metadata_uri, pam.quote_mint, pam.created_at,
					       ai.id as agent_id, ai.name as agent_name,
					       ai.meta->>'solana_address' as agent_solana_address,
					       ai.meta->>'solana_vanity_prefix' as agent_solana_vanity_prefix,
					       ai.meta->>'solana_vanity_suffix' as agent_solana_vanity_suffix,
					       a.thumbnail_key as avatar_thumbnail_key,
					       a.visibility as avatar_visibility
					from pump_agent_mints pam
					left join agent_identities ai on ai.id = pam.agent_id and ai.deleted_at is null
					left join avatars a on a.id = ai.avatar_id and a.deleted_at is null
					where pam.network=${network} and pam.agent_id=${agentId}
					order by pam.created_at desc
					limit ${limit + 1} offset ${offset}
				`
			: await sql`
					select pam.mint, pam.network, pam.name, pam.symbol, pam.buyback_bps,
					       pam.metadata_uri, pam.quote_mint, pam.created_at,
					       ai.id as agent_id, ai.name as agent_name,
					       ai.meta->>'solana_address' as agent_solana_address,
					       ai.meta->>'solana_vanity_prefix' as agent_solana_vanity_prefix,
					       ai.meta->>'solana_vanity_suffix' as agent_solana_vanity_suffix,
					       a.thumbnail_key as avatar_thumbnail_key,
					       a.visibility as avatar_visibility
					from pump_agent_mints pam
					left join agent_identities ai on ai.id = pam.agent_id and ai.deleted_at is null
					left join avatars a on a.id = ai.avatar_id and a.deleted_at is null
					where pam.network=${network}
					order by pam.created_at desc
					limit ${limit + 1} offset ${offset}
				`;
	}

	const hasMore = rows.length > limit;
	const launches = rows.slice(0, limit).map((r) => {
		const avatarPublic =
			r.avatar_visibility === 'public' || r.avatar_visibility === 'unlisted';
		return {
			mint: r.mint,
			network: r.network,
			name: r.name,
			symbol: r.symbol,
			buyback_bps: r.buyback_bps,
			metadata_uri: normalizeGatewayURL(r.metadata_uri) || r.metadata_uri,
			quote_mint: r.quote_mint,
			created_at: r.created_at,
			oracle: r.oracle_score != null
				? { score: Number(r.oracle_score), tier: r.oracle_tier, category: r.oracle_category || null }
				: null,
			agent: r.agent_id
				? {
						id: r.agent_id,
						name: r.agent_name,
						url: `/agents/${r.agent_id}`,
						avatar_thumbnail_url:
							r.avatar_thumbnail_key && avatarPublic
								? r2PublicUrl(r.avatar_thumbnail_key)
								: null,
						solana_address: r.agent_solana_address || null,
						solana_vanity_prefix: r.agent_solana_vanity_prefix || null,
						solana_vanity_suffix: r.agent_solana_vanity_suffix || null,
					}
				: null,
		};
	});

	return { launches, has_more: hasMore };
}

/**
 * Name/symbol search over three.ws's own launch directory (pump_agent_mints) —
 * the platform-native half of the cross-entity search endpoint (api/search.js).
 * Distinct from searchPumpTokens (api/_lib/pump-search.js), which searches
 * pump.fun/Birdeye market-wide and has no creator or three.ws-verified
 * created_at; results here always carry a real launching agent and timestamp.
 */
export async function searchAgentLaunches({ q, network = 'mainnet', limit = 12 } = {}) {
	const search = typeof q === 'string' && q.trim() ? `%${q.trim().slice(0, 80)}%` : null;
	if (!search) return [];
	const capped = Math.min(Math.max(Number(limit) || 12, 1), 24);
	const rows = await sql`
		select pam.mint, pam.network, pam.name, pam.symbol, pam.created_at,
		       ai.id as agent_id, ai.name as agent_name,
		       a.thumbnail_key as avatar_thumbnail_key,
		       a.visibility as avatar_visibility
		from pump_agent_mints pam
		left join agent_identities ai on ai.id = pam.agent_id and ai.deleted_at is null
		left join avatars a on a.id = ai.avatar_id and a.deleted_at is null
		where pam.network = ${network}
		  and (coalesce(pam.name,'') ilike ${search} or coalesce(pam.symbol,'') ilike ${search})
		order by pam.created_at desc
		limit ${capped}
	`;
	return rows.map((r) => {
		const avatarPublic = r.avatar_visibility === 'public' || r.avatar_visibility === 'unlisted';
		return {
			mint: r.mint,
			network: r.network,
			name: r.name,
			symbol: r.symbol,
			createdAt: r.created_at,
			agent: r.agent_id
				? {
						id: r.agent_id,
						name: r.agent_name,
						url: `/agents/${r.agent_id}`,
						avatar_thumbnail_url: r.avatar_thumbnail_key && avatarPublic ? r2PublicUrl(r.avatar_thumbnail_key) : null,
					}
				: null,
		};
	});
}
