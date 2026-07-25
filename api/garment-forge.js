/**
 * /api/garment-forge: text prompt → published wardrobe garment.
 *
 *   POST /api/garment-forge  {
 *     prompt: string,   // "a white oxford cotton dress shirt, long sleeves"
 *     slot: string      // top | bottom | footwear | outerwear | hair |
 *   }                   // headwear | glasses | accessory
 *     → 202 { job_id, status, eta_seconds }
 *
 *   GET  /api/garment-forge?job=<id>
 *     → { job_id, status, stage, glb_url?, manifest_url?, thumb_url?,
 *         coverage?, occludes?, garment_id?, error? }
 *
 * Thin authenticated proxy over the workers/garment-forge Cloud Run service
 * (see its README for the pipeline: Vertex reference image → GPU mesh fleet →
 * compose on the canonical body → model-rig → strip/validate → publish). A
 * finished job is ALREADY live in the public wardrobe catalog
 * (src/garment-catalog.js) when this endpoint reports done — the closet's next
 * catalog refresh shows it with no extra step.
 *
 * Uses the same free-lane rate limits as the other generation endpoints; the
 * worker's bearer secret never leaves the server.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';

const GARMENT_SLOTS = [
	'top', 'bottom', 'footwear', 'outerwear', 'hair', 'headwear', 'glasses', 'accessory',
];
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The full pipeline (image → mesh on the GPU fleet → rig → publish) runs
// about 7 minutes at the high tier; surfaced so clients can pace their polls.
const ETA_SECONDS = 450;

function config() {
	const base = (process.env.GCP_GARMENT_FORGE_URL || '').replace(/\/$/, '');
	const key = process.env.GCP_RECONSTRUCTION_KEY || '';
	return base && key ? { base, key } : null;
}

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Garment generation is not configured. Set GCP_GARMENT_FORGE_URL and ' +
			'GCP_RECONSTRUCTION_KEY to the URL and bearer secret of the deployed ' +
			'workers/garment-forge Cloud Run service.',
	});
}

async function startJob(req, res, cfg) {
	const rl = await limits.mcp3dGenerate(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req, 4_000).catch(() => null);
	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	const slot = typeof body?.slot === 'string' ? body.slot.trim() : '';
	if (prompt.length < 3 || prompt.length > 500) {
		return json(res, 400, {
			error: 'invalid_prompt',
			message: 'Describe the garment in 3–500 characters (e.g. "a white oxford dress shirt").',
		});
	}
	if (!GARMENT_SLOTS.includes(slot)) {
		return json(res, 400, {
			error: 'invalid_slot',
			message: `slot must be one of: ${GARMENT_SLOTS.join(', ')}.`,
		});
	}

	const upstream = await fetch(`${cfg.base}/generate`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${cfg.key}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ prompt, slot }),
	}).catch(() => null);
	if (!upstream || !upstream.ok) {
		return json(res, 502, {
			error: 'garment_forge_unavailable',
			message: `Garment generation could not start (worker ${upstream ? upstream.status : 'unreachable'}).`,
		});
	}
	const job = await upstream.json();
	return json(res, 202, {
		job_id: job.job_id,
		status: job.status || 'queued',
		eta_seconds: ETA_SECONDS,
	});
}

async function pollJob(req, res, cfg, jobId) {
	if (!JOB_ID_RE.test(jobId)) {
		return json(res, 400, { error: 'invalid_job', message: 'Malformed job id.' });
	}
	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const upstream = await fetch(`${cfg.base}/jobs/${jobId}`, {
		headers: { authorization: `Bearer ${cfg.key}` },
	}).catch(() => null);
	if (!upstream) {
		return json(res, 502, { error: 'garment_forge_unavailable', message: 'Worker unreachable.' });
	}
	if (upstream.status === 404) {
		return json(res, 404, { error: 'job_not_found', message: 'No such garment job.' });
	}
	if (!upstream.ok) {
		return json(res, 502, {
			error: 'garment_forge_unavailable',
			message: `Worker returned ${upstream.status}.`,
		});
	}
	const job = await upstream.json();
	// Pass through only the documented public fields — the worker record also
	// carries internal bookkeeping the client has no use for.
	return json(res, 200, {
		job_id: job.job_id,
		status: job.status,
		stage: job.stage || null,
		glb_url: job.glb_url || null,
		manifest_url: job.manifest_url || null,
		thumb_url: job.thumb_url || null,
		coverage: typeof job.coverage === 'number' ? job.coverage : null,
		occludes: Array.isArray(job.occludes) ? job.occludes : null,
		garment_id: job.garment_id || null,
		error: job.error || null,
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const cfg = config();
	if (!cfg) return unconfigured(res);

	if (req.method === 'POST') return startJob(req, res, cfg);

	const url = new URL(req.url, 'http://localhost');
	const jobId = (url.searchParams.get('job') || '').trim();
	if (!jobId) return json(res, 400, { error: 'missing_job', message: 'Pass ?job=<id> to poll.' });
	return pollJob(req, res, cfg, jobId);
});
