// NVIDIA NIM provider — the FREE TRELLIS 3D-generation backend (TEXT-ONLY).
//
// Microsoft TRELLIS hosted on NVIDIA NVCF gives `/forge` a zero-vendor-cost
// text→3D lane (GLB output) behind the platform `NVIDIA_API_KEY`. Per the
// platform free-first policy it is the default draft backend for prompt
// generations, with the paid Replicate/Meshy/Tripo lanes staying selectable.
//
// ── Why text-only ────────────────────────────────────────────────────────────
// The hosted preview API does NOT accept user images for mode:"image": every
// form — inline base64 at any size, NVCF asset references (`;asset_id,` with
// NVCF-INPUT-ASSET-REFERENCES), bare asset ids — is rejected 422; the only
// accepted image input is `data:image/png;example_id,{0..3}` referencing
// NVIDIA's predefined sample images. Verified live 2026-06-11 against the real
// endpoint and confirmed by the official schema docs — full transcripts in
// tasks/nvidia-nim/probes/trellis.md. Self-deployed TRELLIS NIMs accept real
// image input, so this constraint is about NVIDIA's hosted preview, not the
// model; if NVIDIA lifts it, the asset handshake recipe is preserved in the
// probe file and git history.
//
// The forge layer therefore routes user-photo submissions to the standing
// image backend (Replicate TRELLIS) and only sends prompts here — see
// resolveBackendId({ userImages }) in api/_lib/forge-tiers.js.
//
// ── Protocol (verified live, T0.2/T1.1 probes) ──────────────────────────────
//   submit  POST https://ai.api.nvidia.com/v1/genai/microsoft/trellis
//           Authorization: Bearer nvapi-…   Accept: application/json
//           { mode:"text", prompt, seed?, ss_sampling_steps, slat_sampling_steps, output_format:"glb" }
//           → 202 + header NVCF-REQID  (async; poll)   |   200 + body (synchronous completion)
//
//   poll    GET https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{NVCF-REQID}
//           → 202 (still running)   |   200 (done, body holds the GLB)
//
//   result  The GLB rides inside `body.artifacts[0]`, but the hosted NVCF preview
//           has shipped it in SEVERAL shapes over time — the original
//           `{ base64 }` object is no longer the only one observed in prod. The
//           extractor (extractGlbBase64) normalizes all of:
//             • { artifacts: [ { base64 } ] }     inline base64 (original)
//             • { artifacts: [ { data } ] }        inline base64 under `data`
//             • { artifacts: [ "<base64 string>" ] }   bare string, no wrapper
//             • { artifacts: [ { url } ] }         CDN URL → fetched + buffered here
//             • { artifacts: { "0": {…} } }        object with numeric-string keys
//           plus raw-bytes (model/gltf-binary | octet-stream) when Accept is
//           ignored. Whatever the shape, we end up with GLB bytes, persist them to
//           R2, and hand back a durable public URL like the other providers
//           (replicate/meshy return upstream URLs; TRELLIS hands us the bytes — or
//           a short-lived CDN URL — so WE own the durable persist). On an
//           unrecognized shape the warn logs `json keys=[…] artifact[0]=[…]` so the
//           next schema drift is visible in the first failure without guessing.
//
// Error codes match the established provider contract (replicate.js / meshy.js):
//   provider_unreachable / invalid_key / insufficient_credits / rate_limited /
//   provider_error — so the forge layer can route around a dead/limited lane.

import { env } from '../_lib/env.js';

const TRELLIS_INVOKE_URL = 'https://ai.api.nvidia.com/v1/genai/microsoft/trellis';
const NVCF_STATUS_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

// TRELLIS truncates the text prompt at 77 characters server-side; clamp so the
// request is honest about what's actually conditioning the generation.
const TRELLIS_PROMPT_MAX = 77;

// Without explicit lighting/color hints TRELLIS defaults to dark, gritty
// aesthetics. Reserve 17 chars at the end for a studio-lighting suffix and
// append it unless the caller already included their own lighting/color cues.
const TRELLIS_STYLE_SUFFIX = ', studio lighting';
const TRELLIS_STYLE_WORDS = ['studio', 'light', 'bright', 'backlit', 'colorful', 'vibrant', 'cartoon', 'stylized'];

