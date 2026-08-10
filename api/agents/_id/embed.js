// POST /api/agents/:id/embed
// Generates a text embedding. Used by AgentMemory.recall() for semantic
// similarity search.
//
// Provider policy is NOT restated here: it is delegated to api/_lib/embeddings.js,
// the platform's single embedder registry (free NVIDIA NIM nv-embedqa-e5-v5 first,
// then the GCP-credit-funded Vertex lane, then OpenAI as the paid backstop). That
// module exists to prevent one specific trap: embeddings from different models are
// different vector spaces, and comparing across them yields plausible-looking
// garbage. So the response carries the registry's `embedder` tag (model + dim,
// e.g. "nvidia/nv-embedqa-e5-v5@1024"). Callers that persist a vector must persist
// that tag beside it and only compare vectors sharing one.
//
// `inputType` matters for the same reason: NIM's retrieval models are asymmetric.
// Search strings embed as 'query' (the default, matching recall()); corpus text
// being stored for later retrieval embeds as 'passage'.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../../_lib/auth.js';
import { cors, json, method, readJson, error, rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { sql } from '../../_lib/db.js';
import {
	embedWith,
	embedderInfo,
	defaultIngestEmbedderTag,
	embedderConfigured,
} from '../../_lib/embeddings.js';

export async function handleEmbed(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	// Match the sibling per-agent sub-resources (nfts.js / pumpfun.js): a bearer
	// token must carry an appropriate scope to drive the embeddings API.
	if (bearer && !hasScope(bearer.scope, 'mcp') && !hasScope(bearer.scope, 'profile')) {
		return error(res, 403, 'insufficient_scope', 'requires mcp or profile scope');
	}
	const userId = session?.id || bearer?.userId;

	// This route is namespaced per-agent and burns shared platform embedding
	// keys, so it must enforce ownership of :id exactly like every other
	// /api/agents/:id sub-resource — never embed against an agent the caller
	// doesn't own.
	const [agent] = await sql`
		select id from agent_identities
		where id = ${id} and user_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const rl = await limits.embedUser(userId);
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	const text = body?.text;
	if (!text || typeof text !== 'string' || !text.trim()) {
		return error(res, 400, 'validation_error', 'text is required');
	}
	if (text.length > 8192) {
		return error(res, 400, 'validation_error', 'text exceeds 8192 character limit');
	}
	const inputType = body?.inputType ?? 'query';
	if (inputType !== 'query' && inputType !== 'passage') {
		return error(res, 400, 'validation_error', "inputType must be 'query' or 'passage'");
	}

	// An explicit `embedder` lets a caller re-embed into the same space its stored
	// vectors already live in, which is the whole point of tagging them.
	const requested = body?.embedder;
	let tag;
	if (requested) {
		if (!embedderInfo(requested)) {
			return error(res, 400, 'validation_error', `unknown embedder: ${requested}`);
		}
		if (!embedderConfigured(requested)) {
			return error(res, 503, 'not_configured', `embedder ${requested} is not configured on this server`);
		}
		tag = requested;
	} else {
		tag = defaultIngestEmbedderTag();
		if (!tag) {
			return error(res, 503, 'not_configured',
				'No embedding provider configured. Set NVIDIA_API_KEY (free), GOOGLE_CLOUD_PROJECT, or OPENAI_API_KEY.');
		}
	}

	const info = embedderInfo(tag);
	let vector;
	try {
		[vector] = await embedWith(tag, [text.trim()], inputType);
	} catch (err) {
		console.error('[embed] provider failed', tag, err?.message);
		return error(res, 502, 'upstream_error', `embedding service unavailable (${info.provider})`);
	}

	return json(res, 200, {
		embedding: Array.from(vector),
		embedder: info.tag,
		model: info.model,
		provider: info.provider,
		dim: info.dim,
		inputType,
	});
}
