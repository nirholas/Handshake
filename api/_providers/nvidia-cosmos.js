// NVIDIA Cosmos provider — the FREE text→world VIDEO backend.
//
// Cosmos is NVIDIA's omnimodal World Foundation Model family for Physical AI.
// The `cosmos-predict` line generates a short photoreal video of a world state
// from a text prompt (Text2World) — a living, physically-plausible scene. We use
// it to bring an avatar to life: a generated animated world plays behind the
// static 3D avatar render, turning a still portrait into a cinematic shot.
//
// This is the video sibling of api/_providers/nvidia.js (TRELLIS text→3D) and
// api/_mcp3d/text-to-image.js (FLUX text→image): the SAME platform NVIDIA_API_KEY
// (nvapi-…) unlocks it on the NVIDIA NIM catalog at zero vendor cost, behind the
// SAME NVCF async gateway (202 + NVCF-REQID → poll pexec/status), so the forge
// poll loop and persistence (R2) work identically.
//
// ── Why Text2World (and not image→video) ─────────────────────────────────────
// NVIDIA's HOSTED preview gateway rejects user-supplied images for the visual
// models — verified live against TRELLIS (see the header of nvidia.js: every
// inline/asset image form 422s; only NVIDIA's own predefined sample images are
// accepted). Cosmos Video2World on the hosted tier carries the same constraint,
// so the lowest-friction, always-available capability is Text2World: a prompt is
// the only input, and it produces the most visually striking result for the
// avatar backdrop. A self-deployed Cosmos NIM accepts real image conditioning;
// if NVIDIA lifts the hosted-image restriction, the same provider extends to
// Video2World by adding the image input to buildWorldBody().
//
// ── Protocol (NVCF genai gateway — same shape verified live for TRELLIS) ──────
//   submit  POST {INVOKE_URL}
//           Authorization: Bearer nvapi-…   Accept: application/json
//           KServe v2 body: { inputs: [ { name:"command", shape:[1],
//             datatype:"BYTES", data:[ 'text2world --prompt="…" --seed=…' ] } ] }
//           → 202 + header NVCF-REQID  (async; poll)  |  200 + body (sync, rare)
//
//   poll    GET https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{NVCF-REQID}
//           → 202 (still running)  |  200 (done, body holds the MP4)
//
//   result  The MP4 rides in the response under one of several shapes the NVCF
//           preview has shipped over time — KServe `outputs[].data[0]` (base64),
//           `{ b64_video }`, `{ video }`, `{ artifacts:[{ base64|data|url }] }`,
//           or raw `video/mp4` bytes. extractVideoBase64 normalizes all of them,
//           we persist the bytes to R2, and hand back a durable public URL like
//           the other providers. On an unrecognized shape the warn logs the
//           top-level keys so the next schema drift is visible without guessing.
//
// The default INVOKE_URL follows NVIDIA's published cosmos gateway path
// (/v1/cosmos/nvidia/cosmos-predict1-7b) and is overridable (without a redeploy) via
// NVIDIA_COSMOS_INVOKE_URL — confirm the live contract for an account with
// `node scripts/verify-nvidia-cosmos.mjs`.
//
// Error codes match the established provider contract (nvidia.js / replicate.js):
//   provider_unreachable / invalid_key / insufficient_credits / rate_limited /
//   provider_error, so callers can route around a dead/limited lane. One code is
//   specific to this lane: lane_unavailable, raised when NVIDIA has retired every
//   hosted cosmos-predict route this account can reach (see the route chain
//   below), so the caller degrades instead of offering a pointless retry.

import { env } from '../_lib/env.js';

// Published genai gateway path for the hosted cosmos-predict world model. The
// `command` input's leading token (text2world) selects the modality, so one
// endpoint serves the whole predict line.
const DEFAULT_COSMOS_INVOKE_URL = 'https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos-predict1-7b';
const NVCF_STATUS_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

// NVIDIA retires hosted preview functions without retiring the gateway PATH: the
// route keeps answering (401 unauthenticated), but an authenticated submit comes
// back with `Function '<uuid>': Not found for account '<id>'`. That is what the
// live account hit on cosmos-predict1-7b, and one dead function should not take
// the whole lane down, so the submit walks the published cosmos-predict routes in
// order and only reports the lane unavailable when every rung is gone. Pinning
// NVIDIA_COSMOS_INVOKE_URL opts out: an explicit pin is used alone, because the
// operator who set it means that model (or a self-hosted NIM), not a sibling.
const COSMOS_ROUTE_CANDIDATES = [
	DEFAULT_COSMOS_INVOKE_URL,
	'https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos-predict1-5b',
];

