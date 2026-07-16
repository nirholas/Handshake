// Forge realism / quality gate — the vision-model half of "raise the floor".
//
// glb-quality.js (scoreGlbQuality) answers the CHEAP, deterministic question
// from the glTF JSON chunk alone: is this a valid, dense, textured mesh, or a
// degenerate blob? It cannot see what the mesh actually LOOKS like. This module
// answers the harder, product-facing question: does a render of this model read
// as a real photograph of a real subject, or as a plastic toy / melted blob /
// incomplete / duplicated mess a user should never be shown?
//
// It renders the GLB (or takes a render you already have), sends the image to
// Vertex Gemini vision (GCP-credit-funded, no third-party key) with a subject-
// aware photoreal rubric, and returns a structured verdict:
//   { pass, score, realism, completeness, defects, reason, suggested_retry_hint }.
//
// ── Fail-open, always ─────────────────────────────────────────────────────────
// Quality gating is a BOOST, never a hard gate. If Vertex is down, the render
// fails, the token can't be minted, or the model returns garbage, runQualityGate
// returns pass:true with qa_available:false and a "qa_unavailable" reason. A QA
// outage must never take down a working generation. The router treats a non-pass
// verdict as "try one adjusted regeneration"; it must treat qa_available:false as
// "ship what we have".
//
// ── Provider order ────────────────────────────────────────────────────────────
//   1. Vertex Gemini (gemini-2.5-flash) — the intended lane, bills GCP credits.
//   2. Platform vision chain (describeImageJson: free NVIDIA NIM VLMs) — used
//      when Vertex is unconfigured or errors, so the gate still functions off the
//      free lanes rather than silently disabling itself.
//   3. Neither available → fail-open pass with qa_available:false.
//
// ── The router seam ───────────────────────────────────────────────────────────
// The generation router (api/forge.js, owned by another agent) wires this in by:
//   const verdict = await runQualityGate({ glbUrl, prompt });
//   if (!verdict.pass && verdict.qa_available) {
//     const next = buildRetryDirective(verdict, { prompt, tier, path, attempt });
//     if (next) { /* regenerate once with next.prompt / next.tier / next.path */ }
//   }
// See the SEAM comment block at the end of this file for the copy-paste contract.

import { getGcpAccessToken } from './gcp-auth.js';
import { describeImageJson, visionConfigured, parseJsonLoose } from './vision.js';
import { renderAvatarScene, SCENE_PRESETS } from './avatar-render.js';
import { validatePublicUrl, isPrivateAddress, SsrfError } from './ssrf.js';
import { isIP } from 'node:net';

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
	return null;
}

