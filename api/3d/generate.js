// POST /api/3d/generate  +  GET /api/3d/generate?job=<id>
//
// The FREE, keyless, agent-first front door to three.ws text→3D. An autonomous
// agent building a game, a scene, an NFT, or any visual can turn a text prompt
// into a real textured GLB in one call — no key, no account, no wallet. No other
// agent-payments platform gives away 3D generation; this is the magnet that
// funnels to paid Forge Pro (quality tiers) and Rigged Avatars.
//
// This route does NOT re-implement generation. It wraps the existing free draft
// lane (NVIDIA NIM TRELLIS → self-host TRELLIS/Hunyuan3D → HuggingFace Spaces)
// through the SAME /api/forge submit/poll pipeline the forge_free MCP tool and
// /api/v1/ai/text-to-3d already use (api/_mcp-studio/forge-client.js). Only the
// wire contract is new: a clean, minimal agent shape.
//
//   POST { prompt, format?:'glb' }
//     → 200 { status:'done',  glbUrl, viewerUrl, arUrl, ... }  (draft finished inline)
//     → 200 { status:'pending', job, poll, ... }               (queued — poll below)
//
//   GET ?job=<id>&title=<prompt>   (title optional — labels the AR/viewer pages)
//     → 200 { status:'pending' }                               (still generating)
//     → 200 { status:'done',  glbUrl, viewerUrl, arUrl }       (GLB ready)
//     → 200 { status:'error', error }                          (upstream failed; free = no charge)
//
// arUrl is the device-aware AR launch (api/ar.js): opened on a phone it places
// the model in the caller's real room (Scene Viewer on Android, Quick Look on
// iOS); on desktop it falls back to the WebGL viewer. Same lane as /forge and
// /ar — surface it to end users as "place it in your room".
//
// Free = the draft/NIM tier only, and we say so honestly: single-subject prompts,
// ~draft-fidelity geometry, no rigging. Higher quality + rigging live behind the
// paid Forge (/api/x402/forge) and Rigged Avatars, linked in every response.

