// Shared core for the realism eval harness (scripts/quality-bench.mjs — the full,
// resumable, git-committed run — and api/cron/quality-bench.js — the bounded
// weekly regression sweep that runs in-process on Cloud Run). One place for the
// generate → render → judge pipeline so the two callers can never drift apart on
// what "a scored view" means.
//
// Mission spec: quality-bar campaign, work order 09 (realism eval harness;
// retired, see git history). See
// data/quality-bench/README.md for how to run/read/extend the bench.

import { renderClip } from './render-clip.js';
import { vertexGeminiAvailable, vertexGeminiChatUrl, vertexGeminiHeaders } from './vertex-gemini.js';

// Judge model — fixed here (not env-tunable) so every run in the repo's history
// used the same rung unless this constant itself changed via a reviewed commit.
export const JUDGE_MODEL = 'google/gemini-2.5-pro';
export const JUDGE_PROMPT_VERSION = 1;
// Gemini 2.5 Pro always spends thinking tokens, and on Vertex's OpenAI-compatible
// surface those count against `max_tokens`. Measured on this judge prompt: ~1000-1300
// reasoning tokens before a ~60-token JSON verdict, so the original 700 budget cut
// every reply off mid-string (finish_reason "length" → "Unterminated string in JSON")
// and lost most views. 3000 clears the observed ceiling with headroom; the verdict
// itself stays tiny, so this costs nothing extra on a reply that finishes early.
const JUDGE_MAX_TOKENS = 3000;

// Front, three-quarter, side — matches the studio-product framing render-clip.js
// already uses for avatar thumbnails (phi=78deg, just above eye level).
export const CANONICAL_VIEWS = [
	{ label: 'front', theta: 0, phi: 78 },
	{ label: 'three-quarter', theta: 40, phi: 78 },
	{ label: 'side', theta: 90, phi: 78 },
];

export const RENDER_BACKGROUND = '#14151a';

// Never receives forge's internal art-director/enhanced prompt text — only the
// benchmark's own fixed prompt string and subject-class watchlist — so the judge
// can't inflate prompt-adherence by grading against its own prior expansion
// (anti-gaming rule in the mission spec).
export function buildJudgePrompt({ prompt, subjectClass, watch, viewLabel }) {
	return `You are a strict, expert 3D-asset realism critic. You are shown ONE rendered view ("${viewLabel}") of a textured 3D model generated from this brief:

Subject class: ${subjectClass}
Original brief: "${prompt}"

Known failure modes to specifically check for on this subject class:
${watch.map((w) => `- ${w}`).join('\n')}

Score the render on four axes, 1-10 (10 = indistinguishable from a real photograph / studio 3D render, 1 = broken):
- photorealism: does material/lighting/surface read as real, not "game asset" or plastic?
- geometryIntegrity: is the mesh coherent (no blobs, no fused limbs/parts, no melted details)?
- textureFidelity: are textures sharp, non-tiling, and free of baked-in artifacts?
- promptAdherence: does the render actually depict the brief above?

Reply with ONLY a JSON object, no markdown fence, no prose outside the JSON:
{"photorealism": <1-10 integer>, "geometryIntegrity": <1-10 integer>, "textureFidelity": <1-10 integer>, "promptAdherence": <1-10 integer>, "critique": "<one sentence, concrete, naming the specific defect or strength you observed>"}`;
}

