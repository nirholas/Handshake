// Agent Identity Studio pipeline, the engine behind the paid
// /api/okx/3d/identity-studio A2MCP service (see api/_lib/okx-catalog.js).
//
// Turns a brand brief into a complete 3D identity for an AI agent:
//   brief → identity prompt (Granite director, fail-soft)
//         → textured mesh (/api/forge)
//         → humanoid auto-rig (/api/forge?action=rig)
//         → posed studio renders (/api/render/avatar-clip + sharp compositing)
//         → PFP crop (square, reads at 128px) + full-body set, persisted to R2.
//
// Every GPU/render stage is driven over the deployed three.ws HTTP surfaces,
// the exact pattern the npx MCP server (mcp-server/src/tools/_studio-core.js)
// uses, so this module behaves identically inside the Vercel function and in
// a local run (scripts/okx-identity-demo.mjs), and holds no provider keys.
//
// Job model: state lives as one JSON document in R2. create() validates the
// brief (and reference image reachability) BEFORE the transport settles the
// x402 payment, submits generation, and returns a signed job token. Each free
// identity_status poll advances the pipeline by ONE bounded step (a single
// upstream poll, or one render), so no request outlives its function budget
// and polling is what drives the job to completion. Failed generate/rig
// stages retry free up to MAX_STAGE_ATTEMPTS, the buyer pays once, for
// deliverables, not for our transient failures.

import { createHash } from 'node:crypto';
import { putObject, getObjectBuffer, publicUrl } from '../_lib/r2.js';
import { encodeJobToken, decodeJobToken } from '../_lib/forge-job-token.js';
import { assertSafePublicUrl, fetchSafePublicUrlPinned } from '../_lib/ssrf-guard.js';
import { llmComplete } from '../_lib/llm.js';
import { PRESETS } from '../../src/pose-presets.js';

const BASE = 'https://three.ws';
const JOB_PROVIDER = 'okxid';
const JOB_PREFIX = 'okx-identity/jobs';
const RENDER_PREFIX = 'okx-identity/renders';

export const MAX_BRIEF_CHARS = 2000;
const MAX_STAGE_ATTEMPTS = 3;

// The PFP pose is pinned to a neutral standing preset: the head-crop geometry
// below assumes the top of the model's alpha bounding box is the head, which
// raised-arm poses would break. Full-body poses draw from a shortlist that
// reads well as a brand identity (confident, natural stances, no floor poses).
const PFP_POSE = 'contrapposto';
const FULLBODY_POSES = [
	'hands-on-hips',
	'relaxed',
	'wave',
	'salute',
	'point',
	'fighting-stance',
	'walk-step',
	'flex',
];
const FULLBODY_COUNT = 3;
const FULLBODY_THETAS = [0, 24, -18];

const KNOWN_POSES = new Set(PRESETS.map((p) => p.id));

export const IDENTITY_DIRECTOR_INSTRUCTION =
	'You are a 3D character art director designing the visual identity of an AI agent. From the ' +
	"agent's name and brand brief, write ONE concise prompt for a text-to-3D generator that will be " +
	'auto-rigged. Describe a SINGLE full-body humanoid character that embodies the brand: body type, ' +
	'outfit, materials, colors, and one signature visual motif. Standing neutral pose, arms slightly ' +
	'away from the body, plain background. No scene, no props held across the body, no multiple ' +
	'characters, no text or logos. The brief may be in any language; ALWAYS write the prompt in ' +
	'English. Output ONLY the rewritten prompt as a single line, no preamble, no quotes.';

function pipelineError(code, message, extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}

function jobKey(id) {
	return `${JOB_PREFIX}/${id}.json`;
}

export function encodeIdentityJobToken(id) {
	return encodeJobToken({ provider: JOB_PROVIDER, kind: 'identity', taskId: id });
}

