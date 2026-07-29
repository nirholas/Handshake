// @ts-check
// Automated quality gate for platform-seeded catalog content.
//
// Both seeding paths share this module so the bar is identical wherever an
// asset enters the public catalog:
//   • api/cron/forge-seed-cron.js  — the per-minute trickle, in-process on
//     Cloud Run (Vertex reachable via the attached service account).
//   • scripts/gcp/seed-avatars.mjs — the bulk batch runner, driven from a
//     workstation with no GCP credentials, so it routes render + judge through
//     the production HTTP surfaces instead.
//
// Two stages, cheapest first:
//
//   1. MESH SANITY (free, deterministic, no network beyond the GLB fetch).
//      Reuses scoreGlbQuality (api/_lib/glb-quality.js), the same scorer the
//      interactive forge flow already trusts, and adds catalog-specific bounds:
//      vertex-count floor/ceiling and "must carry a texture". A degenerate blob
//      never reaches a vision model — it is rejected here for a tenth of a cent.
//
//   2. VISION JUDGE (Vertex Gemini). Renders the mesh and asks the judge two
//      questions: the realism/geometry scoring from the realism eval harness
//      (judgeOnce, api/_lib/quality-bench.js — imported, never forked, so the
//      catalog gate and the regression bench can never disagree about what a
//      score means) plus a catalog-specific rig-readiness check ("is this one
//      complete humanoid with separated limbs, or a bust / a blob / a crowd?").
//
// Rejects are never published. They are copied to the `forge/rejected/` prefix
// with a JSON sidecar carrying the full verdict, so prompt and threshold tuning
// works off real failures instead of guesses.

import { scoreGlbQuality } from './glb-quality.js';
import { inspectGlb } from './glb-inspect.js';
import { judgeOnce, JUDGE_MODEL, RENDER_BACKGROUND } from './quality-bench.js';
import { vertexGeminiAvailable, vertexGeminiChatUrl, vertexGeminiHeaders } from './vertex-gemini.js';
import { copyObject, putObject } from './r2.js';

// Bumped whenever a threshold or judge prompt changes, and stored on every
// verdict — an accept rate is only comparable within one gate version.
export const SEED_GATE_VERSION = 1;

