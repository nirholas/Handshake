/**
 * /api/forge-iterate — conversational, ownership-preserving 3D iteration.
 *
 *   POST /api/forge-iterate {
 *     glb_url: string, instruction: string,
 *     parent_prompt?: string, parent_lineage?: array, parent_index?: number
 *   } → 200 {
 *     ok, glbUrl, viewerUrl, prompt, instruction, creationId, durable,
 *     lineage, activeIndex
 *   }
 *
 * The free /api/mcp-studio JSON-RPC endpoint already exposes conversational
 * refinement for OpenAI/ChatGPT (the `refine_model` tool) — but that call is
 * server-to-server with no forwarded client identity, so its results aren't
 * owned by any browser session and can never be published to the remix bazaar
 * (api/remix-feed.js), which is ownership-scoped by `x-forge-client`.
 *
 * This endpoint is the SAME composeRefinement + version-lineage core
 * (mcp-server/src/tools/_lineage.js — the single source of truth shared with
 * refine_model, so the two paths can never drift) wired as a plain REST call
 * from the signed-in Forge Studio UI (/forge-studio). It forwards
 * `x-forge-client` straight through to /api/forge, so an iteration is a
 * normal, owned creation: it lands in the caller's gallery and can be
 * published as remixable exactly like any other forge result. No payment
 * surface — iteration is free on every track, same as the free studio.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { originFromReq, viewerUrl } from './_mcp-studio/forge-client.js';
import {
	composeRefinement,
	seedLineage,
	appendVersion,
	buildLineageChain,
	branchFrom,
} from '../mcp-server/src/tools/_lineage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clientIdFrom(req) {
	const raw = req.headers['x-forge-client'];
	const id = Array.isArray(raw) ? raw[0] : raw;
	return typeof id === 'string' && id.trim() ? id.trim().slice(0, 128) : null;
}

// Submit + poll against /api/forge, forwarding the caller's x-forge-client so
// the resulting row is owned by the same browser session that owns the parent
// model — the piece the anonymous free-studio path deliberately omits.
//
// /api/forge holds the connection open while a saturated generator queues the
// job, so the accept can legitimately take minutes before it answers (a live
// three.ws submit held for 157s, then returned its own busy 429). A short submit
// timeout therefore fires on exactly the condition the busy branch below exists
// to report, which is why this window is generous and why a timeout is answered
// as busy rather than as a bare gateway timeout.
const SUBMIT_TIMEOUT_MS = Number(process.env.FORGE_ITERATE_SUBMIT_MS) || 60_000;

async function submitForge(base, payload, clientId) {
	let res;
	try {
		res = await fetch(`${base}/api/forge`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(clientId ? { 'x-forge-client': clientId } : {}),
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
		});
	} catch (err) {
		if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
			// Report it the way the generator itself would: busy, with a back-off the
			// caller can act on. Both iterate UIs (src/forge-studio/forge-iterate.js,
			// src/forge-conversational-refine.js) already render a 429 + retry_after as
			// "busy, try again in Ns"; the old 504 sent them down the generic
			// "rephrase your instruction" branch, which blamed a wording the user had
			// got right.
			return {
				error: 'busy',
				status: 429,
				message: 'The 3D generator is busy right now; try again shortly.',
				retryAfter: 20,
			};
		}
		return { error: 'provider_error', status: 502, message: `The 3D generator is unreachable: ${err?.message || err}` };
	}
	const data = await res.json().catch(() => ({}));
	if (res.status === 503) {
		return { error: 'not_configured', status: 503, message: data?.message || '3D generation is not configured on this deployment.' };
	}
	if (res.status === 429) {
		return { error: 'busy', status: 429, message: data?.message || 'The 3D generator is busy; try again shortly.', retryAfter: data?.retry_after };
	}
	const completedSync = data?.status === 'done' && data?.glb_url;
	if (!res.ok || !(data?.job_id || completedSync)) {
		return { error: 'provider_error', status: 502, message: data?.message || `forge returned ${res.status}` };
	}
	return { data };
}

async function pollForge(base, jobId, clientId, { timeoutMs, intervalMs }) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		let res;
		try {
			res = await fetch(`${base}/api/forge?job=${encodeURIComponent(jobId)}`, {
				headers: { accept: 'application/json', ...(clientId ? { 'x-forge-client': clientId } : {}) },
				signal: AbortSignal.timeout(Math.max(intervalMs * 3, 15_000)),
			});
		} catch (err) {
			if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
				await sleep(intervalMs);
				continue;
			}
			return { error: 'provider_error', status: 502, message: `forge poll failed: ${err?.message || err}` };
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			return { error: 'provider_error', status: 502, message: data?.message || `forge poll returned ${res.status}` };
		}
		last = data;
		if (data.status === 'done' && data.glb_url) return { data };
		if (data.status === 'failed') {
			return { error: 'generation_failed', status: 502, message: data.error || 'Generation failed for this instruction.' };
		}
		await sleep(intervalMs);
	}
	return { data: { ...(last || {}), _timedOut: true } };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const clientId = clientIdFrom(req);
	const rl = await limits.forgeIterate(clientId || clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req, 200_000).catch(() => null);
	if (!body || typeof body !== 'object') {
		return json(res, 400, { error: 'invalid_json', message: 'Malformed JSON body.' });
	}

	const glbUrl = typeof body.glb_url === 'string' ? body.glb_url.trim() : '';
	if (!/^https?:\/\//i.test(glbUrl)) {
		return json(res, 400, { error: 'invalid_glb_url', message: 'Provide the http(s) glb_url of the model to iterate on.' });
	}
	const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
	if (!instruction) {
		return json(res, 400, { error: 'missing_instruction', message: 'Describe the change to make, e.g. "make it metallic".' });
	}
	if (instruction.length > 500) {
		return json(res, 400, { error: 'instruction_too_long', message: 'Keep the instruction to 500 characters or fewer.' });
	}
	const parentPrompt = typeof body.parent_prompt === 'string' ? body.parent_prompt.trim() : '';

	const composed = composeRefinement(parentPrompt, instruction);

	// Resolve the starting lineage exactly like refine_model does: extend a
	// client-supplied one when it's structurally valid, otherwise seed fresh so
	// a malformed/tampered array never corrupts history.
	const freshLineage = () => seedLineage({ glbUrl, prompt: parentPrompt || null });
	const clientLineage = Array.isArray(body.parent_lineage) ? body.parent_lineage : null;
	let baseLineage;
	if (clientLineage && clientLineage.length > 0) {
		const rehydrated = clientLineage.map((v, i) => ({
			index: Number.isInteger(v?.index) ? v.index : i,
			parentIndex: v?.parentIndex ?? (i > 0 ? i - 1 : null),
			glbUrl: v?.glbUrl,
			viewerUrl: v?.viewerUrl || null,
			prompt: v?.prompt || null,
			instruction: v?.instruction || null,
			refKind: v?.refKind || (i === 0 ? 'origin' : 'text'),
		}));
		baseLineage = buildLineageChain(rehydrated).ok ? rehydrated : freshLineage();
	} else {
		baseLineage = freshLineage();
	}

	let parentIndex;
	if (Number.isInteger(body.parent_index)) {
		try {
			parentIndex = branchFrom(baseLineage, body.parent_index);
		} catch {
			parentIndex = undefined;
		}
	}

	const base = originFromReq(req);
	const submitted = await submitForge(base, { prompt: composed }, clientId);
	if (submitted.error) {
		return json(res, submitted.status, {
			error: submitted.error,
			message: submitted.message,
			...(submitted.retryAfter ? { retry_after: submitted.retryAfter } : {}),
		});
	}
	const job = submitted.data;

	let final = job;
	if (!(job.status === 'done' && job.glb_url)) {
		const timeoutMs = Number(process.env.FORGE_ITERATE_TIMEOUT_MS) || 180_000;
		const intervalMs = Number(process.env.FORGE_ITERATE_POLL_MS) || 3000;
		const polled = await pollForge(base, job.job_id, clientId, { timeoutMs, intervalMs });
		if (polled.error) {
			return json(res, polled.status, { error: polled.error, message: polled.message });
		}
		final = polled.data;
	}
	if (final._timedOut || !final.glb_url) {
		return json(res, 504, {
			error: 'timeout',
			message: 'Iteration is taking longer than expected. Please try again.',
			job_id: job.job_id || null,
			creation_id: final.creation_id ?? job.creation_id ?? null,
		});
	}

	const newGlbUrl = final.glb_url;
	const vUrl = viewerUrl(base, newGlbUrl);
	const lineage = appendVersion(baseLineage, {
		glbUrl: newGlbUrl,
		viewerUrl: vUrl,
		prompt: composed,
		instruction,
		refKind: 'text',
		...(parentIndex !== undefined ? { parentIndex } : {}),
	});
	const activeIndex = lineage.length - 1;

	return json(res, 200, {
		ok: true,
		glbUrl: newGlbUrl,
		viewerUrl: vUrl,
		prompt: composed,
		instruction,
		creationId: final.creation_id ?? job.creation_id ?? null,
		durable: Boolean(final.durable),
		lineage,
		activeIndex,
	});
});