export function decodeIdentityJobToken(token) {
	const decoded = decodeJobToken(token);
	if (!decoded || decoded.provider !== JOB_PROVIDER) return null;
	return decoded.taskId;
}

async function loadState(id) {
	try {
		const buf = await getObjectBuffer(jobKey(id));
		return JSON.parse(buf.toString('utf8'));
	} catch {
		return null;
	}
}

async function saveState(state) {
	state.updatedAt = new Date().toISOString();
	await putObject({
		key: jobKey(state.id),
		body: Buffer.from(JSON.stringify(state), 'utf8'),
		contentType: 'application/json',
	});
	return state;
}

// ---------------------------------------------------------------------------
// Prompt shaping
// ---------------------------------------------------------------------------

// LLM prompt director over the in-process free-provider chain (Groq → OpenRouter
// → NVIDIA NIM via api/_lib/llm.js, the same server keys the platform funds).
// Runs in-process instead of over the deployed /api/chat SSE endpoint: this
// module executes inside the Vercel function, and a server-to-server call to
// /api/chat is anonymous, so it hits the anon rate limiter / provider gate and
// never actually reaches a model. Fail-soft: any failure (no keys configured,
// every provider down, empty completion) returns null and the deterministic
// template below takes over. Never fabricates.
async function directIdentityPrompt({ agentName, brief, styleHints }) {
	const idea =
		`Agent name: ${agentName}\nBrand brief: ${brief}` +
		(styleHints ? `\nStyle hints: ${styleHints}` : '');
	let out;
	try {
		out = await llmComplete({
			system: IDENTITY_DIRECTOR_INSTRUCTION,
			user: `Idea: ${idea}`,
			maxTokens: 200,
			timeoutMs: 30_000,
		});
	} catch {
		return null;
	}
	const refined = (out?.text || '').trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
	return refined.length >= 3 && refined.length <= 1000 ? refined : null;
}

// The generation lane's text→image encoder truncates/chokes on long prompts,
// verified against production /api/forge: ~250-char prompts generate cleanly,
// ~430-char prompts fail. Keep every prompt we send under this budget, cut at
// a word boundary.
export const MAX_GENERATION_PROMPT_CHARS = 300;
function clampPrompt(text, max = MAX_GENERATION_PROMPT_CHARS) {
	const t = String(text ?? '').trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max);
	const lastSpace = cut.lastIndexOf(' ');
	return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, '');
}

// Deterministic fallback when the director is unreachable. Forces the humanoid
// framing rigging requires, an identity brief ("a finance data agent") rarely
// names a humanoid subject, so unlike forge_avatar there is no humanoid gate
// here: the subject is BY CONSTRUCTION a humanoid character embodying the
// brief. A text-to-3D encoder wants a visual SUBJECT, not backstory, so this
// leads with the (visual) style hints and reduces the brief to its first
// sentence, the core descriptor, rather than dumping the whole narrative and
// truncating it mid-clause. Stays inside the generation prompt budget (~130
// chars of frame text leaves ~170 for hints + subject) and never leaves a
// dangling comma or half-word at a cut.
export function fallbackIdentityPrompt({ brief, styleHints }) {
	// The style hints ARE the visual direction, give them priority and their own
	// budget so a long brief can never crowd them out of the prompt.
	const hints = styleHints ? cleanClause(clampPrompt(styleHints, 90)) : '';
	// First sentence only. A Latin terminator is followed by a space; a CJK one
	// usually is not, so that branch splits on a zero-width boundary instead, or
	// a whole Chinese brief counts as one sentence and crowds out the hints.
	const raw = String(brief ?? '').trim();
	const firstSentence = raw.split(/(?<=[.!?])\s+|(?<=[。！？])\s*/)[0] || raw;
	const subject = cleanClause(
		clampPrompt(firstSentence, MAX_GENERATION_PROMPT_CHARS - 140 - (hints ? hints.length + 2 : 0)),
	);
	const visual = [subject, hints].filter(Boolean).join(', ');
	return (
		`full-body humanoid character embodying: ${visual}, standing neutral pose, ` +
		'arms slightly away from body, plain background'
	);
}

