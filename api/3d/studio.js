// POST /api/3d/studio  +  GET /api/3d/studio?job=<id>
//
// The ChatGPT Actions surface for free text→3D — the REST contract behind the
// "three.ws 3D Studio" custom GPT (prompts/store-submissions/_generated/
// openai-actions.yaml). It exists as a separate route from /api/3d/generate
// because a GPT Store listing has stricter response rules than the agent lane:
// responses may carry ONLY the model URLs and job state — no upsell block, no
// pricing paths, no internal identifiers — and every prompt must pass the
// age-13+ content-safety gate before any GPU work starts.
//
// It is a thin shaper, not a second pipeline: generation runs through the SAME
// forge-client → /api/forge router at the high tier (platform-funded via the
// internal seed token; the free-first router picks the engine — Hunyuan3D at
// high, with a standard-tier fallback if the gate refuses) and draws from the
// SAME per-IP quota buckets as /api/3d/generate, so adding this surface creates
// no new capacity and no new limiter.
//
//   POST { prompt }
//     → 200 { status:'done',  glbUrl, viewerUrl, format }   (finished inline)
//     → 200 { status:'pending', job, poll, format }          (queued — poll below)
//     → 400 { error:'prompt_rejected', message }             (safety gate refusal)
//
//   GET ?job=<id>
//     → 200 { status:'pending', job, poll }                  (still generating)
//     → 200 { status:'done',  glbUrl, viewerUrl, format }    (GLB ready)
//     → 200 { status:'error', error }                        (upstream failed — retry is free)
//
// ChatGPT Actions time out at ~45s; the forge lane bounds its synchronous hold
// to 30s (NVCF_POLL_SECONDS in api/_providers/nvidia.js), so a slow job always
// returns 'pending' + a poll handle before the Action deadline instead of dying
// on the socket.

