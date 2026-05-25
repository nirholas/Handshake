// `text_to_avatar` — paid MCP tool that generates a textured 3D GLB avatar
// from either a text prompt or one/more reference image URLs, by driving
// Replicate's text-to-3D / image-to-3D pipeline (Tencent Hunyuan-3D 3.1 by
// default, configurable via REPLICATE_TEXT_TO_AVATAR_MODEL).
//
// Pricing: $0.15 USDC, settled `exact` on Base or Solana.
//
// Behavior: synchronously submits a Replicate prediction and polls until the
// prediction reaches a terminal state or the configured timeout fires. The
// returned GLB URL is the Replicate-hosted output. To avoid the caller having
// to chase signed-URL expiration, this tool re-fetches the GLB and rehosts it
// on the three.ws R2 bucket when MCP_TEXT_TO_AVATAR_REHOST is enabled
// (default off; opt-in because rehosting writes a public object).
//
// Environment:
//   REPLICATE_API_TOKEN                — required.
//   REPLICATE_TEXT_TO_AVATAR_MODEL     — required version hash. Pin a
//                                        commercial-OK image/text-to-3D model
//                                        (e.g. tencent/hunyuan-3d-3.1 latest).
//   MCP_TEXT_TO_AVATAR_TIMEOUT_MS      — optional, defaults to 110_000.
//   MCP_TEXT_TO_AVATAR_POLL_MS         — optional, defaults to 2_000.
//   MCP_TEXT_TO_AVATAR_REHOST          — "1" to rehost via MCP_REHOST_ENDPOINT.
//   MCP_REHOST_ENDPOINT                — three.ws URL that ingests external
//                                        GLB URLs.
//   MCP_REHOST_KEY                     — bearer for MCP_REHOST_ENDPOINT.

import { z } from 'zod';

import { paid } from '../payments.js';

const TOOL_NAME = 'text_to_avatar';
const TOOL_DESCRIPTION =
	'Generate a textured 3D GLB avatar from a text prompt or one or more reference image URLs. Drives Replicate (Hunyuan-3D 3.1 by default, configurable) and polls the prediction synchronously until a GLB is produced or the timeout fires. Returns the GLB URL, the source prompt/images, the picked model version, the prediction id, and timing metadata. Paid: $0.15 USDC.';

const REPLICATE_BASE = 'https://api.replicate.com/v1';

function env(k, def) {
	const v = process.env[k];
	return v && String(v).trim() ? String(v).trim() : def;
}