// Cosmos predict renders a fixed ~5 s 1280×704 @ 24fps clip; the prompt is the
// only knob that meaningfully changes the output, so we keep the body minimal.
// A long prompt is clamped so the request is honest about what conditions it.
const COSMOS_PROMPT_MAX = 300;

// Without scene/lighting cues Cosmos drifts toward muted, overcast worlds. Append
// a cinematic suffix unless the caller already steered the look — the backdrop
// should feel alive and vivid behind the avatar.
const COSMOS_STYLE_SUFFIX = ', cinematic lighting, volumetric atmosphere, vivid color, photoreal';
const COSMOS_STYLE_WORDS = ['cinematic', 'lighting', 'sunset', 'sunrise', 'neon', 'golden hour', 'vivid', 'photoreal', 'volumetric', 'dramatic'];

function enhanceWorldPrompt(raw) {
	const text = String(raw || '').trim().slice(0, COSMOS_PROMPT_MAX);
	const lower = text.toLowerCase();
	const hasStyle = COSMOS_STYLE_WORDS.some((w) => lower.includes(w));
	if (hasStyle) return text;
	return (text + COSMOS_STYLE_SUFFIX).slice(0, COSMOS_PROMPT_MAX + COSMOS_STYLE_SUFFIX.length);
}

// Bound the gateway's synchronous hold so a long render becomes a pollable 202
// instead of timing out our socket and losing the request id (the failure the
// TRELLIS provider documents at length). Video takes minutes, so the sync window
// almost always yields a 202 + reqId immediately.
const NVCF_POLL_SECONDS = 30;

// Per-request timeouts. A completed poll streams the full MP4 (several MB), so it
// gets the longer budget. Submit only needs to outlast the synchronous window.
const SUBMIT_TIMEOUT_MS = 45_000;
const POLL_TIMEOUT_MS = 90_000;

// NVCF can answer a cold model or a momentary gateway blip with a transient
// 502/503/504, or drop the socket before a worker is warm. A single short retry
// usually lands once the model spins up; bounded to one so a genuinely-down
// upstream still fails fast. Mirrors nvidia.js.
const GATEWAY_RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_INVOKE_ATTEMPTS = 2;
const INVOKE_RETRY_DELAY_MS = 1_500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function invokeUrl() {
	return env.NVIDIA_COSMOS_INVOKE_URL || DEFAULT_COSMOS_INVOKE_URL;
}

// Ordered submit targets: an explicit pin alone, otherwise the published route
// chain above.
function invokeCandidates() {
	return env.NVIDIA_COSMOS_INVOKE_URL ? [env.NVIDIA_COSMOS_INVOKE_URL] : [...COSMOS_ROUTE_CANDIDATES];
}

// Does this upstream answer mean "the model behind this route is gone for this
// account" (as opposed to a transient or credential failure)? The gateway says it
// with a 404 or with a `Not found for account` detail on another status.
function isRouteRetired(status, detail) {
	if (status === 404) return true;
	return typeof detail === 'string' && /not found for account/i.test(detail);
}

// Map an upstream HTTP status onto the normalized error callers route on.
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
	} else if (isRouteRetired(status, message)) {
		// The model is gone for this account, not broken: the caller should report
		// the lane offline (503) and degrade, never ask the user to retry a route
		// that will keep answering the same way.
		code = 'lane_unavailable';
		mapped = 503;
	}
	const err = Object.assign(new Error(message || `NVIDIA Cosmos returned ${status}`), {
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

// Is a base64 string actually base64 (not a URL or empty)? Cosmos may inline the
// MP4 as base64 or point at a CDN URL; this routes the two apart.
function isBase64Blob(s) {
	return typeof s === 'string' && s.length > 64 && !/^https?:\/\//.test(s);
}

// Walk a JSON Cosmos response for the MP4, tolerant of the several shapes the
// hosted NVCF preview has shipped. Returns { base64 } on success, or
// { base64:null, diag } with a compact description of the unrecognized shape.
async function extractFromJson(data) {
	if (!data || typeof data !== 'object') return { base64: null, diag: 'non-object json' };

	// KServe v2 inference output — the documented hosted shape:
	//   { outputs: [ { name, datatype:"BYTES", data: [ "<base64 mp4>" ] } ] }
	const kserve = Array.isArray(data.outputs) ? data.outputs : null;
	if (kserve) {
		for (const out of kserve) {
			const d = Array.isArray(out?.data) ? out.data[0] : out?.data;
			if (isBase64Blob(d)) return { base64: d };
			if (typeof d === 'string' && /^https?:\/\//.test(d)) {
				const fetched = await fetchToBase64(d);
				if (fetched.base64) return fetched;
			}
		}
	}

	// Flat fields some preview builds use.
	for (const key of ['b64_video', 'video', 'b64_json', 'output']) {
		const v = data[key];
		if (isBase64Blob(v)) return { base64: v };
	}

	// Artifact array (same family as TRELLIS/FLUX): { base64 | data | url }.
	const artifact0 = data?.artifacts?.[0];
	if (artifact0) {
		const inline = artifact0.base64 ?? artifact0.data ?? (isBase64Blob(artifact0) ? artifact0 : null);
		if (isBase64Blob(inline)) return { base64: inline };
		const url = artifact0.url ?? (typeof artifact0 === 'string' && artifact0.startsWith('http') ? artifact0 : null);
		if (url) {
			const fetched = await fetchToBase64(url);
			if (fetched.base64) return fetched;
			return fetched;
		}
	}

	const topKeys = JSON.stringify(Object.keys(data)).slice(0, 120);
	return { base64: null, diag: `json keys=${topKeys}` };
}

// Pull bytes from a CDN URL and base64 them, so the rest of the pipeline always
// holds the MP4 itself (we own the durable persist, like nvidia.js does for GLBs).
async function fetchToBase64(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
		if (!res.ok) return { base64: null, diag: `artifact url fetch ${res.status}` };
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > 0) return { base64: buf.toString('base64') };
		return { base64: null, diag: 'artifact url empty body' };
	} catch (err) {
		return { base64: null, diag: `artifact url error: ${err?.message}` };
	}
}

