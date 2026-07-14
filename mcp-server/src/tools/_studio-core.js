// Shared, dependency-free generation cores for the three.ws 3D pipeline.
//
// These are the REAL handlers behind the five generation tools — text→3D, 3D
// avatar, text/image→mesh, auto-rig, and one-call text→rigged-avatar. They are
// thin clients over the three.ws production pipeline (/api/forge) and, for
// text_to_avatar, Replicate: no GPU/LLM work happens here, all of it runs on
// the operator-funded backend that holds the provider keys.
//
// One implementation, two transports:
//   • the npx-distributed stdio MCP server wraps each core in `paid()`/`free()`
//     (mcp-server/src/tools/*.js) — x402 USDC gates the call.
//   • the hosted, FREE 3D Studio endpoint (api/_studio/*, /api/mcp-studio) calls
//     the SAME cores directly with no payment surface — abuse is bounded by
//     server-side rate limits instead.
//
// Keeping the generation logic here (not forked into each transport) means the
// stdio and the free HTTP lanes can never drift. This module imports nothing
// payment- or schema-related: only the global `fetch` and the dependency-free
// humanoid classifier, so it loads in the Vercel `api/` bundle (which carries
// neither the @x402 stack nor zod-to-json-schema) unchanged.

import { classifyHumanoidPrompt } from './_humanoid.js';
import { composeRefinement, seedLineage, appendVersion, buildLineageChain, branchFrom } from './_lineage.js';
import { resolveLogoPrompt, BRAND_MARK_DIRECTIVE } from './_logo-lexicon.js';

// Standard tool error envelope — identical shape to payments.js `toolError`, so
// a core's error is indistinguishable whether it is surfaced through the paid
// stdio wrapper or the free HTTP endpoint. Duplicated (not imported) because
// payments.js pulls the @x402 stack, which the api/ bundle must not load.
export function coreError(code, message, extra) {
	return { ok: false, error: code, message, ...(extra || {}) };
}

function env(k, def) {
	const v = process.env[k];
	return v && String(v).trim() ? String(v).trim() : def;
}

// Resolve the three.ws origin from the first set of the provided env keys,
// trailing slash stripped. Each tool keeps its historical override key.
function apiBaseFrom(keys, def = 'https://three.ws') {
	for (const k of keys) {
		const v = env(k);
		if (v) return v.replace(/\/$/, '');
	}
	return def.replace(/\/$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VALID_TIER = new Set(['draft', 'standard', 'high']);
const VALID_ASPECT = new Set(['1:1', '4:3', '3:4', '16:9', '9:16']);

// Probe that a generated asset URL is actually fetchable before returning it as
// a success: a degraded lane can hand back an already-expired temp URL, and a
// 404 link reads as breakage downstream. A 1-byte ranged GET is used because
// gradio file routes frequently reject HEAD. Best-effort — any error counts as
// unreachable.
async function isUrlReachable(url) {
	if (!url) return false;
	try {
		const r = await fetch(url, {
			method: 'GET',
			headers: { range: 'bytes=0-0' },
			signal: AbortSignal.timeout(15_000),
		});
		return r.ok || r.status === 206;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// /api/forge client — submit + poll, shared by forge_free / mesh_forge /
// forge_avatar. The three callers differ only in: which backend/path they pin,
// whether a synchronous `status:"done"` submit is acceptable, and the submit
// timeout. Everything else is identical, so it lives here once.
// ---------------------------------------------------------------------------

async function submitForge({ base, payload, submitTimeoutMs, allowSyncDone }) {
	let res;
	try {
		res = await fetch(`${base}/api/forge`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(submitTimeoutMs),
		});
	} catch (err) {
		if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
			const e = new Error('the 3D lane took too long to accept the job; try again');
			e.code = 'timeout';
			throw e;
		}
		const e = new Error(`forge unreachable: ${err?.message || err}`);
		e.code = 'provider_error';
		throw e;
	}
	const data = await res.json().catch(() => ({}));
	if (res.status === 503) {
		const e = new Error(data?.message || 'text→3D is not configured on the three.ws deployment');
		e.code = 'not_configured';
		throw e;
	}
	if (res.status === 429) {
		const e = new Error(data?.message || 'the 3D generator is busy; try again shortly');
		e.code = 'rate_limited';
		e.retryAfter = data?.retry_after;
		throw e;
	}
	const completedSync = allowSyncDone && data?.status === 'done' && data?.glb_url;
	if (!res.ok || !(data?.job_id || completedSync)) {
		const e = new Error(data?.message || `forge returned ${res.status}`);
		e.code = 'provider_error';
		throw e;
	}
	return data;
}

async function pollForge(jobId, { base, timeoutMs, intervalMs, failCode = 'generation_failed' }) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		let res;
		try {
			res = await fetch(`${base}/api/forge?job=${encodeURIComponent(jobId)}`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(Math.max(intervalMs * 3, 15_000)),
			});
		} catch (err) {
			if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
				await sleep(intervalMs);
				continue;
			}
			const e = new Error(`forge poll failed: ${err?.message || err}`);
			e.code = 'provider_error';
			throw e;
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			const e = new Error(data?.message || `forge poll returned ${res.status}`);
			e.code = 'provider_error';
			throw e;
		}
		last = data;
		if (data.status === 'done' && data.glb_url) return data;
		if (data.status === 'failed') {
			const e = new Error(data.error || 'generation failed');
			e.code = failCode;
			throw e;
		}
		await sleep(intervalMs);
	}
	return { ...(last || {}), _timedOut: true };
}