function enhanceTrellisPrompt(raw) {
	const text = String(raw || '').trim();
	const lower = text.toLowerCase();
	const hasStyle = TRELLIS_STYLE_WORDS.some((w) => lower.includes(w));
	if (hasStyle) return text.slice(0, TRELLIS_PROMPT_MAX);
	const maxBase = TRELLIS_PROMPT_MAX - TRELLIS_STYLE_SUFFIX.length;
	return text.slice(0, maxBase) + TRELLIS_STYLE_SUFFIX;
}

// NVCF pexec hands off long jobs to async polling: the gateway holds the invoke
// connection open for at most NVCF-POLL-SECONDS waiting for a synchronous
// completion, then returns 202 + NVCF-REQID so we poll. WITHOUT this header the
// gateway held the connection until our own AbortSignal fired ("operation aborted
// due to timeout") and the request id was lost with the aborted socket — so a
// merely-slow generation surfaced as a hard "nvidia unreachable" and the whole
// free text→3D lane fell over. Capping the synchronous window at 30 s converts
// "slow" into a normal queued+poll job (the path the 202 branch already handles)
// while still completing fast draft jobs (~12–13 s) inline.
const NVCF_POLL_SECONDS = 30;

// Per-request timeouts so a hung upstream never stalls a serverless function.
// A completed poll streams the full GLB (can be several MB), so it gets longer.
// Submit only needs to outlast the NVCF-POLL-SECONDS synchronous window (30 s)
// plus transfer/handshake slack — at 35 s the gateway has already returned its
// 202 long before this backstop fires. (Was 45s; tightened — see
// SUBMIT_PHASE_DEADLINE_MS below for why a hard hang with zero response now
// aborts sooner instead of stacking with the retry budget.)
const SUBMIT_TIMEOUT_MS = 35_000;
const POLL_TIMEOUT_MS = 60_000;

// NVCF can answer a cold model — or a momentary capacity/routing blip at the
// gateway — with a transient 502/503/504, or drop the socket before a worker is
// warm. None of these is terminal: a short retry usually lands once the model
// spins up, which keeps the FREE lane from dead-ending straight to the (often
// equally throttled) paid Replicate lane and surfacing to the user as a hard 502.
// A hosted-preview 504 is the single most common blip (the gateway gives up on a
// slow worker), and it returns FAST — so retrying it a couple of times with
// spaced-out backoff is cheap and lands most of them on a warmed node, which is
// the main lever that stops a transient 504 from tripping the lane cooldown and
// dumping the request on the paid lane. Bounded to MAX_INVOKE_ATTEMPTS so a
// genuinely-down upstream still fails over fast rather than burning the whole
// serverless budget on a dead provider.
const GATEWAY_RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_INVOKE_ATTEMPTS = 3;
const INVOKE_RETRY_BASE_MS = 1_000;
const INVOKE_RETRY_MAX_MS = 6_000;

// Overall wall-clock budget for the WHOLE submit-with-retries phase, on top of
// the per-attempt/per-status bounds above. Root-caused live 2026-07-08: with
// NVCF's hosted TRELLIS gateway in a degraded state, every invoke attempt
// returned HTTP 504 (`nvcf-status: errored`, empty body) at ~32s — comfortably
// under the (then) 45s per-attempt SUBMIT_TIMEOUT_MS, so it was never the
// per-attempt guard that fired. But MAX_INVOKE_ATTEMPTS retries stack: 3
// attempts x ~32s + 2 backoff sleeps totalled ~96-108s server-side — LONGER
// than every downstream client-side submit timeout guarding this call
// (api/_mcp-studio/forge-client.js `startForge` and
// mcp-server/src/tools/_studio-core.js `submitForge`, both 90s). So the caller
// (curl, the `forge_free` MCP tool, `/api/forge` itself) always saw a bare
// timeout with zero bytes, even though this provider would have correctly
// reported the lane as down and let forge.js's own "never dead-end" fallback
// (backendId='trellis' -> Replicate/HuggingFace) run — just too late, after
// every caller had already given up. This deadline stops the retry loop with
// enough of that 90s client budget left for the fallback lane to actually run
// and answer, instead of guaranteeing a client-side timeout on every request
// while NVCF is in this state. Self-adjusting: if NVCF's real failure latency
// changes, this still bounds the worst case rather than relying on a
// hand-tuned attempt count matching today's ~32s number.
//
// Sized at 30s (under one ~32s degraded-gateway attempt) so THIS failure mode —
// a single attempt already burning ~32s — bails after exactly one attempt,
// leaving ~55-60s of the 90s client budget for the FLUX-synthesis +
// Replicate-submit fallback (api/forge.js: backendId='trellis') to actually
// complete. A gateway that fails FAST (the common transient blip, a few
// hundred ms to a couple seconds) still gets its full MAX_INVOKE_ATTEMPTS
// retries, since each barely moves the elapsed-time needle against this
// budget; only a slow-failing gateway forfeits retries — which is exactly the
// case where they aren't worth the client's patience anyway.
const SUBMIT_PHASE_DEADLINE_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Backoff between invoke retries: exponential (base · 2^(n-1), capped) with full
// jitter so concurrent retries don't resynchronize into a thundering herd against
// a single warming node. When the gateway hands back a Retry-After we honour it
// (capped) instead of guessing.
function invokeRetryDelayMs(attempt, retryAfterSeconds) {
	const hinted = Number(retryAfterSeconds);
	if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, INVOKE_RETRY_MAX_MS);
	const ceiling = Math.min(INVOKE_RETRY_BASE_MS * 2 ** (attempt - 1), INVOKE_RETRY_MAX_MS);
	return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

