// `generate_avatar` — generate a textured GLB from a text prompt or
// reference image(s) via Replicate. Requires REPLICATE_API_TOKEN and a
// pinned model version in REPLICATE_TEXT_TO_AVATAR_MODEL (recommended:
// the latest tencent/hunyuan-3d-3.1 commercial-OK version).
//
// On success, the result is a new avatar session preloaded with the
// generated GLB URL.

import { z } from 'zod';

import { REPLICATE_API_TOKEN, REPLICATE_TEXT_TO_AVATAR_MODEL } from '../config.js';
import { createSession, viewerUrlFor } from '../lib/avatars.js';

const REPLICATE_BASE = 'https://api.replicate.com/v1';

function authHeaders() {
	return { authorization: `Bearer ${REPLICATE_API_TOKEN}`, 'content-type': 'application/json' };
}

function extractGlbUrl(output) {
	if (!output) return null;
	if (typeof output === 'string') return output;
	if (Array.isArray(output)) {
		for (const v of output) if (typeof v === 'string' && /\.glb(\?|$)/i.test(v)) return v;
		for (const v of output) if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
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
		throw err;
	}
	return data;
}

async function pollPrediction(predictionId, { timeoutMs, intervalMs }) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		const r = await fetch(`${REPLICATE_BASE}/predictions/${encodeURIComponent(predictionId)}`, {
			headers: authHeaders(),
		});
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

export const def = {
	name: 'generate_avatar',
	title: 'Generate a 3D avatar (Replicate text-to-3D)',
	description:
		'Generate a textured GLB from a text prompt or reference image URLs via Replicate (Hunyuan-3D 3.1 by default; configurable). Returns the GLB URL and a new avatar session you can dress + animate. Requires REPLICATE_API_TOKEN and REPLICATE_TEXT_TO_AVATAR_MODEL on the MCP server.',
	inputSchema: {
		prompt: z.string().max(1000).optional().describe('Text description of the avatar to generate.'),
		images: z.array(z.string().url()).max(4).optional().describe('Reference image URLs for image-to-3D.'),
		seed: z.number().int().min(0).max(2147483647).optional(),
		texture: z.boolean().optional().describe('Request PBR textures when supported (default true).'),
		name: z.string().max(80).optional().describe('Name for the resulting avatar session.'),
		voice: z
			.enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'])
			.optional()
			.describe('TTS voice the session should use.'),
	},
	async handler(args) {
		if (!REPLICATE_API_TOKEN) {
			return { ok: false, error: 'not_configured', message: 'REPLICATE_API_TOKEN is not set on the MCP server.' };
		}
		if (!REPLICATE_TEXT_TO_AVATAR_MODEL) {
			return {
				ok: false,
				error: 'not_configured',
				message: 'REPLICATE_TEXT_TO_AVATAR_MODEL is not set. Pin a commercial-OK image/text-to-3D version (e.g. latest tencent/hunyuan-3d-3.1).',
			};
		}
		const { prompt, images, seed, texture, name, voice } = args || {};
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
			submitted = await submitPrediction({ version: REPLICATE_TEXT_TO_AVATAR_MODEL, input });
		} catch (err) {
			return { ok: false, error: err.code || 'provider_error', message: err.message };
		}
		const timeoutMs = Number(process.env.REPLICATE_TIMEOUT_MS || '120000');
		const intervalMs = Number(process.env.REPLICATE_POLL_MS || '2000');
		const finalState = await pollPrediction(submitted.id, { timeoutMs, intervalMs });
		const durationMs = Date.now() - started;
		if (finalState._timedOut) {
			return {
				ok: false,
				error: 'timeout',
				message: `prediction did not finish within ${timeoutMs}ms`,
				predictionId: submitted.id,
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
		const session = createSession({ glb: glbUrl, name, voice });
		return {
			ok: true,
			sessionId: session.id,
			avatar: session.avatar,
			predictionId: submitted.id,
			model: REPLICATE_TEXT_TO_AVATAR_MODEL,
			prompt: prompt || null,
			images: images || null,
			seed: typeof seed === 'number' ? seed : null,
			durationMs,
			viewerUrl: viewerUrlFor(session),
		};
	},
};