// Trim trailing sentence/clause punctuation so a clause never abuts the next
// comma-joined fragment ("…real time., deep navy" → "…real time, deep navy").
function cleanClause(text) {
	return String(text ?? '').replace(/[.,;:!?。！？、\s]+$/, '');
}

export async function shapeIdentityPrompt({ agentName, brief, styleHints }) {
	const directed = await directIdentityPrompt({ agentName, brief, styleHints });
	return {
		directed,
		effective: clampPrompt(directed || fallbackIdentityPrompt({ brief, styleHints })),
	};
}

// ---------------------------------------------------------------------------
// /api/forge client (submit / single poll / rig), adapted from the npx MCP
// server's _studio-core.js, minus the internal polling loop: this pipeline
// polls upstream once per identity_status call instead of blocking.
// ---------------------------------------------------------------------------

async function submitForge(base, payload) {
	let res;
	try {
		// The default free lane (NVIDIA NIM TRELLIS) completes SYNCHRONOUSLY,
		// the submit response can take minutes and already carry the finished
		// GLB, so the submit timeout must cover a full generation, not just an
		// enqueue ack. Async backends still return a job_id quickly.
		res = await fetch(`${base}/api/forge`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(150_000),
		});
	} catch (err) {
		throw pipelineError('provider_error', `forge unreachable: ${err?.message || err}`);
	}
	const data = await res.json().catch(() => ({}));
	if (res.status === 503) throw pipelineError('not_configured', data?.message || 'generation lane down');
	if (res.status === 429)
		throw pipelineError('rate_limited', data?.message || 'generator busy', {
			retryAfter: data?.retry_after,
		});
	if (!res.ok || !(data?.job_id || (data?.status === 'done' && data?.glb_url))) {
		throw pipelineError('provider_error', data?.message || `forge returned ${res.status}`);
	}
	return data;
}

async function pollForgeOnce(base, jobId) {
	let res;
	try {
		res = await fetch(`${base}/api/forge?job=${encodeURIComponent(jobId)}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		// A transient poll failure is not a job failure, report still-running.
		return { status: 'running', _pollError: String(err?.message || err) };
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) return { status: 'running', _pollError: `poll returned ${res.status}` };
	return data;
}

async function startRig(base, glbUrl) {
	let res;
	try {
		res = await fetch(`${base}/api/forge?action=rig`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ glb_url: glbUrl }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw pipelineError('provider_error', `rig start unreachable: ${err?.message || err}`);
	}
	const data = await res.json().catch(() => ({}));
	if (res.status === 503 || res.status === 501)
		throw pipelineError('not_configured', data?.message || 'rig lane down');
	if (res.status === 429)
		throw pipelineError('rate_limited', data?.message || 'rigger busy', {
			retryAfter: data?.retry_after,
		});
	if (!res.ok || !data?.job_id)
		throw pipelineError('provider_error', data?.message || `rig start returned ${res.status}`);
	return data;
}

// ---------------------------------------------------------------------------
// Rendering + compositing
// ---------------------------------------------------------------------------

// Studio backdrop: brand-neutral dark radial gradient matching the three.ws
// dark tokens. Rasterized by sharp from SVG so no binary asset ships.
function backdropSvg(width, height) {
	return Buffer.from(
		`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
			`<defs><radialGradient id="g" cx="50%" cy="40%" r="78%">` +
			`<stop offset="0%" stop-color="#33405c"/>` +
			`<stop offset="52%" stop-color="#1c2331"/>` +
			`<stop offset="100%" stop-color="#0d1017"/>` +
			`</radialGradient></defs>` +
			`<rect width="100%" height="100%" fill="url(#g)"/></svg>`,
		'utf8',
	);
}

async function renderTransparent(base, { glbUrl, posePresetId, theta, size = 1600 }) {
	let res;
	try {
		res = await fetch(`${base}/api/render/avatar-clip`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				glbUrl,
				width: size,
				height: size,
				background: 'transparent',
				posePresetId,
				cameraOrbit: { theta, phi: 83, radius: null },
			}),
			signal: AbortSignal.timeout(45_000),
		});
	} catch (err) {
		throw pipelineError('render_failed', `renderer unreachable: ${err?.message || err}`);
	}
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw pipelineError(
			data?.code === 'rate_limited' ? 'rate_limited' : 'render_failed',
			data?.message || `renderer returned ${res.status}`,
		);
	}
	return Buffer.from(await res.arrayBuffer());
}