function intEnv(name, fallback) {
	const v = readEnv(name);
	const n = v == null || v === '' ? NaN : Number(v);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Env-tunable knobs. Defaults chosen for the Forge lanes; a deployment can retune
// without a code change.
export const QUALITY_GATE_DEFAULTS = Object.freeze({
	// A verdict at or above this composite score passes the gate.
	passScore: intEnv('FORGE_QUALITY_PASS_SCORE', 60),
	// Hard cap on auto-retries per generation, so a persistently-bad prompt can
	// never burn unbounded GCP credit. attempt is 0-indexed, so 2 means the
	// original plus up to two adjusted regenerations.
	maxRetries: intEnv('FORGE_QUALITY_MAX_RETRIES', 2),
	// Vertex model + region. gemini-2.5-flash is vision-capable and serves on
	// us-central1 and global (both probed live).
	model: readEnv('VERTEX_QUALITY_MODEL') || 'gemini-2.5-flash',
	location: readEnv('GOOGLE_CLOUD_LOCATION_QUALITY') || readEnv('GOOGLE_CLOUD_LOCATION') || 'us-central1',
	// Render size for scoring. Small keeps image-token cost low while staying
	// legible enough for a realism call.
	renderSize: intEnv('FORGE_QUALITY_RENDER_SIZE', 640),
	// Per-call vision timeout.
	timeoutMs: intEnv('FORGE_QUALITY_TIMEOUT_MS', 25_000),
});

// ── Subject awareness ─────────────────────────────────────────────────────────
// The photoreal bar differs by subject: a person needs correct anatomy and skin;
// food needs appetizing surface and no plastic sheen; a vehicle needs panel gaps
// and real paint. Detecting the subject lets the rubric ask for the right cues
// and lets the retry hint steer regeneration toward them.
const SUBJECT_RULES = Object.freeze({
	person: {
		match: /\b(person|man|woman|boy|girl|human|character|warrior|knight|astronaut|soldier|king|queen|figure|portrait|avatar|face|guy|lady|ninja|wizard|hero)\b/i,
		cues: 'correct human anatomy and proportions, five fingers per hand, two eyes, symmetric face, realistic skin with pores (not plastic or waxy), one single complete body (no extra or fused limbs, no duplicated heads)',
	},
	animal: {
		match: /\b(cat|dog|horse|bird|dragon|lion|tiger|bear|wolf|fox|animal|creature|fish|snake|deer|rabbit|elephant|monster|beast)\b/i,
		cues: 'correct animal anatomy (right leg count, single head/tail), real fur/scale/feather texture, no melted or fused limbs',
	},
	food: {
		match: /\b(food|burger|pizza|cake|fruit|apple|bread|sushi|donut|coffee|drink|meal|dish|sandwich|ice cream|cookie|steak)\b/i,
		cues: 'appetizing photoreal surface, real food texture and translucency, no plastic sheen, no toy-like uniform color',
	},
	vehicle: {
		match: /\b(car|truck|vehicle|motorcycle|plane|aircraft|ship|boat|tank|bike|bus|train|rocket|helicopter)\b/i,
		cues: 'real paint with panel gaps and reflections, correct wheel/window/light placement, symmetric body, no warped or collapsed panels',
	},
	plant: {
		match: /\b(tree|plant|flower|bush|leaf|grass|cactus|fern|rose|palm|forest)\b/i,
		cues: 'natural organic branching and leaf texture, real botanical silhouette, no fused or repeating geometry',
	},
	building: {
		match: /\b(house|building|castle|tower|church|temple|bridge|structure|architecture|room|shop|store|hut|cabin)\b/i,
		cues: 'straight structural lines, real material texture (brick/wood/stone/glass), coherent architecture, no floating or collapsed sections',
	},
	object: {
		match: /.*/,
		cues: 'real PBR-looking materials (metal/wood/fabric/leather read as their true material, not flat plastic), complete single object, correct proportions, no melted or blobby geometry',
	},
});

// Resolve a subject category from an explicit hint or the prompt text. Falls back
// to the generic "object" bar, which every asset must at least clear.
export function subjectFromPrompt(prompt, hint = null) {
	if (hint && SUBJECT_RULES[hint]) return hint;
	const text = String(prompt || '');
	for (const key of ['person', 'animal', 'food', 'vehicle', 'plant', 'building']) {
		if (SUBJECT_RULES[key].match.test(text)) return key;
	}
	return 'object';
}

// Build the rubric prompt sent to the vision model. Subject-aware, and it demands
// a strict JSON reply so the parse is reliable (VLMs honor "reply ONLY JSON").
function rubricPrompt(subject, prompt) {
	const rule = SUBJECT_RULES[subject] || SUBJECT_RULES.object;
	const promptLine = prompt
		? `The model was generated from this request: "${String(prompt).slice(0, 400)}".`
		: 'No source prompt was provided.';
	return [
		'You are a strict quality inspector for an AI 3D-model generator. You are shown a render of ONE generated 3D model.',
		promptLine,
		`This model is a ${subject}. For this subject, a good result shows: ${rule.cues}.`,
		'',
		'OUR BAR is photoreal: the render should look like a real photograph of a real physical object or being, not a video-game asset, not a plastic toy, not a clay sculpt.',
		'',
		'Reject (low score) any of these failure modes if present: blobby/melted/undefined geometry; a plastic or toy-like look when the subject should be real; incomplete or partial mesh (missing parts, holes, cut-off body); duplicated or fused parts (two heads, extra limbs, merged copies); floating disconnected fragments; garbled or smeared textures; flat untextured gray/white surfaces; wildly wrong proportions.',
		'',
		'Reply with ONLY this JSON object and nothing else:',
		'{',
		'  "score": <int 0-100, overall how photoreal and correct this is>,',
		'  "realism": <int 0-100, how photographic vs toy/plastic/CG the materials and shading look>,',
		'  "completeness": <int 0-100, how complete and single-subject the geometry is (100 = one whole subject, low = missing/partial/duplicated/fragmented)>,',
		'  "is_photoreal": <true|false>,',
		'  "subject_detected": "<what you actually see>",',
		'  "defects": [<zero or more short tags from: blob, melted, plastic, toy, incomplete, partial, holes, duplicated, fused, extra_limbs, floating_fragments, garbled_texture, untextured, wrong_proportions, low_detail>],',
		'  "reason": "<one concrete sentence on the main quality issue, or why it is good>",',
		'  "retry_hint": "<one short instruction to improve a regeneration, or empty string if it is already good>"',
		'}',
	].join('\n');
}

// Clamp a value into a 0-100 integer, or null when it is not a finite number.
function score100(v) {
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return Math.max(0, Math.min(100, Math.round(n)));
}

// SSRF guard for a caller-supplied render URL we fetch server-side. Mirrors the
// guard in vision.js: require https (http only in dev) and reject private IP
// literals + localhost. DNS-name hosts pass (we can't pin resolution here).
function assertSafeUrl(rawUrl) {
	let url;
	try {
		url = validatePublicUrl(rawUrl);
	} catch (e) {
		if (e instanceof SsrfError) throw Object.assign(new Error('render URL is not a public https address'), { code: 'invalid_url' });
		throw e;
	}
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const fam = isIP(host);
	const blocked = fam ? isPrivateAddress(host, fam) : host === 'localhost' || /\.(local|internal|localdomain)$/i.test(host);
	if (blocked) throw Object.assign(new Error('render URL resolves to a non-public host'), { code: 'invalid_url' });
	return url;
}

// Fetch an image URL and return { base64, mimeType }. Guarded + size-capped.
async function fetchImageBase64(rawUrl, timeoutMs) {
	assertSafeUrl(rawUrl);
	const res = await fetch(rawUrl, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`render fetch ${res.status}`);
	const ct = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.byteLength > 16 * 1024 * 1024) throw new Error('render image exceeds 16 MB');
	return { base64: buf.toString('base64'), mimeType: ct.startsWith('image/') ? ct : 'image/png' };
}

