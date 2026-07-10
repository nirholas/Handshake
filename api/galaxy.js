/**
 * Agent Galaxy — a semantic 3D star-map of every published agent on three.ws,
 * positioned by IBM Granite embeddings (watsonx.ai) and grouped into Granite-named
 * constellations.
 *
 *   GET  /api/galaxy              — the full galaxy snapshot (cached server-side).
 *        ?refresh=1               — force a rebuild (re-embed changed agents,
 *                                   re-cluster, re-name constellations).
 *        ?limit=<n>               — cap agents (default 600, max 1200; busiest first).
 *
 *   POST /api/galaxy              — { "query": "trading bots" } semantic search.
 *                                   Embeds the query with Granite, ranks published
 *                                   agents by cosine similarity against their stored
 *                                   Granite vectors, returns the top matches.
 *
 * No mock path. Coordinates and rankings come from real watsonx.ai embeddings; when
 * watsonx is unconfigured the endpoint returns 503 with a machine-readable reason so
 * the viewer can explain the requirement instead of inventing a fake universe.
 */

import { sql } from './_lib/db.js';
import { cacheWrap } from './_lib/cache.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from './_lib/http.js';
import { clampInt } from './_lib/http-params.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { thumbnailUrl } from './_lib/r2.js';
import { watsonxConfig, watsonxEmbed, watsonxChatComplete } from './_lib/watsonx.js';
import { ensureAgentEmbeddings, readAgentVectors } from './_lib/agent-embeddings.js';
import {
	assembleGalaxy,
	rankBySimilarity,
	clusterNamePrompt,
	parseClusterName,
} from './_lib/galaxy.js';

// A served snapshot is reused for this long before a GET rebuilds it. The embedding
// cache (agent_embeddings) makes rebuilds cheap — only new/edited agents re-embed —
// so this mostly throttles the k Granite cluster-naming calls per rebuild.
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// Coalesce concurrent rebuilds within a warm function instance so a burst of first
// visitors triggers one build, not N. Keyed by the build limit.
const building = new Map(); // limit → Promise<payload>

let _snapshotTableReady = null;
function ensureSnapshotTable() {
	if (_snapshotTableReady) return _snapshotTableReady;
	_snapshotTableReady = sql`
		CREATE TABLE IF NOT EXISTS galaxy_snapshots (
			id          bigserial PRIMARY KEY,
			model       text NOT NULL,
			agent_count int  NOT NULL,
			payload     jsonb NOT NULL,
			created_at  timestamptz NOT NULL DEFAULT now()
		)
	`.then(() => true);
	return _snapshotTableReady;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const cfg = watsonxConfig();
	if (!cfg.configured) {
		return error(
			res,
			503,
			'watsonx_unavailable',
			'The Agent Galaxy is positioned by IBM Granite embeddings on watsonx.ai. ' +
				'Set WATSONX_API_KEY and WATSONX_PROJECT_ID (or WATSONX_SPACE_ID) to build it.',
		);
	}

	if (req.method === 'POST') return handleSearch(req, res, cfg);
	return handleGalaxy(req, res, cfg);
});

// ── GET: the galaxy snapshot ────────────────────────────────────────────────

async function handleGalaxy(req, res, cfg) {
	const url = new URL(req.url, 'http://x');
	const refresh = url.searchParams.get('refresh') === '1';
	const limit = clampInt(url.searchParams.get('limit'), { max: 1200, fallback: 600 });

	await ensureSnapshotTable();

	if (!refresh) {
		const [snap] = await sql`
			SELECT payload, created_at FROM galaxy_snapshots ORDER BY created_at DESC LIMIT 1
		`;
		if (snap && Date.now() - new Date(snap.created_at).getTime() < SNAPSHOT_TTL_MS) {
			return json(res, 200, {
				...snap.payload,
				cached: true,
				generated_at: snap.created_at,
			});
		}
	}

	// Coalesce concurrent rebuilds in this warm instance.
	let job = building.get(limit);
	if (!job) {
		job = buildGalaxy(cfg, limit).finally(() => building.delete(limit));
		building.set(limit, job);
	}
	const payload = await job;

	return json(res, 200, { ...payload, cached: false, generated_at: new Date().toISOString() });
}

// Build a fresh galaxy: load published agents, ensure their Granite embeddings,
// project + cluster, name the constellations with Granite, persist the snapshot.
async function buildGalaxy(cfg, limit) {
	const agents = await loadPublishedAgents(limit);

	if (agents.length === 0) {
		const empty = { count: 0, dims: 0, model: cfg.embedModel, clusters: [], agents: [] };
		await persistSnapshot(empty);
		return empty;
	}

	const { vectors, dims, model } = await ensureAgentEmbeddings(cfg, agents);

	const payload = await assembleGalaxy(agents, vectors, {
		dims,
		model,
		nameClusters: (clusters) => nameClustersWithGranite(cfg, clusters),
	});

	await persistSnapshot(payload);
	return payload;
}

