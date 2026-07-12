// cross-search — the query layer behind GET /api/search (api/search.js), the
// cross-entity discovery surface (prompts/user-value/05-discovery-search.md).
//
// three.ws's creation types live in genuinely heterogeneous stores: avatars +
// on-chain/Solana agents in Postgres tables already served by api/explore.js,
// 3D models in forge_creations (api/_lib/forge-store.js), worlds in dioramas
// (api/_lib/diorama-store.js), and coins split between three.ws's own launch
// directory (pump_agent_mints) and the wider pump.fun/Birdeye market (external
// HTTP, no shared schema at all). A single SQL UNION across those is not
// possible — coins aren't even in the same database — so this module fans out
// N independent, narrow queries in parallel and normalizes each into one
// common card shape. That federated-fan-out choice (not a "one true query") is
// the honest one for this data layout; see the search.js file header for the
// full unify-vs-federate writeup.
//
// Every function here returns already-normalized SearchItem objects:
//   { type, id, title, description, image, glbUrl, assetUrl, creator, remix,
//     createdAt, signals }
// so api/search.js only has to merge + rank arrays, never branch on shape.

import { sql } from './db.js';
import { publicUrl, thumbnailUrl } from './r2.js';
import { listRemixable } from './forge-store.js';
import { listDioramas } from './diorama-store.js';
import { searchAgentLaunches } from './pump-agent-launches.js';
import { searchPumpTokens } from './pump-search.js';