// Trim the transparent render to the model's alpha bounding box. Returns the
// trimmed buffer plus its dimensions, the head-crop math keys off these.
async function trimToModel(sharp, png) {
	const trimmed = await sharp(png).trim({ threshold: 8 }).png().toBuffer({ resolveWithObject: true });
	return { buffer: trimmed.data, width: trimmed.info.width, height: trimmed.info.height };
}

// PFP: head-and-shoulders square crop from the top of the trimmed body. With
// the pinned neutral pose the bbox top IS the head; head+shoulders span
// roughly the top third of a standing humanoid, so the crop side is 36% of
// body height (clamped to body width so narrow models never over-crop).
async function composePfp(sharp, transparentPng, { outSize = 1024 }) {
	const body = await trimToModel(sharp, transparentPng);
	const side = Math.min(body.width, Math.max(64, Math.round(body.height * 0.36)));
	const left = Math.max(0, Math.round((body.width - side) / 2));
	const head = await sharp(body.buffer)
		.extract({ left, top: 0, width: side, height: Math.min(side, body.height) })
		.png()
		.toBuffer();
	// 8% breathing room around the head so the crop doesn't kiss the frame.
	const inner = Math.round(outSize * 0.84);
	const headResized = await sharp(head)
		.resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();
	const pad = Math.round((outSize - inner) / 2);
	return sharp(backdropSvg(outSize, outSize))
		.composite([{ input: headResized, left: pad, top: pad }])
		.png()
		.toBuffer();
}

// Full-body: the trimmed model composited over the backdrop in a 4:5 portrait
// frame with even margins.
async function composeFullBody(sharp, transparentPng, { outWidth = 1024, outHeight = 1280 }) {
	const body = await trimToModel(sharp, transparentPng);
	const maxW = Math.round(outWidth * 0.82);
	const maxH = Math.round(outHeight * 0.9);
	const scale = Math.min(maxW / body.width, maxH / body.height);
	const w = Math.max(1, Math.round(body.width * scale));
	const h = Math.max(1, Math.round(body.height * scale));
	const resized = await sharp(body.buffer).resize(w, h).png().toBuffer();
	return sharp(backdropSvg(outWidth, outHeight))
		.composite([{ input: resized, left: Math.round((outWidth - w) / 2), top: Math.round((outHeight - h) / 2) }])
		.png()
		.toBuffer();
}