// Sampling steps per quality tier. TRELLIS accepts 10–50, but the NVIDIA HOSTED
// preview at this endpoint only returns within the gateway's synchronous window
// at the low end: a 15-step draft completes in ~13 s, while 25 steps overruns the
// gateway (it neither finishes inline nor hands back a pollable NVCF-REQID before
// our submit timeout), so the whole free lane aborts and silently degrades to the
// PAID Replicate fallback — exactly the "standard tier doesn't work like draft"
// failure. So the free hosted lane is pinned to the proven 15-step budget for both
// draft and standard; the tiers still differ in polycount/price (the catalog) and
// in the higher-fidelity PAID lanes a user can select. High routes to HuggingFace,
// not here, by default; its 40 stays for a self-hosted NIM (which serves the full
// window) if one is ever pointed at this provider.
function trellisSteps(tier) {
	const id = tier?.id || tier || 'draft';
	switch (id) {
		case 'high':
			return { ss: 40, slat: 40 };
		case 'standard':
		case 'draft':
		default:
			return { ss: 15, slat: 15 };
	}
}

// Map an upstream HTTP status onto the normalized error the forge layer routes
// on. `retryAfter` (seconds) is attached for 429 so callers can back off.
function providerError(status, message, retryAfter) {
	let code = 'provider_error';
	let mapped = 502;
	if (status === 401 || status === 403) {
		code = 'invalid_key';
		mapped = 401;
	} else if (status === 402) {
		code = 'insufficient_credits';
		mapped = 402;
	} else if (status === 429) {
		code = 'rate_limited';
		mapped = 429;
	}
	const err = Object.assign(new Error(message || `NVIDIA returned ${status}`), {
		code,
		status: mapped,
		providerStatus: status,
	});
	if (retryAfter != null) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) err.retryAfter = secs;
	}
	return err;
}

