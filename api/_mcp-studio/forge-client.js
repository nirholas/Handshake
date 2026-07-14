// three.ws 3D Studio (free) — client over the production generation pipeline.
//
// Every studio tool is a thin client over /api/forge — the public, auth-free
// twin of the paid 3D Studio MCP server (see api/forge.js). The platform's
// server-side keys (NVIDIA NIM, FLUX, TRELLIS/Hunyuan3D, UniRig, IBM Granite)
// cover the provider cost, so the ChatGPT user pays nothing and no wallet,
// payment, or API key is ever involved. This module is the SAME submit/poll
// logic the npm MCP tools use, factored once — not a fork and not a mock.
//
// All work runs against the deployment's own origin (resolved from the incoming
// request, falling back to PUBLIC_APP_ORIGIN / https://three.ws), so the studio
// front door and the generation pipeline are always the same deployment.

import { env } from '../_lib/env.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 3_000;

function envNum(key, def) {
	const v = Number(process.env[key]);
	return Number.isFinite(v) && v > 0 ? v : def;
}

// Resolve the origin to call /api/forge on. Prefer the request's own host so the
// studio endpoint is self-referential on any deployment (preview, prod, local
// dev), then PUBLIC_APP_ORIGIN, then the canonical fallback.
export function originFromReq(req) {
	const explicit = process.env.STUDIO_API_BASE && String(process.env.STUDIO_API_BASE).trim();
	if (explicit) return explicit.replace(/\/$/, '');
	const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
	if (host) {
		const proto = req.headers['x-forwarded-proto'] || (/^localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https');
		return `${proto}://${host}`.replace(/\/$/, '');
	}
	return env.APP_ORIGIN.replace(/\/$/, '');
}

export function viewerUrl(base, glbUrl) {
	return `${base}/viewer?src=${encodeURIComponent(glbUrl)}`;
}

function failure(code, message, extra = {}) {
	const e = new Error(message);
	e.code = code;
	Object.assign(e, extra);
	return e;
}

// The studio surfaces run server→server against the deployment's own /api/forge,
// so they may carry the internal seed token (the same one forge-seed-cron uses).
// Forge accepts it as proof the call is platform-originated, which clears the
// High-tier access gate — the ChatGPT user stays anonymous and keyless while the
// platform funds the premium tier. Absent secret → no header, and the tier
// fallback in startForge keeps the surface working.
function internalHeaders() {
	const secret = process.env.CRON_SECRET;
	return secret ? { 'x-forge-seed': secret } : {};
}

// Submit a generation job to /api/forge. Handles both the synchronous-done shape
// (the free lanes often complete inside the submit window) and the queued shape
// ({ job_id }). `backend`/`path`/`tier` pass through to forge's router; omitting
// `backend` lets the free-first router pick the best engine for the tier.
// `internal: true` attaches the platform seed token so gated tiers (high) run
// operator-funded; if the gate still refuses (secret missing or stale), the
// submit retries once at the ungated standard tier rather than dead-ending.
export async function startForge(base, { prompt, imageUrls, aspect, backend, path, tier, internal }) {
	const attempt = async (tierId, withInternal) => {
		const payload = {
			...(prompt ? { prompt } : {}),
			...(Array.isArray(imageUrls) && imageUrls.length ? { image_urls: imageUrls } : {}),
			...(aspect ? { aspect_ratio: aspect } : {}),
			...(backend ? { backend } : {}),
			...(path ? { path } : {}),
			...(tierId ? { tier: tierId } : {}),
		};
		let res;
		try {
			res = await fetch(`${base}/api/forge`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(withInternal ? internalHeaders() : {}) },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(90_000),
			});
		} catch (err) {
			if (err?.name === 'TimeoutError' || err?.name === 'AbortError')
				throw failure('timeout', 'the 3D generator took too long to accept the job; try again');
			throw failure('provider_error', `the 3D generator is unreachable: ${err?.message || err}`);
		}
		const data = await res.json().catch(() => ({}));
		return { res, data };
	};

	let { res, data } = await attempt(tier, !!internal);
	if (res.status === 402 && tier === 'high') ({ res, data } = await attempt('standard', false));
	if (res.status === 503) throw failure('not_configured', data?.message || '3D generation is not configured on this deployment');
	if (res.status === 429) throw failure('busy', data?.message || 'the 3D generator is busy; try again shortly', { retryAfter: data?.retry_after });
	const completedSync = data?.status === 'done' && data?.glb_url;
	if (!res.ok || !(data?.job_id || completedSync)) throw failure('provider_error', data?.message || `the 3D generator returned ${res.status}`);
	return data;
}