function parseJudgeJson(text) {
	const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	const start = trimmed.search(/[{[]/);
	const candidate = start >= 0 ? trimmed.slice(start) : trimmed;
	const parsed = JSON.parse(candidate);
	for (const k of ['photorealism', 'geometryIntegrity', 'textureFidelity', 'promptAdherence']) {
		const n = Number(parsed[k]);
		if (!Number.isFinite(n)) throw new Error(`judge reply missing numeric ${k}`);
		parsed[k] = Math.max(1, Math.min(10, n));
	}
	if (typeof parsed.critique !== 'string') parsed.critique = '';
	return parsed;
}

// One judge call against one rendered PNG. Throws on any failure (unconfigured
// Vertex, transport error, unparseable reply) — callers must record that as a
// failed score, never fabricate one.
export async function judgeOnce({ png, promptEntry, viewLabel }) {
	if (!vertexGeminiAvailable()) {
		throw Object.assign(new Error('Vertex Gemini unavailable: GOOGLE_CLOUD_PROJECT is not set in this environment'), { code: 'judge_unconfigured' });
	}
	const headers = await vertexGeminiHeaders();
	const text = buildJudgePrompt({ ...promptEntry, viewLabel });
	const dataUri = `data:image/png;base64,${png.toString('base64')}`;
	const body = {
		model: JUDGE_MODEL,
		temperature: 0,
		max_tokens: JUDGE_MAX_TOKENS,
		messages: [
			{ role: 'user', content: [
				{ type: 'text', text },
				{ type: 'image_url', image_url: { url: dataUri } },
			] },
		],
	};
	const res = await fetch(vertexGeminiChatUrl(), {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`judge call ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
	const content = data?.choices?.[0]?.message?.content || '';
	const parsed = parseJudgeJson(content);
	return { ...parsed, modelVersion: data?.model || data?.modelVersion || JUDGE_MODEL };
}

export function avgScores(scores) {
	const dims = ['photorealism', 'geometryIntegrity', 'textureFidelity', 'promptAdherence'];
	const out = {};
	for (const d of dims) out[d] = scores.reduce((s, x) => s + x[d], 0) / scores.length;
	out.mean = dims.reduce((s, d) => s + out[d], 0) / dims.length;
	return out;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Per-request ceilings. Every outbound call here needs one: the cron caller's
// `deadlineAt` is only ever consulted BETWEEN steps, so a single request that
// hangs sails straight past the budget no matter how carefully the loop above it
// counts. That is not hypothetical, it is the 2026-08-10 failure recorded in
// api/cron/quality-bench.js's header (900s spent, 504 from Cloud Run, Scheduler
// left holding DEADLINE_EXCEEDED). A catalog read and a forge submit are small
// JSON round trips; a poll is one status read, not the generation itself.
const CATALOG_TIMEOUT_MS = 15_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
// The judge spends ~1300 reasoning tokens before its verdict, so it is the
// slowest call here by design. Generous, but still a ceiling.
const JUDGE_TIMEOUT_MS = 120_000;

export async function loadCatalog(baseUrl) {
	const res = await fetch(`${baseUrl}/api/forge?catalog`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
	return res.json();
}

// The bench is an internal sweep of our own deployment, so it submits as an
// internal seed request when the deployment's CRON_SECRET is available locally
// (api/forge.js: isInternalSeedRequest). Without it the High tier is unreachable —
// forge.high is $THREE hold-or-pay gated and an anonymous submit gets a 402
// three_hold_required, which would record every high-tier combo as a lane failure
// and make the "standard vs high" comparison meaningless. Absent the secret the
// bench still runs; only the ungated tiers produce scores.
export function forgeSeedHeaders() {
	const secret = (process.env.QUALITY_BENCH_FORGE_SEED || process.env.CRON_SECRET || '').trim();
	return secret ? { 'x-forge-seed': secret } : {};
}

export async function submitForge(baseUrl, { prompt, mode, referenceImageUrl, tier, backend }) {
	const body = { prompt, tier, backend };
	if (mode === 'image' && referenceImageUrl) body.image_urls = [referenceImageUrl];
	const res = await fetch(`${baseUrl}/api/forge`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...forgeSeedHeaders() },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(data?.error || data?.message || `forge submit ${res.status}`);
		err.status = res.status;
		err.code = data?.code;
		throw err;
	}
	return data;
}

// Two independent ceilings bound the wait: this poll's own patience (timeoutMs,
// how long one generation is worth waiting for) and `deadlineAt`, an absolute
// wall-clock instant the CALLER must return inside. Whichever lands first wins,
// so a caller with 40s of runway left never sits out a 10-minute poll. Callers
// that pass no deadline (the by-hand full bench) keep the old unbounded-patience
// behavior exactly.
export async function pollForge(baseUrl, jobId, { timeoutMs = 10 * 60 * 1000, intervalMs = 4000, deadlineAt = Infinity } = {}) {
	const ownDeadline = Date.now() + timeoutMs;
	const budgetBound = deadlineAt < ownDeadline;
	const deadline = budgetBound ? deadlineAt : ownDeadline;
	while (Date.now() < deadline) {
		// Clamped to whatever runway is actually left, so the last poll of a run
		// cannot overshoot the deadline the caller is being held to.
		const pollMs = Math.max(1, Math.min(POLL_TIMEOUT_MS, deadline - Date.now()));
		let res;
		try {
			res = await fetch(`${baseUrl}/api/forge?job=${encodeURIComponent(jobId)}`, {
				signal: AbortSignal.timeout(pollMs),
			});
		} catch {
			// One status read stalling says nothing about the generation behind it,
			// so keep waiting on the next tick rather than failing a job that is
			// still healthy. The deadline above, not this request, ends the wait.
			await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
			continue;
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.error || `poll ${res.status}`);
		if (data.status === 'done') return data;
		if (data.status === 'failed') {
			const err = new Error(data?.error || 'generation failed');
			err.code = 'generation_failed';
			throw err;
		}
		// Never sleep past the deadline: the last nap decides how far the caller
		// overshoots its budget.
		await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
	}
	if (budgetBound) {
		const err = new Error('run budget exhausted while waiting for generation');
		err.code = 'budget_exhausted';
		throw err;
	}
	throw new Error(`poll timed out after ${timeoutMs}ms`);
}

export async function generate(baseUrl, params, { deadlineAt = Infinity } = {}) {
	const submitted = await submitForge(baseUrl, params);
	if (submitted.status === 'done' && submitted.glb_url) return submitted;
	if (submitted.job_id) return pollForge(baseUrl, submitted.job_id, { deadlineAt });
	throw new Error(`unexpected forge response shape: ${JSON.stringify(submitted).slice(0, 300)}`);
}

// Run one (prompt, lane, tier) combo end to end: generate -> render 3 views ->
// judge each view twice -> average. Never throws for a generation/scoring
// failure — returns a result object with status set instead, so a caller
// iterating many combos never has one bad lane abort the whole sweep.
// `deadlineAt` is an absolute wall-clock instant this combo must be finished by.
// A caller running under a request budget passes it so generation waits and the
// per-view render/judge loop both stop at the line instead of running on past a
// response nobody is listening to any more. Omitting it keeps the unbounded
// behavior the by-hand bench relies on.
export async function runOne(baseUrl, promptEntry, lane, tier, { deadlineAt = Infinity } = {}) {
	const result = { promptId: promptEntry.id, subjectClass: promptEntry.subjectClass, lane, tier, startedAt: new Date().toISOString() };
	try {
		const gen = await generate(baseUrl, {
			prompt: promptEntry.prompt,
			mode: promptEntry.mode,
			referenceImageUrl: promptEntry.referenceImageUrl,
			tier,
			backend: lane,
		}, { deadlineAt });
		result.glbUrl = gen.glb_url;
		result.creationId = gen.creation_id ?? null;
		// /api/forge falls back between lanes internally (a cooling NIM gateway
		// reroutes to the reconstruct lane, an exhausted HF Space hands off to a
		// self-host worker), and the response reports which engine actually
		// produced the GLB. Record it: without it a score can be filed under a lane
		// that never ran, which is exactly the comparison the bench exists to make.
		// `lane` stays the REQUESTED lane so resume keys are stable across runs.
		result.effectiveLane = gen.backend ?? null;
		result.cached = gen.cached === true;
		result.views = [];
		for (const view of CANONICAL_VIEWS) {
			if (Date.now() >= deadlineAt) {
				result.budgetExhausted = true;
				break;
			}
			const viewResult = { view: view.label };
			try {
				const { png } = await renderClip({
					glbUrl: gen.glb_url,
					width: 1024,
					height: 1024,
					background: RENDER_BACKGROUND,
					cameraOrbit: { theta: view.theta, phi: view.phi },
				});
				const scores = [];
				for (let i = 0; i < 2; i += 1) scores.push(await judgeOnce({ png, promptEntry, viewLabel: view.label }));
				viewResult.scores = scores;
				viewResult.avg = avgScores(scores);
			} catch (viewErr) {
				viewResult.error = viewErr.message;
			}
			result.views.push(viewResult);
		}
		const okViews = result.views.filter((v) => v.avg);
		if (result.budgetExhausted) {
			// A combo whose view sweep was cut short is not a comparable data point:
			// scoring it against a baseline built from complete sweeps would read a
			// short clock as a quality change. Keep the partial views for diagnosis
			// and withhold the score.
			result.status = 'budget_exhausted';
			result.meanScore = null;
		} else {
			result.status = okViews.length ? 'ok' : 'scoring_failed';
			result.meanScore = okViews.length ? okViews.reduce((s, v) => s + v.avg.mean, 0) / okViews.length : null;
		}
	} catch (genErr) {
		if (genErr.code === 'budget_exhausted') {
			// Same reasoning: out of time is not the same finding as a broken lane,
			// so it must not be scored as a zero.
			result.status = 'budget_exhausted';
			result.budgetExhausted = true;
			result.error = genErr.message;
			result.meanScore = null;
		} else {
			result.status = 'lane_failed';
			result.error = genErr.message;
			result.meanScore = 0;
		}
	}
	result.finishedAt = new Date().toISOString();
	return result;
}