// Ask Granite to name each constellation from its members. One short chat call per
// cluster (k ≤ 8), run in parallel. Any failure or unparseable reply falls back to a
// member-derived label inside assembleGalaxy, so this never throws the whole build.
async function nameClustersWithGranite(cfg, clusters) {
	return Promise.all(
		clusters.map(async (cluster) => {
			try {
				const { text } = await watsonxChatComplete(cfg, {
					messages: [{ role: 'user', content: clusterNamePrompt(cluster.members) }],
					maxTokens: 120,
					temperature: 0.5,
				});
				return parseClusterName(text);
			} catch {
				return {};
			}
		}),
	);
}

async function persistSnapshot(payload) {
	try {
		await sql`
			INSERT INTO galaxy_snapshots (model, agent_count, payload)
			VALUES (${payload.model || 'unknown'}, ${payload.count || 0}, ${JSON.stringify(payload)}::jsonb)
		`;
		// Keep only the most recent few snapshots.
		await sql`
			DELETE FROM galaxy_snapshots
			WHERE id NOT IN (SELECT id FROM galaxy_snapshots ORDER BY created_at DESC LIMIT 5)
		`;
	} catch (err) {
		// A persistence failure must not fail the request — the caller still gets a
		// freshly computed payload; the next GET simply rebuilds instead of caching.
		console.error('[galaxy] persistSnapshot failed', err);
	}
}

// ── POST: Granite semantic search ───────────────────────────────────────────

async function handleSearch(req, res, cfg) {
	const body = await readJson(req).catch(() => ({}));
	const query = String(body.query || '').trim().slice(0, 200);
	if (!query) return error(res, 400, 'validation_error', 'query is required');

	const topK = clampInt(body.limit, { max: 30, fallback: 12 });

	// Embed the query with the same Granite model the agents were embedded with, so
	// query and agent vectors share a space.
	const { vectors } = await watsonxEmbed(cfg, { inputs: [query], model: cfg.embedModel });
	const queryVec = vectors[0];
	if (!queryVec?.length) {
		return error(res, 502, 'embed_failed', 'watsonx returned no embedding for the query');
	}

	const agents = await loadPublishedAgents(1200);
	const byId = new Map(agents.map((a) => [a.id, a]));
	const vectorsById = await readAgentVectors([...byId.keys()], { model: cfg.embedModel });

	const ranked = rankBySimilarity(queryVec, vectorsById, { topK });
	const results = ranked
		.map(({ id, score }) => {
			const a = byId.get(id);
			if (!a) return null;
			return {
				id: a.id,
				name: a.name,
				description: a.description || '',
				thumbnail: a.thumbnail || null,
				score,
			};
		})
		.filter(Boolean);

	return json(res, 200, { query, model: cfg.embedModel, count: results.length, results });
}

// ── Shared: published-agent population ──────────────────────────────────────

// The galaxy and search share the same population: published, named, described
// agents (mirrors /api/characters' feed filter), busiest first so a `limit` keeps
// the most active agents. Wallet + token surface the on-chain identity layer in the
// viewer; both are public-safe.
async function loadPublishedAgents(limit) {
	// This is the same public feed for every viewer, and its `chat_count`
	// correlated subquery + `ORDER BY chat_count` forces a COUNT(*) over
	// usage_events for EVERY published agent on each load — the dominant cost
	// here. Cache the result for 60s so that expensive ranking runs at most once
	// a minute regardless of traffic.
	const rows = await cacheWrap(`galaxy:published:${limit}`, 60, async () => await sql`
		SELECT
			i.id,
			i.name,
			i.description,
			i.wallet_address,
			i.chain_id,
			i.meta,
			a.thumbnail_key AS avatar_thumbnail_key,
			a.visibility    AS avatar_visibility,
			COALESCE((
				SELECT COUNT(*)::int FROM usage_events ue
				WHERE ue.agent_id = i.id AND ue.kind = 'llm'
			), 0) AS chat_count
		FROM agent_identities i
		LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
		WHERE i.deleted_at IS NULL
		  AND i.is_published = true
		  AND i.description IS NOT NULL
		  AND length(trim(i.name)) > 0
		ORDER BY chat_count DESC, i.created_at DESC
		LIMIT ${limit}
	`);

	return rows.map((row) => {
		const meta = row.meta || {};
		const thumbnail =
			row.avatar_thumbnail_key &&
			(row.avatar_visibility === 'public' || row.avatar_visibility === 'unlisted')
				? thumbnailUrl(row.avatar_thumbnail_key)
				: meta.profile_image_url || meta.thumbnail_url || meta.avatar_url || null;
		const token = meta.token || null;
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			thumbnail,
			wallet: row.wallet_address || meta.solana_address || null,
			chain: row.chain_id || (meta.solana_address ? 'solana' : null),
			// Vanity pattern (if any) so the shared wallet chip can advertise the
			// address's honest rarity tier on the inspect card, matching every other
			// surface. Public, non-secret metadata.
			solana_vanity_prefix: meta.solana_vanity_prefix || null,
			solana_vanity_suffix: meta.solana_vanity_suffix || null,
			chat_count: row.chat_count,
			token: token
				? {
						symbol: token.symbol || null,
						mint: token.mint || null,
						market_cap_usd: token.market_cap_usd ?? token.usd_market_cap ?? null,
					}
				: null,
		};
	});
}
