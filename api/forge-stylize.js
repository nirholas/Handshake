/**
 * /api/forge-stylize — one-click geometric stylization for the forge pipeline.
 *
 *   POST /api/forge-stylize  {
 *     mesh_url: string,
 *     style?: "voxel"|"brick"|"voronoi"|"lowpoly",
 *     resolution?: number,                 // style-specific density (clamped)
 *     output_format?: "glb"|"obj"|"stl"|"ply"
 *   } → 202 { job_id, status, style, resolution }
 *
 *   GET  /api/forge-stylize?job=<id>
 *     → { job_id, status, result_url?, face_count?, error? }
 *
 * Routes to workers/stylize (GCP Cloud Run) when GCP_STYLIZE_URL is set.
 * The same filter set is exposed to agents over MCP (stylize_model) and the
 * worker's GET /styles endpoint documents each filter's density knob.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { assertPublicHttpsUrl, SsrfError } from './_lib/ssrf.js';
import { createRegenProvider } from './_providers/gcp.js';

// Provider job ids are base64url JSON envelopes (packJobId in _providers/gcp.js)
// and run several hundred chars — a 64-char cap 400s every poll.
const JOB_ID_RE = /^[A-Za-z0-9_-]{20,600}$/;
const VALID_FORMATS = new Set(['glb', 'obj', 'stl', 'ply']);

// Density bounds per filter — kept in lockstep with workers/stylize STYLE_CATALOG
// and src/shared/stylize-filters.js. The worker re-clamps server-side; clamping
// here too keeps the API honest and avoids a pointless round-trip on bad input.
const STYLE_BOUNDS = {
	voxel: { def: 32, min: 8, max: 96 },
	brick: { def: 24, min: 8, max: 64 },
	voronoi: { def: 48, min: 12, max: 120 },
	lowpoly: { def: 40, min: 8, max: 120 },
};

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Stylization is not configured. Set GCP_STYLIZE_URL and GCP_RECONSTRUCTION_KEY ' +
			'to the URL and bearer secret of your deployed workers/stylize Cloud Run service.',
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

	const style = STYLE_BOUNDS[body?.style] ? body.style : 'voxel';
	const bounds = STYLE_BOUNDS[style];
	const outputFormat = VALID_FORMATS.has(body?.output_format) ? body.output_format : 'glb';
	const requested = Number(body?.resolution);
	const resolution = Number.isFinite(requested)
		? Math.max(bounds.min, Math.min(bounds.max, Math.round(requested)))
		: bounds.def;

	let provider;
	try {
		provider = createRegenProvider();
		if (!provider.supportsMode('stylize')) return unconfigured(res);
	} catch {
		return unconfigured(res);
	}

	try {
		const job = await provider.submit({
			mode: 'stylize',
			sourceUrl: meshUrl,
			params: { style, resolution, output_format: outputFormat },
		});
		return json(res, 202, {
			job_id: job.extJobId,
			status: 'queued',
			style,
			resolution,
			output_format: outputFormat,
			eta_seconds: job.eta,
		});
	} catch (err) {
		return json(res, 502, { error: 'stylize_failed', message: err?.message || 'Stylization could not start.' });
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
		result_url: result.resultGlbUrl || null,
		face_count: result.faceCount || null,
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
