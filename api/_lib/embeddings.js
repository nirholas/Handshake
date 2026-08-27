// Multi-provider text embeddings with vector-space tagging.
//
// Provider policy (free-first, per the platform LLM policy): NVIDIA NIM's
// nv-embedqa-e5-v5 (1024-dim, free with one nvapi key) is the default for new
// ingests; Vertex AI's text-embedding-005 (768-dim, service-account auth,
// billed to the platform's GCP credit pool — no vendor quota to exhaust) is
// the second-choice ingest lane when NIM is unconfigured; OpenAI
// text-embedding-3-small @ 256 dims (Matryoshka truncation) is the last-resort
// paid backstop and, critically, the space every pre-tagging legacy row lives
// in (LEGACY_EMBED_TAG) — its entry in EMBEDDERS must never be removed even
// if it stops being used for new ingests, or legacy-row resolution breaks.
//
// THE TRAP this module exists to prevent: embeddings from different models are
// different vector spaces. A query embedded with model A compared against
// passages embedded with model B returns garbage similarity scores that look
// plausible. So every embed call here names its embedder explicitly via a
// `tag` (model id + dimension, e.g. "nvidia/nv-embedqa-e5-v5@1024"), callers
// persist that tag next to every stored vector, and query-time code must
// resolve the stored tag back through this module — never pick a provider ad
// hoc. Untagged legacy rows are OpenAI text-embedding-3-small@256 by
// definition (`LEGACY_EMBED_TAG`): that was the only embedder before tagging
// shipped.
//
// We keep this zero-dep (plain fetch, no SDK) so the talking-agent chat path
// stays a single cheap import — matching api/widgets/[id]/[action].js.

const NIM_EMBED_URL = 'https://integrate.api.nvidia.com/v1/embeddings';
const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';

// text-embedding-005 is a regional model (verified live: us-central1 serves
// it; "global" does not for this model family, unlike the Gemini chat/image
// models elsewhere in the codebase) — default to the region every other
// GCP-hosted worker in this platform already runs in.
import {
	AUTH_COOLDOWN_SECONDS,
	clearProviderCooldown,
	markProviderCooldown,
	providersInCooldown,
} from './provider-health.js';

