/**
 * /api/forge-segment — split a 3D model into named, addressable parts.
 *
 *   POST /api/forge-segment  {
 *     mesh_url: string,
 *     method?: "auto"|"connected"|"crease",
 *     max_parts?: number,        // 2–64
 *     min_part_faces?: number,   // 4–100000
 *     crease_angle?: number,     // 5–170 (degrees)
 *     only_part?: string         // export just this part id/name (e.g. "part_03")
 *   } → 202 { job_id, status }
 *
 *   GET  /api/forge-segment?job=<id>
 *     → { job_id, status, result_url?, manifest_url?, parts?, part_count?,
 *         source_faces?, method?, warnings?, error? }
 *
 * Routes to workers/segment (GCP Cloud Run) when GCP_SEGMENT_URL is set.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { assertPublicHttpsUrl, SsrfError } from './_lib/ssrf.js';
import { createRegenProvider } from './_providers/gcp.js';

// Provider job ids are base64url JSON envelopes (packJobId in _providers/gcp.js)
// and run several hundred chars — a 64-char cap 400s every poll.
const JOB_ID_RE = /^[A-Za-z0-9_-]{20,600}$/;
const VALID_METHODS = new Set(['auto', 'connected', 'crease']);
const PART_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Part segmentation is not configured. Set GCP_SEGMENT_URL and GCP_RECONSTRUCTION_KEY ' +
			'to the URL and bearer secret of your deployed workers/segment Cloud Run service.',
	});
}

async function startJob(req, res) {
	const ip = clientIp(req);
	const rl = await limits.mcp3dGenerate(ip);
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	const body = await readJson(req, 4_000).catch(() => null);
	const rawMeshUrl = typeof body?.mesh_url === 'string' ? body.mesh_url.trim() : '';
	// Resolve + validate the host our side (rejects private/loopback/metadata IPs)
	// before handing the URL to the worker — SSRF defense in depth.
	let meshUrl;
	try {
		meshUrl = await assertPublicHttpsUrl(rawMeshUrl);
	} catch (err) {
		return json(res, 400, {
			error: 'invalid_mesh_url',
			message: err instanceof SsrfError ? `mesh_url rejected: ${err.message}` : 'mesh_url must be a public https URL.',
		});
	}

	const segMethod = VALID_METHODS.has(body?.method) ? body.method : 'auto';
	const maxParts = Math.max(2, Math.min(64, Number(body?.max_parts) || 24));
	const minPartFaces = Math.max(4, Math.min(100_000, Number(body?.min_part_faces) || 64));
	const creaseAngle = Math.max(5, Math.min(170, Number(body?.crease_angle) || 40));
	const onlyPart =
		typeof body?.only_part === 'string' && PART_REF_RE.test(body.only_part.trim())
			? body.only_part.trim()
			: undefined;

	let provider;
	try {
		provider = createRegenProvider();
		if (!provider.supportsMode('segment')) return unconfigured(res);
	} catch {
		return unconfigured(res);
	}

	try {
		const job = await provider.submit({
			mode: 'segment',
			sourceUrl: meshUrl,
			params: {
				method: segMethod,
				max_parts: maxParts,
				min_part_faces: minPartFaces,
				crease_angle: creaseAngle,
				only_part: onlyPart,
			},
		});
		return json(res, 202, {
			job_id: job.extJobId,
			status: 'queued',
			method: segMethod,
			eta_seconds: job.eta,
		});
	} catch (err) {
		return json(res, 502, { error: 'segment_failed', message: err?.message || 'Segmentation could not start.' });
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
			error: 'segment_status_failed',
			message: err?.message || 'Could not read the segmentation job.',
		});
	}
	return json(res, 200, {
		job_id: jobId,
		status: result.status,
		result_url: result.resultGlbUrl || null,
		manifest_url: result.manifestUrl || null,
		parts: result.parts || null,
		part_count: result.partCount ?? null,
		source_faces: result.sourceFaces ?? null,
		method: result.segmentMethod || null,
		warnings: result.warnings || null,
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