// Render a GLB to a PNG and return { base64, mimeType }. Uses the shared headless
// pipeline (avatar-render.js) with a full-body framing on a neutral dark
// background so the whole subject is judged, not a cropped portrait.
async function renderGlbBase64(glbUrl, size) {
	assertSafeUrl(glbUrl);
	const { png } = await renderAvatarScene({
		glbUrl,
		width: size,
		height: size,
		background: '#101014',
		scenePreset: SCENE_PRESETS['full-body'],
	});
	return { base64: Buffer.from(png).toString('base64'), mimeType: 'image/png' };
}

// Resolve a GCP OAuth bearer token. Primary path is the shared service-account /
// metadata-server minter (production Cloud Run). As an additive fallback for
// environments where an ambient gcloud token is exported (local verification,
// CI shells), accept GOOGLE_ACCESS_TOKEN / GCLOUD_ACCESS_TOKEN. Never logged.
async function resolveGcpToken() {
	try {
		return await getGcpAccessToken();
	} catch (e) {
		const ambient = readEnv('GOOGLE_ACCESS_TOKEN') || readEnv('GCLOUD_ACCESS_TOKEN');
		if (ambient) return ambient.trim();
		throw e;
	}
}

// True when the Vertex Gemini lane can be attempted (GCP project configured).
export function vertexQualityConfigured() {
	return Boolean(readEnv('GOOGLE_CLOUD_PROJECT'));
}

// True when the gate can score at all — Vertex OR the free platform vision chain.
// Use to decide whether to bother rendering (a cheap pre-check the router can run).
export function qualityGateConfigured() {
	return vertexQualityConfigured() || visionConfigured();
}

