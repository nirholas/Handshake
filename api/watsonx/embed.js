// POST /api/watsonx/embed: IBM Granite embeddings on watsonx.ai.
//
// Body: { texts: string[], model?: string }
// Response: { model, dimensions, count, cachedHits, vectors: number[][] }
//   vectors[i] is the Granite embedding of texts[i], order preserved.
//
// This is the public read-side of the three.ws ↔ IBM watsonx integration: it
// turns arbitrary short texts into Granite embedding vectors so the browser can
// lay them out in semantic space (e.g. the watsonx Constellation at
// /constellation). Inference runs on watsonx.ai with the server's IBM Cloud key.
//
// There is no mock path: every vector is a real embedding call. The provider
// chain degrades gracefully so a watsonx outage never blanks the page:
//   1. IBM Granite on watsonx.ai (primary, when WATSONX_* is configured)
//   2. The platform's free-first embedding chain (NVIDIA NIM when keyed, then
//      Vertex text-embedding-005 on the GCP credit pool, then OpenAI
//      text-embedding-3-small as the paid backstop). See api/_lib/embeddings.js
//      for the authoritative preference order.
//   3. 503 `embed_unconfigured` only when NO provider is available, so the
//      client can show an honest "not configured" state instead of inventing
//      vectors. Within a single response all vectors come from one provider, so
//      `dimensions` is uniform regardless of which tier served the request.
//
// A provider that answers with a short or empty batch is treated as a failure,
// not as a partial success: the response never carries a null in place of a
// vector, because a caller laying these out in semantic space cannot tell a
// missing embedding from a real one at the origin.

import { createHash } from 'node:crypto';
import { cors, method, readJson, error, json, wrap, rateLimited } from '../_lib/http.js';
import { watsonxConfig, watsonxEmbed } from '../_lib/watsonx.js';
import {
	embedPassagesAny,
	embeddingsConfigured,
	defaultIngestEmbedderTag,
	embedderInfo,
} from '../_lib/embeddings.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

// watsonx accepts many inputs per call; cap a single request so one caller can't
// submit an unbounded batch. Matches the chunk size used by agent-embeddings.
const MAX_TEXTS = 96;
const MAX_TEXT_LEN = 512;

// Process-local vector cache. Embeddings are deterministic for a given
// (model, text), and a warm Vercel instance serves many requests, so caching by
// content hash turns repeat lookups (the same trending tokens across visitors)
// into zero-cost hits. Bounded with a simple FIFO trim to cap memory.
const CACHE_MAX = 5000;
const cache = new Map(); // sha256(model\ntext) → number[]

function cacheKey(model, text) {
	return createHash('sha256').update(`${model}\n${text}`).digest('hex');
}

function cacheGet(key) {
	const v = cache.get(key);
	if (v) {
		// Refresh recency: re-insert so the oldest genuinely-cold entries trim first.
		cache.delete(key);
		cache.set(key, v);
	}
	return v;
}

