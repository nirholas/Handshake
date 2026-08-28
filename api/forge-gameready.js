/**
 * /api/forge-gameready — one-click engine-ready export for a forged or uploaded
 * model. Drives the workers/remesh Cloud Run service to retopologize the mesh to
 * a poly budget and bake PBR, then delivers the result in every requested format
 * (GLB for inline preview, FBX for Unity/Unreal) in a single job.
 *
 *   POST /api/forge-gameready {
 *     mesh_url: string,
 *     topology?: "quad"|"tri",        // quad → QuadriFlow retopo; tri → smart low-poly
 *     poly_budget?: number,           // 1000–500000 target faces
 *     texture_size?: 1024|2048,
 *     formats?: ("glb"|"fbx")[],      // default ["glb","fbx"]
 *     preserve_rig?: boolean          // keep the source skeleton on the FBX (skips
 *                                     // retopology for that file — original topology)
 *   } → 202 { job_id, status, topology, poly_budget, formats, preserve_rig, eta_seconds }
 *
 *   GET /api/forge-gameready?job=<id>
 *     → { job_id, status, outputs?: { glb?: {url,format}, fbx?: {url,format} },
 *         face_count?, quad_ratio?, textured?, topology?, error? }
 *
 * The worker writes one format per task, so a multi-format request fans out into
 * one remesh task per format; the job id packs every sub-task so a single poll
 * resolves them all. Finished artifacts are mirrored into our R2 bucket so the
 * download URLs are first-party and durable. Routes to workers/remesh when
 * GCP_REMESH_URL is set.
 */

import { createHash } from 'node:crypto';
import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { assertPublicHttpsUrl, SsrfError } from './_lib/ssrf.js';
import { createRegenProvider } from './_providers/gcp.js';
import { putObject, publicUrl } from './_lib/r2.js';
import { fetchUpstream } from './_lib/upstream-fetch.js';
import { requireFeatureAccess } from './_lib/require-three.js';
import {
	assertForgePurchase,
	redeemForgePurchase,
	releaseForgePurchase,
} from './_lib/forge-consumption-payment.js';
import { priceForAction } from './_lib/pricing/catalog.js';

const GAMEREADY_ACTION = 'forge.gameready';

// The complete set of codes assertForgePurchase raises deliberately to describe a
// payment (api/_lib/forge-consumption-payment.js). Every one of them is part of
// this endpoint's documented contract and is safe to hand back; anything else is
// an internal fault and is rethrown rather than echoed.
const PAYMENT_ERROR_CODES = new Set([
	'bad_request',
	'payment_invalid',
	'payment_expired',
	'payment_already_used',
]);

// The composite job id is a base64url JSON envelope packing one upstream task per
// requested format, so it is far longer than a raw worker task id.
const JOB_ID_RE = /^[A-Za-z0-9_-]{24,16000}$/;
const VALID_TOPOLOGIES = new Set(['quad', 'tri']);
const VALID_FORMATS = new Set(['glb', 'fbx']);
const VALID_TEXTURE_SIZES = new Set([1024, 2048]);
const POLY_MIN = 1_000;
const POLY_MAX = 500_000;

// quad → field-aligned QuadriFlow retopology; tri → silhouette-preserving
// quadric low-poly with UV re-unwrap + texture re-bake. Both are real worker
// pipelines (workers/remesh); neither is faked here.
const TOPOLOGY_TO_MODE = { quad: 'quad', tri: 'lowpoly' };

const CONTENT_TYPE = {
	glb: 'model/gltf-binary',
	fbx: 'application/octet-stream',
};

function unconfigured(res) {
	return json(res, 503, {
		error: 'unconfigured',
		message:
			'Game-Ready export is not configured. Set GCP_REMESH_URL and GCP_RECONSTRUCTION_KEY ' +
			'to the URL and bearer secret of your deployed workers/remesh Cloud Run service.',
	});
}

