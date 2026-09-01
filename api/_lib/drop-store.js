// Generative 3D drops: persistence.
//
// The engine in ./drops.js is pure; this module is the only thing that talks to
// Postgres about drops. It keeps two invariants the rest of the feature relies
// on:
//
//  1. A drop and its full rolled supply are written together. A drop row with a
//     partial item set would serve a supply whose rarity ranks disagree with the
//     published provenance hash, so createDrop inserts every item in the same
//     transaction as the parent and fails as a unit.
//  2. A reveal is claimed atomically. Two concurrent reveal requests for the
//     same index must not both start a paid generation job, so claimForReveal
//     is a conditional UPDATE that returns a row only to the caller that won.

import { randomUUID } from 'node:crypto';
import { sql, sqlValues } from './db.js';
import { databaseConfigured } from './env.js';
import {
	assertSupply,
	normalizeLayers,
	provenanceHash,
	rollSupply,
	slugify,
	traitDistribution,
} from './drops.js';

// Items are inserted in chunks so a 10k supply does not build one enormous
// parameterized statement. 500 rows x 7 columns is 3500 placeholders, which is
// comfortably inside Postgres's 65535 parameter ceiling with room to spare.
const ITEM_INSERT_CHUNK = 500;

export function dropsConfigured() {
	return databaseConfigured();
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Create
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Create a drop and materialize its entire rolled supply.
 *
 * @param {object} spec
 * @returns {Promise<object>} the created drop, with its provenance hash
 */
export async function createDrop({
	ownerId,
	name,
	symbol,
	description,
	style,
	supply,
	layers,
	seed,
	visibility = 'public',
}) {
	const size = assertSupply(supply);
	const normalizedLayers = normalizeLayers(layers);
	const rollSeed = String(seed || randomUUID()).slice(0, 64);
	const hash = provenanceHash({ seed: rollSeed, supply: size, style, layers: normalizedLayers });

	const slug = await uniqueSlug(name);
	const items = rollSupply({ seed: rollSeed, supply: size, layers: normalizedLayers });

	const [drop] = await sql`
		insert into drops (owner_id, slug, name, symbol, description, style, supply, seed,
		                   provenance_hash, layers, visibility)
		values (${ownerId}, ${slug}, ${name}, ${symbol}, ${description || null}, ${style},
		        ${size}, ${rollSeed}, ${hash}, ${JSON.stringify(normalizedLayers)}, ${visibility})
		returning *
	`;

	try {
		for (let start = 0; start < items.length; start += ITEM_INSERT_CHUNK) {
			const chunk = items.slice(start, start + ITEM_INSERT_CHUNK);
			const rows = chunk.map((item) => [
				drop.id,
				item.index,
				JSON.stringify(item.traits),
				item.rarity_score,
				item.rarity_rank,
				item.rarity_tier,
			]);
			await sql`
				insert into drop_items (drop_id, idx, traits, rarity_score, rarity_rank, rarity_tier)
				values ${sqlValues(rows)}
			`;
		}
	} catch (err) {
		// A drop whose supply is half-written is worse than no drop at all: it
		// would serve rarity ranks that do not match its own provenance hash.
		// Roll the parent back so the creator can simply retry.
		await sql`delete from drops where id = ${drop.id}`.catch(() => {});
		throw err;
	}

	return publicDrop(drop, { includeSeed: true });
}

async function uniqueSlug(name) {
	const base = slugify(name) || 'drop';
	for (let attempt = 0; attempt < 12; attempt++) {
		const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`.slice(0, 48);
		const rows = await sql`select 1 from drops where slug = ${candidate} and deleted_at is null limit 1`;
		if (rows.length === 0) return candidate;
	}
	return `${base.slice(0, 40)}-${randomUUID().slice(0, 6)}`;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Read
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Public drop index, newest first. Returns live and closed drops only: a draft
 * has not published its seed, so its rarity claims are not yet checkable and it
 * has no business on a public listing.
 */
export async function listDrops({ limit = 24, before = null, ownerId = null } = {}) {
	const capped = Math.min(Math.max(Number(limit) || 24, 1), 60);
	const rows = ownerId
		? await sql`
			select d.*, ${revealedCountExpr} as revealed_count, ${mintedCountExpr} as minted_count
			from drops d
			where d.owner_id = ${ownerId} and d.deleted_at is null
			  and (${before}::timestamptz is null or d.created_at < ${before}::timestamptz)
			order by d.created_at desc
			limit ${capped}
		`
		: await sql`
			select d.*, ${revealedCountExpr} as revealed_count, ${mintedCountExpr} as minted_count
			from drops d
			where d.deleted_at is null and d.visibility = 'public' and d.status in ('live', 'closed')
			  and (${before}::timestamptz is null or d.created_at < ${before}::timestamptz)
			order by d.created_at desc
			limit ${capped}
		`;
	return rows.map((row) => publicDrop(row));
}

// Correlated counts, so the index does not need a second round trip per drop.
const revealedCountExpr = sql`(select count(*) from drop_items i where i.drop_id = d.id and i.status = 'revealed')`;
const mintedCountExpr = sql`(select count(*) from drop_items i where i.drop_id = d.id and i.mint_address is not null)`;

/** @returns {Promise<object|null>} */
export async function getDropBySlug(slug, { viewerId = null } = {}) {
	const rows = await sql`
		select d.*, ${revealedCountExpr} as revealed_count, ${mintedCountExpr} as minted_count
		from drops d
		where d.slug = ${slug} and d.deleted_at is null
		limit 1
	`;
	const row = rows[0];
	if (!row) return null;
	const isOwner = viewerId && row.owner_id === viewerId;
	if (row.visibility === 'private' && !isOwner) return null;
	// The seed is the commitment's other half. It is published the moment the
	// drop goes live, and withheld from everyone but the creator before that.
	return publicDrop(row, { includeSeed: row.status !== 'draft' || Boolean(isOwner), isOwner });
}

/** The internal row, seed and all. Never serve this straight to a client. */
export async function getDropRow(dropId) {
	const rows = await sql`select * from drops where id = ${dropId} and deleted_at is null limit 1`;
	return rows[0] || null;
}

export async function listItems(dropId, { limit = 48, offset = 0, tier = null, status = null, sort = 'rank' } = {}) {
	const capped = Math.min(Math.max(Number(limit) || 48, 1), 200);
	const skip = Math.max(Number(offset) || 0, 0);
	const order = sort === 'index' ? sql`i.idx asc` : sql`i.rarity_rank asc`;
	const rows = await sql`
		select * from drop_items i
		where i.drop_id = ${dropId}
		  and (${tier}::text is null or i.rarity_tier = ${tier}::text)
		  and (${status}::text is null or i.status = ${status}::text)
		order by ${order}
		limit ${capped} offset ${skip}
	`;
	return rows.map(publicItem);
}

export async function countItems(dropId, { tier = null, status = null } = {}) {
	const rows = await sql`
		select count(*)::int as n from drop_items
		where drop_id = ${dropId}
		  and (${tier}::text is null or rarity_tier = ${tier}::text)
		  and (${status}::text is null or status = ${status}::text)
	`;
	return rows[0]?.n || 0;
}

export async function getItem(dropId, idx) {
	const rows = await sql`
		select * from drop_items where drop_id = ${dropId} and idx = ${idx} limit 1
	`;
	return rows[0] ? publicItem(rows[0]) : null;
}

/** Per-layer trait frequency for the rarity panel, computed from the stored supply. */
export async function itemDistribution(dropId, layers) {
	const rows = await sql`select traits from drop_items where drop_id = ${dropId}`;
	return traitDistribution(
		rows.map((r) => ({ traits: parseJson(r.traits, []) })),
		layers,
	);
}

/** Counts by status and by tier in one round trip, for the supply meter. */
export async function dropStats(dropId) {
	const rows = await sql`
		select status, rarity_tier, count(*)::int as n
		from drop_items where drop_id = ${dropId}
		group by status, rarity_tier
	`;
	const byStatus = { sealed: 0, revealing: 0, revealed: 0, failed: 0 };
	const byTier = { common: 0, rare: 0, epic: 0, legendary: 0 };
	for (const row of rows) {
		byStatus[row.status] = (byStatus[row.status] || 0) + row.n;
		byTier[row.rarity_tier] = (byTier[row.rarity_tier] || 0) + row.n;
	}
	return { by_status: byStatus, by_tier: byTier };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Mutate
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Freeze a draft and publish its seed.
 *
 * One-way on purpose. After this point the spec that the provenance hash
 * commits to is the spec holders can check, so editing it would invalidate
 * every claim the drop has already made.
 */
export async function publishDrop(dropId, ownerId) {
	const rows = await sql`
		update drops set status = 'live'
		where id = ${dropId} and owner_id = ${ownerId} and status = 'draft' and deleted_at is null
		returning *
	`;
	return rows[0] ? publicDrop(rows[0], { includeSeed: true, isOwner: true }) : null;
}

export async function closeDrop(dropId, ownerId) {
	const rows = await sql`
		update drops set status = 'closed'
		where id = ${dropId} and owner_id = ${ownerId} and status = 'live' and deleted_at is null
		returning *
	`;
	return rows[0] ? publicDrop(rows[0], { includeSeed: true, isOwner: true }) : null;
}

/**
 * Claim one item for reveal.
 *
 * The conditional UPDATE is the lock: only a row still `sealed` (or a `failed`
 * one being retried) transitions, and only one concurrent caller can win it, so
 * a double-clicked reveal button cannot start two paid generation jobs for the
 * same token.
 *
 * @returns {Promise<object|null>} the claimed item, or null if someone else won
 */
export async function claimForReveal(dropId, idx) {
	const rows = await sql`
		update drop_items
		set status = 'revealing', reveal_attempts = reveal_attempts + 1, reveal_error = null
		where drop_id = ${dropId} and idx = ${idx} and status in ('sealed', 'failed')
		returning *
	`;
	return rows[0] ? publicItem(rows[0]) : null;
}

/** Record the forge job handle so a reveal survives a restart mid-generation. */
export async function attachForgeJob(dropId, idx, jobId) {
	await sql`
		update drop_items set forge_job_id = ${jobId}
		where drop_id = ${dropId} and idx = ${idx} and status = 'revealing'
	`;
}

export async function markRevealed(dropId, idx, { glbUrl, thumbnailUrl = null, creationId = null, rigged = false }) {
	const rows = await sql`
		update drop_items
		set status = 'revealed', glb_url = ${glbUrl}, thumbnail_url = ${thumbnailUrl},
		    creation_id = ${creationId}, rigged = ${Boolean(rigged)},
		    revealed_at = now(), reveal_error = null
		where drop_id = ${dropId} and idx = ${idx}
		returning *
	`;
	return rows[0] ? publicItem(rows[0]) : null;
}

export async function markRevealFailed(dropId, idx, message) {
	const rows = await sql`
		update drop_items
		set status = 'failed', reveal_error = ${String(message || 'generation failed').slice(0, 500)}
		where drop_id = ${dropId} and idx = ${idx}
		returning *
	`;
	return rows[0] ? publicItem(rows[0]) : null;
}

/** Release a stuck claim so the item can be revealed again. */
export async function releaseClaim(dropId, idx) {
	await sql`
		update drop_items set status = 'sealed'
		where drop_id = ${dropId} and idx = ${idx} and status = 'revealing'
	`;
}

export async function setCollectionAddress(dropId, ownerId, address) {
	const rows = await sql`
		update drops set collection_address = ${address}
		where id = ${dropId} and owner_id = ${ownerId} and collection_address is null and deleted_at is null
		returning *
	`;
	return rows[0] ? publicDrop(rows[0], { includeSeed: true, isOwner: true }) : null;
}

export async function markMinted(dropId, idx, { mintAddress, ownerWallet }) {
	const rows = await sql`
		update drop_items
		set mint_address = ${mintAddress}, owner_wallet = ${ownerWallet}, minted_at = now()
		where drop_id = ${dropId} and idx = ${idx} and mint_address is null
		returning *
	`;
	return rows[0] ? publicItem(rows[0]) : null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Shapes
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The client-facing drop shape. `seed` is present only when the caller is
 * entitled to it, so a draft's commitment stays sealed until it goes live.
 */
export function publicDrop(row, { includeSeed = false, isOwner = false } = {}) {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		symbol: row.symbol,
		description: row.description,
		style: row.style,
		supply: row.supply,
		status: row.status,
		visibility: row.visibility,
		provenance_hash: row.provenance_hash,
		seed: includeSeed ? row.seed : null,
		layers: parseJson(row.layers, []),
		collection_address: row.collection_address,
		cover_item_index: row.cover_item_index,
		revealed_count: Number(row.revealed_count ?? 0),
		minted_count: Number(row.minted_count ?? 0),
		created_at: row.created_at,
		is_owner: isOwner,
	};
}

export function publicItem(row) {
	return {
		index: row.idx,
		traits: parseJson(row.traits, []),
		rarity_score: Number(row.rarity_score),
		rarity_rank: row.rarity_rank,
		rarity_tier: row.rarity_tier,
		status: row.status,
		glb_url: row.glb_url,
		thumbnail_url: row.thumbnail_url,
		rigged: row.rigged,
		reveal_error: row.reveal_error,
		mint_address: row.mint_address,
		owner_wallet: row.owner_wallet,
		revealed_at: row.revealed_at,
		minted_at: row.minted_at,
	};
}

function parseJson(value, fallback) {
	if (value == null) return fallback;
	if (typeof value === 'object') return value;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}