function vertexEmbedUrl() {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	const location = process.env.GOOGLE_CLOUD_LOCATION_EMBED || 'us-central1';
	return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/text-embedding-005:predict`;
}

// NIM nv-embedqa-e5-v5 hard-caps inputs at 512 tokens (probed: longer inputs
// 400 with "exceeds maximum allowed token size"). The chunker already targets
// ≤512 estimated tokens (4 chars/token), but dense text (code, CJK) can run
// more tokens per char — so the NIM lane retries an over-length 400 once with
// inputs truncated to a conservative 3 chars/token budget.
const NIM_MAX_TOKENS = 512;
const NIM_SAFE_CHARS = NIM_MAX_TOKENS * 3;

export const NIM_EMBED_TAG = 'nvidia/nv-embedqa-e5-v5@1024';
export const VERTEX_EMBED_TAG = 'vertex/text-embedding-005@768';
export const OPENAI_EMBED_TAG = 'text-embedding-3-small@256';

// Rows written before embedder tagging existed were embedded with OpenAI
// text-embedding-3-small @ 256 — encode that assumption in exactly one place.
// This tag (and its EMBEDDERS entry below) must never be removed, even after
// it stops being the ingest default, or legacy-row resolution breaks.
export const LEGACY_EMBED_TAG = OPENAI_EMBED_TAG;

const EMBEDDERS = Object.freeze({
	[NIM_EMBED_TAG]: Object.freeze({
		tag: NIM_EMBED_TAG,
		provider: 'nim',
		model: 'nvidia/nv-embedqa-e5-v5',
		dim: 1024,
		free: true,
		configured: () => !!process.env.NVIDIA_API_KEY,
	}),
	[VERTEX_EMBED_TAG]: Object.freeze({
		tag: VERTEX_EMBED_TAG,
		provider: 'vertex',
		model: 'text-embedding-005',
		dim: 768,
		// Not vendor-free like NIM, but billed to the platform's GCP credit pool
		// rather than a metered API key — no quota to exhaust, same reasoning
		// api/_lib/llm.js's vertexGeminiProvider() documents for the LLM chain.
		free: false,
		configured: () => !!process.env.GOOGLE_CLOUD_PROJECT,
	}),
	[OPENAI_EMBED_TAG]: Object.freeze({
		tag: OPENAI_EMBED_TAG,
		provider: 'openai',
		model: 'text-embedding-3-small',
		dim: 256,
		free: false,
		configured: () => !!process.env.OPENAI_API_KEY,
	}),
});

// Free lane first, then the credit-funded Vertex lane (no vendor quota to
// exhaust), OpenAI as the true last-resort paid backstop.
const INGEST_PREFERENCE = Object.freeze([NIM_EMBED_TAG, VERTEX_EMBED_TAG, OPENAI_EMBED_TAG]);

/** True when at least one embedding provider can actually serve. */
export function embeddingsConfigured() {
	return INGEST_PREFERENCE.some((tag) => EMBEDDERS[tag].configured());
}

/**
 * The embedder tag new document sets should be ingested with — free NIM when
 * the key is present, OpenAI otherwise, null when nothing is configured.
 */
export function defaultIngestEmbedderTag() {
	for (const tag of INGEST_PREFERENCE) {
		if (EMBEDDERS[tag].configured()) return tag;
	}
	return null;
}

/**
 * Normalize a stored embedder tag (null/'' = legacy OpenAI) to a known tag,
 * or null when the tag names an embedder this build doesn't know — an unknown
 * space can never be queried, only re-embedded.
 */
export function resolveEmbedderTag(storedTag) {
	const tag = storedTag || LEGACY_EMBED_TAG;
	return EMBEDDERS[tag] ? tag : null;
}

/** Embedder metadata ({tag, provider, model, dim, free}) or null if unknown. */
export function embedderInfo(storedTag) {
	const tag = resolveEmbedderTag(storedTag);
	return tag ? EMBEDDERS[tag] : null;
}

/** True when the provider behind `storedTag`'s space can serve right now. */
export function embedderConfigured(storedTag) {
	const tag = resolveEmbedderTag(storedTag);
	return !!tag && EMBEDDERS[tag].configured();
}

/**
 * Embed `texts` in the vector space named by `tag`.
 * `inputType` is 'passage' for corpus chunks at ingest and 'query' for search
 * strings — NIM's retrieval models are asymmetric and REQUIRE the distinction;
 * the OpenAI lane ignores it. Returns Float64Array[] aligned with `texts`.
 * Throws { code: 'unknown_embedder' | 'no_embedder' | 'embedder_error' }.
 */
export async function embedWith(tag, texts, inputType) {
	const embedder = EMBEDDERS[resolveEmbedderTag(tag) || ''];
	if (!embedder) {
		throw Object.assign(new Error(`unknown embedder tag: ${tag}`), {
			code: 'unknown_embedder',
		});
	}
	if (!embedder.configured()) {
		throw Object.assign(new Error(`${embedder.provider} embedder not configured (${embedder.tag})`), {
			code: 'no_embedder',
		});
	}
	if (inputType !== 'passage' && inputType !== 'query') {
		throw Object.assign(new Error(`inputType must be 'passage' or 'query', got: ${inputType}`), {
			code: 'embedder_error',
		});
	}
	if (!texts.length) return [];

	if (embedder.provider === 'nim') return embedNim(embedder, texts, inputType);
	if (embedder.provider === 'vertex') return embedVertex(embedder, texts, inputType);
	return embedOpenAi(embedder, texts);
}

/** Convenience: embed corpus chunks at ingest time. */
export function embedPassages(tag, texts) {
	return embedWith(tag, texts, 'passage');
}

// ── Ingest-time provider walk ───────────────────────────────────────────────
//
// embedWith is deliberately strict: a stored vector space has ONE embedder, and
// the three lanes have three different dimensions (NIM 1024, Vertex 768, OpenAI
// 256), so answering a query against an existing space with another lane's
// vectors would compare points in unrelated geometries. Nothing here weakens
// that, and this must never be used to query an existing space.
//
// What was missing is the case where no space is fixed yet. At INGEST the caller
// is free to choose any lane, but defaultIngestEmbedderTag() picked the first
// CONFIGURED one and embedWith threw when that provider was down, so a single
// NIM 429 failed the whole embed with Vertex and OpenAI configured and idle
// (the /api/watsonx/embed 502s of 2026-08-27). This walks the preference order
// instead and returns the tag that actually answered, so the caller records the
// space it really got rather than the one it asked for.
const EMBED_LANE_COOLDOWN_SECONDS = 45;
const embedLaneKey = (tag) => `embed:${tag}`;

/**
 * Embed `texts` as passages with the first lane that answers, preferring
 * `preferredTag` and then the standard free-first order.
 *
 * @param {string|null} preferredTag  tried first when configured
 * @param {string[]} texts
 * @returns {Promise<{ tag: string, info: object, vectors: Float64Array[] }>}
 * @throws the last lane's error, or { code: 'no_embedder' } when none is configured
 */
export async function embedPassagesAny(preferredTag, texts) {
	const resolved = resolveEmbedderTag(preferredTag);
	const order = [
		...(resolved && EMBEDDERS[resolved].configured() ? [resolved] : []),
		...INGEST_PREFERENCE.filter((t) => t !== resolved && EMBEDDERS[t].configured()),
	];
	if (!order.length) {
		throw Object.assign(new Error('no embedding provider is configured'), { code: 'no_embedder' });
	}
	if (!texts.length) return { tag: order[0], info: EMBEDDERS[order[0]], vectors: [] };

	// A lane a recent request found throttled goes to the back rather than being
	// dropped, so a chain whose lanes are all cooling still answers.
	let lanes = order;
	if (order.length > 1) {
		const cooling = await providersInCooldown(order.map(embedLaneKey));
		if (cooling.size) {
			const hot = order.filter((t) => !cooling.has(embedLaneKey(t)));
			if (hot.length) lanes = [...hot, ...order.filter((t) => cooling.has(embedLaneKey(t)))];
		}
	}

	let lastErr;
	for (const tag of lanes) {
		try {
			const vectors = await embedWith(tag, texts, 'passage');
			void clearProviderCooldown(embedLaneKey(tag));
			return { tag, info: EMBEDDERS[tag], vectors };
		} catch (err) {
			// A misconfigured or unknown lane is not a health signal, it simply
			// cannot serve; only a real upstream failure earns a cooldown.
			if (err?.code !== 'no_embedder' && err?.code !== 'unknown_embedder') {
				const authFault = err?.status === 401 || err?.status === 403 || err?.status === 402;
				void markProviderCooldown(
					embedLaneKey(tag),
					authFault ? AUTH_COOLDOWN_SECONDS : EMBED_LANE_COOLDOWN_SECONDS,
					authFault ? 'auth' : 'health',
				);
			}
			lastErr = err;
		}
	}
	throw lastErr || Object.assign(new Error('every embedding lane failed'), { code: 'embedder_error' });
}

/** Convenience: embed one search string; resolves to a single Float64Array. */
export async function embedQuery(tag, text) {
	const [vec] = await embedWith(tag, [text], 'query');
	return vec;
}

async function embedNim(embedder, texts, inputType, { truncated = false } = {}) {
	const upstream = await fetch(NIM_EMBED_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: embedder.model,
			input: texts,
			input_type: inputType,
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!upstream.ok) {
		const body = await upstream.text().catch(() => '');
		// Over-length input: retry once with every input clamped to a budget that
		// cannot exceed the 512-token cap. Better to truncate one outlier chunk
		// than to fail a whole ingest batch.
		if (upstream.status === 400 && /maximum allowed token size/i.test(body) && !truncated) {
			return embedNim(embedder, texts.map((t) => t.slice(0, NIM_SAFE_CHARS)), inputType, {
				truncated: true,
			});
		}
		throw upstreamError('nim', upstream.status, body);
	}
	return parseEmbeddings(await upstream.json(), texts.length, 'nim');
}

// Vertex AI text-embedding-005 — service-account/metadata-server auth (same
// helper api/_lib/vertex-claude.js and api/_mcp3d/vertex-imagen.js already
// use), billed to the platform's GCP credit pool. Asymmetric like NIM: a
// document/passage and a query embed differently, so `task_type` carries the
// same distinction NIM's `input_type` does. Verified live 2026-07-16 (batch
// request, both task types, 768-dim output confirmed).
async function embedVertex(embedder, texts, inputType) {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	if (!project) {
		throw Object.assign(new Error('vertex embedder not configured (GOOGLE_CLOUD_PROJECT missing)'), {
			code: 'no_embedder',
		});
	}
	const { getGcpAccessToken } = await import('./gcp-auth.js');
	const token = await getGcpAccessToken();
	const taskType = inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
	const upstream = await fetch(vertexEmbedUrl(), {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify({
			instances: texts.map((content) => ({ content, task_type: taskType })),
			parameters: { outputDimensionality: embedder.dim },
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!upstream.ok) {
		const body = await upstream.text().catch(() => '');
		throw upstreamError('vertex', upstream.status, body);
	}
	const data = await upstream.json();
	const rows = data?.predictions || [];
	if (rows.length !== texts.length || rows.some((r) => !Array.isArray(r?.embeddings?.values))) {
		throw Object.assign(new Error('vertex embedding response shape mismatch'), {
			code: 'embedder_error',
		});
	}
	return rows.map((row) => Float64Array.from(row.embeddings.values));
}

async function embedOpenAi(embedder, texts) {
	const upstream = await fetch(OPENAI_EMBED_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: embedder.model,
			input: texts,
			dimensions: embedder.dim,
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!upstream.ok) {
		const body = await upstream.text().catch(() => '');
		throw upstreamError('openai', upstream.status, body);
	}
	return parseEmbeddings(await upstream.json(), texts.length, 'openai');
}

function parseEmbeddings(data, expected, provider) {
	const rows = (data?.data || []).sort((a, b) => a.index - b.index);
	if (rows.length !== expected || rows.some((r) => !Array.isArray(r.embedding))) {
		throw Object.assign(new Error(`${provider} embedding response shape mismatch`), {
			code: 'embedder_error',
		});
	}
	return rows.map((row) => Float64Array.from(row.embedding));
}

function upstreamError(provider, status, body) {
	return Object.assign(new Error(`${provider} embedding api ${status}: ${body.slice(0, 200)}`), {
		code: 'embedder_error',
		status,
	});
}

/**
 * Score stored vector rows against a search string without ever crossing
 * vector spaces. Rows are grouped by their `embedder` tag (untagged legacy
 * rows are OpenAI — LEGACY_EMBED_TAG), the query is embedded once per space
 * whose provider is configured, and cosine runs strictly within each space.
 * Rows in a space no configured provider can serve are counted in
 * `needsReembed` — reported, never silently compared.
 *
 * @param {Array<{embedder?: string|null, embedding: number[]|{values:number[]}}>} rows
 * @param {string} query
 * @returns {Promise<{scored: Array<object & {embedder: string, score: number}>,
 *                    needsReembed: Array<{embedder: string, chunks: number}>}>}
 */
export async function scoreRowsBySpace(rows, query) {
	const bySpace = new Map();
	for (const r of rows) {
		const tag = r.embedder || LEGACY_EMBED_TAG;
		if (!bySpace.has(tag)) bySpace.set(tag, []);
		bySpace.get(tag).push(r);
	}

	const scored = [];
	const needsReembed = [];
	for (const [tag, group] of bySpace) {
		if (!embedderConfigured(tag)) {
			needsReembed.push({ embedder: tag, chunks: group.length });
			continue;
		}
		const queryEmbedding = await embedQuery(tag, query);
		for (const r of group) {
			const e = Array.isArray(r.embedding) ? r.embedding : r.embedding?.values || [];
			scored.push({ ...r, embedder: tag, score: cosine(queryEmbedding, e) });
		}
	}
	return { scored, needsReembed };
}

/**
 * Cosine similarity between two equal-length numeric arrays. Inputs come from
 * embedWith() (Float64Array) or from the DB (plain Array via JSONB) — both
 * work. Mismatched lengths score 0: vectors of different dimensionality are
 * by definition different spaces, and comparing a shared prefix would be
 * exactly the silent cross-space garbage this module is built to prevent.
 */
export function cosine(a, b) {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (!na || !nb) return 0;
	return dot / Math.sqrt(na * nb);
}
