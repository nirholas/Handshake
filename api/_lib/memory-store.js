// Memory Store (P2 — Memory Studio engine)
// =========================================
// The real, tiered memory engine shared by api/agent-memory.js and api/memory/**.
//
// Tiers (Letta/MemGPT model):
//   working  — the small, always-in-context core (pinned + the agent's identity
//              and active rules). Token-budgeted.
//   recall   — recent interactions/trades, searchable.
//   archival — long-term store; semantic search over real embeddings.
//
// Embeddings are produced by api/_lib/embeddings.js (free NIM lane first, OpenAI
// backstop), stored as JSONB vectors tagged with the embedder that made them,
// and scored strictly within their own vector space (scoreRowsBySpace). No fake
// similarity: when no provider is configured, search degrades to substring +
// salience, never a fabricated cosine score.
//
// Entity graph (Zep/Graphiti-style temporal KG): every memory is mined for the
// mints, tickers, wallets, people and strategies it mentions; entities are
// upserted as graph nodes and linked to their source memory. Edges between
// entities are derived at read time from co-occurrence within a memory.

import { sql, sqlValues } from './db.js';
import {
	embeddingsConfigured,
	defaultIngestEmbedderTag,
	embedPassages,
	scoreRowsBySpace,
} from './embeddings.js';
import { extractEntities } from './memory-entities.js';

export const MEMORY_TIERS = ['working', 'recall', 'archival'];

// The working core is kept small on purpose — this is what's always paged into
// the model's context. ~4 chars/token is the platform's standard estimate
// (matches widget knowledge chunking).
export const WORKING_TOKEN_BUDGET = 2000;
export const CHARS_PER_TOKEN = 4;

// How many un-embedded / un-extracted rows a single read-triggered lazy pass
// processes. Bounds the work per request; repeated reads converge the backlog.
const EMBED_CAP = 24;
const ENTITY_CAP = 40;