async function startRig({ base, glbUrl }) {
	const res = await fetch(`${base}/api/forge?action=rig`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ glb_url: glbUrl }),
		signal: AbortSignal.timeout(30_000),
	});
	const data = await res.json().catch(() => ({}));
	if (res.status === 503 || res.status === 501) {
		const e = new Error(data?.message || 'auto-rigging is not enabled on the three.ws deployment');
		e.code = 'not_configured';
		throw e;
	}
	if (res.status === 429) {
		const e = new Error(data?.message || 'the rigger is busy; try again shortly');
		e.code = 'rate_limited';
		e.retryAfter = data?.retry_after;
		throw e;
	}
	if (!res.ok || !data?.job_id) {
		const e = new Error(data?.message || `rig start returned ${res.status}`);
		e.code = 'provider_error';
		throw e;
	}
	return data;
}

// Prompt director over the deployed /api/chat SSE endpoint. Returns the refined
// prompt string, or null on ANY failure so the caller falls back to the
// original prompt (fail-soft, never fabricated).
//
// No provider is pinned: this client is anonymous, and /api/chat rejects every
// non-free provider for anonymous callers with 401 (pinning watsonx here used
// to kill the director on every call). Unpinned, the deployment routes the
// request through its anonymous free-provider chain. MESH_FORGE_DIRECTOR_MODEL
// stays available as an explicit override for callers who know their
// deployment's model catalog.
async function directPrompt({ base, rawPrompt, instruction, model }) {
	let res;
	try {
		res = await fetch(`${base}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({
				...(model ? { model } : {}),
				message: `${instruction}\n\nIdea: ${rawPrompt}`,
			}),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		return null;
	}
	if (!res.ok || !res.body) return null;

	let acc = '';
	try {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				let evt;
				try {
					evt = JSON.parse(line.slice(6));
				} catch {
					continue;
				}
				if (evt.type === 'chunk' && typeof evt.text === 'string') acc += evt.text;
				else if (evt.type === 'error') return null;
				else if (evt.type === 'done' && typeof evt.text === 'string' && !acc) acc = evt.text;
			}
		}
	} catch {
		return null;
	}

	// First line only, then strip wrapping quotes; the reverse order leaves a
	// dangling quote when the model adds commentary lines after a quoted prompt.
	const firstLine = acc.trim().split('\n')[0].trim();
	const refined = firstLine.replace(/^["'“”]+|["'“”]+$/g, '').trim();
	return refined.length >= 3 && refined.length <= 1000 ? refined : null;
}

// Merge a multi-view array with a single image_url, de-duped + order-preserving.
function normalizeViews({ image_url, image_urls }) {
	const raw = Array.isArray(image_urls)
		? image_urls
		: typeof image_url === 'string'
			? [image_url]
			: [];
	const seen = new Set();
	const views = [];
	for (const v of raw) {
		if (typeof v !== 'string') continue;
		const t = v.trim();
		if (!t || seen.has(t)) continue;
		seen.add(t);
		views.push(t);
	}
	return views;
}

const MESH_DIRECTOR_INSTRUCTION =
	"You are a 3D asset art director. Rewrite the user's idea into ONE concise prompt for a " +
	'text-to-3D generator. Describe a SINGLE isolated subject on a plain background, naming form, ' +
	'materials, color, and surface detail. No scenes, no multiple objects, no rendered text, no ' +
	'background environment. ' +
	BRAND_MARK_DIRECTIVE +
	'Output ONLY the rewritten prompt as a single line — no preamble, no quotes.';

const AVATAR_DIRECTOR_INSTRUCTION =
	"You are a 3D character art director. Rewrite the user's idea into ONE concise prompt for a text-to-3D " +
	'generator that will be auto-rigged. Describe a SINGLE full-body humanoid character standing in a neutral ' +
	'pose with arms slightly away from the body, on a plain background. Name the body type, outfit, materials, ' +
	'colors, and key features. No scene, no props held across the body, no multiple characters, no text or logos. ' +
	'Output ONLY the rewritten prompt as a single line — no preamble, no quotes.';

// ---------------------------------------------------------------------------
// forge_free — text → textured 3D GLB on the FREE NVIDIA NIM (TRELLIS) lane.
// ---------------------------------------------------------------------------
export async function runForgeFree({ prompt, tier }) {
	const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
	if (trimmed.length < 3) {
		return coreError('invalid_input', 'Provide a text prompt of at least 3 characters.');
	}
	const tierId = VALID_TIER.has(tier) ? tier : 'draft';
	// Known brand-mark prompts ("<brand name> logo") resolve to a deterministic
	// geometric spec of the real mark; this lane has no LLM director, so without
	// it the raw brand name reconstructs as a garbled generic badge. The user's
	// original prompt stays on the response metadata unchanged.
	const knownMark = resolveLogoPrompt(trimmed);
	const subject = knownMark ? knownMark.prompt : trimmed;
	const base = apiBaseFrom(['FORGE_FREE_API_BASE']);
	// A pre-rendered reference view beats any text draw for a known mark: the
	// text lane rolls a random colorway per run, the reference reconstructs the
	// exact mark. Served by the same deployment the job is submitted to.
	const markImageUrls = knownMark?.imagePath ? [`${base}${knownMark.imagePath}`] : undefined;
	const startedAt = Date.now();
	// The free lane's happy path is the durable NVIDIA NIM (R2-persisted) result.
	// When NIM is cold it degrades to a HuggingFace Space whose gradio /tmp URL
	// expires within seconds — a non-durable result that can be DEAD on arrival.
	// Prefer a durable result via a bounded retry, verify any non-durable URL is
	// actually reachable before returning it, and never hand back a confirmed-dead
	// link as success. This is what keeps the free smoke-test reliable for a
	// reviewer even during a NIM outage. Raise FORGE_FREE_ATTEMPTS to trade
	// latency for a better shot at landing the durable lane.
	const maxAttempts = Math.max(1, Math.min(4, Number(env('FORGE_FREE_ATTEMPTS', '2')) || 2));
	// The free lane is shared and rate-limited, so a reviewer (or any first caller
	// during a busy window) can hit a transient `rate_limited` instead of a model.
	// That single response should NOT bounce them: it carries a `retryAfter`, so a
	// short, bounded backoff lands a real result on the next slot. Budgeted
	// separately from the durable-attempt loop so a pure backoff never burns an
	// attempt. Genuine failures stay terminal (see the catch below).
	const _rateRetriesRaw = Number(env('FORGE_FREE_RATE_RETRIES', '4'));
	// `|| 4` would swallow an explicit, valid 0 (0 is falsy) — making the rate
	// backoff impossible to disable. Honor 0; only fall back to the default when
	// the env value is non-numeric.
	const maxRateRetries = Math.max(0, Math.min(6, Number.isFinite(_rateRetriesRaw) ? _rateRetriesRaw : 4));

	let liveFallback = null; // first reachable-but-non-durable result, used only if no durable one appears
	let rateRetries = 0;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let gen;
		try {
			gen = await forgeFreeOnce({ base, prompt: subject, tierId, imageUrls: markImageUrls });
		} catch (err) {
			// Transient contention on the shared free lane (the generator is busy):
			// honor the server's retryAfter (capped 1–8s), back off, and retry
			// WITHOUT consuming a durable attempt. This is what keeps the free
			// smoke-test reliable for a reviewer during a busy window. Only
			// rate_limited is retried here — every OTHER error (generation_failed,
			// not_configured, invalid_input, timeout) stays terminal and is surfaced
			// immediately, preserving the tool's original error contract.
			if (err.code === 'rate_limited' && rateRetries < maxRateRetries) {
				rateRetries++;
				const waitMs = Math.min(8000, Math.max(1000, (Number(err.retryAfter) || 2) * 1000));
				await sleep(waitMs);
				attempt--; // a pure backoff must not count against the durable-attempt budget
				continue;
			}
			// The ONLY exception to surfacing immediately: if an earlier attempt
			// already produced a reachable result, keep it rather than losing a
			// usable model to a later attempt's transient error.
			if (liveFallback) break;
			return coreError(err.code || 'provider_error', err.message, {
				...(err.extra || {}),
				...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
				...(attempt > 1 ? { attempts: attempt } : {}),
				...(rateRetries ? { rateRetries } : {}),
				durationMs: Date.now() - startedAt,
			});
		}
		// Durable — the reliable, R2-persisted result. Return immediately.
		if (gen.data.durable && gen.data.glb_url) {
			return shapeForgeFree({
				data: gen.data,
				prompt: trimmed,
				tierId,
				jobId: gen.jobId,
				base,
				startedAt,
				attempts: attempt,
			});
		}
		// Non-durable success — only trust it if the ephemeral URL is actually
		// fetchable right now. Keep the first reachable one, but keep trying for a
		// durable result while attempts remain.
		if (gen.data.glb_url && !liveFallback && (await isUrlReachable(gen.data.glb_url))) {
			liveFallback = { data: gen.data, jobId: gen.jobId };
		}
	}

	// No durable result across all attempts — fall back to a verified-reachable
	// non-durable one (flagged with a `warning` in shapeForgeFree).
	if (liveFallback) {
		return shapeForgeFree({
			data: liveFallback.data,
			prompt: trimmed,
			tierId,
			jobId: liveFallback.jobId,
			base,
			startedAt,
			attempts: maxAttempts,
		});
	}

	// Every attempt produced a non-durable URL that was unreachable — return a
	// clear, actionable error instead of a dead "success".
	return coreError(
		'lane_degraded',
		'The free 3D lane produced a result but its URL was unreachable — the durable NVIDIA NIM path is ' +
			'momentarily cold and the fallback provider URL expired before it could be used. Please try again shortly.',
		{ attempts: maxAttempts, durationMs: Date.now() - startedAt },
	);
}

// One forge_free generation attempt: submit to the pinned free NVIDIA NIM lane,
// then (when queued) poll to a terminal state. Returns { data, jobId } or throws
// a coded error (with optional `.extra`/`.retryAfter`) the retry loop acts on.
async function forgeFreeOnce({ base, prompt, tierId, imageUrls }) {
	const job = await submitForge({
		base,
		// Pin the free NVIDIA NIM (TRELLIS) lane so the happy path is always the
		// zero-cost engine; path:"image" is the only path NVIDIA serves. NVCF can
		// finish inside the generous submit window, so accept a synchronous done.
		// With a reference view (known brand marks) the submit goes image→3D
		// unpinned: the forge router owns image-mode engine selection, and the
		// prompt rides along as the caption.
		payload:
			Array.isArray(imageUrls) && imageUrls.length
				? { image_urls: imageUrls, prompt: prompt || undefined, tier: tierId }
				: { prompt, tier: tierId, backend: 'nvidia', path: 'image' },
		submitTimeoutMs: 90_000,
		allowSyncDone: true,
	});

	if (job.status === 'done' && job.glb_url) {
		return { data: job, jobId: null };
	}

	const timeoutMs = Number(env('FORGE_FREE_TIMEOUT_MS', '180000'));
	const intervalMs = Number(env('FORGE_FREE_POLL_MS', '3000'));
	const final = await pollForge(job.job_id, { base, timeoutMs, intervalMs });

	if (final._timedOut) {
		const e = new Error(`generation did not finish within ${timeoutMs}ms`);
		e.code = 'timeout';
		e.extra = {
			jobId: job.job_id,
			creationId: job.creation_id ?? null,
			status: final.status || 'running',
			resumeUrl: `${base}/api/forge?job=${job.job_id}`,
		};
		throw e;
	}
	return { data: final, jobId: job.job_id };
}

function shapeForgeFree({ data, prompt, tierId, jobId, base, startedAt, attempts }) {
	const glbUrl = data.glb_url;
	const durable = Boolean(data.durable);
	const result = {
		ok: true,
		free: true,
		cost: '$0.00',
		mode: 'text_to_3d',
		glbUrl,
		preview: `${base}/viewer?src=${encodeURIComponent(glbUrl)}`,
		prompt,
		tier: tierId,
		backend: data.backend ?? null,
		durable,
		jobId,
		creationId: data.creation_id ?? null,
		attempts,
		durationMs: Date.now() - startedAt,
		fetchedAt: new Date().toISOString(),
	};
	// A non-durable URL is an ephemeral provider temp file (the free lane degraded
	// off the durable NVIDIA NIM path). We only return it after verifying it is
	// reachable, but it can still expire soon — flag it so a stale link later is
	// never read as breakage, and so the caller views/downloads it promptly.
	if (!durable) {
		result.verifiedReachable = true;
		result.warning =
			'Served from an ephemeral provider URL (the free lane degraded off the durable NVIDIA NIM path). ' +
			'It is reachable now but may expire soon — open or download it promptly, or call again for a durable result.';
	}
	return result;
}

// ---------------------------------------------------------------------------
// mesh_forge — text / image / multi-view → textured 3D GLB (Granite-directed).
// ---------------------------------------------------------------------------
export async function runMeshForge({ prompt, image_url, image_urls, aspect_ratio, direct }) {
	const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
	const views = normalizeViews({ image_url, image_urls });
	if (views.length > 4) {
		return coreError('invalid_input', 'Provide between 1 and 4 reference images.');
	}
	const imageMode = views.length > 0;
	if (!imageMode && trimmedPrompt.length < 3) {
		return coreError(
			'invalid_input',
			'Provide a prompt (3+ chars) for text→3D, or 1–4 image_urls for image/multi-view→3D.',
		);
	}
	const aspect = VALID_ASPECT.has(aspect_ratio) ? aspect_ratio : '1:1';
	const base = apiBaseFrom(['MESH_FORGE_API_BASE']);
	const started = Date.now();

	// A known brand-mark prompt resolves deterministically and skips the LLM
	// director: the lexicon spec is already a tight, correct description of the
	// real mark, and a rewrite could only degrade it.
	const knownMark = !imageMode && trimmedPrompt ? resolveLogoPrompt(trimmedPrompt) : null;
	const runDirector =
		!imageMode && !knownMark && trimmedPrompt && direct !== false && env('MESH_FORGE_DIRECTOR', '1') !== '0';
	let directedPrompt = null;
	if (runDirector) {
		directedPrompt = await directPrompt({
			base,
			rawPrompt: trimmedPrompt,
			instruction: MESH_DIRECTOR_INSTRUCTION,
			model: env('MESH_FORGE_DIRECTOR_MODEL'),
		});
	}
	const effectivePrompt = knownMark?.prompt || directedPrompt || trimmedPrompt;
	// Known marks with a pre-rendered reference view go image→3D: the reference
	// reconstructs the exact mark, while a text draw rolls a random colorway.
	const markViews = knownMark?.imagePath ? [`${base}${knownMark.imagePath}`] : null;

	let job;
	try {
		job = await submitForge({
			base,
			payload:
				imageMode || markViews
					? { image_urls: imageMode ? views : markViews, prompt: effectivePrompt || undefined, aspect_ratio: aspect }
					: { prompt: effectivePrompt, aspect_ratio: aspect },
			submitTimeoutMs: 30_000,
			allowSyncDone: false,
		});
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message, {
			...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
		});
	}

	const timeoutMs = Number(env('MESH_FORGE_TIMEOUT_MS', '180000'));
	const intervalMs = Number(env('MESH_FORGE_POLL_MS', '3000'));
	let final;
	try {
		final = await pollForge(job.job_id, { base, timeoutMs, intervalMs });
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message, {
			jobId: job.job_id,
			creationId: job.creation_id ?? null,
			durationMs: Date.now() - started,
		});
	}

	const durationMs = Date.now() - started;
	if (final._timedOut) {
		return coreError('timeout', `reconstruction did not finish within ${timeoutMs}ms`, {
			jobId: job.job_id,
			creationId: job.creation_id ?? null,
			status: final.status || 'running',
			resumeUrl: `${base}/api/forge?job=${job.job_id}`,
			durationMs,
		});
	}

	const glbUrl = final.glb_url;
	return {
		ok: true,
		mode: imageMode ? 'image_to_3d' : 'text_to_3d',
		glbUrl,
		preview: `${base}/viewer?src=${encodeURIComponent(glbUrl)}`,
		prompt: trimmedPrompt || null,
		imageUrl: imageMode ? views[0] : null,
		imageUrls: imageMode ? views : null,
		viewsRequested: imageMode ? views.length : 0,
		viewsUsed: (typeof final.views_used === 'number' ? final.views_used : job.views_used) ?? null,
		multiview: (final.multiview ?? job.multiview) ?? null,
		backend: (final.backend ?? job.backend) ?? null,
		directedPrompt: directedPrompt || null,
		directed: Boolean(directedPrompt),
		jobId: job.job_id,
		creationId: final.creation_id ?? job.creation_id ?? null,
		referenceImageUrl: job.preview_image_url ?? null,
		durable: Boolean(final.durable),
		durationMs,
		fetchedAt: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// rig_mesh — static GLB → rigged, animation-ready GLB (auto-rig pipeline).
// ---------------------------------------------------------------------------
export async function runRigMesh({ glb_url }) {
	const base = apiBaseFrom(['MESH_FORGE_API_BASE']);
	const started = Date.now();

	let job;
	try {
		job = await startRig({ base, glbUrl: glb_url });
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message, {
			...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
		});
	}

	const timeoutMs = Number(env('RIG_MESH_TIMEOUT_MS', '180000'));
	const intervalMs = Number(env('RIG_MESH_POLL_MS', '3000'));
	let final;
	try {
		final = await pollForge(job.job_id, { base, timeoutMs, intervalMs, failCode: 'rig_failed' });
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message, {
			jobId: job.job_id,
			creationId: job.creation_id ?? null,
			durationMs: Date.now() - started,
		});
	}

	const durationMs = Date.now() - started;
	if (final._timedOut) {
		return coreError('timeout', `rigging did not finish within ${timeoutMs}ms`, {
			jobId: job.job_id,
			creationId: job.creation_id ?? null,
			status: final.status || 'running',
			resumeUrl: `${base}/api/forge?job=${job.job_id}`,
			durationMs,
		});
	}

	const riggedGlbUrl = final.glb_url;
	return {
		ok: true,
		riggedGlbUrl,
		sourceGlbUrl: glb_url,
		poseStudioUrl: `${base}/pose?src=${encodeURIComponent(riggedGlbUrl)}`,
		jobId: job.job_id,
		creationId: final.creation_id ?? job.creation_id ?? null,
		durable: Boolean(final.durable),
		durationMs,
		fetchedAt: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// forge_avatar — one-call text/image → rigged, animation-ready avatar.
// ---------------------------------------------------------------------------
export async function runForgeAvatar({
	prompt,
	image_url,
	image_urls,
	aspect_ratio,
	direct,
	allow_non_humanoid,
}) {
	const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
	const views = normalizeViews({ image_url, image_urls });
	if (views.length > 4) {
		return coreError('invalid_input', 'Provide between 1 and 4 reference images.');
	}
	const imageMode = views.length > 0;
	if (!imageMode && trimmedPrompt.length < 3) {
		return coreError(
			'invalid_input',
			'Provide a prompt (3+ chars) for text→avatar, or 1–4 image_urls for image/multi-view→avatar.',
		);
	}

	// Humanoid gate runs BEFORE any work — rigging assumes a humanoid skeleton.
	let humanoidInfo;
	if (trimmedPrompt.length >= 3) {
		const verdict = classifyHumanoidPrompt(trimmedPrompt);
		humanoidInfo = {
			humanoid: verdict.humanoid,
			confidence: verdict.confidence,
			reason: verdict.reason,
		};
		if (!verdict.humanoid && allow_non_humanoid !== true) {
			return coreError(
				'not_a_character',
				`"${trimmedPrompt}" does not look like a humanoid character (${verdict.reason}). ` +
					'Auto-rigging needs a humanoid subject. Use forge_free or mesh_forge to generate a ' +
					'non-character mesh, or set allow_non_humanoid:true to rig it anyway.',
				{ humanoid: humanoidInfo },
			);
		}
	} else {
		humanoidInfo = {
			humanoid: true,
			confidence: 'low',
			reason: 'image-only request; trusting caller intent (no prompt to classify)',
		};
	}

	const aspect = VALID_ASPECT.has(aspect_ratio) ? aspect_ratio : '3:4';
	const base = apiBaseFrom(['MESH_FORGE_API_BASE']);
	const intervalMs = Number(env('FORGE_AVATAR_POLL_MS', '3000'));
	const started = Date.now();

	const runDirector =
		!imageMode && trimmedPrompt && direct !== false && env('FORGE_AVATAR_DIRECTOR', '1') !== '0';
	let directedPrompt = null;
	if (runDirector) {
		directedPrompt = await directPrompt({
			base,
			rawPrompt: trimmedPrompt,
			instruction: AVATAR_DIRECTOR_INSTRUCTION,
		});
	}
	const effectivePrompt = directedPrompt || trimmedPrompt;

	// Stage 1 — generate the textured mesh.
	const genStarted = Date.now();
	let genJob;
	try {
		genJob = await submitForge({
			base,
			payload: imageMode
				? { image_urls: views, prompt: effectivePrompt || undefined, aspect_ratio: aspect }
				: { prompt: effectivePrompt, aspect_ratio: aspect },
			submitTimeoutMs: 30_000,
			allowSyncDone: true,
		});
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message, {
			...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
		});
	}

	const genTimeout = Number(env('FORGE_AVATAR_GEN_TIMEOUT_MS', '180000'));
	let gen;
	if (genJob.status === 'done' && genJob.glb_url) {
		gen = genJob;
	} else {
		try {
			gen = await pollForge(genJob.job_id, {
				base,
				timeoutMs: genTimeout,
				intervalMs,
				failCode: 'generation_failed',
			});
		} catch (err) {
			return coreError(err.code || 'provider_error', err.message, {
				stage: 'generation',
				jobId: genJob.job_id,
				creationId: genJob.creation_id ?? null,
				durationMs: Date.now() - started,
			});
		}
		if (gen._timedOut) {
			return coreError('timeout', `generation did not finish within ${genTimeout}ms`, {
				stage: 'generation',
				jobId: genJob.job_id,
				creationId: genJob.creation_id ?? null,
				resumeUrl: `${base}/api/forge?job=${genJob.job_id}`,
				durationMs: Date.now() - started,
			});
		}
	}
	const meshGlbUrl = gen.glb_url;
	const generationMs = Date.now() - genStarted;

	// Stage 2 — auto-rig. Failures still surface meshGlbUrl so generation is not lost.
	const rigStarted = Date.now();
	let rigJob;
	try {
		rigJob = await startRig({ base, glbUrl: meshGlbUrl });
	} catch (err) {
		return coreError(err.code || 'provider_error', `rigging could not start: ${err.message}`, {
			stage: 'rig',
			meshGlbUrl,
			meshViewerUrl: `${base}/viewer?src=${encodeURIComponent(meshGlbUrl)}`,
			generationMs,
			durationMs: Date.now() - started,
			...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
		});
	}

	const rigTimeout = Number(env('FORGE_AVATAR_RIG_TIMEOUT_MS', '180000'));
	let rig;
	try {
		rig = await pollForge(rigJob.job_id, {
			base,
			timeoutMs: rigTimeout,
			intervalMs,
			failCode: 'rig_failed',
		});
	} catch (err) {
		return coreError(err.code || 'provider_error', `rigging failed: ${err.message}`, {
			stage: 'rig',
			meshGlbUrl,
			meshViewerUrl: `${base}/viewer?src=${encodeURIComponent(meshGlbUrl)}`,
			rigJobId: rigJob.job_id,
			generationMs,
			durationMs: Date.now() - started,
		});
	}
	if (rig._timedOut) {
		return coreError('timeout', `rigging did not finish within ${rigTimeout}ms`, {
			stage: 'rig',
			meshGlbUrl,
			meshViewerUrl: `${base}/viewer?src=${encodeURIComponent(meshGlbUrl)}`,
			rigJobId: rigJob.job_id,
			resumeUrl: `${base}/api/forge?job=${rigJob.job_id}`,
			generationMs,
			durationMs: Date.now() - started,
		});
	}

	const riggedGlbUrl = rig.glb_url;
	return {
		ok: true,
		mode: imageMode ? 'image_to_avatar' : 'text_to_avatar',
		riggedGlbUrl,
		meshGlbUrl,
		poseStudioUrl: `${base}/pose?src=${encodeURIComponent(riggedGlbUrl)}`,
		viewerUrl: `${base}/viewer?src=${encodeURIComponent(riggedGlbUrl)}`,
		animationReady: true,
		prompt: trimmedPrompt || null,
		imageUrls: imageMode ? views : null,
		viewsUsed: (gen.views_used ?? genJob.views_used) ?? (imageMode ? views.length : 0),
		backend: (gen.backend ?? genJob.backend) ?? null,
		directedPrompt: directedPrompt || null,
		directed: Boolean(directedPrompt),
		humanoid: humanoidInfo,
		meshCreationId: gen.creation_id ?? genJob.creation_id ?? null,
		riggedCreationId: rig.creation_id ?? rigJob.creation_id ?? null,
		rigJobId: rigJob.job_id,
		durable: Boolean(rig.durable),
		generationMs,
		rigMs: Date.now() - rigStarted,
		durationMs: Date.now() - started,
		fetchedAt: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// text_to_avatar — text/image → 3D GLB avatar via Replicate (Hunyuan-3D).
// ---------------------------------------------------------------------------
const REPLICATE_BASE = 'https://api.replicate.com/v1';

function replicateAuthHeaders() {
	const token = env('REPLICATE_API_TOKEN');
	if (!token) {
		const err = new Error('REPLICATE_API_TOKEN is not configured on the server');
		err.code = 'not_configured';
		throw err;
	}
	return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function extractGlbUrl(output) {
	if (!output) return null;
	if (typeof output === 'string') return output;
	if (Array.isArray(output)) {
		for (const v of output) {
			if (typeof v === 'string' && /\.glb(\?|$)/i.test(v)) return v;
		}
		for (const v of output) {
			if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
		}
	}
	if (typeof output === 'object') {
		for (const key of ['glb', 'mesh', 'mesh_url', 'output_url', 'url', 'model']) {
			if (typeof output[key] === 'string') return output[key];
		}
	}
	return null;
}

async function submitPrediction({ version, input }) {
	const res = await fetch(`${REPLICATE_BASE}/predictions`, {
		method: 'POST',
		headers: replicateAuthHeaders(),
		body: JSON.stringify({ version, input }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(data?.detail || data?.title || `replicate returned ${res.status}`);
		err.code = 'provider_error';
		err.providerStatus = res.status;
		throw err;
	}
	return data;
}

async function pollPrediction(predictionId, { timeoutMs, intervalMs }) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	const perFetchTimeoutMs = Math.max(intervalMs * 3, 10_000);
	while (Date.now() < deadline) {
		let r;
		try {
			r = await fetch(`${REPLICATE_BASE}/predictions/${encodeURIComponent(predictionId)}`, {
				headers: replicateAuthHeaders(),
				signal: AbortSignal.timeout(perFetchTimeoutMs),
			});
		} catch (err) {
			if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
				await sleep(intervalMs);
				continue;
			}
			const e = new Error(`replicate poll fetch failed: ${err?.message || err}`);
			e.code = 'provider_error';
			throw e;
		}
		const data = await r.json().catch(() => ({}));
		if (!r.ok) {
			const err = new Error(data?.detail || `replicate poll returned ${r.status}`);
			err.code = 'provider_error';
			throw err;
		}
		last = data;
		const s = data.status;
		if (s === 'succeeded' || s === 'failed' || s === 'canceled') return data;
		await sleep(intervalMs);
	}
	return { ...last, _timedOut: true };
}

async function rehostIfRequested(glbUrl, { prompt, images }) {
	if (env('MCP_TEXT_TO_AVATAR_REHOST', '0') !== '1') return null;
	const endpoint = env('MCP_REHOST_ENDPOINT', 'https://three.ws/api/avatars/ingest-url');
	const ingestKey = env('MCP_REHOST_KEY');
	if (!ingestKey) return null;
	try {
		const r = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ingestKey}` },
			body: JSON.stringify({
				source_url: glbUrl,
				name: (prompt || 'text-to-avatar').slice(0, 80),
				source: 'mcp',
				source_meta: { provider: 'replicate', prompt, images },
			}),
		});
		if (!r.ok) return { error: `rehost failed: ${r.status}` };
		return await r.json();
	} catch (err) {
		return { error: err?.message || 'rehost call failed' };
	}
}

