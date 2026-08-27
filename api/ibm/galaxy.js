// /api/ibm/galaxy — the IBM Granite Agent Galaxy.
//
// GET  /api/ibm/galaxy        → builds (or returns cached) the 3D constellation:
//   every public agent embedded with an IBM Granite embedding model on
//   watsonx.ai, projected to 3D by PCA so semantically similar agents sit near
//   each other, grouped into themes by k-means, and each theme NAMED by IBM
//   Granite. Real embeddings, real positions, no mock path.
//
// POST /api/ibm/galaxy {query} → semantic search: embeds the natural-language
//   query with the same Granite model and ranks every agent by cosine
//   similarity, so "a witty Solana trading assistant" flies the camera to the
//   agents that actually mean that.
//
// The whole layout is cached in Postgres keyed by a content version derived from
// the agent set, so repeat loads are instant and stable, and a rebuild only
// happens when agents are added or edited.

import { sql } from '../_lib/db.js';
import { cors, method, readJson, error, json, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { publicUrl } from '../_lib/r2.js';
import { watsonxConfig, watsonxEmbed, watsonxChatComplete } from '../_lib/watsonx.js';
import {
	ensureAgentEmbeddings,
	readAgentVectors,
	agentEmbedText,
} from '../_lib/agent-embeddings.js';
import {
	projectTo3D,
	kmeans,
	suggestClusterCount,
	cosineSimilarity,
	unit,
	dot,
} from '../_lib/embedding-math.js';
import { rankLexically } from '../_lib/lexical-rank.js';
import { createHash } from 'node:crypto';

// Hard cap on agents in one galaxy — keeps embedding cost bounded and the scene
// legible. Surfaced in meta.truncated so we never silently hide agents.
const MAX_AGENTS = 400;
// A galaxy is considered fresh for this long even if its version is unchanged;
// bounds how stale a cached layout can be against new agents.
const CACHE_TTL_MS = 30 * 60 * 1000;
// Bumping this invalidates every cached layout when the build algorithm changes.
// v2: payload now carries per-agent semantic neighbours.
const ALGO_VERSION = 'v2';
// How many semantic neighbours to precompute per agent.
const NEIGHBOR_K = 6;

// IBM Carbon-derived palette — distinct, accessible hues for up to 8 themes.
const CLUSTER_COLORS = [
	'#4589ff',
	'#08bdba',
	'#a56eff',
	'#ff7eb6',
	'#fa4d56',
	'#f1c21b',
	'#42be65',
	'#82cfff',
];

let _cacheReady = null;
function ensureCacheTable() {
	if (_cacheReady) return _cacheReady;
	_cacheReady = sql`
		CREATE TABLE IF NOT EXISTS agent_galaxy_cache (
			id           text PRIMARY KEY,
			data_version text NOT NULL,
			payload      jsonb NOT NULL,
			computed_at  timestamptz NOT NULL DEFAULT now()
		)
	`.then(() => true);
	// Drop the latch if the DDL rejects. Caching the promise unconditionally means
	// one transient DB blip (a dropped connection, a cold Neon branch) is memoized
	// as a permanently rejected promise, and every later request on that warm
	// instance re-awaits the same rejection: the galaxy stays down until the
	// instance recycles, long after the database recovered. Clearing it lets the
	// next caller retry the create, while concurrent callers still share one
	// round-trip on the happy path.
	_cacheReady = _cacheReady.catch((err) => {
		_cacheReady = null;
		throw err;
	});
	return _cacheReady;
}

// The candidate agent set, identical for build and search so search ranks
// exactly what the galaxy shows. Public, non-deleted, with real embeddable text.
async function selectGalaxyAgents() {
	return sql`
		SELECT i.id, i.name, i.description, i.avatar_url, i.profile_image_url,
		       i.home_url, i.persona_tone_tags, i.updated_at, i.created_at
		FROM agent_identities i
		WHERE i.deleted_at IS NULL
		  AND i.is_public = true
		  AND i.description IS NOT NULL
		  AND length(trim(i.description)) > 0
		ORDER BY i.created_at DESC
		LIMIT ${MAX_AGENTS}
	`;
}

// A version fingerprint of the agent set: any add/remove/edit (updated_at moves
// on edit) changes it, triggering a rebuild; an unchanged set reuses the cache.
function dataVersion(agents, model) {
	const h = createHash('sha256');
	h.update(`${ALGO_VERSION}|${model}|${agents.length}`);
	for (const a of agents) {
		const stamp = a.updated_at || a.created_at;
		h.update(`|${a.id}:${stamp ? new Date(stamp).getTime() : 0}`);
	}
	return h.digest('hex');
}

function agentImage(a) {
	return (
		a.profile_image_url ||
		a.avatar_url ||
		(a.avatar_storage_key ? publicUrl(a.avatar_storage_key) : null)
	);
}

function agentUrl(a) {
	return a.home_url || `/agents/${a.id}`;
}

// ── Cluster naming ───────────────────────────────────────────────────────────

const STOPWORDS = new Set(
	(
		'a an the and or of to for with in on at by from your you our we is are be this that ' +
		'agent agents ai assistant bot help can will your their it its as your into about'
	).split(' '),
);

// Deterministic fallback theme name derived from the most frequent meaningful
// words across a cluster's members. Used only if Granite naming fails — it's
// real signal from the agents, not invented text.
function keywordLabel(members) {
	const counts = new Map();
	for (const m of members) {
		const text = `${m.name || ''} ${m.description || ''}`.toLowerCase();
		for (const raw of text.split(/[^a-z0-9]+/)) {
			const w = raw.trim();
			if (w.length < 4 || STOPWORDS.has(w)) continue;
			counts.set(w, (counts.get(w) || 0) + 1);
		}
	}
	const top = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2)
		.map(([w]) => w);
	if (!top.length) return 'Mixed';
	return top.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function sanitizeLabel(text) {
	if (!text) return '';
	let s = String(text).split('\n')[0].trim();
	s = s.replace(/^["'`*\-\s]+|["'`*.\s]+$/g, ''); // strip quotes/markdown/trailing punctuation
	s = s.replace(/\s+/g, ' ');
	if (s.length > 28) s = s.slice(0, 28).trim();
	return s;
}

// Ask Granite to name one theme from up to 8 of its members. Returns a short
// Title-Case label; throws are caught by the caller, which falls back to
// keywordLabel.
async function graniteThemeLabel(cfg, members) {
	const sample = members
		.slice(0, 8)
		.map((m) => {
			const desc = (m.description || '').replace(/\s+/g, ' ').slice(0, 120);
			return `- ${m.name}: ${desc}`;
		})
		.join('\n');
	const messages = [
		{
			role: 'system',
			content:
				'You name themes for clusters of AI agents. Given a list of agents, reply with ONLY a ' +
				'concise 1-3 word theme label in Title Case. No quotes, no punctuation, no explanation.',
		},
		{ role: 'user', content: `Agents in this group:\n${sample}\n\nTheme label:` },
	];
	const { text } = await watsonxChatComplete(cfg, { messages, maxTokens: 12, temperature: 0.2 });
	return sanitizeLabel(text);
}

// ── Build ────────────────────────────────────────────────────────────────────

// `rows` is the agent set the caller already read and fingerprinted. Reading it
// again here would not just cost a second identical query: an agent added
// between the two reads would be embedded into this payload while the cache row
// carries the pre-add fingerprint, so the stale layout would be served as fresh
// until the TTL expired.
async function buildGalaxy(cfg, rows) {
	const agents = rows.filter((a) => agentEmbedText(a)); // must have embeddable text

	if (agents.length < 2) {
		return {
			available: true,
			agents: [],
			clusters: [],
			meta: {
				count: agents.length,
				totalPublic: rows.length,
				model: cfg.embedModel,
				reason: agents.length === 0 ? 'no_agents' : 'too_few_agents',
			},
		};
	}

	const { vectors, model, dims } = await ensureAgentEmbeddings(cfg, agents);

	// Keep only agents that came back with a real vector.
	const kept = [];
	const keptVecs = [];
	for (let i = 0; i < agents.length; i++) {
		if (vectors[i]?.length) {
			kept.push(agents[i]);
			keptVecs.push(vectors[i]);
		}
	}
	if (kept.length < 2) {
		return {
			available: true,
			agents: [],
			clusters: [],
			meta: { count: kept.length, totalPublic: rows.length, model, reason: 'too_few_agents' },
		};
	}

	// L2-normalise so PCA geometry and k-means distances reflect cosine
	// similarity (the natural metric for these embeddings).
	const unitVecs = keptVecs.map(unit);
	const coords = projectTo3D(unitVecs, { radius: 100 });
	const kTarget = suggestClusterCount(kept.length);
	const { assignments, k } = kmeans(unitVecs, kTarget);

	// True semantic neighbours per agent, ranked by Granite cosine similarity (a
	// dot product on the unit vectors). This is what the detail panel surfaces as
	// "nearest in meaning" — the real embedding metric, not just 3D proximity.
	const neighbors = topNeighbors(unitVecs, NEIGHBOR_K);

	// Group members per cluster for naming + centroid placement.
	const groups = Array.from({ length: k }, () => []);
	for (let i = 0; i < kept.length; i++) {
		groups[assignments[i]].push({
			index: i,
			name: kept[i].name,
			description: kept[i].description,
		});
	}

	// Name every theme with Granite in parallel; degrade per-cluster to a
	// keyword label only if a specific call fails.
	const labels = await Promise.all(
		groups.map(async (members) => {
			if (!members.length) return { label: 'Mixed', labelSource: 'keyword' };
			try {
				const label = await graniteThemeLabel(cfg, members);
				if (label) return { label, labelSource: 'granite' };
			} catch {
				// fall through to keyword
			}
			return { label: keywordLabel(members), labelSource: 'keyword' };
		}),
	);

	// 3D centroid of each cluster (mean of member positions) for the floating label.
	const centroids = groups.map((members) => {
		if (!members.length) return [0, 0, 0];
		const c = [0, 0, 0];
		for (const m of members) {
			c[0] += coords[m.index][0];
			c[1] += coords[m.index][1];
			c[2] += coords[m.index][2];
		}
		return [c[0] / members.length, c[1] / members.length, c[2] / members.length];
	});

	const outAgents = kept.map((a, i) => ({
		id: a.id,
		name: a.name,
		description: (a.description || '').replace(/\s+/g, ' ').slice(0, 240),
		url: agentUrl(a),
		image: agentImage(a),
		cluster: assignments[i],
		x: round(coords[i][0]),
		y: round(coords[i][1]),
		z: round(coords[i][2]),
		neighbors: neighbors[i].map((nb) => ({ id: kept[nb.j].id, score: round(nb.s) })),
	}));

	const clusters = groups.map((members, i) => ({
		id: i,
		label: labels[i].label,
		labelSource: labels[i].labelSource,
		color: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
		size: members.length,
		x: round(centroids[i][0]),
		y: round(centroids[i][1]),
		z: round(centroids[i][2]),
	}));

	return {
		available: true,
		agents: outAgents,
		clusters,
		meta: {
			count: outAgents.length,
			totalPublic: rows.length,
			truncated: rows.length >= MAX_AGENTS,
			model,
			dims,
			clusterCount: k,
			generatedAt: new Date().toISOString(),
		},
	};
}

function round(n) {
	return Math.round(n * 100) / 100;
}

// For each agent, its top-K most semantically-similar agents by cosine. Vectors
// are unit-normalised, so cosine is a plain dot product. O(N²·D) — bounded by
// MAX_AGENTS, and computed once per cached rebuild.
function topNeighbors(unitVecs, k) {
	const n = unitVecs.length;
	const out = new Array(n);
	for (let i = 0; i < n; i++) {
		const sims = [];
		for (let j = 0; j < n; j++) {
			if (j === i) continue;
			sims.push({ j, s: dot(unitVecs[i], unitVecs[j]) });
		}
		sims.sort((a, b) => b.s - a.s);
		out[i] = sims.slice(0, k);
	}
	return out;
}

// ── GET: build or serve cached galaxy ────────────────────────────────────────

async function handleGet(req, res) {
	const cfg = watsonxConfig();
	if (!cfg.configured) {
		return json(res, 200, {
			available: false,
			reason: 'watsonx_not_configured',
			message:
				'IBM watsonx.ai is not configured on this deployment. Set WATSONX_API_KEY and ' +
				'WATSONX_PROJECT_ID to power the Agent Galaxy with Granite embeddings.',
		});
	}

	const url = new URL(req.url, 'http://x');
	const forceRefresh = url.searchParams.get('refresh') === '1';

	await ensureCacheTable();
	const rows = await selectGalaxyAgents();
	const agents = rows.filter((a) => agentEmbedText(a));
	const version = dataVersion(agents, cfg.embedModel);

	if (!forceRefresh) {
		const [cached] = await sql`
			SELECT payload, data_version, computed_at FROM agent_galaxy_cache WHERE id = 'default'
		`;
		if (cached && cached.data_version === version) {
			const ageMs = Date.now() - new Date(cached.computed_at).getTime();
			if (ageMs < CACHE_TTL_MS) {
				res.setHeader('x-galaxy-cache', 'hit');
				return json(res, 200, {
					...cached.payload,
					meta: { ...cached.payload.meta, cache: 'hit' },
				});
			}
		}
	}

	const payload = await buildGalaxy(cfg, rows);
	// Persist only fully-built galaxies (with agents) so empty/edge states never
	// poison the cache.
	if (payload.agents.length) {
		await sql`
			INSERT INTO agent_galaxy_cache (id, data_version, payload, computed_at)
			VALUES ('default', ${version}, ${JSON.stringify(payload)}::jsonb, now())
			ON CONFLICT (id) DO UPDATE SET
				data_version = EXCLUDED.data_version,
				payload = EXCLUDED.payload,
				computed_at = now()
		`;
	}
	res.setHeader('x-galaxy-cache', forceRefresh ? 'refresh' : 'miss');
	return json(res, 200, {
		...payload,
		meta: { ...payload.meta, cache: forceRefresh ? 'refresh' : 'miss' },
	});
}

// ── POST: semantic search ────────────────────────────────────────────────────

async function handleSearch(req, res) {
	const cfg = watsonxConfig();
	if (!cfg.configured) {
		return error(
			res,
			503,
			'watsonx_not_configured',
			'IBM watsonx.ai is not configured on this deployment.',
		);
	}

	let body;
	try {
		// A body of `null` / a bare string is valid JSON that readJson returns as-is
		// on the raw-stream path, and reading .query off it throws a TypeError that
		// surfaces as a 500. Malformed input answers 400 like every other bad body.
		const parsed = await readJson(req, 8_000);
		body = parsed && typeof parsed === 'object' ? parsed : {};
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}
	const query = typeof body.query === 'string' ? body.query.trim().slice(0, 400) : '';
	if (!query) return error(res, 400, 'bad_request', 'query is required');

	const rows = await selectGalaxyAgents();
	const ids = rows.filter((a) => agentEmbedText(a)).map((a) => a.id);
	if (!ids.length) return json(res, 200, { results: [], query, model: cfg.embedModel });

	const vectorMap = await readAgentVectors(ids, { model: cfg.embedModel });
	// No provider failover exists for this read and none would be correct: the
	// stored agent vectors live in Granite's space, so a vector minted by another
	// lane would be a different dimension in a different geometry. Degrade the
	// METHOD instead, ranking the same corpus lexically and saying so, rather
	// than answering a search with a 502.
	let qvec = null;
	let model = cfg.embedModel;
	let embedError = null;
	try {
		const out = await watsonxEmbed(cfg, { inputs: [query] });
		qvec = out.vectors?.[0]?.length ? out.vectors[0] : null;
		model = out.model || model;
		if (!qvec) embedError = 'the embedder returned no vector for the query';
	} catch (err) {
		embedError = err?.message || 'the embedder is unreachable';
	}
	if (!qvec) {
		const byId = new Map(rows.map((a) => [a.id, a]));
		const lexical = rankLexically(
			query,
			rows.map((a) => ({ id: a.id, text: agentEmbedText(a) || '' })),
			{ limit: 16 },
		);
		return json(res, 200, {
			query,
			model,
			count: lexical.length,
			best: lexical[0] || null,
			results: lexical.map((r) => ({ ...r, name: byId.get(r.id)?.name || null })),
			ranking: 'lexical',
			degraded: { reason: 'embedder_unavailable', detail: embedError, retryable: true },
		});
	}

	const ranked = [];
	for (const [id, vec] of vectorMap) {
		if (!vec?.length) continue;
		ranked.push({ id, score: round(cosineSimilarity(qvec, vec)) });
	}
	ranked.sort((a, b) => b.score - a.score);
	const top = ranked.slice(0, 16);

	return json(res, 200, {
		query,
		model,
		count: ranked.length,
		best: top[0] || null,
		results: top,
		ranking: 'semantic',
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Global hourly ceiling on the shared watsonx server key (same bucket as
	// api/watsonx/embed) — a hard aggregate cost cap independent of any one IP.
	// Only consumed when watsonx is configured, i.e. when a request can
	// actually bill Granite inference.
	if (watsonxConfig().configured) {
		const global = await limits.watsonxEmbedGlobal();
		if (!global.success)
			return rateLimited(res, global, 'watsonx capacity reached — try again shortly');
	}

	if (req.method === 'POST') return handleSearch(req, res);
	return handleGet(req, res);
});

export const maxDuration = 60;
