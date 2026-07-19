/**
 * /api/forge-remesh — mesh processing for the forge pipeline.
 *
 *   POST /api/forge-remesh  {
 *     mesh_url: string,
 *     remesh_mode?: "triangle"|"quad"|"lowpoly",
 *     operation?: "full"|"simplify"|"repair"|"convert",   // triangle mode only
 *     target_faces?: number,
 *     texture_size?: 512|1024|2048,
 *     output_format?: "glb"|"obj"|"stl"|"ply"|"usdz"|"3mf"|"fbx"
 *   } → 202 { job_id, status }
 *
 *   GET  /api/forge-remesh?job=<id>
 *     → { job_id, status, result_url?, texture_url?, face_count?, quad_ratio?, textured?, mode?, error? }
 *
 * Routes to workers/remesh (GCP Cloud Run) when GCP_REMESH_URL is set.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { assertPublicHttpsUrl, SsrfError } from './_lib/ssrf.js';
import { createRegenProvider } from './_providers/gcp.js';

// Provider job ids are base64url JSON envelopes (packJobId in _providers/gcp.js)
// and run several hundred chars — a 64-char cap 400s every poll.
const JOB_ID_RE = /^[A-Za-z0-9_-]{20,600}$/;
const VALID_OPERATIONS = new Set(['full', 'simplify', 'repair', 'convert']);
const VALID_FORMATS = new Set(['glb', 'obj', 'stl', 'ply', 'usdz', '3mf', 'fbx']);
const VALID_MODES = new Set(['triangle', 'quad', 'lowpoly']);
const VALID_TEXTURE_SIZES = new Set([512, 1024, 2048]);

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Mesh processing is not configured. Set GCP_REMESH_URL and GCP_RECONSTRUCTION_KEY ' +
			'to the URL and bearer secret of your deployed workers/remesh Cloud Run service.',
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

	const remeshMode = VALID_MODES.has(body?.remesh_mode) ? body.remesh_mode : 'triangle';
	const operation = VALID_OPERATIONS.has(body?.operation) ? body.operation : 'full';
	const outputFormat = VALID_FORMATS.has(body?.output_format) ? body.output_format : 'glb';
	const targetFaces = Math.max(1_000, Math.min(500_000, Number(body?.target_faces) || 50_000));
	const textureSize = VALID_TEXTURE_SIZES.has(Number(body?.texture_size))
		? Number(body.texture_size)
		: 1024;

	let provider;
	try {
		provider = createRegenProvider();
		if (!provider.supportsMode('remesh')) return unconfigured(res);
	} catch {
		return unconfigured(res);
	}

	try {
		const job = await provider.submit({
			mode: 'remesh',
			sourceUrl: meshUrl,
			params: {
				remesh_mode: remeshMode,
				operation,
				target_faces: targetFaces,
				texture_size: textureSize,
				output_format: outputFormat,
			},
		});
		return json(res, 202, {
			job_id: job.extJobId,
			status: 'queued',
			remesh_mode: remeshMode,
			operation,
			output_format: outputFormat,
			eta_seconds: job.eta,
		});
	} catch (err) {
		return json(res, 502, { error: 'remesh_failed', message: err?.message || 'Mesh processing could not start.' });
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
		texture_url: result.textureUrl || null,
		face_count: typeof result.faceCount === 'number' ? result.faceCount : null,
		quad_ratio: typeof result.quadRatio === 'number' ? result.quadRatio : null,
		textured: typeof result.textured === 'boolean' ? result.textured : null,
		mode: result.mode || null,
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