// Normalize a successful Cosmos response (JSON shapes above, or raw MP4 bytes
// when the gateway ignores Accept) into base64 MP4.
async function extractVideoBase64(res) {
	const ct = (res.headers.get('content-type') || '').toLowerCase();
	if (ct.includes('json')) {
		const data = await res.json().catch(() => null);
		return extractFromJson(data);
	}
	if (ct.includes('mp4') || ct.startsWith('video/') || ct.includes('octet-stream') || ct.includes('binary')) {
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > 0) return { base64: buf.toString('base64') };
		return { base64: null, diag: `empty ${ct} body` };
	}
	const body = await res.text().catch(() => '');
	return { base64: null, diag: `ct=${ct || 'none'} body[0:160]=${body.slice(0, 160)}` };
}

// KServe v2 invoke body. The `command` BYTES input carries the NIM CLI line that
// selects the Text2World modality and the prompt — the documented hosted contract.
function buildWorldBody({ prompt, seed }) {
	const cmd = [`text2world`, `--prompt="${enhanceWorldPrompt(prompt).replace(/"/g, "'")}"`];
	if (Number.isInteger(seed)) cmd.push(`--seed=${seed}`);
	return {
		inputs: [
			{
				name: 'command',
				shape: [1],
				datatype: 'BYTES',
				data: [cmd.join(' ')],
			},
		],
	};
}

export function nvidiaCosmosConfigured() {
	return Boolean(env.NVIDIA_API_KEY);
}