function authHeaders() {
	const token = env('REPLICATE_API_TOKEN');
	if (!token) {
		const err = new Error('REPLICATE_API_TOKEN is not configured on the MCP server');
		err.code = 'not_configured';
		throw err;
	}
	return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function extractGlbUrl(output) {
	if (!output) return null;
	if (typeof output === 'string') return output;
	if (Array.isArray(output)) {
		for (const v of output) {
			if (typeof v === 'string' && /\.glb(\?|$)/i.test(v)) return v;
		}
		for (const v of output) {
			if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
		}
	}
	if (typeof output === 'object') {
		for (const key of ['glb', 'mesh', 'mesh_url', 'output_url', 'url', 'model']) {
			if (typeof output[key] === 'string') return output[key];
		}
	}
	return null;
}

async function submitPrediction({ version, input }) {
	const res = await fetch(`${REPLICATE_BASE}/predictions`, {
		method: 'POST',
		headers: authHeaders(),
		body: JSON.stringify({ version, input }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(data?.detail || data?.title || `replicate returned ${res.status}`);
		err.code = 'provider_error';
		err.providerStatus = res.status;
		throw err;
	}
	return data;
}

async function pollPrediction(predictionId, { timeoutMs, intervalMs }) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	// Per-fetch ceiling so a single hung HTTP roundtrip can't block the whole
	// poll loop past `deadline`. Without this, Node's fetch has no default
	// timeout — a Replicate edge-stall would dangle the request indefinitely
	// and the outer loop never gets a chance to re-check Date.now() < deadline.
	const perFetchTimeoutMs = Math.max(intervalMs * 3, 10_000);
	while (Date.now() < deadline) {
		let r;
		try {
			r = await fetch(`${REPLICATE_BASE}/predictions/${encodeURIComponent(predictionId)}`, {
				headers: authHeaders(),
				signal: AbortSignal.timeout(perFetchTimeoutMs),
			});
		} catch (err) {
			// Aborted polls are transient; resume the loop until `deadline`
			// expires. Other network failures bubble up as provider errors so
			// the caller sees them instead of an opaque _timedOut.
			if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
				await new Promise((res) => setTimeout(res, intervalMs));
				continue;
			}
			const e = new Error(`replicate poll fetch failed: ${err?.message || err}`);
			e.code = 'provider_error';
			throw e;
		}
		const data = await r.json().catch(() => ({}));
		if (!r.ok) {
			const err = new Error(data?.detail || `replicate poll returned ${r.status}`);
			err.code = 'provider_error';
			throw err;
		}
		last = data;
		const s = data.status;
		if (s === 'succeeded' || s === 'failed' || s === 'canceled') return data;
		await new Promise((res) => setTimeout(res, intervalMs));
	}
	return { ...last, _timedOut: true };
}

async function rehostIfRequested(glbUrl, { prompt, images }) {
	if (env('MCP_TEXT_TO_AVATAR_REHOST', '0') !== '1') return null;
	const endpoint = env('MCP_REHOST_ENDPOINT', 'https://three.ws/api/avatars/ingest-url');
	const ingestKey = env('MCP_REHOST_KEY');
	if (!ingestKey) return null;
	try {
		const r = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ingestKey}`,
			},
			body: JSON.stringify({
				source_url: glbUrl,
				name: (prompt || 'mcp-text-to-avatar').slice(0, 80),
				source: 'mcp',
				source_meta: { provider: 'replicate', prompt, images },
			}),
		});
		if (!r.ok) return { error: `rehost failed: ${r.status}` };
		return await r.json();
	} catch (err) {
		return { error: err?.message || 'rehost call failed' };
	}
}

const inputJsonSchema = {
	type: 'object',
	properties: {
		prompt: {
			type: 'string',
			description: 'Natural-language description of the avatar to generate.',
			maxLength: 1000,
		},
		images: {
			type: 'array',
			description: 'Optional reference image URLs. When provided, the model performs image-to-3D reconstruction.',
			items: { type: 'string', format: 'uri' },
			maxItems: 4,
		},
		seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
		texture: { type: 'boolean', description: 'Request PBR textures when supported (default true).' },
	},
	additionalProperties: false,
};

const inputZodShape = {
	prompt: z.string().max(1000).optional(),
	images: z.array(z.string().url()).max(4).optional(),
	seed: z.number().int().min(0).max(2147483647).optional(),
	texture: z.boolean().optional(),
};

export async function buildTextToAvatarTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.15',
			inputSchema: inputJsonSchema,
			example: { prompt: 'a cheerful cyberpunk fox in a red hoodie' },
			outputExample: {
				ok: true,
				predictionId: 'qb...8',
				glbUrl: 'https://replicate.delivery/.../mesh.glb',
				prompt: 'a cheerful cyberpunk fox in a red hoodie',
				model: 'tencent/hunyuan-3d-3.1@<version-hash>',
				durationMs: 41000,
				preview: 'https://three.ws/viewer?src=https%3A%2F%2Freplicate.delivery%2F...',
			},
		},
		async ({ prompt, images, seed, texture }) => {
			const version = env('REPLICATE_TEXT_TO_AVATAR_MODEL');
			if (!version) {
				return {
					ok: false,
					error: 'not_configured',
					message:
						'REPLICATE_TEXT_TO_AVATAR_MODEL is not set on the MCP server. Pin a commercial-OK image/text-to-3D version (e.g. tencent/hunyuan-3d-3.1 latest).',
				};
			}
			if (!prompt && (!images || images.length === 0)) {
				return { ok: false, error: 'invalid_input', message: 'Provide either prompt or images[].' };
			}
			const input = {
				prompt: prompt || undefined,
				image: images && images.length ? images[0] : undefined,
				images: images && images.length ? images : undefined,
				seed: typeof seed === 'number' ? seed : undefined,
				texture: typeof texture === 'boolean' ? texture : true,
			};
			Object.keys(input).forEach((k) => input[k] === undefined && delete input[k]);

			const started = Date.now();
			let submitted;
			try {
				submitted = await submitPrediction({ version, input });
			} catch (err) {
				return { ok: false, error: err.code || 'provider_error', message: err.message };
			}

			const timeoutMs = Number(env('MCP_TEXT_TO_AVATAR_TIMEOUT_MS', '110000'));
			const intervalMs = Number(env('MCP_TEXT_TO_AVATAR_POLL_MS', '2000'));
			let finalState;
			try {
				finalState = await pollPrediction(submitted.id, { timeoutMs, intervalMs });
			} catch (err) {
				return {
					ok: false,
					error: err.code || 'provider_error',
					message: err.message,
					predictionId: submitted.id,
				};
			}

			const durationMs = Date.now() - started;

			if (finalState._timedOut) {
				return {
					ok: false,
					error: 'timeout',
					message: `prediction did not finish within ${timeoutMs}ms`,
					predictionId: submitted.id,
					status: finalState.status,
					resumeUrl: `${REPLICATE_BASE}/predictions/${submitted.id}`,
					durationMs,
				};
			}

			if (finalState.status === 'failed' || finalState.status === 'canceled') {
				return {
					ok: false,
					error: 'prediction_failed',
					message: finalState.error || `prediction ended with status ${finalState.status}`,
					predictionId: submitted.id,
					durationMs,
				};
			}

			const glbUrl = extractGlbUrl(finalState.output);
			if (!glbUrl) {
				return {
					ok: false,
					error: 'no_glb_in_output',
					message: 'prediction succeeded but no GLB url was found in output',
					rawOutput: finalState.output,
					predictionId: submitted.id,
					durationMs,
				};
			}

			const rehost = await rehostIfRequested(glbUrl, { prompt, images });
			const preview = `https://three.ws/viewer?src=${encodeURIComponent(glbUrl)}`;

			return {
				ok: true,
				predictionId: submitted.id,
				glbUrl,
				rehosted: rehost,
				prompt: prompt || null,
				images: images || null,
				seed: typeof seed === 'number' ? seed : null,
				model: version,
				durationMs,
				preview,
				fetchedAt: new Date().toISOString(),
			};
		},
	);
	return {
		name: TOOL_NAME,
		title: 'Text → 3D avatar ($0.15)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		handler,
	};
}