function shortAddr(a) {
	if (!a || a.length < 10) return a || '';
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function likePattern(q) {
	return q ? `%${q}%` : null;
}

// ── avatars ──────────────────────────────────────────────────────────────────

export async function searchAvatars({ q, limit = 12 } = {}) {
	const search = likePattern(q);
	const capped = Math.min(Math.max(Number(limit) || 12, 1), 24);
	const rows = await sql`
		select a.id, a.slug, a.name, a.description, a.storage_key, a.thumbnail_key,
		       a.created_at, a.model_category, coalesce(a.view_count, 0) as view_count,
		       u.username as owner_username, u.display_name as owner_display_name
		from avatars a
		left join users u on u.id = a.owner_id and u.deleted_at is null
		where a.deleted_at is null and a.visibility = 'public'
		  and (${search}::text is null or coalesce(a.name,'') ilike ${search} or coalesce(a.description,'') ilike ${search})
		order by coalesce(a.featured, false) desc, a.created_at desc
		limit ${capped}
	`;
	return rows.map((r) => ({
		type: 'avatar',
		id: r.id,
		title: r.name || 'Untitled avatar',
		description: r.description || '',
		image: thumbnailUrl(r.thumbnail_key),
		glbUrl: publicUrl(r.storage_key),
		assetUrl: `/discover/avatar/${r.id}`,
		creator: r.owner_username
			? { label: `@${r.owner_username}`, url: `/u/${r.owner_username}` }
			: null,
		remix: null,
		createdAt: r.created_at,
		signals: { viewCount: Number(r.view_count) || 0 },
	}));
}

// ── on-chain + Solana agents ─────────────────────────────────────────────────

export async function searchAgents({ q, limit = 12 } = {}) {
	const search = likePattern(q);
	const capped = Math.min(Math.max(Number(limit) || 12, 1), 24);

	const [onchainRows, solanaRows] = await Promise.all([
		sql`
			select chain_id, agent_id, owner, name, description, image, registered_at
			from erc8004_agents_index
			where active = true
			  and (${search}::text is null or coalesce(name,'') ilike ${search} or coalesce(description,'') ilike ${search})
			order by registered_at desc nulls last
			limit ${capped}
		`,
		sql`
			select ai.id, ai.name, ai.description, ai.wallet_address, ai.created_at,
			       a.thumbnail_key as avatar_thumb,
			       u.username as owner_username, u.display_name as owner_display_name
			from agent_identities ai
			left join avatars a on a.id = ai.avatar_id and a.deleted_at is null
			left join users u on u.id = ai.user_id and u.deleted_at is null
			where ai.deleted_at is null
			  and ai.meta->>'chain_type' = 'solana' and ai.meta->>'network' = 'mainnet'
			  and (${search}::text is null or coalesce(ai.name,'') ilike ${search} or coalesce(ai.description,'') ilike ${search})
			order by ai.created_at desc nulls last
			limit ${capped}
		`,
	]);

	const onchainItems = onchainRows.map((r) => ({
		type: 'agent',
		id: `onchain:${r.chain_id}:${r.agent_id}`,
		title: r.name || `Agent #${r.agent_id}`,
		description: r.description || '',
		image: r.image || null,
		glbUrl: null,
		assetUrl: `/discover/a/${r.chain_id}/${r.agent_id}`,
		// No platform user_id on erc8004_agents_index (pure on-chain identity) —
		// the closest honest "creator" link is the owner's on-chain address, not
		// a fabricated three.ws profile.
		creator: r.owner ? { label: shortAddr(r.owner), url: null } : null,
		remix: null,
		createdAt: r.registered_at,
		signals: {},
	}));

	const solanaItems = solanaRows.map((r) => ({
		type: 'agent',
		id: `solana:${r.id}`,
		title: r.name || 'Solana Agent',
		description: r.description || '',
		image: thumbnailUrl(r.avatar_thumb),
		glbUrl: null,
		assetUrl: `/agent/${r.id}`,
		creator: r.owner_username
			? { label: `@${r.owner_username}`, url: `/u/${r.owner_username}` }
			: r.wallet_address
				? { label: shortAddr(r.wallet_address), url: null }
				: null,
		remix: null,
		createdAt: r.created_at,
		signals: {},
	}));

	return [...onchainItems, ...solanaItems];
}

// ── 3D models (remix bazaar) ─────────────────────────────────────────────────

export async function searchModels({ q, limit = 12 } = {}) {
	const rows = await listRemixable({ limit, q, sort: 'recent' });
	return rows.map((r) => ({
		type: 'model',
		id: r.id,
		title: r.prompt ? (r.prompt.length > 90 ? `${r.prompt.slice(0, 87)}…` : r.prompt) : 'A remixable 3D model',
		description: r.prompt || '',
		image: r.preview_image_url || null,
		glbUrl: r.glb_url,
		assetUrl: `https://three.ws/viewer?src=${encodeURIComponent(r.glb_url)}`,
		creator: r.ownerUsername
			? { label: `@${r.ownerUsername}`, url: `/u/${r.ownerUsername}` }
			: { label: 'Lineage', url: `/creations#lineage=${r.id}` },
		remix: {
			endpoint: '/api/x402/remix-asset',
			sourceCreationId: r.id,
			priceUsd: 0.25,
			royaltyPercent: Math.round(((r.royaltyBps ?? 0) / 100) * 10) / 10,
			royaltyPayable: r.royaltyPayable,
		},
		createdAt: r.created_at,
		signals: { remixCount: r.remixCount || 0 },
	}));
}

// ── worlds (dioramas) ─────────────────────────────────────────────────────────

export async function searchWorlds({ q, limit = 12 } = {}) {
	const rows = await listDioramas({ scope: 'recent', limit, q });
	return rows.map((r) => ({
		type: 'world',
		id: r.id,
		title: r.title || 'Untitled world',
		description: r.prompt || '',
		image: null,
		glbUrl: r.thumbnailGlb,
		assetUrl: `/diorama?id=${encodeURIComponent(r.id)}`,
		creator: r.creatorUsername
			? { label: `@${r.creatorUsername}`, url: `/u/${r.creatorUsername}` }
			: null,
		remix: null,
		createdAt: r.createdAt,
		signals: { viewCount: r.views || 0 },
	}));
}

// ── coins (three.ws launches, then market-wide pump.fun/Birdeye) ────────────

export async function searchCoins({ q, limit = 12 } = {}) {
	if (!q) return [];
	const capped = Math.min(Math.max(Number(limit) || 12, 1), 24);
	const [ownLaunches, external] = await Promise.all([
		searchAgentLaunches({ q, limit: capped }).catch(() => []),
		searchPumpTokens(q, capped).catch(() => []),
	]);

	const ownItems = ownLaunches.map((l) => ({
		type: 'coin',
		id: `launch:${l.mint}`,
		title: l.name || l.symbol || 'Coin',
		description: l.symbol ? `$${l.symbol}` : '',
		image: l.agent?.avatar_thumbnail_url || null,
		glbUrl: null,
		assetUrl: `/launches/${l.mint}`,
		creator: l.agent ? { label: l.agent.name || 'Launching agent', url: l.agent.url } : null,
		remix: null,
		createdAt: l.createdAt,
		signals: {},
	}));

	const ownMints = new Set(ownLaunches.map((l) => l.mint));
	// External pump.fun/Birdeye matches have no three.ws-verified created_at and
	// no resolvable creator profile — never fabricate either; the market data is
	// still real, just less complete than our own launch directory.
	const externalItems = external
		.filter((t) => !ownMints.has(t.mint))
		.map((t) => ({
			type: 'coin',
			id: `market:${t.mint}`,
			title: t.name || t.symbol || 'Coin',
			description: t.symbol ? `$${t.symbol}` : '',
			image: t.logo || null,
			glbUrl: null,
			assetUrl: `/coin3d?mint=${encodeURIComponent(t.mint)}`,
			creator: { label: 'pump.fun ↗', url: `https://pump.fun/${t.mint}` },
			remix: null,
			createdAt: null,
			signals: {},
		}));

	return [...ownItems, ...externalItems];
}

// ── ranking signals: follower counts for resolved creator profiles ──────────
// Batches one extra query for every /u/:username link a result set surfaced,
// so ranking can weight "does this creator have an audience" without an N+1.
export async function attachFollowerCounts(items) {
	const usernames = [...new Set(items.map((i) => i.creator?.url).filter((u) => u?.startsWith('/u/')).map((u) => u.slice(3)))];
	if (!usernames.length) return items;
	const rows = await sql`
		select u.username, count(f.follower_id)::int as followers
		from users u
		left join user_follows f on f.following_id = u.id
		where lower(u.username) = any(${usernames.map((u) => u.toLowerCase())})
		group by u.username
	`.catch(() => []);
	const byUsername = new Map(rows.map((r) => [r.username.toLowerCase(), r.followers]));
	for (const item of items) {
		const uname = item.creator?.url?.startsWith('/u/') ? item.creator.url.slice(3).toLowerCase() : null;
		if (uname && byUsername.has(uname)) {
			item.signals = { ...item.signals, followerCount: byUsername.get(uname) };
		}
	}
	return items;
}

// ── ranking ───────────────────────────────────────────────────────────────────
// Recency is the primary signal (real for every type except external
// market-wide coin matches, which carry no verified timestamp). Real
// engagement signals — followers, remix count, views — nudge a result up by a
// capped amount so a genuinely popular older item can beat a brand-new one,
// without letting popularity fully override "when was this made". No signal
// is fabricated: items missing a signal simply get zero boost from it.
const DAY_MS = 24 * 60 * 60 * 1000;
// Undated external coin matches sink near the bottom but still surface.
const UNDATED_BASELINE_MS = Date.now() - 365 * DAY_MS;

export function rankItems(items) {
	return items
		.map((item) => {
			const base = item.createdAt ? new Date(item.createdAt).getTime() : UNDATED_BASELINE_MS;
			const followers = item.signals?.followerCount || 0;
			const remixes = item.signals?.remixCount || 0;
			const views = item.signals?.viewCount || 0;
			const boost =
				Math.min(followers * DAY_MS, 30 * DAY_MS) +
				Math.min(remixes * DAY_MS * 0.5, 15 * DAY_MS) +
				Math.min(views * DAY_MS * 0.05, 7 * DAY_MS);
			return { item, score: base + boost };
		})
		.sort((a, b) => b.score - a.score)
		.map((s) => s.item);
}
