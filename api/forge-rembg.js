/**
 * /api/forge-rembg — background removal for the forge pipeline.
 *
 *   POST /api/forge-rembg  { image_url: string, model?: string }
 *                        → 202 { job_id, status }
 *
 *   GET  /api/forge-rembg?job=<id>
 *                        → { job_id, status, result_url?, error? }
 *
 * Routes to workers/rembg (GCP Cloud Run) when GCP_REMBG_URL is set,
 * otherwise returns 503 with an actionable configuration message.
 *
 * No auth required — rate-limited by client IP using the same mcp3d buckets.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { assertPublicHttpsUrl, SsrfError } from './_lib/ssrf.js';
import { createRegenProvider } from './_providers/gcp.js';

// Provider job ids are base64url JSON envelopes (packJobId in _providers/gcp.js)
// and run several hundred chars — a 64-char cap 400s every poll.
const JOB_ID_RE = /^[A-Za-z0-9_-]{20,600}$/;
const VALID_MODELS = new Set(['rmbg2', 'u2net', 'isnet', 'u2net_human_seg', 'silueta']);

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Background removal is not configured. Set GCP_REMBG_URL and GCP_RECONSTRUCTION_KEY ' +
			'to the URL and bearer secret of your deployed workers/rembg Cloud Run service.',
	});
}

async function startJob(req, res) {
	const ip = clientIp(req);
	const rl = await limits.mcp3dGenerate(ip);
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	const body = await readJson(req, 4_000).catch(() => null);
	const rawImageUrl = typeof body?.image_url === 'string' ? body.image_url.trim() : '';
	// Resolve + validate the host our side (rejects private/loopback/metadata IPs)
	// before handing the URL to the worker — defense in depth against SSRF rather
	// than trusting the worker's egress posture.
	let imageUrl;
	try {
		imageUrl = await assertPublicHttpsUrl(rawImageUrl);
	} catch (err) {
		return json(res, 400, {
			error: 'invalid_image_url',
			message: err instanceof SsrfError ? `image_url rejected: ${err.message}` : 'image_url must be a public https URL.',
		});
	}

	const model = VALID_MODELS.has(body?.model) ? body.model : 'rmbg2';

	let provider;
	try {
		provider = createRegenProvider();
		if (!provider.supportsMode('rembg')) return unconfigured(res);
	} catch {
		return unconfigured(res);
	}

	try {
		const job = await provider.submit({ mode: 'rembg', sourceUrl: imageUrl, params: { model } });
		return json(res, 202, {
			job_id: job.extJobId,
			status: 'queued',
			eta_seconds: job.eta,
		});
	} catch (err) {
		return json(res, 502, { error: 'rembg_failed', message: err?.message || 'Background removal could not start.' });
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

	// Poll is an outbound call to the worker, so it gets the same boundary guard
	// as submit. Without it an upstream fault escapes to wrap() as a 500, and
	// because clients poll every couple of seconds one worker outage pages ops
	// once per poll per client instead of once. A 502 with no `status` field
	// leaves the client's poll loop retrying, which is what a transient fault
	// deserves.
	let result;
	try {
		result = await provider.status(jobId);
	} catch (err) {
		return json(res, 502, {
			error: 'rembg_status_failed',
			message: err?.message || 'Could not read the background-removal job.',
		});
	}
	return json(res, 200, {
		job_id: jobId,
		status: result.status,
		result_url: result.resultImageUrl || result.resultGlbUrl || null,
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