export async function startRig(base, glbUrl) {
	let res;
	try {
		res = await fetch(`${base}/api/forge?action=rig`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ glb_url: glbUrl }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		if (err?.name === 'TimeoutError' || err?.name === 'AbortError')
			throw failure('timeout', 'the rigger took too long to accept the job; try again');
		throw failure('provider_error', `the rigger is unreachable: ${err?.message || err}`);
	}
	const data = await res.json().catch(() => ({}));
	if (res.status === 503 || res.status === 501) throw failure('not_configured', data?.message || 'auto-rigging is not enabled on this deployment');
	if (res.status === 429) throw failure('busy', data?.message || 'the rigger is busy; try again shortly', { retryAfter: data?.retry_after });
	if (!res.ok || !data?.job_id) throw failure('provider_error', data?.message || `the rigger returned ${res.status}`);
	return data;
}

// Poll a /api/forge job to a terminal state. Returns the done payload, throws a
// coded failure on a failed job, or returns { _timedOut: true } at the deadline.
export async function pollJob(base, jobId, { timeoutMs, intervalMs } = {}) {
	const tMs = timeoutMs || DEFAULT_TIMEOUT_MS;
	const iMs = intervalMs || DEFAULT_POLL_MS;
	const deadline = Date.now() + tMs;
	let last = null;
	while (Date.now() < deadline) {
		let res;
		try {
			res = await fetch(`${base}/api/forge?job=${encodeURIComponent(jobId)}`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(Math.max(iMs * 3, 15_000)),
			});
		} catch (err) {
			if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
				await sleep(iMs);
				continue;
			}
			throw failure('provider_error', `generation poll failed: ${err?.message || err}`);
		}
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw failure('provider_error', data?.message || `generation poll returned ${res.status}`);
		last = data;
		if (data.status === 'done' && data.glb_url) return data;
		if (data.status === 'failed') throw failure('generation_failed', data.error || 'generation failed');
		await sleep(iMs);
	}
	return { ...(last || {}), _timedOut: true };
}

// Run a submit→poll cycle end to end, returning the terminal job payload.
export async function generate(base, submitArgs, { timeoutEnv } = {}) {
	const job = await startForge(base, submitArgs);
	if (job.status === 'done' && job.glb_url) return job;
	return pollJob(base, job.job_id, {
		timeoutMs: timeoutEnv ? envNum(timeoutEnv, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
		intervalMs: envNum('STUDIO_POLL_MS', DEFAULT_POLL_MS),
	});
}

export async function rig(base, glbUrl, { timeoutEnv } = {}) {
	const job = await startRig(base, glbUrl);
	return pollJob(base, job.job_id, {
		timeoutMs: timeoutEnv ? envNum(timeoutEnv, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
		intervalMs: envNum('STUDIO_POLL_MS', DEFAULT_POLL_MS),
	});
}

// IBM Granite prompt director (via /api/chat, provider=watsonx). Rewrites a
// rough idea into a tight single-subject 3D spec. Fail-soft: returns null on any
// failure so the caller forwards the original prompt unchanged — never faked.
export async function directPrompt(base, instruction, rawPrompt) {
	let res;
	try {
		res = await fetch(`${base}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({ provider: 'watsonx', message: `${instruction}\n\nIdea: ${rawPrompt}` }),
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
	const refined = acc.trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
	return refined.length >= 3 && refined.length <= 1000 ? refined : null;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
