/**
 * /api/cosmos: text to an animated WORLD video on the free NVIDIA Cosmos lane.
 *
 *   POST /api/cosmos  { prompt: string, seed?: number }
 *     → 202 { job_id, status, eta_seconds }            (async, poll for the clip)
 *     → 200 { status:'done', video_url }               (rare synchronous completion)
 *
 *   GET  /api/cosmos?job=<id>
 *     → { job_id, status, video_url?, error? }
 *
 * Cosmos is NVIDIA's World Foundation Model family. The Text2World predict model
 * renders a short photoreal video of a world from a prompt, and we play it as a
 * living backdrop behind a 3D avatar (see /cosmos). The job runs on NVIDIA's NVCF
 * async gateway: submit returns a request id, we hand it back as job_id, and the
 * GET poll asks NVCF for status and (on completion) persists the MP4 to R2,
 * returning a durable URL. There is no server-side job store: the NVCF request
 * id IS the durable handle, exactly like the TRELLIS text→3D lane.
 *
 * Reuses the platform NVIDIA_API_KEY (free NIM tier). When it is absent the lane
 * reports itself unconfigured (503) and the page degrades to a static backdrop.
 * The same 503 shape (error:'lane_unavailable') answers the case where the key is
 * present but NVIDIA has retired every hosted cosmos-predict route this account
 * can reach, so the page lands in the same designed offline state instead of
 * asking the user to retry something that cannot succeed.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { createNvidiaCosmosProvider, nvidiaCosmosConfigured } from './_providers/nvidia-cosmos.js';

const JOB_ID_RE = /^[A-Za-z0-9_-]{20,64}$/;
// Cosmos predict renders ~5 s of 1280×704 @ 24fps video; on the shared free tier
// that typically lands in 60-120 s. Surfaced to the client so the loading state
// can set honest expectations instead of an open-ended spinner.
const ETA_SECONDS = 90;

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Cosmos world generation is not configured. Set NVIDIA_API_KEY (an nvapi-… key from ' +
			'build.nvidia.com) to enable the free NVIDIA Cosmos lane.',
	});
}

// User-facing copy per normalized provider code. The upstream detail is operator
// diagnostics (it has carried NVCF function ids and the account id) and is logged,
// never returned: a caller can act on "the lane is down", not on a function uuid.
const FAILURE_COPY = {
	lane_unavailable:
		'NVIDIA Cosmos world generation is offline right now. Your avatar keeps its living backdrop above; ' +
		'check back soon for generated worlds.',
	invalid_key: 'The Cosmos lane rejected this deployment’s NVIDIA credentials. An operator needs to refresh the key.',
	insufficient_credits: 'The Cosmos lane is out of NVIDIA credits for now.',
	rate_limited: 'NVIDIA Cosmos is rate limiting right now.',
	provider_unreachable: 'NVIDIA Cosmos did not answer. Try again in a moment.',
	provider_error: 'Cosmos could not start this world. Try again, or try a simpler prompt.',
};

function failureResponse(res, err) {
	const code = FAILURE_COPY[err?.code] ? err.code : 'provider_error';
	const status = code === 'lane_unavailable' ? 503 : code === 'rate_limited' ? 429 : code === 'invalid_key' ? 401 : code === 'insufficient_credits' ? 402 : 502;
	console.warn('[cosmos] submit failed (%s/%s): %s', code, err?.providerStatus ?? '-', err?.message || 'no detail');
	return json(res, status, {
		error: code,
		message: FAILURE_COPY[code],
		...(err?.retryAfter ? { retry_after: err.retryAfter } : {}),
	});
}

async function startJob(req, res) {
	const rl = await limits.mcp3dGenerate(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (!nvidiaCosmosConfigured()) return unconfigured(res);

	const body = await readJson(req, 4_000).catch(() => null);
	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	if (prompt.length < 3 || prompt.length > 300) {
		return json(res, 400, {
			error: 'invalid_prompt',
			message: 'Describe the world in 3-300 characters (e.g. "a neon Tokyo street in the rain at night").',
		});
	}
	const seed = Number.isFinite(Number(body?.seed)) ? Math.trunc(Number(body.seed)) : undefined;

	let provider;
	try {
		provider = createNvidiaCosmosProvider();
	} catch {
		return unconfigured(res);
	}

	try {
		const result = await provider.textToWorld({ prompt, seed });
		// Synchronous completion (uncommon for video), hand back the clip directly.
		if (result.resultVideoUrl) {
			return json(res, 200, { status: 'done', video_url: result.resultVideoUrl });
		}
		return json(res, 202, {
			job_id: result.taskId,
			status: 'queued',
			eta_seconds: ETA_SECONDS,
		});
	} catch (err) {
		return failureResponse(res, err);
	}
}

async function pollJob(req, res, jobId) {
	if (!JOB_ID_RE.test(jobId)) {
		return json(res, 400, { error: 'invalid_job', message: 'Malformed job id.' });
	}

	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (!nvidiaCosmosConfigured()) return unconfigured(res);

	let provider;
	try {
		provider = createNvidiaCosmosProvider();
	} catch {
		return unconfigured(res);
	}

	const result = await provider.status({ taskId: jobId });
	// The provider's `error` is operator diagnostics on both the running and failed
	// paths (upstream statuses, persist failures). Log it, hand the caller a stable
	// sentence it can render, and never echo it while the job is still alive.
	if (result.error) console.warn('[cosmos] poll %s (%s): %s', jobId, result.status, result.error);
	return json(res, 200, {
		job_id: jobId,
		status: result.status,
		video_url: result.resultVideoUrl || null,
		error: result.status === 'failed' ? 'Cosmos could not finish this world. Try again, or try a different prompt.' : null,
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'POST') return startJob(req, res);

	const url = new URL(req.url, 'http://localhost');
	const jobId = (url.searchParams.get('job') || '').trim();
	if (!jobId) return json(res, 400, { error: 'missing_job', message: 'Pass ?job=<id> to poll.' });
	return pollJob(req, res, jobId);
});