export function estimateTokens(text) {
	return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

// ── Decoration ──────────────────────────────────────────────────────────────

export function decorateMemory(row, extra = {}) {
	const createdMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
	return {
		id: row.id,
		agent_id: row.agent_id,
		type: row.type,
		content: row.content,
		tags: row.tags || [],
		context: row.context || {},
		salience: row.salience,
		tier: row.tier || 'recall',
		pinned: !!row.pinned,
		embedder: row.embedder || null,
		hasEmbedding: row.has_embedding ?? row.embedding != null,
		accessCount: row.access_count ?? 0,
		isPublic: row.is_public ?? false,
		tokens: estimateTokens(row.content),
		createdAt: createdMs,
		updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : createdMs,
		lastAccessedAt: row.last_accessed_at ? new Date(row.last_accessed_at).getTime() : null,
		expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
		// Portable & Verifiable Brain — authorship + storage provenance. Present
		// on rows selected with the brain columns; absent (undefined) otherwise.
		contentHash: row.content_hash ?? undefined,
		signature: row.signature ?? undefined,
		signerAddress: row.signer_address ?? undefined,
		signedAt: row.signed_at ? new Date(row.signed_at).getTime() : (row.signed_at === null ? null : undefined),
		storageMode: row.storage_mode ?? undefined,
		ipfsCid: row.ipfs_cid ?? undefined,
		...extra,
	};
}

// ── Lazy embedding ────────────────────────────────────────────────────────────

/**
 * Embed up to EMBED_CAP not-yet-embedded memories for an agent. Best-effort:
 * returns counts and never throws (a provider outage just leaves rows for the
 * next pass). Covers every write path uniformly — no writer needs to embed.
 * @returns {Promise<{configured:boolean, embedded:number, remaining:number}>}
 */
export async function ensureEmbeddings(agentId, cap = EMBED_CAP) {
	if (!embeddingsConfigured()) return { configured: false, embedded: 0, remaining: 0 };
	const tag = defaultIngestEmbedderTag();
	if (!tag) return { configured: false, embedded: 0, remaining: 0 };

	let rows;
	try {
		rows = await sql`
			SELECT id, content FROM agent_memories
			WHERE agent_id = ${agentId} AND embedding IS NULL
			  AND (expires_at IS NULL OR expires_at > now())
			ORDER BY created_at DESC
			LIMIT ${cap + 1}
		`;
	} catch {
		return { configured: true, embedded: 0, remaining: 0 };
	}
	if (!rows.length) return { configured: true, embedded: 0, remaining: 0 };

	const capped = rows.length > cap;
	const batch = capped ? rows.slice(0, cap) : rows;

	let vectors;
	try {
		vectors = await embedPassages(tag, batch.map((r) => r.content || ''));
	} catch (err) {
		console.warn('[memory-store] embed batch failed', err?.code || err?.message);
		return { configured: true, embedded: 0, remaining: rows.length };
	}

	let embedded = 0;
	for (let i = 0; i < batch.length; i++) {
		const vec = vectors[i];
		if (!vec) continue;
		try {
			await sql`
				UPDATE agent_memories
				SET embedding = ${JSON.stringify(Array.from(vec))}::jsonb, embedder = ${tag}
				WHERE id = ${batch[i].id}
			`;
			embedded++;
		} catch {
			/* leave for next pass */
		}
	}
	return { configured: true, embedded, remaining: capped ? 1 : 0 };
}

// ── Semantic search (mem0 search()) ────────────────────────────────────────────

/**
 * Rank an agent's memories against a query. Embeds the query in each stored
 * vector space (never crossing spaces), filters by minScore, and fills any
 * shortfall with a salience-ranked substring match so recall is never empty
 * just because a provider is down.
 *
 * @param {string} agentId
 * @param {string} query
 * @param {{ topK?:number, minScore?:number, tiers?:string[], type?:string, bump?:boolean }} [opts]
 * @returns {Promise<{ results:Array<object>, provider:boolean, scored:number }>}
 */
export async function searchMemories(agentId, query, opts = {}) {
	const { topK = 8, minScore = 0.25, tiers, type, bump = true } = opts;
	const q = String(query || '').trim();
	if (!q) return { results: [], provider: false, scored: 0 };

	await ensureEmbeddings(agentId).catch(() => {});

	const tierList = Array.isArray(tiers) && tiers.length ? tiers.filter((t) => MEMORY_TIERS.includes(t)) : null;
	const rows = await sql`
		SELECT id, agent_id, type, content, tags, context, salience, tier, pinned,
		       embedder, embedding, access_count, is_public, created_at, updated_at,
		       last_accessed_at, expires_at
		FROM agent_memories
		WHERE agent_id = ${agentId}
		  AND (expires_at IS NULL OR expires_at > now())
		  AND (${type ?? null}::text IS NULL OR type = ${type ?? null})
		  AND (${tierList}::text[] IS NULL OR tier = ANY(${tierList}))
		ORDER BY created_at DESC
		LIMIT 1500
	`;
	if (!rows.length) return { results: [], provider: embeddingsConfigured(), scored: 0 };

	const embedded = rows.filter((r) => Array.isArray(r.embedding) && r.embedding.length);
	let semantic = [];
	let usedProvider = false;
	if (embedded.length && embeddingsConfigured()) {
		try {
			const { scored } = await scoreRowsBySpace(embedded, q);
			semantic = scored
				.filter((r) => r.score >= minScore)
				.sort((a, b) => b.score - a.score);
			usedProvider = true;
		} catch (err) {
			console.warn('[memory-store] scoring failed', err?.code || err?.message);
		}
	}

	const ranked = [];
	const seen = new Set();
	for (const r of semantic) {
		if (seen.has(r.id)) continue;
		seen.add(r.id);
		ranked.push(decorateMemory(r, { score: Number(r.score.toFixed(4)), match: 'semantic' }));
		if (ranked.length >= topK) break;
	}

	// Substring + salience fill so a query always surfaces obvious lexical hits
	// (and so recall works at all before embeddings backfill / when unconfigured).
	if (ranked.length < topK) {
		const ql = q.toLowerCase();
		const lexical = rows
			.filter((r) => !seen.has(r.id) && String(r.content || '').toLowerCase().includes(ql))
			.sort((a, b) => (b.salience || 0) - (a.salience || 0));
		for (const r of lexical) {
			if (seen.has(r.id)) continue;
			seen.add(r.id);
			ranked.push(decorateMemory(r, { score: null, match: 'lexical' }));
			if (ranked.length >= topK) break;
		}
	}

	if (bump && ranked.length) {
		const ids = ranked.map((r) => r.id);
		// Reinforcement: accessed memories gain a little salience (capped) and
		// record the access — the recency/decay loop the Letta tiering relies on.
		sql`
			UPDATE agent_memories
			SET access_count = access_count + 1,
			    last_accessed_at = now(),
			    salience = LEAST(1.0, salience + 0.02)
			WHERE id = ANY(${ids}::uuid[])
		`.catch(() => {});
	}

	return { results: ranked, provider: usedProvider, scored: semantic.length };
}

// ── Entity extraction + graph ──────────────────────────────────────────────────

/**
 * Mine up to ENTITY_CAP not-yet-processed memories for entities, upsert them as
 * graph nodes, and link each to its source memory. Idempotent + best-effort.
 * @returns {Promise<{processed:number, remaining:number}>}
 */
export async function ensureEntities(agentId, cap = ENTITY_CAP) {
	let rows;
	try {
		rows = await sql`
			SELECT id, content, tags, context FROM agent_memories
			WHERE agent_id = ${agentId} AND entities_extracted = false
			  AND (expires_at IS NULL OR expires_at > now())
			ORDER BY created_at DESC
			LIMIT ${cap + 1}
		`;
	} catch {
		return { processed: 0, remaining: 0 };
	}
	if (!rows.length) return { processed: 0, remaining: 0 };

	const capped = rows.length > cap;
	const batch = capped ? rows.slice(0, cap) : rows;

	// Mine every memory first, then write in three bulk statements instead of the
	// 2× INSERT + UPDATE per entity-per-row the loop used to issue.
	//   1. Upsert entities, aggregated by (kind, normalized): mention_count and the
	//      capped salience bump are summed over occurrences in this batch (net-equal
	//      to applying the per-occurrence upsert sequentially); label/meta take the
	//      last occurrence, matching the original EXCLUDED.* "last writer wins".
	//   2. Insert the (entity, memory) links, resolving entity ids from the upsert's
	//      RETURNING, with ON CONFLICT DO NOTHING.
	//   3. Mark the processed memories entities_extracted.
	const byKey = new Map();   // "kind\u0000normalized" → { kind, label, normalized, meta, count }
	const mentions = [];       // { key, memoryId } per occurrence — drives the links
	for (const row of batch) {
		const entities = extractEntities(row.content, row.tags || [], row.context || {});
		for (const e of entities) {
			const key = `${e.kind}\u0000${e.normalized}`;
			const agg = byKey.get(key);
			if (agg) {
				agg.count += 1;
				agg.label = e.label;
				agg.meta = e.meta || {};
			} else {
				byKey.set(key, { kind: e.kind, label: e.label, normalized: e.normalized, meta: e.meta || {}, count: 1 });
			}
			mentions.push({ key, memoryId: row.id });
		}
	}

	if (!byKey.size) {
		// No entities in any memory — still mark them processed so reads converge.
		try {
			const ids = batch.map((r) => r.id);
			await sql`UPDATE agent_memories SET entities_extracted = true WHERE id = ANY(${ids}::uuid[])`;
			return { processed: batch.length, remaining: capped ? 1 : 0 };
		} catch (err) {
			console.warn('[memory-store] entity extraction failed', err?.message);
			return { processed: 0, remaining: capped ? 1 : 0 };
		}
	}

	try {
		const entityRows = [...byKey.values()].map((e) => [
			agentId, e.kind, e.label, e.normalized, e.count, JSON.stringify(e.meta || {}),
		]);
		const upserted = await sql`
			INSERT INTO agent_memory_entities (agent_id, kind, label, normalized, mention_count, salience, meta)
			SELECT v.agent_id, v.kind, v.label, v.normalized, v.cnt::int,
			       LEAST(1.0, 0.5 + 0.05 * (v.cnt::int - 1)), v.meta::jsonb
			FROM ( VALUES ${sqlValues(entityRows)} ) AS v(agent_id, kind, label, normalized, cnt, meta)
			ON CONFLICT (agent_id, kind, normalized) DO UPDATE
			SET mention_count = agent_memory_entities.mention_count + EXCLUDED.mention_count,
			    last_seen_at = now(),
			    label = EXCLUDED.label,
			    salience = LEAST(1.0, agent_memory_entities.salience + 0.05 * EXCLUDED.mention_count)
			RETURNING id, kind, normalized
		`;

		const idByKey = new Map();
		for (const r of upserted) idByKey.set(`${r.kind}\u0000${r.normalized}`, r.id);

		// Dedup link pairs (the PK is (entity_id, memory_id)) before the bulk insert.
		const linkSet = new Set();
		const linkRows = [];
		for (const m of mentions) {
			const entityId = idByKey.get(m.key);
			if (!entityId) continue;
			const pair = `${entityId}\u0000${m.memoryId}`;
			if (linkSet.has(pair)) continue;
			linkSet.add(pair);
			linkRows.push([entityId, m.memoryId]);
		}
		if (linkRows.length) {
			await sql`
				INSERT INTO agent_memory_entity_links (entity_id, memory_id)
				SELECT v.entity_id::uuid, v.memory_id::uuid
				FROM ( VALUES ${sqlValues(linkRows)} ) AS v(entity_id, memory_id)
				ON CONFLICT DO NOTHING
			`;
		}

		const ids = batch.map((r) => r.id);
		await sql`UPDATE agent_memories SET entities_extracted = true WHERE id = ANY(${ids}::uuid[])`;
		return { processed: batch.length, remaining: capped ? 1 : 0 };
	} catch (err) {
		console.warn('[memory-store] entity extraction failed', err?.message);
		return { processed: 0, remaining: capped ? 1 : 0 };
	}
}

/**
 * Build the agent's knowledge graph: entity nodes + co-occurrence edges.
 * @returns {Promise<{nodes:Array<object>, edges:Array<object>, stats:object}>}
 */
export async function buildGraph(agentId, { limit = 200 } = {}) {
	await ensureEntities(agentId).catch(() => {});

	const entities = await sql`
		SELECT id, kind, label, normalized, salience, mention_count, first_seen_at, last_seen_at, meta
		FROM agent_memory_entities
		WHERE agent_id = ${agentId}
		ORDER BY mention_count DESC, last_seen_at DESC
		LIMIT ${limit}
	`;
	if (!entities.length) return { nodes: [], edges: [], stats: { entities: 0, edges: 0 } };

	const ids = entities.map((e) => e.id);
	const links = await sql`
		SELECT entity_id, memory_id FROM agent_memory_entity_links
		WHERE entity_id = ANY(${ids}::uuid[])
	`;

	// Group entities by the memory they co-occur in; every pair in a memory is an edge.
	const byMemory = new Map();
	for (const l of links) {
		if (!byMemory.has(l.memory_id)) byMemory.set(l.memory_id, []);
		byMemory.get(l.memory_id).push(l.entity_id);
	}
	const edgeWeights = new Map();
	for (const entIds of byMemory.values()) {
		const uniq = [...new Set(entIds)];
		for (let i = 0; i < uniq.length; i++) {
			for (let j = i + 1; j < uniq.length; j++) {
				const [a, b] = uniq[i] < uniq[j] ? [uniq[i], uniq[j]] : [uniq[j], uniq[i]];
				const key = `${a}|${b}`;
				edgeWeights.set(key, (edgeWeights.get(key) || 0) + 1);
			}
		}
	}

	const nodes = entities.map((e) => ({
		id: e.id,
		kind: e.kind,
		label: e.label,
		salience: e.salience,
		mentions: e.mention_count,
		firstSeenAt: e.first_seen_at ? new Date(e.first_seen_at).getTime() : null,
		lastSeenAt: e.last_seen_at ? new Date(e.last_seen_at).getTime() : null,
		meta: e.meta || {},
	}));
	const edges = [...edgeWeights.entries()].map(([key, weight]) => {
		const [source, target] = key.split('|');
		return { source, target, weight };
	});
	return { nodes, edges, stats: { entities: nodes.length, edges: edges.length } };
}

/**
 * Memories that mention a given entity (by id) — powers "what does my agent
 * remember about <mint>?" and graph-node drilldown.
 */
export async function memoriesForEntity(agentId, entityId, { limit = 50 } = {}) {
	const rows = await sql`
		SELECT m.id, m.agent_id, m.type, m.content, m.tags, m.context, m.salience, m.tier,
		       m.pinned, m.embedder, m.embedding, m.access_count, m.is_public, m.created_at,
		       m.updated_at, m.last_accessed_at, m.expires_at
		FROM agent_memories m
		JOIN agent_memory_entity_links l ON l.memory_id = m.id
		JOIN agent_memory_entities e ON e.id = l.entity_id
		WHERE e.id = ${entityId} AND e.agent_id = ${agentId} AND m.agent_id = ${agentId}
		  AND (m.expires_at IS NULL OR m.expires_at > now())
		ORDER BY m.created_at DESC
		LIMIT ${limit}
	`;
	return rows.map((r) => decorateMemory(r));
}

// ── Working context + token budget ──────────────────────────────────────────────

/**
 * The "in-context now" working set: pinned and working-tier memories, ordered by
 * salience, with a live token-budget accounting so the UI can show exactly what
 * the model carries and whether the core has overflowed its budget.
 */
export async function computeContext(agentId) {
	const rows = await sql`
		SELECT id, agent_id, type, content, tags, context, salience, tier, pinned,
		       embedder, embedding, access_count, is_public, created_at, updated_at,
		       last_accessed_at, expires_at
		FROM agent_memories
		WHERE agent_id = ${agentId}
		  AND (expires_at IS NULL OR expires_at > now())
		  AND (pinned = true OR tier = 'working')
		ORDER BY pinned DESC, salience DESC, created_at DESC
	`;
	let tokens = 0;
	const entries = rows.map((r) => {
		const dec = decorateMemory(r);
		tokens += dec.tokens;
		return dec;
	});
	const [counts] = await sql`
		SELECT
			COUNT(*)::int AS total,
			COUNT(*) FILTER (WHERE tier = 'working')::int AS working,
			COUNT(*) FILTER (WHERE tier = 'recall')::int AS recall,
			COUNT(*) FILTER (WHERE tier = 'archival')::int AS archival,
			COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
		FROM agent_memories
		WHERE agent_id = ${agentId} AND (expires_at IS NULL OR expires_at > now())
	`;
	return {
		entries,
		tokens,
		budget: WORKING_TOKEN_BUDGET,
		overBudget: tokens > WORKING_TOKEN_BUDGET,
		counts: counts || { total: 0, working: 0, recall: 0, archival: 0, embedded: 0 },
	};
}

// ── Tier assignment helper (used at write time) ──────────────────────────────────

/**
 * Default tier for a new memory: pinned/working when the caller pins it,
 * archival for low-salience reference material, recall otherwise.
 */
export function defaultTier({ pinned, salience = 0.5, type } = {}) {
	if (pinned) return 'working';
	if (type === 'reference' && salience < 0.5) return 'archival';
	return 'recall';
}