async function uploadRender(id, name, png) {
	const key = `${RENDER_PREFIX}/${id}/${name}.png`;
	await putObject({ key, body: png, contentType: 'image/png' });
	return publicUrl(key);
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

// Deterministic pose plan seeded from the job id, reproducible per job, varied
// across jobs. Slot n picks from the remaining shortlist by seed byte.
export function buildRenderPlan(id) {
	const seed = createHash('sha256').update(id).digest();
	const pool = [...FULLBODY_POSES];
	const plan = [{ kind: 'pfp', pose: PFP_POSE, theta: 14 }];
	for (let i = 0; i < FULLBODY_COUNT; i++) {
		const pick = seed[i] % pool.length;
		plan.push({ kind: 'fullbody', pose: pool.splice(pick, 1)[0], theta: FULLBODY_THETAS[i] });
	}
	// Belt and braces: a stale preset id in the shortlist must fail loudly in
	// tests, not 400 mid-job against the render endpoint.
	for (const step of plan) {
		if (!KNOWN_POSES.has(step.pose)) throw new Error(`unknown pose preset: ${step.pose}`);
	}
	return plan;
}

// Validate a caller-supplied reference image BEFORE the transport settles the
// payment: unreachable input must fail the call with nothing charged.
export async function validateReferenceImage(url) {
	await assertSafePublicUrl(url, { allowHttp: true });
	let res;
	try {
		// Pinned guard fetch: validation alone leaves a DNS-rebinding window and
		// a validated host could redirect to an internal address. The byte cap
		// bounds hosts that ignore the Range header and stream the whole image.
		res = await fetchSafePublicUrlPinned(
			url,
			{
				method: 'GET',
				headers: { range: 'bytes=0-0' },
				signal: AbortSignal.timeout(15_000),
			},
			{ allowHttp: true, maxBytes: 16 * 1024 * 1024 },
		);
	} catch (err) {
		throw pipelineError(
			'reference_image_unreachable',
			`reference_image_url could not be fetched (${err?.message || err}). ` +
				'Host it somewhere publicly reachable, or omit it. Nothing was charged.',
		);
	}
	if (!(res.ok || res.status === 206)) {
		throw pipelineError(
			'reference_image_unreachable',
			`reference_image_url returned HTTP ${res.status}. Fix or omit it. Nothing was charged.`,
		);
	}
	const type = res.headers.get('content-type') || '';
	if (type && !type.startsWith('image/')) {
		throw pipelineError(
			'reference_image_invalid',
			`reference_image_url serves "${type}", not an image. Nothing was charged.`,
		);
	}
}

export async function createIdentityJob({
	base = BASE,
	agentName,
	brief,
	styleHints,
	referenceImageUrl,
}) {
	const name = String(agentName ?? '').trim().slice(0, 80);
	const rawBrief = String(brief ?? '').trim();
	if (!name) throw pipelineError('invalid_input', 'agent_name is required.');
	if (rawBrief.length < 3) {
		throw pipelineError('invalid_input', 'brief must describe the agent in at least 3 characters.');
	}
	// Honest long-brief handling: hard truncation, flagged in every response.
	const briefTruncated = rawBrief.length > MAX_BRIEF_CHARS;
	const effectiveBrief = briefTruncated ? rawBrief.slice(0, MAX_BRIEF_CHARS) : rawBrief;
	const hints = styleHints ? String(styleHints).trim().slice(0, 500) : null;
	const refUrl = referenceImageUrl ? String(referenceImageUrl).trim() : null;
	if (refUrl) await validateReferenceImage(refUrl);

	const prompt = await shapeIdentityPrompt({
		agentName: name,
		brief: effectiveBrief,
		styleHints: hints,
	});

	const id = crypto.randomUUID();
	const gen = await submitForge(
		base,
		refUrl
			? { image_urls: [refUrl], prompt: prompt.effective, aspect_ratio: '3:4' }
			: { prompt: prompt.effective, aspect_ratio: '3:4' },
	);

	const state = await saveState({
		id,
		createdAt: new Date().toISOString(),
		input: { agentName: name, brief: effectiveBrief, briefTruncated, styleHints: hints, referenceImageUrl: refUrl },
		prompt,
		stage: 'generate',
		attempts: { generate: 1, rig: 0 },
		gen: {
			jobId: gen.job_id ?? null,
			glbUrl: gen.status === 'done' ? gen.glb_url : null,
			backend: gen.backend ?? null,
		},
		rig: { jobId: null, glbUrl: null },
		plan: buildRenderPlan(id),
		renders: [],
		renderCursor: 0,
		error: null,
	});
	if (state.gen.glbUrl) {
		// Synchronous free-lane completion, jump straight to rigging.
		await beginRig(base, state);
	}
	return { jobId: encodeIdentityJobToken(id), state };
}

async function beginRig(base, state) {
	state.stage = 'rig';
	try {
		const rig = await startRig(base, state.gen.glbUrl);
		state.attempts.rig += 1;
		state.rig.jobId = rig.job_id;
		state.error = null;
	} catch (err) {
		return failStage(state, 'rig', err);
	}
	return saveState(state);
}

// A generate/rig/render failure retries free while attempts remain, the
// buyer paid for deliverables, not for our transient upstream weather. The
// retry itself happens on the NEXT status poll (the failed stage's job handle
// is cleared, and advance re-submits), so one bad resubmission can never go
// terminal while attempts remain. Exhausted retries mark the job failed with
// the last actionable error.
async function failStage(state, stage, err) {
	// Backpressure is not failure: a rate-limited upstream never consumes a
	// retry attempt. Clear the stage handle, honor retry_after (default 30s),
	// and let a later poll resubmit.
	if (err?.code === 'rate_limited') {
		state.error = { stage, code: 'rate_limited', message: String(err?.message || err), retrying: true };
		if (stage === 'generate') state.gen.jobId = null;
		else if (stage === 'rig') state.rig.jobId = null;
		const waitMs = Number(err?.retryAfter) > 0 ? Number(err.retryAfter) * 1000 : 30_000;
		state.nextAttemptAt = Date.now() + Math.min(waitMs, 5 * 60_000);
		return saveState(state);
	}
	const attempts = state.attempts[stage] ?? 0;
	if (attempts < MAX_STAGE_ATTEMPTS && err?.code !== 'not_configured') {
		state.error = { stage, code: err?.code || 'provider_error', message: String(err?.message || err), retrying: true };
		if (stage === 'generate') state.gen.jobId = null;
		else if (stage === 'rig') state.rig.jobId = null;
		// render: cursor stays put, the next poll re-runs the same render.
		state.attempts[stage] = attempts + 1;
		return saveState(state);
	}
	state.stage = 'failed';
	state.error = { stage, code: err?.code || 'provider_error', message: String(err?.message || err), retrying: false };
	return saveState(state);
}

// Advance the job by ONE bounded step. Called by every identity_status poll.
export async function advanceIdentityJob(id, { base = BASE } = {}) {
	const state = await loadState(id);
	if (!state) return null;

	// Rate-limit backoff window, this poll is a no-op until it elapses.
	if (state.nextAttemptAt && Date.now() < state.nextAttemptAt) return state;
	if (state.nextAttemptAt) {
		delete state.nextAttemptAt;
	}

	if (state.stage === 'generate') {
		if (!state.gen.glbUrl && !state.gen.jobId) {
			// A previous attempt failed, this poll performs the free retry.
			try {
				const gen = await submitForge(
					base,
					state.input.referenceImageUrl
						? { image_urls: [state.input.referenceImageUrl], prompt: state.prompt.effective, aspect_ratio: '3:4' }
						: { prompt: state.prompt.effective, aspect_ratio: '3:4' },
				);
				state.gen.jobId = gen.job_id ?? null;
				if (gen.status === 'done' && gen.glb_url) {
					state.gen.glbUrl = gen.glb_url;
					state.gen.backend = gen.backend ?? state.gen.backend;
				}
				await saveState(state);
			} catch (err) {
				await failStage(state, 'generate', err);
			}
		} else if (!state.gen.glbUrl) {
			const status = await pollForgeOnce(base, state.gen.jobId);
			if (status.status === 'failed') {
				await failStage(state, 'generate', pipelineError('generation_failed', status.error || 'generation failed'));
			} else if (status.status === 'done' && status.glb_url) {
				state.gen.glbUrl = status.glb_url;
				state.gen.backend = status.backend ?? state.gen.backend;
				await saveState(state);
			}
		}
		if (state.stage === 'generate' && state.gen.glbUrl) await beginRig(base, state);
	} else if (state.stage === 'rig') {
		if (!state.rig.jobId) {
			// Rig submission failed earlier, retry it on this poll.
			await beginRig(base, state);
		} else {
			const status = await pollForgeOnce(base, state.rig.jobId);
			if (status.status === 'failed') {
				await failStage(state, 'rig', pipelineError('rig_failed', status.error || 'rigging failed'));
			} else if (status.status === 'done' && status.glb_url) {
				state.rig.glbUrl = status.glb_url;
				state.stage = 'render';
				await saveState(state);
			}
		}
	} else if (state.stage === 'render') {
		const step = state.plan[state.renderCursor];
		if (!step) {
			state.stage = 'done';
			await saveState(state);
		} else {
			try {
				// sharp is imported lazily so Vercel only traces its native tree for
				// this function (mirrors the chromium lazy-load in render-clip.js).
				const { default: sharp } = await import('sharp');
				const raw = await renderTransparent(base, {
					glbUrl: state.rig.glbUrl,
					posePresetId: step.pose,
					theta: step.theta,
				});
				if (step.kind === 'pfp') {
					const pfp = await composePfp(sharp, raw, { outSize: 1024 });
					const url = await uploadRender(state.id, 'pfp-1024', pfp);
					const preview = await sharp(pfp).resize(128, 128).png().toBuffer();
					const previewUrl = await uploadRender(state.id, 'pfp-128', preview);
					state.renders.push({ kind: 'pfp', pose: step.pose, url, previewUrl, width: 1024, height: 1024 });
				} else {
					const shot = await composeFullBody(sharp, raw, {});
					const url = await uploadRender(state.id, `fullbody-${state.renderCursor}-${step.pose}`, shot);
					state.renders.push({ kind: 'fullbody', pose: step.pose, url, width: 1024, height: 1280 });
				}
				state.renderCursor += 1;
				state.error = null;
				if (state.renderCursor >= state.plan.length) state.stage = 'done';
				await saveState(state);
			} catch (err) {
				// failStage handles rate_limited as pure backoff (cursor untouched,
				// no attempt consumed) and real failures with bounded retries.
				await failStage(state, 'render', err);
			}
		}
	}

	return state;
}

// The public status/result shape identity_status returns.
export function describeIdentityJob(state, { base = BASE } = {}) {
	const stageOrder = ['generate', 'rig', 'render', 'done'];
	const doneRenders = state.renders.length;
	const body = {
		job_id: encodeIdentityJobToken(state.id),
		status: state.stage === 'done' ? 'done' : state.stage === 'failed' ? 'failed' : 'running',
		stage: state.stage,
		progress: {
			steps: stageOrder,
			renders_done: doneRenders,
			renders_total: state.plan.length,
		},
		brief_truncated: state.input.briefTruncated,
		prompt: state.prompt.effective,
		directed: Boolean(state.prompt.directed),
		...(state.error ? { last_error: state.error } : {}),
	};
	if (state.stage === 'done') {
		const pfp = state.renders.find((r) => r.kind === 'pfp');
		body.deliverables = {
			pfp: pfp ? { url: pfp.url, preview_128_url: pfp.previewUrl, pose: pfp.pose, size: 1024 } : null,
			full_body: state.renders
				.filter((r) => r.kind === 'fullbody')
				.map((r) => ({ url: r.url, pose: r.pose, width: r.width, height: r.height })),
			rigged_glb_url: state.rig.glbUrl,
			mesh_glb_url: state.gen.glbUrl,
			viewer_url: `${base}/viewer?src=${encodeURIComponent(state.rig.glbUrl)}`,
			pose_studio_url: `${base}/pose?src=${encodeURIComponent(state.rig.glbUrl)}`,
		};
	}
	return body;
}