function numEnv(name, fallback) {
	const raw = typeof process !== 'undefined' ? process.env?.[name] : null;
	const n = raw == null || raw === '' ? NaN : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Catalog bounds, on top of the forge-wide QUALITY_THRESHOLDS. Deliberately
// stricter than the interactive flow: a user who generates a coarse mesh chose
// to, a catalog entry nobody asked for has to earn its slot.
export const SEED_MESH_BOUNDS = Object.freeze({
	minVertices: numEnv('SEED_GATE_MIN_VERTICES', 1_500),
	maxVertices: numEnv('SEED_GATE_MAX_VERTICES', 1_500_000),
	minBytes: numEnv('SEED_GATE_MIN_BYTES', 20_000),
	// A rigged avatar with blendshapes legitimately runs tens of MB; the ceiling
	// only catches runaway output that would break the viewer's fetch budget.
	maxBytes: numEnv('SEED_GATE_MAX_BYTES', 80 * 1024 * 1024),
	requireTexture: (process?.env?.SEED_GATE_REQUIRE_TEXTURE ?? '1') !== '0',
});

// Vision thresholds, 1-10 on the shared realism-bench scale.
export const SEED_JUDGE_THRESHOLDS = Object.freeze({
	minGeometryIntegrity: numEnv('SEED_GATE_MIN_GEOMETRY', 5),
	minPromptAdherence: numEnv('SEED_GATE_MIN_ADHERENCE', 5),
	minMean: numEnv('SEED_GATE_MIN_MEAN', 4.5),
});

// ── Stage 1: mesh sanity ─────────────────────────────────────────────────────

/**
 * Deterministic structural gate over the GLB bytes.
 * @param {Buffer|Uint8Array} buf
 * @param {{ category?: string }} [opts]
 */
export function gateMesh(buf, { category = 'avatar' } = {}) {
	const quality = scoreGlbQuality(buf);
	const inspected = inspectGlb(buf);
	const reasons = [];
	const b = SEED_MESH_BOUNDS;

	if (!quality.valid) {
		return {
			pass: false,
			reasons: ['not_valid_glb'],
			quality,
			rigged: false,
			metrics: quality.metrics,
		};
	}
	if (quality.flag === 'degenerate') reasons.push(...quality.reasons);

	const m = quality.metrics;
	if (m.vertexCount < b.minVertices) reasons.push('vertices_below_floor');
	if (m.vertexCount > b.maxVertices) reasons.push('vertices_above_ceiling');
	if (m.sizeBytes < b.minBytes) reasons.push('file_too_small');
	if (m.sizeBytes > b.maxBytes) reasons.push('file_too_large');
	if (b.requireTexture && !m.hasTextures) reasons.push('no_textures');
	// A collapsed bounding box passes triangle counts but renders as a speck.
	if (!(m.bboxDiagonal > 0)) reasons.push('zero_volume');
	// Props may be a loose collection of parts; a catalog avatar that arrives as
	// a dozen disconnected meshes is a scene, not a character.
	if (category === 'avatar' && m.meshCount > 8) reasons.push('too_many_meshes_for_a_character');

	return {
		pass: reasons.length === 0,
		reasons,
		quality,
		rigged: Boolean(inspected?.isRigged),
		jointCount: inspected?.skeletonJointCount ?? 0,
		metrics: m,
	};
}

// ── Stage 2: vision judge ────────────────────────────────────────────────────

// Catalog-specific question the realism bench does not ask: can this asset be
// rigged and animated at all? Answered as strict JSON so the gate is a decision,
// not a paragraph to interpret.
export function buildRigReadinessPrompt({ prompt, category }) {
	const subject =
		category === 'accessory'
			? 'a single wearable / carried object or a sculpted display prop (NOT a character)'
			: 'exactly one complete humanoid character, whole body from head to feet';
	return `You are inspecting one rendered view of a 3D asset generated for a public asset catalog.

The asset was requested as: "${prompt}"
It is expected to be: ${subject}

Answer these checks about what you actually see, not what was requested:
- subjectPresent: is the intended subject clearly recognisable at all?
- singleSubject: is there exactly one subject (not a crowd, not a duplicated figure, not a scene)?
- complete: is the subject whole — for a character, head, torso, both arms and both legs down to the feet are present (a waist-up bust or a headless torso is NOT complete); for an object, no missing half.
- limbsSeparated: for a character, are the arms clear of the torso and the legs distinguishable from each other (fused/melted limbs fail)? For an object, answer true.
- blob: is it an amorphous blob or unrecognisable mass?

Reply with ONLY a JSON object, no markdown fence, no prose:
{"subjectPresent": <true|false>, "singleSubject": <true|false>, "complete": <true|false>, "limbsSeparated": <true|false>, "blob": <true|false>, "note": "<one short sentence naming the decisive detail>"}`;
}

function parseJsonReply(text) {
	const trimmed = String(text || '')
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '');
	const start = trimmed.search(/[{[]/);
	return JSON.parse(start >= 0 ? trimmed.slice(start) : trimmed);
}

function normalizeRigReadiness(parsed) {
	const bool = (v) => v === true || v === 'true';
	return {
		subjectPresent: bool(parsed?.subjectPresent),
		singleSubject: bool(parsed?.singleSubject),
		complete: bool(parsed?.complete),
		limbsSeparated: bool(parsed?.limbsSeparated),
		blob: bool(parsed?.blob),
		note: typeof parsed?.note === 'string' ? parsed.note.slice(0, 300) : '',
	};
}

// In-process rig-readiness call against the same Vertex Gemini client the
// realism bench uses (vertex-gemini.js) — one client, one auth path, one place
// a Vertex change has to be made.
async function rigReadinessVertex({ png, prompt, category }) {
	if (!vertexGeminiAvailable()) {
		throw Object.assign(new Error('Vertex Gemini unavailable: GOOGLE_CLOUD_PROJECT is not set'), {
			code: 'judge_unconfigured',
		});
	}
	const headers = await vertexGeminiHeaders();
	const body = {
		model: JUDGE_MODEL,
		temperature: 0,
		max_tokens: 300,
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: buildRigReadinessPrompt({ prompt, category }) },
					{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
				],
			},
		],
	};
	const res = await fetch(vertexGeminiChatUrl(), { method: 'POST', headers, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`rig-readiness call ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
	return normalizeRigReadiness(parseJsonReply(data?.choices?.[0]?.message?.content || ''));
}

/**
 * In-process transport: render with the shared headless renderer, judge with
 * Vertex. Used by the cron (and by anything else running with GCP credentials).
 */
export function inProcessTransport() {
	return {
		name: 'in-process',
		async render({ glbUrl, width = 768, height = 768, theta = 0, phi = 78 }) {
			const { renderClip } = await import('./render-clip.js');
			const { png } = await renderClip({
				glbUrl,
				width,
				height,
				background: RENDER_BACKGROUND,
				cameraOrbit: { theta, phi },
			});
			return png;
		},
		async judgeRealism({ png, prompt, viewLabel }) {
			return judgeOnce({
				png,
				promptEntry: { prompt, subjectClass: 'catalog-seed', watch: SEED_WATCHLIST },
				viewLabel,
			});
		},
		async judgeRigReadiness({ png, prompt, category }) {
			return rigReadinessVertex({ png, prompt, category });
		},
	};
}

// Failure modes the realism judge should look for on generated catalog content.
// Passed through judgeOnce's `watch` slot (the bench's own subject watchlists
// live in data/quality-bench; this is the seeding-specific one).
export const SEED_WATCHLIST = Object.freeze([
	'fused or melted limbs, arms welded to the torso',
	'a bust or half-body result where a full standing figure was requested',
	'duplicated or extra limbs, two heads, a second figure fused to the first',
	'hands collapsed into mittens or fingers fused into a single mass',
	'flat untextured grey surfaces where material detail was requested',
	'a floor slab, plinth, or background plane fused into the subject',
]);

/**
 * Remote transport: renders through POST /api/render/avatar-clip and judges
 * through POST /api/vision on the live platform. Lets the batch runner enforce
 * the identical gate from a machine with no GCP credentials, using the same
 * production vision chain (whose last rung is the same Vertex Gemini anchor).
 *
 * @param {{ origin: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function remoteTransport({ origin, fetchImpl = fetch, timeoutMs = 120_000 }) {
	const base = String(origin || '').replace(/\/+$/, '');

	async function visionAsk({ png, prompt }) {
		const res = await fetchImpl(`${base}/api/vision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				image: png.toString('base64'),
				prompt,
				maxTokens: 700,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`vision ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
		return String(data?.text || '');
	}

	return {
		name: 'remote',
		async render({ glbUrl, width = 768, height = 768, theta = 0, phi = 78 }) {
			const res = await fetchImpl(`${base}/api/render/avatar-clip`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					glbUrl,
					width,
					height,
					background: RENDER_BACKGROUND,
					cameraOrbit: { theta, phi },
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				const detail = await res.text().catch(() => '');
				throw new Error(`render ${res.status}: ${detail.slice(0, 200)}`);
			}
			return Buffer.from(await res.arrayBuffer());
		},
		async judgeRealism({ png, prompt, viewLabel }) {
			const { buildJudgePrompt } = await import('./quality-bench.js');
			const text = await visionAsk({
				png,
				prompt: buildJudgePrompt({
					prompt,
					subjectClass: 'catalog-seed',
					watch: SEED_WATCHLIST,
					viewLabel,
				}),
			});
			const parsed = parseJsonReply(text);
			const out = {};
			for (const k of ['photorealism', 'geometryIntegrity', 'textureFidelity', 'promptAdherence']) {
				const n = Number(parsed[k]);
				if (!Number.isFinite(n)) throw new Error(`judge reply missing numeric ${k}`);
				out[k] = Math.max(1, Math.min(10, n));
			}
			out.critique = typeof parsed.critique === 'string' ? parsed.critique : '';
			return out;
		},
		async judgeRigReadiness({ png, prompt, category }) {
			const text = await visionAsk({ png, prompt: buildRigReadinessPrompt({ prompt, category }) });
			return normalizeRigReadiness(parseJsonReply(text));
		},
	};
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export function scoreMean(scores) {
	const dims = ['photorealism', 'geometryIntegrity', 'textureFidelity', 'promptAdherence'];
	return dims.reduce((s, d) => s + Number(scores?.[d] || 0), 0) / dims.length;
}

/**
 * Turn the two judge replies into an accept/reject decision. Pure — unit
 * testable without a GPU, a browser, or a model.
 */
export function decideVisionVerdict({ realism, rigReadiness, category }) {
	const reasons = [];
	const t = SEED_JUDGE_THRESHOLDS;

	if (rigReadiness) {
		if (rigReadiness.blob) reasons.push('vision_blob');
		if (!rigReadiness.subjectPresent) reasons.push('vision_subject_missing');
		if (!rigReadiness.singleSubject) reasons.push('vision_multiple_subjects');
		if (!rigReadiness.complete) reasons.push('vision_incomplete_body');
		if (category !== 'accessory' && !rigReadiness.limbsSeparated) reasons.push('vision_fused_limbs');
	}

	let mean = null;
	if (realism) {
		mean = scoreMean(realism);
		if (realism.geometryIntegrity < t.minGeometryIntegrity) reasons.push('geometry_below_floor');
		if (realism.promptAdherence < t.minPromptAdherence) reasons.push('prompt_adherence_below_floor');
		if (mean < t.minMean) reasons.push('mean_score_below_floor');
	}

	return { pass: reasons.length === 0, reasons, mean };
}

/**
 * Full gate: mesh sanity, then (when a transport is supplied) render + judge.
 *
 * Never throws for a judge/render failure — an infrastructure problem must not
 * be recorded as a quality reject, so the verdict carries `vision.status` and
 * the mesh decision stands on its own. Fail-closed on mesh, fail-soft-with-flag
 * on vision: a mesh-degenerate asset is never published; a mesh-clean asset
 * whose judge could not be reached is published and marked `vision_unavailable`
 * so the accept-rate maths stays honest.
 *
 * @param {{
 *   glbBuffer: Buffer|Uint8Array,
 *   glbUrl?: string|null,
 *   prompt: string,
 *   category?: string,
 *   transport?: { render: Function, judgeRealism: Function, judgeRigReadiness: Function, name?: string }|null,
 *   views?: Array<{ label: string, theta: number, phi: number }>,
 * }} args
 */
export async function evaluateSeedAsset({
	glbBuffer,
	glbUrl = null,
	prompt,
	category = 'avatar',
	transport = null,
	views = [{ label: 'front', theta: 0, phi: 78 }],
}) {
	const startedAt = Date.now();
	const mesh = gateMesh(glbBuffer, { category });

	/** @type {{ status: string, error?: string, realism?: any, rigReadiness?: any, mean?: number|null, viewLabel?: string }} */
	const vision = { status: 'skipped' };
	let visionDecision = { pass: true, reasons: [], mean: null };

	if (mesh.pass && transport && glbUrl) {
		const view = views[0];
		try {
			const png = await transport.render({ glbUrl, theta: view.theta, phi: view.phi });
			const [realism, rigReadiness] = await Promise.all([
				transport.judgeRealism({ png, prompt, viewLabel: view.label }),
				transport.judgeRigReadiness({ png, prompt, category }),
			]);
			visionDecision = decideVisionVerdict({ realism, rigReadiness, category });
			vision.status = 'judged';
			vision.realism = realism;
			vision.rigReadiness = rigReadiness;
			vision.mean = visionDecision.mean;
			vision.viewLabel = view.label;
		} catch (err) {
			vision.status = 'unavailable';
			vision.error = String(err?.message || err).slice(0, 300);
		}
	} else if (mesh.pass && transport && !glbUrl) {
		vision.status = 'unavailable';
		vision.error = 'no public glb url to render';
	}

	const reasons = [...mesh.reasons, ...visionDecision.reasons];
	return {
		gateVersion: SEED_GATE_VERSION,
		accepted: mesh.pass && visionDecision.pass,
		reasons,
		mesh: {
			pass: mesh.pass,
			reasons: mesh.reasons,
			flag: mesh.quality.flag,
			score: mesh.quality.score,
			rigged: mesh.rigged,
			jointCount: mesh.jointCount,
			metrics: mesh.metrics,
		},
		vision,
		transport: transport?.name || null,
		durationMs: Date.now() - startedAt,
	};
}

// ── Reject quarantine ────────────────────────────────────────────────────────

export const REJECTED_PREFIX = 'forge/rejected/';

/**
 * Move a failed asset out of the publishable namespace and record why.
 *
 * Copies (never moves) the GLB so the original creation row stays coherent for
 * the owner-facing forge history, and writes `<id>.reason.json` beside it with
 * the whole verdict — that sidecar is the tuning dataset for thresholds and
 * prompt wording.
 *
 * @param {{ id: string, glbKey?: string|null, glbUrl?: string|null, prompt: string,
 *           category?: string, verdict: object, extra?: object }} args
 */
export async function quarantineReject({ id, glbKey = null, glbUrl = null, prompt, category = 'avatar', verdict, extra = {} }) {
	const safeId = String(id || '').replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';
	const modelKey = `${REJECTED_PREFIX}${safeId}.glb`;
	const reasonKey = `${REJECTED_PREFIX}${safeId}.reason.json`;
	const out = { modelKey, reasonKey, modelCopied: false };

	try {
		if (glbKey && !/^https?:\/\//i.test(glbKey)) {
			await copyObject({ fromKey: glbKey, toKey: modelKey });
			out.modelCopied = true;
		} else if (glbUrl) {
			const res = await fetch(glbUrl, { signal: AbortSignal.timeout(60_000) });
			if (res.ok) {
				await putObject({
					key: modelKey,
					body: Buffer.from(await res.arrayBuffer()),
					contentType: 'model/gltf-binary',
				});
				out.modelCopied = true;
			}
		}
	} catch (err) {
		out.modelError = String(err?.message || err).slice(0, 300);
	}

	await putObject({
		key: reasonKey,
		body: Buffer.from(
			JSON.stringify(
				{
					id: safeId,
					prompt,
					category,
					rejected_at: new Date().toISOString(),
					gate_version: SEED_GATE_VERSION,
					reasons: verdict?.reasons || [],
					verdict,
					...extra,
				},
				null,
				2,
			),
		),
		contentType: 'application/json',
	});

	return out;
}
