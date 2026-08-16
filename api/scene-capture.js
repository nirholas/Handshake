/**
 * /api/scene-capture — streaming video → 3D point-cloud reconstruction.
 *
 *   POST /api/scene-capture
 *     { video_url: string,            // public https URL to an mp4/mov/webm
 *       mode?: "streaming"|"windowed",
 *       fps?: int, keyframe_interval?: int, num_scale_frames?: int,
 *       mask_sky?: bool, conf_percentile?: 0..95, max_points?: int }
 *                              → 202 { job_id, status, eta_seconds }
 *
 *   GET  /api/scene-capture?job=<id>
 *                              → { job_id, status, result_url?, num_points?, frames?, error? }
 *
 * Routes to workers/model-video2scene (LingBot-Map on Cloud Run GPU) via the
 * shared gcp regen provider when GCP_VIDEO2SCENE_URL + GCP_RECONSTRUCTION_KEY are
 * set; otherwise returns a clean 503 so the page degrades to its sample renderer.
 *
 * The result is a binary .ply point cloud the /capture page renders client-side
 * with a WebGL point-cloud viewer. No auth — rate-limited by client IP on the
 * same mcp3d buckets the rest of the forge surface uses.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { assertPublicHttpsUrl, SsrfError } from './_lib/ssrf.js';
import { createRegenProvider } from './_providers/gcp.js';

const JOB_ID_RE = /^[A-Za-z0-9_-]{20,512}$/;

// Reconstruction quality / sampling knobs, clamped to the worker's accepted ranges.
function clampInt(v, lo, hi, dflt) {
	const n = Math.round(Number(v));
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// The 503 body is read straight into the /capture error overlay, so `message` is
// written for a visitor. Operator instructions live in `hint`, which the page
// never renders: telling a first-time user to set two GCP env vars is not an
// actionable error state.
function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message: 'Video reconstruction is offline on this deployment, so a video cannot be turned into a point cloud right now.',
		hint:
			'Set GCP_VIDEO2SCENE_URL and GCP_RECONSTRUCTION_KEY to the URL and bearer ' +
			'secret of your deployed workers/model-video2scene Cloud Run service.',
	});
}

async function startJob(req, res) {
	const ip = clientIp(req);
	const rl = await limits.mcp3dGenerate(ip);
	if (!rl.success) return rateLimited(res, rl, 'Reconstruction limit reached. Try again shortly.');

	const body = await readJson(req, 8_000).catch(() => null);

	const rawVideoUrl = typeof body?.video_url === 'string' ? body.video_url.trim() : '';
	if (!rawVideoUrl) {
		return json(res, 400, {
			error: 'missing_video_url',
			message: 'Pass a public https URL to a video (mp4, mov, or webm) as video_url.',
		});
	}

	// Resolve + validate the host ourselves (rejects private/loopback/metadata IPs)
	// before handing the URL to the worker — defense in depth against SSRF.
	let videoUrl;
	try {
		videoUrl = await assertPublicHttpsUrl(rawVideoUrl);
	} catch (err) {
		return json(res, 400, {
			error: 'invalid_video_url',
			message: err instanceof SsrfError ? `video_url rejected: ${err.message}` : 'video_url must be a public https URL.',
		});
	}

	const params = {
		mode: body?.mode === 'windowed' ? 'windowed' : 'streaming',
		fps: clampInt(body?.fps, 1, 30, 8),
		keyframe_interval: clampInt(body?.keyframe_interval, 1, 64, 4),
		num_scale_frames: clampInt(body?.num_scale_frames, 2, 16, 8),
		window_size: clampInt(body?.window_size, 16, 512, 128),
		conf_percentile: Math.min(95, Math.max(0, Number(body?.conf_percentile) || 30)),
		max_points: clampInt(body?.max_points, 50_000, 3_000_000, 1_500_000),
		voxel_size: Math.min(10, Math.max(0, Number(body?.voxel_size) || 0)),
		mask_sky: body?.mask_sky !== false,
	};

	let provider;
	try {
		provider = createRegenProvider();
		if (!provider.supportsMode('video2scene')) return unconfigured(res);
	} catch {
		return unconfigured(res);
	}

	try {
		const job = await provider.submit({ mode: 'video2scene', sourceUrl: videoUrl, params });
		return json(res, 202, {
			job_id: job.extJobId,
			status: 'queued',
			eta_seconds: job.eta,
		});
	} catch (err) {
		const status = err?.status === 501 ? 503 : 502;
		return json(res, status, {
			error: status === 503 ? 'unconfigured' : 'capture_failed',
			message: err?.message || 'Reconstruction could not start.',
		});
	}
}

async function pollJob(req, res, jobId) {
	if (!JOB_ID_RE.test(jobId)) {
		return json(res, 400, { error: 'invalid_job', message: 'Malformed job id.' });
	}

	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let provider;
	try {
		provider = createRegenProvider();
	} catch {
		return unconfigured(res);
	}

	// The client polls this on a fixed interval; a thrown decode error here would
	// hand it a 500 it can only keep retrying. Report the failure in the payload.
	let result;
	try {
		result = await provider.status(jobId);
	} catch (err) {
		return json(res, 200, {
			job_id: jobId,
			status: 'failed',
			result_url: null,
			error: err?.message || 'Job status could not be read.',
		});
	}

	return json(res, 200, {
		job_id: jobId,
		status: result.status,
		result_url: result.resultPointCloudUrl || null,
		num_points: result.numPoints ?? null,
		frames: result.frames ?? null,
		frames_truncated: result.framesTruncated ?? null,
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
