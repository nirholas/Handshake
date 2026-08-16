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
		const status = err?.code === 'rate_limited' ? 429 : err?.code === 'invalid_key' ? 401 : 502;
		return json(res, status, {
			error: err?.code || 'cosmos_failed',
			message: err?.message || 'Cosmos world generation could not start.',
			...(err?.retryAfter ? { retry_after: err.retryAfter } : {}),
		});
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
	return json(res, 200, {
		job_id: jobId,
		status: result.status,
		video_url: result.resultVideoUrl || null,
		error: result.error || null,
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