// Pull the GLB out of a successful TRELLIS response. The documented and common
// shape is JSON `{ artifacts: [{ base64 }] }`, but NVCF can also return the raw
// GLB bytes directly (model/gltf-binary or octet-stream), or a URL-based artifact
// `{ artifacts: [{ url: "https://..." }] }` (observed when NVIDIA serves the GLB
// from an asset CDN instead of inlining it). Accept all three. When none match,
// return a compact diagnostic that shows both the top-level keys AND the
// artifact[0] keys so the real upstream shape shows up in the logs precisely.
async function extractGlbBase64(res) {
	const ct = (res.headers.get('content-type') || '').toLowerCase();
	if (ct.includes('json')) {
		const data = await res.json().catch(() => null);
		const artifact0 = data?.artifacts?.[0];

		// String artifact — NVIDIA sometimes returns the base64 string directly in
		// the artifacts array rather than wrapped in an object { base64 }. Accept it
		// unless it looks like a URL (those go through the artifactUrl path below).
		if (typeof artifact0 === 'string' && artifact0.length > 0 && !artifact0.startsWith('http')) {
			return { base64: artifact0 };
		}

		// Inline base64 — the documented shape; also accept output[] variants.
		const inlineData = artifact0?.base64 ?? artifact0?.data ?? null;
		const inlineB64 =
			(typeof inlineData === 'string' && !inlineData.startsWith('http') ? inlineData : null) ||
			(typeof data?.output === 'string' ? data.output : null) ||
			data?.output?.[0]?.base64 ||
			null;
		if (inlineB64) return { base64: inlineB64 };

		// URL-based artifact — NVIDIA may serve the GLB from an asset CDN.
		const artifactUrl =
			(typeof artifact0?.url === 'string' ? artifact0.url : null) ||
			(typeof inlineData === 'string' && inlineData.startsWith('http') ? inlineData : null) ||
			null;
		if (artifactUrl) {
			try {
				const artRes = await fetch(artifactUrl, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
				if (!artRes.ok) {
					return { base64: null, diag: `artifact url fetch ${artRes.status}: ${artifactUrl.slice(0, 80)}` };
				}
				const buf = Buffer.from(await artRes.arrayBuffer());
				if (buf.length > 0) return { base64: buf.toString('base64') };
				return { base64: null, diag: `artifact url returned empty body: ${artifactUrl.slice(0, 80)}` };
			} catch (err) {
				return { base64: null, diag: `artifact url fetch error: ${err?.message}` };
			}
		}

		// Build a precise diagnostic showing top-level keys and artifact[0] shape so
		// the actual upstream response is visible in the logs without guessing.
		const topKeys = data && typeof data === 'object' ? JSON.stringify(Object.keys(data)) : 'unparseable';
		const arts = data?.artifacts;
		let artDesc = '';
		if (Array.isArray(arts)) {
			if (arts.length === 0) {
				artDesc = ' artifacts=[]';
			} else if (artifact0 && typeof artifact0 === 'object') {
				artDesc = ` artifact[0]=${JSON.stringify(Object.keys(artifact0))}`;
			} else {
				artDesc = ` artifact[0]=${typeof artifact0}`;
			}
		} else if (arts !== null && arts !== undefined && typeof arts === 'object') {
			// NVIDIA sometimes returns artifacts as an object with numeric string keys
			// (e.g. {"0": {"base64": "..."}}) — try to extract the same way as an array.
			const firstVal = arts['0'] ?? Object.values(arts)[0] ?? null;
			const firstB64 = firstVal?.base64 ?? (typeof firstVal === 'string' && !firstVal.startsWith('http') ? firstVal : null);
			if (firstB64) return { base64: firstB64 };
			const firstUrl = firstVal?.url ?? (typeof firstVal === 'string' && firstVal.startsWith('http') ? firstVal : null);
			if (firstUrl) {
				try {
					const artRes = await fetch(firstUrl, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
					if (artRes.ok) {
						const buf = Buffer.from(await artRes.arrayBuffer());
						if (buf.length > 0) return { base64: buf.toString('base64') };
					}
				} catch { /* fall through to diagnostic */ }
			}
			artDesc = ` artifacts(object)=${JSON.stringify(Object.keys(arts)).slice(0, 80)}`;
		} else {
			artDesc = ` artifacts=${arts === null ? 'null' : typeof arts}`;
		}
		return { base64: null, diag: `json keys=${topKeys}${artDesc}` };
	}
	if (ct.includes('gltf') || ct.includes('octet-stream') || ct.startsWith('model/') || ct.includes('binary')) {
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > 0) return { base64: buf.toString('base64') };
		return { base64: null, diag: `empty ${ct} body` };
	}
	const text = await res.text().catch(() => '');
	return { base64: null, diag: `ct=${ct || 'none'} body[0:160]=${text.slice(0, 160)}` };
}

function buildTextBody({ prompt, tier, seed }) {
	const steps = trellisSteps(tier);
	const body = {
		mode: 'text',
		prompt: enhanceTrellisPrompt(prompt),
		ss_sampling_steps: steps.ss,
		slat_sampling_steps: steps.slat,
		output_format: 'glb',
	};
	if (Number.isInteger(seed)) body.seed = seed;
	return body;
}

export function createNvidiaProvider() {
	const apiKey = env.NVIDIA_API_KEY;
	if (!apiKey) {
		throw Object.assign(
			new Error('NVIDIA_API_KEY env var is required for the nvidia (TRELLIS) provider'),
			{ code: 'missing_key', status: 503 },
		);
	}

	const authHeader = { authorization: `Bearer ${apiKey}` };
	const invokeHeaders = {
		...authHeader,
		accept: 'application/json',
		'content-type': 'application/json',
		// Bound the gateway's synchronous hold so a slow job becomes a pollable 202
		// instead of timing out our socket and losing the request id (see above).
		'nvcf-poll-seconds': String(NVCF_POLL_SECONDS),
	};
	// NVCF pexec results are CONSUME-ONCE: the first status GET that receives the
	// 200 body takes the artifact with it — a later poll 404s. Without an explicit
	// poll window the gateway may long-hold the status connection until the job
	// finishes; if our own POLL_TIMEOUT_MS abort fires while that 200 is being
	// delivered, the result is consumed by a socket nobody read and the job is
	// unrecoverable ("NVCF request not found or expired"). A short explicit window
	// makes every status call answer fast (202 or the ready 200) long before the
	// abort backstop, closing that loss window.
	const pollHeaders = { ...authHeader, accept: 'application/json', 'nvcf-poll-seconds': '10' };

	// Decode a base64 GLB and store it in R2, returning a durable public URL —
	// the same persist the Vertex inline-PNG path uses, but for model bytes.
	async function persistGlb(base64) {
		const { putObject, publicUrl } = await import('../_lib/r2.js');
		const key = `forge/nvidia/${globalThis.crypto.randomUUID()}.glb`;
		await putObject({
			key,
			body: Buffer.from(base64, 'base64'),
			contentType: 'model/gltf-binary',
		});
		return publicUrl(key);
	}

	// POST the invoke request. Returns either { done:true, glbBase64 } when the
	// generation completed synchronously (200) or { done:false, reqId } when NVCF
	// accepted it for async processing (202). Throws normalized provider errors.
	async function postInvoke(body, extraHeaders) {
		let lastErr = null;
		const phaseStart = Date.now();
		// True once the overall submit-phase budget (SUBMIT_PHASE_DEADLINE_MS) is
		// spent — checked before every retry so a degraded gateway (each attempt
		// individually within its per-attempt timeout, but repeatedly failing)
		// still bails with time left for forge.js's own lane fallback to run,
		// instead of stacking MAX_INVOKE_ATTEMPTS full attempts unconditionally.
		const deadlineExceeded = () => Date.now() - phaseStart >= SUBMIT_PHASE_DEADLINE_MS;
		for (let attempt = 1; attempt <= MAX_INVOKE_ATTEMPTS; attempt++) {
			let res;
			try {
				res = await fetch(TRELLIS_INVOKE_URL, {
					method: 'POST',
					headers: { ...invokeHeaders, ...extraHeaders },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
				});
			} catch (err) {
				lastErr = Object.assign(new Error(`nvidia unreachable: ${err?.message}`), {
					code: 'provider_unreachable',
					status: 502,
				});
				// A SUBMIT_TIMEOUT abort means the gateway held our connection open without
				// finishing or handing back a pollable id — retrying just hangs for another
				// full window (the bug that turned a slow lane into a ~90 s double-timeout
				// before failover). Make it terminal so the forge layer fails over to the
				// next lane fast. A genuine socket/DNS blip (not a timeout) still gets one
				// retry, so a single dropped connection doesn't fail the whole free lane.
				const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
				if (!timedOut && attempt < MAX_INVOKE_ATTEMPTS && !deadlineExceeded()) {
					await sleep(invokeRetryDelayMs(attempt));
					continue;
				}
				throw lastErr;
			}

			if (res.status === 202) {
				const reqId = res.headers.get('nvcf-reqid');
				if (!reqId) {
					throw Object.assign(new Error('NVCF accepted the job but returned no NVCF-REQID'), {
						code: 'provider_error',
						status: 502,
					});
				}
				return { done: false, reqId };
			}

			if (res.ok) {
				// NVCF sometimes returns 200 (instead of 202) with { artifacts: [] } and
				// an NVCF-REQID header when routing to async processing. Read the header
				// before consuming the body so we can fall through to the poll path.
				const reqId = res.headers.get('nvcf-reqid');
				const { base64, diag } = await extractGlbBase64(res);
				if (!base64) {
					if (reqId) {
						// Async job on 200 — same path as 202.
						return { done: false, reqId };
					}
					console.warn('[nvidia] sync 200 but no GLB artifact — %s', diag);
					throw Object.assign(new Error('TRELLIS completed but returned no GLB artifact'), {
						code: 'provider_error',
						status: 502,
					});
				}
				return { done: true, glbBase64: base64 };
			}

			// Transient gateway status — the model is likely cold-starting or a node
			// is momentarily unavailable. Drain the body so the socket frees, then
			// retry once; everything else (auth, quota, 4xx, 429) is terminal here and
			// surfaced as a normalized provider error the forge layer routes around.
			if (GATEWAY_RETRY_STATUSES.has(res.status) && attempt < MAX_INVOKE_ATTEMPTS) {
				await res.text().catch(() => {});
				const retryAfter = res.headers.get('retry-after');
				lastErr = providerError(res.status, undefined, retryAfter);
				// Live-verified 2026-07-08: a degraded NVCF gateway answers EVERY attempt
				// with a fast-but-not-instant 504 (~32s, `nvcf-status: errored`) — each
				// attempt alone looks like "a normal retryable blip", but three of them
				// plus backoff blew past every downstream client timeout (see
				// SUBMIT_PHASE_DEADLINE_MS above). Stop retrying once the overall phase
				// budget is spent, even if attempts remain.
				if (deadlineExceeded()) throw lastErr;
				await sleep(invokeRetryDelayMs(attempt, retryAfter));
				continue;
			}

			let detail = '';
			try {
				const d = await res.json();
				detail = d?.detail || d?.message || d?.title || '';
				// TRELLIS 422s carry `detail` as an array of validation objects — keep
				// it human-readable rather than collapsing to "[object Object]".
				if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
			} catch {
				detail = await res.text().catch(() => '');
			}
			throw providerError(res.status, detail || undefined, res.headers.get('retry-after'));
		}
		// Exhausted retries on a transient status/throw without a terminal verdict.
		throw (
			lastErr ||
			Object.assign(new Error('nvidia invoke failed after retries'), {
				code: 'provider_error',
				status: 502,
			})
		);
	}

	// Finish a submission: persist immediately on synchronous completion,
	// otherwise return the poll handle. Shared by the text and image paths.
	async function finishSubmit(kind, parsed) {
		if (parsed.done) {
			const resultGlbUrl = await persistGlb(parsed.glbBase64);
			return { kind, taskId: null, resultGlbUrl };
		}
		return { kind, taskId: parsed.reqId };
	}

	return {
		// Native text→3D. Returns a poll handle, or a ready R2 GLB URL when NVCF
		// completed the job within the submit request.
		async textTo3d({ prompt, tier, seed } = {}) {
			const parsed = await postInvoke(buildTextBody({ prompt, tier, seed }), {});
			return finishSubmit('text-to-3d', parsed);
		},

		// Poll an async job. Never throws — transient failures resolve to
		// 'running' so the forge poll loop keeps the job alive; only terminal
		// upstream states map to 'failed'. On 'done' the GLB is decoded, persisted
		// to R2, and returned as a durable public URL.
		async status({ taskId } = {}) {
			if (!taskId) return { status: 'failed', error: 'missing NVCF request id' };

			let res;
			try {
				res = await fetch(`${NVCF_STATUS_URL}/${encodeURIComponent(taskId)}`, {
					headers: pollHeaders,
					signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
				});
			} catch (err) {
				return { status: 'running', error: `nvidia poll failed: ${err?.message}` };
			}

			if (res.status === 202) return { status: 'running' };

			if (res.ok) {
				const { base64, diag } = await extractGlbBase64(res);
				if (!base64) {
					console.warn('[nvidia] poll 200 but no GLB artifact — %s', diag);
					return { status: 'failed', error: 'TRELLIS finished but returned no GLB artifact' };
				}
				try {
					const resultGlbUrl = await persistGlb(base64);
					return { status: 'done', resultGlbUrl };
				} catch (err) {
					return { status: 'failed', error: `failed to persist GLB: ${err?.message}` };
				}
			}

			if (res.status === 401 || res.status === 403) {
				return { status: 'failed', error: 'NVIDIA rejected the API key' };
			}
			if (res.status === 404) {
				// The request id is gone: either the consume-once result was taken by a
				// racing/aborted poll, or NVCF's retention window lapsed. Tagged with a
				// machine-readable code so the forge poll layer can attempt recovery
				// (re-check the store for a racing completion, then resubmit) instead of
				// dead-ending the user's generation.
				return { status: 'failed', error: 'NVCF request not found or expired', code: 'nvcf_expired' };
			}
			// 429 / 5xx mid-flight: the job may still be alive — keep polling.
			if (res.status === 429) {
				return { status: 'running', error: 'NVIDIA is rate limiting; will retry' };
			}
			return { status: 'running', error: `NVIDIA poll returned ${res.status}` };
		},
	};
}