import { cors, wrap, method, json, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { startForge, originFromReq, viewerUrl, arLaunchUrl } from '../_mcp-studio/forge-client.js';

const PROMPT_MIN = 3; // the draft lane needs a subject to condition on
const PROMPT_MAX = 1000; // matches /api/forge's own prompt ceiling
const MAX_BODY_BYTES = 8_000;

// A forge job handle is either a signed f1.<b64url>.<b64url> token or a bare
// Replicate prediction id ([a-z0-9]{16,64}). Bound the poll param to that shape
// before forwarding — /api/forge does the authoritative validation, this just
// keeps obvious junk off the wire.
const JOB_HANDLE_RE = /^[A-Za-z0-9._-]{8,1024}$/;

// The upsell ladder every response carries: free draft here → paid Forge Pro
// quality tiers → rigged, animation-ready avatars. Not a paywall — a doorway.
const UPGRADE = Object.freeze({
	message:
		'This is the free draft tier (NVIDIA NIM TRELLIS): single-subject, draft-fidelity geometry, no rigging. ' +
		'For higher polygon budgets + PBR textures use paid Forge Pro; for animation-ready rigged characters use Rigged Avatars.',
	forgePro: '/api/x402/forge',
	riggedAvatars: '/api/forge?action=rig',
	docs: '/docs/3d-api',
});

// Shape a /api/forge draft-lane submit response into this route's agent contract.
// Pure + exported so the boundary is pinned in tests against real captured forge
// shapes (inline-done vs queued) without any network.
export function shapeSubmit(job, base, prompt) {
	const glbUrl = typeof job?.glb_url === 'string' ? job.glb_url : '';
	if (job?.status === 'done' && glbUrl) {
		return {
			status: 'done',
			glbUrl,
			viewerUrl: viewerUrl(base, glbUrl),
			arUrl: arLaunchUrl(base, glbUrl, prompt),
			format: 'glb',
			tier: 'draft',
			free: true,
			upgrade: UPGRADE,
		};
	}
	const token = job?.job_id ?? null;
	// The poll URL carries the prompt as `title` so the eventual done response
	// labels the AR/viewer pages without the caller resending anything.
	const t = typeof prompt === 'string' && prompt.trim() ? `&title=${encodeURIComponent(prompt.trim().slice(0, 80))}` : '';
	return {
		status: 'pending',
		job: token,
		poll: token ? `/api/3d/generate?job=${encodeURIComponent(token)}${t}` : null,
		format: 'glb',
		tier: 'draft',
		free: true,
		upgrade: UPGRADE,
	};
}

// Shape a /api/forge poll response into { status:'pending'|'done'|'error', ... }.
// Pure + exported for the same reason as shapeSubmit.
export function shapePoll(data, base, jobId, title) {
	const glbUrl = typeof data?.glb_url === 'string' ? data.glb_url : '';
	if (data?.status === 'done' && glbUrl) {
		return {
			status: 'done',
			job: jobId,
			glbUrl,
			viewerUrl: viewerUrl(base, glbUrl),
			arUrl: arLaunchUrl(base, glbUrl, title),
			format: 'glb',
			tier: 'draft',
			free: true,
		};
	}
	if (data?.status === 'failed') {
		return {
			status: 'error',
			job: jobId,
			// Free lane: an upstream failure costs the caller nothing — say so and let
			// them simply retry. The message is already sanitized by /api/forge.
			error: data?.error || '3D generation hit a snag upstream — no charge; try again.',
			free: true,
			upgrade: UPGRADE,
		};
	}
	// queued / running / anything transient → still pending; keep the title on the
	// poll URL so it survives to the done response.
	const t = typeof title === 'string' && title.trim() ? `&title=${encodeURIComponent(title.trim().slice(0, 80))}` : '';
	return {
		status: 'pending',
		job: jobId,
		poll: `/api/3d/generate?job=${encodeURIComponent(jobId)}${t}`,
		free: true,
	};
}

// Map a startForge lane failure to an honest boundary response. A well-formed
// prompt must NEVER 500: every code has a designed status + actionable message.
function failFromLane(res, err) {
	switch (err?.code) {
		case 'not_configured':
			return json(res, 503, {
				error: 'not_configured',
				message:
					err.message ||
					'Free text→3D is not configured on this deployment — set NVIDIA_API_KEY (or a self-host TRELLIS / HuggingFace lane).',
			});
		case 'busy':
			// GPU lane saturated upstream — surface the retry hint the lane handed back.
			if (err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
			return json(res, 429, {
				error: 'rate_limited',
				message: err.message || 'The free 3D GPU lane is momentarily saturated — try again shortly.',
				retry_after: err.retryAfter || 10,
			});
		case 'timeout':
			res.setHeader('retry-after', '10');
			return json(res, 503, {
				error: 'lane_timeout',
				message: err.message || 'The 3D lane took too long to accept the job — try again.',
				retry_after: 10,
			});
		default:
			// Upstream provider blip — a free-lane failure, not a server fault. Answer
			// with a designed 502 (never a raw 500) so the agent can retry.
			return json(res, 502, {
				error: 'generation_failed',
				message: err?.message || 'The 3D lane could not start this job — try again.',
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

	// Only GLB is offered on the free lane. Accept the default and an explicit
	// 'glb'; reject anything else plainly rather than silently ignoring it.
	const format = body?.format == null ? 'glb' : String(body.format).toLowerCase();
	if (format !== 'glb') {
		return json(res, 400, {
			error: 'unsupported_format',
			message: 'The free lane returns GLB only. Omit "format" or pass "glb".',
		});
	}

	// Per-IP guard on the free GPU lane. Reuses the existing free-lane bucket
	// (mcp3d:generate:free) — the SAME counter /api/forge draws from — so this is a
	// generous shared ceiling protecting one GPU allocation, and the check here
	// rejects a flood before the self-call round-trip. The GLOBAL concurrency guard
	// (HuggingFace slot lease + platform submit throttle) lives inside /api/forge and
	// is inherited automatically by routing through it — no new limiter invented.
	const rl = await limits.mcp3dGenerateFree(ip);
	if (!rl.success) {
		return rateLimited(res, rl, 'Free 3D generation limit reached — try again shortly, or use paid Forge Pro (no per-IP cap).', {
			upgrade: UPGRADE,
		});
	}

	const base = originFromReq(req);
	let job;
	try {
		// Pin the free draft lane exactly: NVIDIA NIM TRELLIS, image path, draft tier.
		job = await startForge(base, { prompt, backend: 'nvidia', path: 'image', tier: 'draft' });
	} catch (err) {
		return failFromLane(res, err);
	}

	return json(res, 200, shapeSubmit(job, base, prompt));
}

async function poll(req, res, jobId, title) {
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
		return json(res, 200, shapePoll({ status: 'running' }, base, jobId, title));
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
		return json(res, 200, shapePoll({ status: 'running' }, base, jobId, title));
	}

	return json(res, 200, shapePoll(data, base, jobId, title));
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
	const title = (url.searchParams.get('title') || '').trim().slice(0, 120);
	return poll(req, res, jobId, title);
});

// The free NIM draft often finishes inside the submit window; startForge waits up
// to 90s for that inline completion. Give the function headroom beyond the default
// so a fast draft returns done in one call instead of forcing a poll.
export const config = { maxDuration: 120 };