export async function runTextToAvatar({ prompt, images, seed, texture }) {
	const version = env('REPLICATE_TEXT_TO_AVATAR_MODEL');
	if (!version) {
		return coreError(
			'not_configured',
			'REPLICATE_TEXT_TO_AVATAR_MODEL is not set on the server. Pin a commercial-OK image/text-to-3D version (e.g. tencent/hunyuan-3d-3.1 latest).',
		);
	}
	if (!prompt && (!images || images.length === 0)) {
		return coreError('invalid_input', 'Provide either prompt or images[].');
	}
	const input = {
		prompt: prompt || undefined,
		image: images && images.length ? images[0] : undefined,
		images: images && images.length ? images : undefined,
		seed: typeof seed === 'number' ? seed : undefined,
		texture: typeof texture === 'boolean' ? texture : true,
	};
	Object.keys(input).forEach((k) => input[k] === undefined && delete input[k]);

	const started = Date.now();
	let submitted;
	try {
		submitted = await submitPrediction({ version, input });
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message);
	}

	const timeoutMs = Number(env('MCP_TEXT_TO_AVATAR_TIMEOUT_MS', '110000'));
	const intervalMs = Number(env('MCP_TEXT_TO_AVATAR_POLL_MS', '2000'));
	let finalState;
	try {
		finalState = await pollPrediction(submitted.id, { timeoutMs, intervalMs });
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message, { predictionId: submitted.id });
	}

	const durationMs = Date.now() - started;
	if (finalState._timedOut) {
		return coreError('timeout', `prediction did not finish within ${timeoutMs}ms`, {
			predictionId: submitted.id,
			status: finalState.status,
			resumeUrl: `${REPLICATE_BASE}/predictions/${submitted.id}`,
			durationMs,
		});
	}
	if (finalState.status === 'failed' || finalState.status === 'canceled') {
		return coreError(
			'prediction_failed',
			finalState.error || `prediction ended with status ${finalState.status}`,
			{ predictionId: submitted.id, durationMs },
		);
	}

	const glbUrl = extractGlbUrl(finalState.output);
	if (!glbUrl) {
		return coreError('no_glb_in_output', 'prediction succeeded but no GLB url was found in output', {
			rawOutput: finalState.output,
			predictionId: submitted.id,
			durationMs,
		});
	}

	const rehost = await rehostIfRequested(glbUrl, { prompt, images });
	return {
		ok: true,
		predictionId: submitted.id,
		glbUrl,
		rehosted: rehost,
		prompt: prompt || null,
		images: images || null,
		seed: typeof seed === 'number' ? seed : null,
		model: version,
		durationMs,
		preview: `https://three.ws/viewer?src=${encodeURIComponent(glbUrl)}`,
		fetchedAt: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// refine_model — conversational refinement: carry a model forward with a
// natural-language change instruction. The prior prompt is folded into the new
// generation prompt so form, material, and subject carry forward. A reference
// image (2D preview/screenshot of the parent) anchors the generation when
// provided; otherwise text-only re-generation is used — still real, still
// anchored through the composed prompt.
//
// Lineage: pass parent_lineage to extend an existing version history, or omit
// to start a fresh lineage rooted at glb_url. The returned lineage array
// supports revert (pointer move, no mutation) and branch (parentIndex override).
// ---------------------------------------------------------------------------
export async function runRefineModel({
	glb_url,
	instruction,
	parent_prompt,
	parent_lineage,
	parent_index,
	reference_image_url,
}) {
	if (!glb_url || typeof glb_url !== 'string' || !glb_url.trim()) {
		return coreError('invalid_input', 'Provide glb_url of the model to refine.');
	}
	const instructionTrimmed = typeof instruction === 'string' ? instruction.trim() : '';
	if (!instructionTrimmed) {
		return coreError('invalid_input', 'Provide an instruction describing the change to make.');
	}

	const parentPromptStr = typeof parent_prompt === 'string' ? parent_prompt.trim() : '';
	const composedPrompt = composeRefinement(parentPromptStr, instructionTrimmed);

	// Resolve starting lineage: extend an existing one, or seed from the parent.
	// A caller-supplied parent_lineage is UNTRUSTED — validate its structural
	// integrity (contiguous indices, single root, no cycles) with buildLineageChain
	// before extending. A malformed array falls back to a fresh lineage rooted at
	// glb_url rather than corrupting history.
	const baseLineage =
		Array.isArray(parent_lineage) && parent_lineage.length > 0 && buildLineageChain(parent_lineage).ok
			? parent_lineage
			: seedLineage({ glbUrl: glb_url.trim(), prompt: parentPromptStr || null });

	// Branch point: branchFrom validates the index against the lineage; an
	// out-of-range index falls back to extending the leaf.
	let effectiveParentIndex;
	if (Number.isInteger(parent_index)) {
		try {
			effectiveParentIndex = branchFrom(baseLineage, parent_index);
		} catch {
			effectiveParentIndex = undefined;
		}
	}

	const base = apiBaseFrom(['MESH_FORGE_API_BASE']);
	const started = Date.now();

	const refImageUrl =
		typeof reference_image_url === 'string' && reference_image_url.trim()
			? reference_image_url.trim()
			: null;

	let job;
	try {
		job = await submitForge({
			base,
			payload: refImageUrl
				? { image_urls: [refImageUrl], prompt: composedPrompt }
				: { prompt: composedPrompt },
			submitTimeoutMs: 30_000,
			allowSyncDone: false,
		});
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message, {
			...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
		});
	}

	const timeoutMs = Number(env('REFINE_MODEL_TIMEOUT_MS', '180000'));
	const intervalMs = Number(env('REFINE_MODEL_POLL_MS', '3000'));
	let final;
	try {
		final = await pollForge(job.job_id, { base, timeoutMs, intervalMs });
	} catch (err) {
		return coreError(err.code || 'provider_error', err.message, {
			jobId: job.job_id,
			creationId: job.creation_id ?? null,
			durationMs: Date.now() - started,
		});
	}

	const durationMs = Date.now() - started;
	if (final._timedOut) {
		return coreError('timeout', `refinement did not finish within ${timeoutMs}ms`, {
			jobId: job.job_id,
			creationId: job.creation_id ?? null,
			status: final.status || 'running',
			resumeUrl: `${base}/api/forge?job=${job.job_id}`,
			durationMs,
		});
	}

	const newGlbUrl = final.glb_url;
	const viewerUrl = `${base}/viewer?src=${encodeURIComponent(newGlbUrl)}`;

	const lineage = appendVersion(baseLineage, {
		glbUrl: newGlbUrl,
		viewerUrl,
		prompt: composedPrompt,
		instruction: instructionTrimmed,
		refKind: refImageUrl ? 'image' : 'text',
		...(effectiveParentIndex !== undefined ? { parentIndex: effectiveParentIndex } : {}),
	});
	const activeIndex = lineage.length - 1;

	return {
		ok: true,
		mode: 'refine',
		glbUrl: newGlbUrl,
		viewerUrl,
		composedPrompt,
		instruction: instructionTrimmed,
		parentGlbUrl: glb_url.trim(),
		anchored: Boolean(refImageUrl),
		referenceImageUrl: refImageUrl,
		backend: (final.backend ?? job.backend) ?? null,
		jobId: job.job_id,
		creationId: final.creation_id ?? job.creation_id ?? null,
		durable: Boolean(final.durable),
		lineage,
		activeIndex,
		durationMs,
		fetchedAt: new Date().toISOString(),
	};
}