export function createNvidiaCosmosProvider() {
	const apiKey = env.NVIDIA_API_KEY;
	if (!apiKey) {
		throw Object.assign(
			new Error('NVIDIA_API_KEY env var is required for the nvidia-cosmos (Text2World) provider'),
			{ code: 'missing_key', status: 503 },
		);
	}

	const authHeader = { authorization: `Bearer ${apiKey}` };
	const invokeHeaders = {
		...authHeader,
		accept: 'application/json',
		'content-type': 'application/json',
		'nvcf-poll-seconds': String(NVCF_POLL_SECONDS),
	};
	const pollHeaders = { ...authHeader, accept: 'application/json' };

	// Decode a base64 MP4 and store it in R2, returning a durable public URL.
	async function persistVideo(base64) {
		const { putObject, publicUrl } = await import('../_lib/r2.js');
		const key = `forge/cosmos/${globalThis.crypto.randomUUID()}.mp4`;
		await putObject({
			key,
			body: Buffer.from(base64, 'base64'),
			contentType: 'video/mp4',
		});
		return publicUrl(key);
	}

	// POST the invoke. Returns { done:true, videoBase64 } on synchronous 200, or
	// { done:false, reqId } when NVCF accepted it for async processing.
	async function postInvoke(body, url = invokeUrl()) {
		let lastErr = null;
		for (let attempt = 1; attempt <= MAX_INVOKE_ATTEMPTS; attempt++) {
			let res;
			try {
				res = await fetch(url, {
					method: 'POST',
					headers: invokeHeaders,
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
				});
			} catch (err) {
				lastErr = Object.assign(new Error(`nvidia cosmos unreachable: ${err?.message}`), {
					code: 'provider_unreachable',
					status: 502,
				});
				// A submit timeout means the gateway held our socket without handing back
				// a pollable id — retrying just stacks another full window. Make it
				// terminal; a genuine socket/DNS blip (non-timeout) gets one retry.
				const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
				if (!timedOut && attempt < MAX_INVOKE_ATTEMPTS) {
					await sleep(INVOKE_RETRY_DELAY_MS);
					continue;
				}
				throw lastErr;
			}

			if (res.status === 202) {
				const reqId = res.headers.get('nvcf-reqid');
				if (!reqId) {
					throw Object.assign(new Error('NVCF accepted the Cosmos job but returned no NVCF-REQID'), {
						code: 'provider_error',
						status: 502,
					});
				}
				return { done: false, reqId };
			}

			if (res.ok) {
				// NVCF sometimes 200s with an empty body + NVCF-REQID when routing to async.
				const reqId = res.headers.get('nvcf-reqid');
				const { base64, diag } = await extractVideoBase64(res);
				if (!base64) {
					if (reqId) return { done: false, reqId };
					console.warn('[nvidia-cosmos] sync 200 but no video — %s', diag);
					throw Object.assign(new Error('Cosmos completed but returned no video'), {
						code: 'provider_error',
						status: 502,
					});
				}
				return { done: true, videoBase64: base64 };
			}

			if (GATEWAY_RETRY_STATUSES.has(res.status) && attempt < MAX_INVOKE_ATTEMPTS) {
				await res.text().catch(() => {});
				lastErr = providerError(res.status, undefined, res.headers.get('retry-after'));
				await sleep(INVOKE_RETRY_DELAY_MS);
				continue;
			}

			let detail = '';
			try {
				const d = await res.json();
				detail = d?.detail || d?.message || d?.title || '';
				if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
			} catch {
				detail = await res.text().catch(() => '');
			}
			throw providerError(res.status, detail || undefined, res.headers.get('retry-after'));
		}
		throw (
			lastErr ||
			Object.assign(new Error('nvidia cosmos invoke failed after retries'), {
				code: 'provider_error',
				status: 502,
			})
		);
	}

	return {
		// Native text→world video. Returns a poll handle, or a ready R2 MP4 URL when
		// NVCF completed within the submit request (rare for video).
		async textToWorld({ prompt, seed } = {}) {
			const body = buildWorldBody({ prompt, seed });
			const candidates = invokeCandidates();
			let retiredErr = null;
			let parsed = null;
			for (const url of candidates) {
				try {
					parsed = await postInvoke(body, url);
					break;
				} catch (err) {
					// Only a retired route is worth stepping past; a key, quota, or
					// gateway failure means the next rung would fail the same way.
					if (err?.code !== 'lane_unavailable') throw err;
					console.warn('[nvidia-cosmos] route retired, trying the next rung: %s', url);
					retiredErr = err;
				}
			}
			if (!parsed) throw retiredErr;
			if (parsed.done) {
				const resultVideoUrl = await persistVideo(parsed.videoBase64);
				return { taskId: null, resultVideoUrl };
			}
			return { taskId: parsed.reqId };
		},

		// Poll an async job. Never throws — transient failures resolve to 'running'
		// so the poll loop keeps the job alive; only terminal upstream states map to
		// 'failed'. On 'done' the MP4 is decoded, persisted to R2, and returned.
		async status({ taskId } = {}) {
			if (!taskId) return { status: 'failed', error: 'missing NVCF request id' };

			let res;
			try {
				res = await fetch(`${NVCF_STATUS_URL}/${encodeURIComponent(taskId)}`, {
					headers: pollHeaders,
					signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
				});
			} catch (err) {
				return { status: 'running', error: `nvidia cosmos poll failed: ${err?.message}` };
			}

			if (res.status === 202) return { status: 'running' };

			if (res.ok) {
				const { base64, diag } = await extractVideoBase64(res);
				if (!base64) {
					console.warn('[nvidia-cosmos] poll 200 but no video — %s', diag);
					return { status: 'failed', error: 'Cosmos finished but returned no video' };
				}
				try {
					const resultVideoUrl = await persistVideo(base64);
					return { status: 'done', resultVideoUrl };
				} catch (err) {
					return { status: 'failed', error: `failed to persist video: ${err?.message}` };
				}
			}

			if (res.status === 401 || res.status === 403) {
				return { status: 'failed', error: 'NVIDIA rejected the API key' };
			}
			if (res.status === 404) {
				return { status: 'failed', error: 'NVCF request not found or expired' };
			}
			if (res.status === 429) {
				return { status: 'running', error: 'NVIDIA is rate limiting; will retry' };
			}
			if (res.status >= 400 && res.status < 500) {
				// A 4xx other than the rate limit means NVCF rejected the handle itself
				// (malformed or unknown request id). Reporting 'running' made the client
				// poll a dead job for the full five-minute ceiling before giving up.
				return { status: 'failed', error: 'NVCF rejected this request id' };
			}
			return { status: 'running', error: `NVIDIA Cosmos poll returned ${res.status}` };
		},
	};
}
