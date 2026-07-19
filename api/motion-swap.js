/**
 * /api/motion-swap — video of a person → avatar body-swap capture job.
 *
 *   POST /api/motion-swap  { action: "upload", content_type, size_bytes }
 *     → 200 { upload_url, public_url, method, headers, expires_in }
 *       Presigns a direct-to-storage PUT for the source video so multi-MB
 *       uploads never proxy through this handler (same flow as /api/forge-upload).
 *
 *   POST /api/motion-swap  { video_url: string, fps?: number, max_seconds?: number }
 *     → 202 { job_id, status, eta_seconds }
 *
 *   GET  /api/motion-swap?job=<id>
 *     → { job_id, status, clip_url?, meta_url?, video_url?, mask_url?,
 *         frames?, fps?, error? }
 *
 * The worker (workers/model-video2motion) tracks the person with MediaPipe
 * pose, solves the motion onto the canonical Wolf3D skeleton (a three.js
 * AnimationClip JSON — the SAME format the animation library serves, so it
 * retargets onto any rigged avatar with src/animation-retarget.js), segments
 * the person into a mask video, and returns per-frame screen anchors. The
 * /motion-swap page composites: source video underneath, subject blurred via
 * the mask, the user's avatar pinned over them performing their motion.
 */

import { randomUUID } from 'node:crypto';
import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { presignUpload, publicUrl } from './_lib/r2.js';
import { createRegenProvider } from './_providers/gcp.js';

// Provider job ids are base64url JSON envelopes (mode + task id + worker base
// URL — see packJobId in _providers/gcp.js), so they run several hundred chars.
const JOB_ID_RE = /^[A-Za-z0-9_-]{20,600}$/;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MAX_SECONDS = 90;

const VIDEO_CONTENT_TYPE_EXT = Object.freeze({
	'video/mp4': 'mp4',
	'video/quicktime': 'mov',
	'video/webm': 'webm',
});

function storageConfigured() {
	return Boolean(
		process.env.S3_ENDPOINT &&
			process.env.S3_BUCKET &&
			process.env.S3_PUBLIC_DOMAIN &&
			process.env.S3_ACCESS_KEY_ID &&
			process.env.S3_SECRET_ACCESS_KEY,
	);
}

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Motion capture is not configured. Set GCP_VIDEO2MOTION_URL and GCP_RECONSTRUCTION_KEY ' +
			'to the URL and bearer secret of your deployed workers/model-video2motion Cloud Run service.',
	});
}

async function presignVideo(req, res, body) {
	if (!storageConfigured()) {
		return json(res, 503, {
			error: 'unconfigured',
			message:
				'Video upload is not configured on this deployment (object storage missing). ' +
				'Pass a public video URL to /api/motion-swap instead.',
		});
	}
	const rl = await limits.upload(`motion-swap:${clientIp(req)}`);
	if (!rl.success) {
		return rateLimited(res, rl, 'Upload limit reached. Try again shortly.');
	}

	const contentType =
		typeof body?.content_type === 'string' ? body.content_type.trim().toLowerCase() : '';
	const ext = VIDEO_CONTENT_TYPE_EXT[contentType];
	if (!ext) {
		return json(res, 400, {
			error: 'invalid_content_type',
			message: 'content_type must be video/mp4, video/quicktime, or video/webm.',
		});
	}
	const size = Number(body?.size_bytes);
	if (!Number.isFinite(size) || size <= 0 || size > MAX_VIDEO_BYTES) {
		return json(res, 400, {
			error: 'invalid_size',
			message: `size_bytes must be between 1 and ${MAX_VIDEO_BYTES} bytes (256 MB).`,
		});
	}

	const key = `motion-swap/uploads/${randomUUID()}.${ext}`;
	let uploadUrl;
	try {
		uploadUrl = await presignUpload({ key, contentType });
	} catch (err) {
		return json(res, 502, {
			error: 'presign_failed',
			message: err?.message || 'Could not create an upload URL.',
		});
	}
	return json(res, 200, {
		upload_url: uploadUrl,
		public_url: publicUrl(key),
		method: 'PUT',
		headers: { 'content-type': contentType },
		expires_in: 600,
	});
}

async function startJob(req, res, body) {
	const rl = await limits.mcp3dGenerate(clientIp(req));
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	let videoUrl;
	try {
		videoUrl = new URL(String(body?.video_url || ''));
		if (videoUrl.protocol !== 'https:') throw new Error('https only');
	} catch {
		return json(res, 400, {
			error: 'invalid_video_url',
			message: 'Pass an https video_url (or use action:"upload" to get one).',
		});
	}
	const fps = Math.max(8, Math.min(30, Number(body?.fps) || 24));
	const maxSeconds = Math.max(1, Math.min(MAX_SECONDS, Number(body?.max_seconds) || MAX_SECONDS));

	let provider;
	try {
		provider = createRegenProvider();
		if (!provider.supportsMode('video2motion')) return unconfigured(res);
	} catch {
		return unconfigured(res);
	}

	try {
		const job = await provider.submit({
			mode: 'video2motion',
			sourceUrl: videoUrl.href,
			params: { fps, max_seconds: maxSeconds },
		});
		return json(res, 202, {
			job_id: job.extJobId,
			status: 'queued',
			eta_seconds: job.eta,
		});
	} catch (err) {
		return json(res, 502, {
			error: 'capture_failed',
			message: err?.message || 'Motion capture could not start.',
		});
	}
}

async function pollJob(req, res, jobId) {
	if (!JOB_ID_RE.test(jobId)) {
		return json(res, 400, { error: 'invalid_job', message: 'Malformed job id.' });
	}
	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	let provider;
	try {
		provider = createRegenProvider();
	} catch {
		return unconfigured(res);
	}

	const result = await provider.status(jobId);
	return json(res, 200, {
		job_id: jobId,
		status: result.status,
		clip_url: result.resultClipUrl || null,
		meta_url: result.metaUrl || null,
		video_url: result.videoUrl || null,
		mask_url: result.maskUrl || null,
		frames: typeof result.frames === 'number' ? result.frames : null,
		fps: typeof result.fps === 'number' ? result.fps : null,
		error: result.error || null,
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'POST') {
		const body = await readJson(req, 4_000).catch(() => null);
		if (body?.action === 'upload') return presignVideo(req, res, body);
		return startJob(req, res, body);
	}

	const url = new URL(req.url, 'http://localhost');
	const jobId = (url.searchParams.get('job') || '').trim();
	if (!jobId) return json(res, 400, { error: 'missing_job', message: 'Pass ?job=<id> to poll.' });
	return pollJob(req, res, jobId);
});