// Score one render via Vertex Gemini. Returns { json, provider, model } or throws.
async function scoreViaVertex({ imageBase64, mimeType, prompt, subject, timeoutMs }) {
	const project = readEnv('GOOGLE_CLOUD_PROJECT');
	if (!project) throw Object.assign(new Error('GOOGLE_CLOUD_PROJECT unset'), { code: 'unconfigured' });
	const location = QUALITY_GATE_DEFAULTS.location;
	const model = QUALITY_GATE_DEFAULTS.model;
	const token = await resolveGcpToken();
	const host = location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
	const endpoint = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

	const body = {
		contents: [
			{
				role: 'user',
				parts: [
					{ text: rubricPrompt(subject, prompt) },
					{ inlineData: { mimeType, data: imageBase64 } },
				],
			},
		],
		generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 700 },
	};

	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw Object.assign(new Error(`vertex ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
	}
	const data = await res.json();
	const parts = data?.candidates?.[0]?.content?.parts || [];
	const text = parts.map((p) => p?.text || '').join('').trim();
	if (!text) {
		const reason = data?.candidates?.[0]?.finishReason;
		throw new Error(`vertex returned no text${reason ? ` (finishReason: ${reason})` : ''}`);
	}
	return { json: parseJsonLoose(text), provider: 'vertex', model: `vertex-ai/${model}` };
}

// Score one render via the free platform vision chain (NVIDIA NIM VLMs). Reuses
// describeImageJson so the free-first doctrine and spend ledger are inherited.
async function scoreViaPlatformVision({ imageBase64, mimeType, prompt, subject, timeoutMs, track }) {
	const out = await describeImageJson({
		prompt: rubricPrompt(subject, prompt),
		imageBase64,
		mimeType,
		maxTokens: 700,
		timeoutMs,
		deadlineMs: timeoutMs + 4000,
		track: { ...(track || {}), tool: 'api/_lib/forge-quality-gate' },
	});
	return { json: out.json, provider: out.provider, model: out.model };
}

// Normalize a raw model reply into the public verdict shape, applying our pass
// threshold. A model that flags a critical structural defect fails even if it
// reported a generous score, because those defects are exactly what users must
// never see.
const CRITICAL_DEFECTS = new Set(['blob', 'melted', 'incomplete', 'partial', 'holes', 'duplicated', 'fused', 'extra_limbs', 'floating_fragments']);

function normalizeVerdict(raw, { subject, provider, model, passScore, renderSource }) {
	const score = score100(raw?.score);
	const realism = score100(raw?.realism);
	const completeness = score100(raw?.completeness);
	const defects = Array.isArray(raw?.defects)
		? raw.defects.map((d) => String(d).toLowerCase().trim().replace(/\s+/g, '_')).filter(Boolean).slice(0, 12)
		: [];
	const hasCritical = defects.some((d) => CRITICAL_DEFECTS.has(d));
	const hint = typeof raw?.retry_hint === 'string' ? raw.retry_hint.trim() : '';
	// Pass requires clearing the score threshold AND not carrying a critical
	// structural defect. A null score (unparseable field) fails closed to a retry
	// only if the provider still answered; a total outage is handled upstream by
	// fail-open.
	const pass = score != null && score >= passScore && !hasCritical;
	return {
		pass,
		score,
		realism,
		completeness,
		subject,
		subject_detected: typeof raw?.subject_detected === 'string' ? raw.subject_detected.slice(0, 120) : null,
		is_photoreal: raw?.is_photoreal === true,
		defects,
		reason: typeof raw?.reason === 'string' ? raw.reason.slice(0, 400) : (pass ? 'meets the realism bar' : 'below the realism bar'),
		suggested_retry_hint: hint || (pass ? null : 'increase realism and detail; render as a real photograph of the subject'),
		provider,
		model,
		qa_available: true,
		render_source: renderSource,
	};
}

// A fail-open pass verdict, returned whenever scoring cannot run. The router MUST
// ship this (qa_available:false) rather than retry — a QA outage is not a quality
// failure of the model.
function failOpen(reason, { subject = 'object', renderSource = 'none' } = {}) {
	return {
		pass: true,
		score: null,
		realism: null,
		completeness: null,
		subject,
		subject_detected: null,
		is_photoreal: null,
		defects: [],
		reason: `qa_unavailable: ${reason}`,
		suggested_retry_hint: null,
		provider: null,
		model: null,
		qa_available: false,
		render_source: renderSource,
	};
}

/**
 * Run the realism / quality gate on a generated model.
 *
 * Provide the GLB to render, or a render you already have. Exactly one image is
 * scored: a provided renderBase64, else a fetched renderUrl, else a fresh render
 * of glbUrl.
 *
 * @param {object} opts
 * @param {string} [opts.glbUrl]        public GLB URL to render + score
 * @param {string} [opts.renderUrl]     public image URL of an existing render
 * @param {string} [opts.renderBase64]  base64 (or data: URI) of an existing render
 * @param {string} [opts.mimeType]      mime for renderBase64 (default image/png)
 * @param {string} [opts.prompt]        the source generation prompt (steers rubric + retry)
 * @param {string} [opts.subject]       explicit subject category override
 * @param {number} [opts.passScore]     override the pass threshold
 * @param {object} [opts.track]         spend-ledger attribution passed to platform vision
 * @returns {Promise<object>} verdict (never throws — fail-open on any error)
 */
export async function runQualityGate({
	glbUrl = null,
	renderUrl = null,
	renderBase64 = null,
	mimeType = 'image/png',
	prompt = null,
	subject = null,
	passScore = QUALITY_GATE_DEFAULTS.passScore,
	track = null,
} = {}) {
	const subj = subjectFromPrompt(prompt, subject);

	if (!qualityGateConfigured()) {
		return failOpen('no vision provider configured (set GOOGLE_CLOUD_PROJECT for Vertex, or NVIDIA_API_KEY for the free lane)', { subject: subj });
	}

	// 1. Obtain exactly one image to score.
	let image;
	let renderSource;
	try {
		if (renderBase64) {
			const m = String(renderBase64).match(/^data:(image\/[a-z+]+);base64,(.*)$/i);
			image = { base64: m ? m[2] : String(renderBase64).replace(/^data:[^,]*,/, ''), mimeType: m ? m[1].toLowerCase() : mimeType };
			renderSource = 'provided_base64';
		} else if (renderUrl) {
			image = await fetchImageBase64(renderUrl, QUALITY_GATE_DEFAULTS.timeoutMs);
			renderSource = 'provided_url';
		} else if (glbUrl) {
			image = await renderGlbBase64(glbUrl, QUALITY_GATE_DEFAULTS.renderSize);
			renderSource = 'rendered_glb';
		} else {
			return failOpen('no glbUrl, renderUrl, or renderBase64 supplied', { subject: subj });
		}
	} catch (e) {
		// A render / fetch failure is a QA outage, not a model failure — fail open.
		return failOpen(`could not obtain a render: ${e?.message || e}`, { subject: subj });
	}

	// 2. Score it. Vertex first, free platform vision as automatic backup.
	let scored = null;
	let lastErr = null;
	if (vertexQualityConfigured()) {
		try {
			scored = await scoreViaVertex({ ...image, prompt, subject: subj, timeoutMs: QUALITY_GATE_DEFAULTS.timeoutMs });
		} catch (e) {
			lastErr = e;
		}
	}
	if (!scored && visionConfigured()) {
		try {
			scored = await scoreViaPlatformVision({ ...image, prompt, subject: subj, timeoutMs: QUALITY_GATE_DEFAULTS.timeoutMs, track });
		} catch (e) {
			lastErr = lastErr || e;
		}
	}
	if (!scored) {
		return failOpen(`scoring failed: ${lastErr?.message || 'no provider answered'}`, { subject: subj, renderSource });
	}

	// 3. Normalize + apply the threshold.
	return normalizeVerdict(scored.json, {
		subject: subj,
		provider: scored.provider,
		model: scored.model,
		passScore,
		renderSource,
	});
}

// ── Auto-retry directive ──────────────────────────────────────────────────────

const TIER_LADDER = ['draft', 'standard', 'high'];

function nextTier(tier) {
	const i = TIER_LADDER.indexOf(tier);
	if (i < 0) return 'standard';
	return TIER_LADDER[Math.min(i + 1, TIER_LADDER.length - 1)];
}

// Turn defect tags into a short negative-guidance clause the regeneration prompt
// can carry, plus a decision on whether to switch the generation path.
function guidanceFromDefects(defects) {
	const set = new Set(defects || []);
	const avoid = [];
	if (set.has('plastic') || set.has('toy')) avoid.push('plastic or toy-like materials');
	if (set.has('blob') || set.has('melted')) avoid.push('blobby or melted geometry');
	if (set.has('incomplete') || set.has('partial') || set.has('holes')) avoid.push('missing or incomplete parts');
	if (set.has('duplicated') || set.has('fused') || set.has('extra_limbs')) avoid.push('duplicated or fused parts');
	if (set.has('floating_fragments')) avoid.push('floating disconnected fragments');
	if (set.has('garbled_texture') || set.has('untextured')) avoid.push('smeared or missing textures');
	if (set.has('wrong_proportions')) avoid.push('wrong proportions');
	// A structural defect (blob/incomplete/duplicated) is best fought with more
	// geometric budget and the image path, which grounds the mesh in a reference.
	const structural = ['blob', 'melted', 'incomplete', 'partial', 'holes', 'duplicated', 'fused', 'extra_limbs', 'floating_fragments'];
	const wantsMoreGeometry = structural.some((d) => set.has(d));
	return { avoid, wantsMoreGeometry };
}

/**
 * Given a failed verdict and the directive that produced it, build a concrete
 * adjusted directive for ONE regeneration. Returns null when a retry should not
 * happen: the verdict passed, QA was unavailable (never retry on an outage), or
 * the retry cap is reached.
 *
 * @param {object} verdict  a runQualityGate() result
 * @param {object} base     { prompt, tier, path, attempt, maxRetries }
 *   attempt is 0-indexed (0 = the original generation). The returned directive
 *   carries attempt+1. Stop when attempt+1 > maxRetries.
 * @returns {object|null} { prompt, tier, path, attempt, reason } or null
 */
export function buildRetryDirective(verdict, base = {}) {
	if (!verdict || verdict.pass || verdict.qa_available === false) return null;
	const maxRetries = Number.isFinite(base.maxRetries) ? base.maxRetries : QUALITY_GATE_DEFAULTS.maxRetries;
	const attempt = Number.isFinite(base.attempt) ? base.attempt : 0;
	const nextAttempt = attempt + 1;
	if (nextAttempt > maxRetries) return null;

	const { avoid, wantsMoreGeometry } = guidanceFromDefects(verdict.defects);
	const basePrompt = String(base.prompt || '').trim();
	const hint = verdict.suggested_retry_hint ? ` ${verdict.suggested_retry_hint.trim()}` : '';
	const avoidClause = avoid.length ? ` Avoid: ${avoid.join(', ')}.` : '';
	// Append photoreal steering to the original prompt without discarding it, so
	// the subject stays intact while the realism bar is pushed.
	const prompt = `${basePrompt}, photorealistic, real photograph, high detail, accurate proportions, realistic PBR materials.${avoidClause}${hint}`.trim();

	const tier = wantsMoreGeometry ? nextTier(base.tier || 'standard') : (base.tier || 'standard');
	// Switch to the image path on a structural failure: a reference image grounds
	// the reconstruction and cuts blob/duplication failure modes. Leave a non-
	// structural (material-only) failure on its current path — a tighter prompt
	// alone usually fixes plastic/toy looks.
	const path = wantsMoreGeometry ? 'image' : (base.path || 'image');

	return {
		prompt,
		tier,
		path,
		attempt: nextAttempt,
		reason: `retry ${nextAttempt}/${maxRetries}: ${verdict.reason || 'below realism bar'}`,
	};
}

// ── ROUTER SEAM (copy-paste contract for api/forge.js, owned by another agent) ──
//
// After a generation produces { glb_url } and BEFORE returning it to the user,
// the router can gate + auto-retry like this (fail-open by construction):
//
//   import { runQualityGate, buildRetryDirective, QUALITY_GATE_DEFAULTS } from './_lib/forge-quality-gate.js';
//
//   let directive = { prompt, tier, path, attempt: 0, maxRetries: QUALITY_GATE_DEFAULTS.maxRetries };
//   let result = await generateOnce(directive);              // existing generation call
//   let verdict = await runQualityGate({ glbUrl: result.glb_url, prompt: directive.prompt });
//
//   while (!verdict.pass && verdict.qa_available) {
//     const next = buildRetryDirective(verdict, directive);  // null when cap reached
//     if (!next) break;
//     directive = next;
//     result = await generateOnce(directive);                // regenerate with adjusted directive
//     verdict = await runQualityGate({ glbUrl: result.glb_url, prompt: directive.prompt });
//   }
//   // Ship `result` regardless. Attach `verdict` to creation metadata for observability.
//   // verdict.qa_available === false  → QA outage, ship as-is, do NOT retry.
//   // verdict.pass === false && cap hit → best effort shipped; the verdict explains why.