import { cors, wrap, method, json, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { startForge, originFromReq, viewerUrl } from '../_mcp-studio/forge-client.js';
import { checkPromptSafety } from '../_mcp-studio/safety.js';

const PROMPT_MIN = 3; // the generation lane needs a subject to condition on
const PROMPT_MAX = 1000; // matches /api/forge's own prompt ceiling
const MAX_BODY_BYTES = 8_000;

// A forge job handle is either a signed f1.<b64url>.<b64url> string or a bare
// prediction id. Bound the poll param to that shape before forwarding —
// /api/forge does the authoritative validation, this just keeps junk off the wire.
const JOB_HANDLE_RE = /^[A-Za-z0-9._-]{8,1024}$/;

// Shape a forge submit response into the Actions contract: model URLs and job
// state only. Pure + exported so tests pin the boundary against real captured
// forge shapes without any network.
export function shapeSubmit(job, base) {
	const glbUrl = typeof job?.glb_url === 'string' ? job.glb_url : '';
	if (job?.status === 'done' && glbUrl) {
		return { status: 'done', glbUrl, viewerUrl: viewerUrl(base, glbUrl), format: 'glb' };
	}
	const handle = job?.job_id ?? null;
	return {
		status: 'pending',
		job: handle,
		poll: handle ? `/api/3d/studio?job=${encodeURIComponent(handle)}` : null,
		format: 'glb',
	};
}

// Shape a forge poll response into { status:'pending'|'done'|'error', ... }.
export function shapePoll(data, base, jobId) {
	const glbUrl = typeof data?.glb_url === 'string' ? data.glb_url : '';
	if (data?.status === 'done' && glbUrl) {
		return { status: 'done', job: jobId, glbUrl, viewerUrl: viewerUrl(base, glbUrl), format: 'glb' };
	}
	if (data?.status === 'failed') {
		return {
			status: 'error',
			job: jobId,
			// The message is already sanitized by /api/forge; generation is free, so a
			// failed job costs the user nothing — they can simply try again.
			error: data?.error || '3D generation hit a snag upstream — it costs nothing to try again.',
		};
	}
	// queued / running / anything transient → still pending.
	return { status: 'pending', job: jobId, poll: `/api/3d/studio?job=${encodeURIComponent(jobId)}` };
}

// Map a startForge lane failure to an honest boundary response. A well-formed
// prompt must NEVER 500: every code has a designed status + actionable message.
function failFromLane(res, err) {
	switch (err?.code) {
		case 'not_configured':
			return json(res, 503, {
				error: 'not_configured',
				message: '3D generation is temporarily unavailable on this deployment — try again later.',
			});
		case 'busy':
			if (err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
			return json(res, 429, {
				error: 'rate_limited',
				message: err.message || 'The free 3D generator is momentarily saturated — try again shortly.',
				retry_after: err.retryAfter || 10,
			});
		case 'timeout':
			res.setHeader('retry-after', '10');
			return json(res, 503, {
				error: 'lane_timeout',
				message: err.message || 'The 3D generator took too long to accept the job — try again.',
				retry_after: 10,
			});
		default:
			return json(res, 502, {
				error: 'generation_failed',
				message: err?.message || 'The 3D generator could not start this job — try again.',
			});
	}
}

async function generate(req, res) {
	const ip = clientIp(req);

	let body;
	try {
		body = await readJson(req, MAX_BODY_BYTES);
	} catch (err) {
		return json(res, err?.status === 413 ? 413 : 400, {
			error: 'bad_request',
			message: err?.status === 413 ? 'Request body too large.' : 'Send a JSON body: { "prompt": "..." }.',
		});
	}

	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	if (prompt.length < PROMPT_MIN) {
		return json(res, 400, {
			error: 'invalid_prompt',
			message: `"prompt" is required — describe one subject in ${PROMPT_MIN}–${PROMPT_MAX} characters, e.g. "a small ceramic robot figurine".`,
		});
	}
	if (prompt.length > PROMPT_MAX) {
		return json(res, 400, {
			error: 'invalid_prompt',
			message: `"prompt" must be ${PROMPT_MAX} characters or fewer.`,
		});
	}

	// Age-13+ content gate BEFORE any quota spend or GPU work. The category
	// message is the user-facing refusal the GPT relays verbatim.
	const safety = checkPromptSafety(prompt);
	if (!safety.allowed) {
		return json(res, 400, { error: 'prompt_rejected', message: safety.message });
	}

	// Per-IP guard on the free GPU lane — the SAME bucket /api/3d/generate and
	// /api/forge draw from, so this surface adds no new unmetered capacity.
	const rl = await limits.mcp3dGenerateFree(ip);
	if (!rl.success) {
		return rateLimited(res, rl, 'Free 3D generation limit reached — try again in a little while.');
	}

	const base = originFromReq(req);
	let job;
	try {
		// High tier, platform-funded: the internal seed token clears the premium-tier
		// gate server-side (nothing user-visible), and omitting `backend` lets the
		// free-first router pick the best engine for the tier (Hunyuan3D at high,
		// self-host fallbacks). Per-IP metering above still bounds spend. If the
		// gate refuses, startForge falls back to the ungated standard tier.
		job = await startForge(base, { prompt, path: 'image', tier: 'high', internal: true });
	} catch (err) {
		return failFromLane(res, err);
	}

	return json(res, 200, shapeSubmit(job, base));
}

async function poll(req, res, jobId) {
	if (!JOB_HANDLE_RE.test(jobId)) {
		return json(res, 400, { error: 'invalid_job', message: 'Malformed job id. Pass the "job" value from the generate response.' });
	}

	// Cheap, high-frequency poll — reuse the forge status limiter (per-instance,
	// flood-guard only) so a polling loop can't be turned into a hammer.
	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'Polling too fast — slow down and retry.');

	const base = originFromReq(req);
	let upstream;
	try {
		upstream = await fetch(`${base}/api/forge?job=${encodeURIComponent(jobId)}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		// A transient network blip on the self-call is not a job failure — tell the
		// caller it's still pending so its poll loop retries.
		return json(res, 200, shapePoll({ status: 'running' }, base, jobId));
	}

	const data = await upstream.json().catch(() => ({}));
	if (upstream.status === 400) {
		return json(res, 400, { error: 'invalid_job', message: data?.message || 'Unknown or malformed job id.' });
	}
	if (upstream.status === 429) {
		const retryAfter = Number(data?.retry_after) || 5;
		res.setHeader('retry-after', String(retryAfter));
		return json(res, 429, { error: 'rate_limited', message: 'Polling is rate-limited — retry shortly.', retry_after: retryAfter });
	}
	if (!upstream.ok) {
		// Upstream hiccup mid-poll — keep the job alive as pending so the loop retries.
		return json(res, 200, shapePoll({ status: 'running' }, base, jobId));
	}

	return json(res, 200, shapePoll(data, base, jobId));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'POST') return generate(req, res);

	const url = new URL(req.url, 'http://localhost');
	const jobId = (url.searchParams.get('job') || '').trim();
	if (!jobId) {
		return error(res, 400, 'missing_job', 'Pass ?job=<id> to poll a generation, or POST { prompt } to start one.');
	}
	return poll(req, res, jobId);
});

// The free NIM draft often finishes inside the submit window; startForge waits up
// to 90s for that inline completion. Give the function headroom beyond the default
// so a fast draft returns done in one call instead of forcing a poll.
export const config = { maxDuration: 120 };