function cacheSet(key, vec) {
	cache.set(key, vec);
	while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function validateTexts(input) {
	if (!Array.isArray(input)) {
		throw Object.assign(new Error('texts must be an array'), { status: 400 });
	}
	if (input.length === 0 || input.length > MAX_TEXTS) {
		throw Object.assign(new Error(`texts must hold 1 to ${MAX_TEXTS} items`), { status: 400 });
	}
	const out = [];
	for (const t of input) {
		if (typeof t !== 'string') {
			throw Object.assign(new Error('each text must be a string'), { status: 400 });
		}
		const trimmed = t.trim().slice(0, MAX_TEXT_LEN);
		if (!trimmed) throw Object.assign(new Error('texts must not be empty'), { status: 400 });
		out.push(trimmed);
	}
	return out;
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// Two-tier rate limit: per-IP burst control + a global hourly ceiling that
	// caps watsonx spend regardless of how many distinct clients call in.
	const ip = clientIp(req);
	const perIp = await limits.watsonxEmbedIp(ip);
	if (!perIp.success) {
		return rateLimited(res, perIp, 'too many embedding requests, slow down');
	}
	const global = await limits.watsonxEmbedGlobal();
	if (!global.success) {
		return rateLimited(res, global, 'embedding capacity reached, try again shortly');
	}

	let body;
	try {
		body = await readJson(req, 200_000);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	let texts;
	try {
		// `body` is whatever parsed: a literal `null` or a bare scalar is valid
		// JSON, so reach for `.texts` defensively and let validateTexts reject it
		// with the same 400 as any other malformed payload.
		texts = validateTexts(body?.texts);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}

	const cfg = watsonxConfig();
	const fallbackReady = embeddingsConfigured();
	if (!cfg.configured && !fallbackReady) {
		// No provider at all. No fabricated vectors. Tell the client exactly
		// what's missing so the UI can render an honest "not configured" state.
		return error(
			res,
			503,
			'embed_unconfigured',
			'No embedding provider is configured. Set WATSONX_API_KEY + WATSONX_PROJECT_ID (IBM Granite), NVIDIA_API_KEY (free fallback), GOOGLE_CLOUD_PROJECT (Vertex fallback), or OPENAI_API_KEY (paid fallback) to enable embeddings.',
		);
	}

	// Provider chain: Granite (primary) then the platform free-first embedding
	// chain (NIM, Vertex, OpenAI). The first provider that returns a FULL batch
	// wins; a watsonx outage, or a watsonx response that covers only part of the
	// batch, transparently falls through so /constellation keeps rendering.
	let result = null;
	let lastError = null;

	if (cfg.configured) {
		const model =
			typeof body.model === 'string' && body.model.trim()
				? body.model.trim()
				: cfg.embedModel;
		try {
			result = await embedBatch(texts, model, (inputs) =>
				watsonxEmbed(cfg, { inputs, model }).then((r) => ({
					vectors: r.vectors,
					dimensions: r.dimensions,
				})),
			);
		} catch (e) {
			// Hold the cause; if the fallback chain can cover we still serve a 200.
			lastError = e;
		}
	}

	if (!result && fallbackReady) {
		// These texts are peers laid out against each other (not query-vs-corpus),
		// so they all embed as 'passage': one consistent space per response.
		//
		// The lane is chosen by embedPassagesAny, which walks the whole free-first
		// order rather than failing on whichever lane happened to be preferred: a
		// single NIM throttle used to 502 this endpoint with Vertex and OpenAI
		// configured and idle. Every text in one response embeds through one lane,
		// so the space stays consistent, and the response reports the model and
		// dimension that actually answered.
		const preferredTag = defaultIngestEmbedderTag();
		try {
			let servedModel = embedderInfo(preferredTag)?.model || preferredTag;
			result = await embedBatch(texts, servedModel, async (inputs) => {
				const out = await embedPassagesAny(preferredTag, inputs);
				servedModel = out.info.model;
				return {
					vectors: out.vectors.map((v) => Array.from(v)),
					dimensions: out.vectors[0]?.length ?? out.info.dim,
				};
			});
			// embedBatch keys its cache by the model it was handed, so re-stamp the
			// result with the lane that answered rather than the one we hoped for.
			if (result) result.model = servedModel;
		} catch (e) {
			lastError = e;
		}
	}

	if (!result) {
		// Every tier failed at the network level. This is upstream weather, not a
		// bad request, so it is a retryable 503 with the real cause rather than a
		// 502 the caller reads as permanent.
		res.setHeader('retry-after', '15');
		return error(res, 503, 'embed_unavailable', lastError?.message || 'embeddings failed');
	}

	// json() defaults to no-store, which is correct here: this is a POST whose
	// body varies per request, so it must not be shared-cached. Determinism is
	// exploited by the process-local `cache` above, not by HTTP caches.
	return json(res, 200, {
		model: result.model,
		dimensions: result.dimensions,
		count: result.vectors.length,
		cachedHits: result.cachedHits,
		vectors: result.vectors,
	});
});

/**
 * Embed `texts` with a single provider, reusing the process-local cache for
 * already-seen (model, text) pairs so repeat lookups cost nothing. `fetcher`
 * receives the genuinely-uncached inputs and returns { vectors, dimensions }.
 * Caching is keyed by model, so Granite and OpenAI vectors never mix: every
 * returned batch is uniform in dimensionality.
 *
 * Throws when the provider covers only part of the batch. That is what makes
 * the caller's fallback chain correct: a half-answered batch has to look like a
 * failure, or the next provider is never tried and the client is handed nulls
 * dressed up as embeddings.
 */
async function embedBatch(texts, model, fetcher) {
	const vectors = new Array(texts.length).fill(null);
	const missIdx = [];
	const missText = [];
	for (let i = 0; i < texts.length; i++) {
		const hit = cacheGet(cacheKey(model, texts[i]));
		if (hit) vectors[i] = hit;
		else {
			missIdx.push(i);
			missText.push(texts[i]);
		}
	}

	let dimensions = vectors.find((v) => v)?.length ?? 0;

	if (missText.length) {
		const fetched = await fetcher(missText);
		dimensions = fetched.dimensions || dimensions;
		const returned = Array.isArray(fetched.vectors) ? fetched.vectors : [];
		for (let k = 0; k < missIdx.length; k++) {
			const vec = returned[k];
			if (!vec?.length) {
				throw new Error(
					`${model} returned ${returned.filter((v) => v?.length).length} of ${missText.length} embeddings`,
				);
			}
			vectors[missIdx[k]] = vec;
			cacheSet(cacheKey(model, missText[k]), vec);
		}
	}

	return { model, dimensions, vectors, cachedHits: texts.length - missText.length };
}