function packJob(payload) {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function unpackJob(jobId) {
	try {
		const parsed = JSON.parse(Buffer.from(jobId, 'base64url').toString('utf8'));
		return parsed && parsed.v === 1 && parsed.sub && typeof parsed.sub === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

// Translate one requested format into the remesh worker params. The GLB (and any
// other geometry format) carries the retopologized mesh. FBX optionally takes the
// rig-preserving `convert` path: retopology rebuilds geometry and so cannot keep
// skin weights, so a rigged FBX is delivered at the source topology — the honest
// trade the worker actually supports.
function workerParamsForFormat(format, { mode, polyBudget, textureSize, preserveRig }) {
	if (format === 'fbx' && preserveRig) {
		return {
			remesh_mode: 'triangle',
			operation: 'convert',
			target_faces: polyBudget,
			texture_size: textureSize,
			output_format: 'fbx',
		};
	}
	return {
		remesh_mode: mode,
		operation: 'full',
		target_faces: polyBudget,
		texture_size: textureSize,
		output_format: format,
	};
}

async function startJob(req, res) {
	const ip = clientIp(req);
	const rl = await limits.mcp3dGenerate(ip);
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	const body = await readJson(req, 4_000).catch(() => null);

	// $THREE hold-or-pay gate (Token Utility — consumption lever). The engine-ready
	// export runs the remesh GPU worker (retopology + PBR re-bake), so it's a holder
	// perk with a per-use pay path — the same model as the High-tier Forge gate. This
	// runs BEFORE any network-touching validation so a non-holder's 402 is hermetic
	// (no DNS, no worker call). A verified holder (tier pass or on-chain tier) passes;
	// a non-holder presents a settled $THREE payment instead. The payment is validated
	// here (read-only) and claimed atomically just before dispatch (paidExport below).
	let paidExport = null;
	const paymentId = typeof body?.payment_id === 'string' ? body.payment_id.trim() : '';
	const payRefId = typeof body?.ref_id === 'string' ? body.ref_id.trim() : '';
	if (paymentId && payRefId) {
		try {
			const proof = await assertForgePurchase({ action: GAMEREADY_ACTION, paymentId, refId: payRefId });
			paidExport = { paymentId, refId: payRefId, settledAt: proof.payment.settledAt };
		} catch (err) {
			// Only assertForgePurchase's own contract errors describe the payment, and
			// only those may be echoed. Anything else reaching here is infrastructure
			// (a database outage, an unexpected driver fault): rethrowing hands it to
			// wrap(), which logs it under a ref, alerts ops, and answers a sanitized
			// 5xx. Echoing it instead would both leak internals and lie to the caller,
			// telling them their settled payment is bad when the database is simply down.
			if (!PAYMENT_ERROR_CODES.has(err?.code)) throw err;
			let usd = null;
			try {
				usd = Number(priceForAction(GAMEREADY_ACTION).usd) || null;
			} catch {
				usd = null;
			}
			return json(res, err.status || 402, {
				error: err.code,
				feature: GAMEREADY_ACTION,
				pay_per_use: usd ? { action: GAMEREADY_ACTION, usd } : null,
				message: err.message || 'That $THREE payment could not be verified.',
			});
		}
	} else {
		const gate = await requireFeatureAccess(req, res, GAMEREADY_ACTION, { body });
		if (!gate.ok) return; // 402 three_hold_required already sent
	}

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

	const topology = VALID_TOPOLOGIES.has(body?.topology) ? body.topology : 'quad';
	const mode = TOPOLOGY_TO_MODE[topology];
	const polyBudget = Math.max(POLY_MIN, Math.min(POLY_MAX, Math.round(Number(body?.poly_budget) || 15_000)));
	const textureSize = VALID_TEXTURE_SIZES.has(Number(body?.texture_size)) ? Number(body.texture_size) : 1024;
	const preserveRig = body?.preserve_rig === true;

	// De-duplicate + clamp the format list to what we support; default to both.
	const requested = Array.isArray(body?.formats) ? body.formats : ['glb', 'fbx'];
	const formats = [...new Set(requested.filter((f) => VALID_FORMATS.has(f)))];
	if (formats.length === 0) {
		return json(res, 400, {
			error: 'invalid_formats',
			message: 'formats must include at least one of "glb" or "fbx".',
		});
	}

	let provider;
	try {
		provider = createRegenProvider();
		if (!provider.supportsMode('remesh')) return unconfigured(res);
	} catch {
		return unconfigured(res);
	}

	// Claim the settled $THREE payment now — immediately before dispatch — so any
	// failure above (validation, unconfigured worker) left it reusable. The atomic
	// claim (payment_id PRIMARY KEY) is the single-use source of truth: a concurrent
	// retry of the same payment loses the race and is told it was already used.
	if (paidExport) {
		const claim = await redeemForgePurchase({
			action: GAMEREADY_ACTION,
			paymentId: paidExport.paymentId,
			refId: paidExport.refId,
			settledAt: paidExport.settledAt,
		});
		if (!claim.redeemed) {
			return json(res, 409, {
				error: 'payment_already_used',
				message: 'That payment was already used for an export. Pay again to export.',
			});
		}
	}

	const sub = {};
	let maxEta = 0;
	try {
		// Fan out one worker task per format. The worker emits a single format per
		// task, so both the GLB and FBX are produced concurrently upstream.
		const submissions = await Promise.all(
			formats.map(async (format) => {
				const job = await provider.submit({
					mode: 'remesh',
					sourceUrl: meshUrl,
					params: workerParamsForFormat(format, { mode, polyBudget, textureSize, preserveRig }),
				});
				return { format, job };
			}),
		);
		for (const { format, job } of submissions) {
			sub[format] = job.extJobId;
			maxEta = Math.max(maxEta, Number(job.eta) || 0);
		}
	} catch (err) {
		// Dispatch failed before any artifact was produced — release the claim so the
		// paid user can retry without paying again.
		if (paidExport) {
			await releaseForgePurchase({ paymentId: paidExport.paymentId }).catch(() => {});
		}
		return json(res, 502, {
			error: 'gameready_failed',
			message: err?.message || 'Game-Ready export could not start.',
		});
	}

	const jobId = packJob({
		v: 1,
		topology,
		budget: polyBudget,
		preserveRig,
		// 12 hex of the source URL → a stable, collision-resistant R2 namespace so
		// re-runs overwrite rather than orphan, without leaking the full URL.
		h: createHash('sha256').update(meshUrl).digest('hex').slice(0, 12),
		sub,
	});

	return json(res, 202, {
		job_id: jobId,
		status: 'queued',
		topology,
		poly_budget: polyBudget,
		texture_size: textureSize,
		formats,
		preserve_rig: preserveRig,
		eta_seconds: maxEta || 35,
	});
}

// Copy a finished worker artifact into our R2 bucket so the download URL is
// first-party and durable. Falls back to the worker URL if R2 is unconfigured or
// the copy fails — a real, working result either way, never a faked one.
async function mirrorToR2(sourceUrl, key, format) {
	try {
		// Bounded, with one retry: the artifact is a fresh worker upload, so a
		// transient read failure is worth retrying, and a stalled one must not hold
		// the poll open. Any failure falls through to the worker URL below.
		const resp = await fetchUpstream(sourceUrl, {}, {
			name: 'worker:gameready-artifact',
			timeoutMs: 30_000,
			attempts: 2,
		});
		const buf = Buffer.from(await resp.arrayBuffer());
		await putObject({
			key,
			body: buf,
			contentType: CONTENT_TYPE[format] || 'application/octet-stream',
			metadata: { source: 'forge-gameready' },
		});
		return { url: publicUrl(key), bytes: buf.length };
	} catch {
		return { url: sourceUrl, bytes: null };
	}
}

async function pollJob(req, res, jobId) {
	if (!JOB_ID_RE.test(jobId)) {
		return json(res, 400, { error: 'invalid_job', message: 'Malformed job id.' });
	}
	const job = unpackJob(jobId);
	if (!job) {
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

	const formats = Object.keys(job.sub);
	const results = await Promise.all(
		formats.map(async (format) => ({ format, result: await provider.status(job.sub[format]) })),
	);

	// Aggregate the sub-task statuses: any failure fails the whole export; the
	// export is done only when every requested format has landed.
	const failed = results.find((r) => r.result.status === 'failed');
	if (failed) {
		return json(res, 200, {
			job_id: jobId,
			status: 'failed',
			topology: job.topology,
			poly_budget: job.budget,
			error: `${failed.format.toUpperCase()} export failed: ${failed.result.error || 'unknown error'}`,
		});
	}

	const allDone = results.every((r) => r.result.status === 'done' && r.result.resultGlbUrl);
	if (!allDone) {
		const running = results.some((r) => r.result.status === 'running');
		return json(res, 200, {
			job_id: jobId,
			status: running ? 'running' : 'queued',
			topology: job.topology,
			poly_budget: job.budget,
		});
	}

	// Every format finished — mirror each artifact into R2 under the model's
	// namespace and surface the topology telemetry from the retopologized output.
	const outputs = {};
	let faceCount = null;
	let quadRatio = null;
	let textured = null;
	await Promise.all(
		results.map(async ({ format, result }) => {
			const key = `forge/gameready/${job.h}/${job.topology}-${job.budget}.${format}`;
			const mirrored = await mirrorToR2(result.resultGlbUrl, key, format);
			outputs[format] = { url: mirrored.url, format, bytes: mirrored.bytes };
			// Prefer the retopologized GLB's telemetry; a rig-preserving FBX reports
			// the source topology, which would misrepresent the delta.
			if (format !== 'fbx' || faceCount === null) {
				if (typeof result.faceCount === 'number') faceCount = result.faceCount;
				if (typeof result.quadRatio === 'number') quadRatio = result.quadRatio;
				if (typeof result.textured === 'boolean') textured = result.textured;
			}
		}),
	);

	return json(res, 200, {
		job_id: jobId,
		status: 'done',
		topology: job.topology,
		poly_budget: job.budget,
		preserve_rig: Boolean(job.preserveRig),
		outputs,
		face_count: faceCount,
		quad_ratio: quadRatio,
		textured,
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
