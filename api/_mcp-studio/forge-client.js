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
import { watsonxConfig, watsonxChatComplete } from '../_lib/watsonx.js';
import { llmComplete } from '../_lib/llm.js';

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

// Device-aware AR launch link (api/ar.js): Android 302s straight into Scene
// Viewer, iOS gets a Quick Look launch page (GLB→USDZ converted in-page), and
// desktop falls back to the WebGL viewer. One URL places the model in the
// user's real room on any phone — the same lane the /ar and /forge pages use.
// `live: true` marks a rigged avatar (an agent's body): the launch page then
// leads with the IRL living handoff instead of static placement.
export function arLaunchUrl(base, glbUrl, title, { live = false } = {}) {
	const t = typeof title === 'string' && title.trim() ? `&title=${encodeURIComponent(title.trim().slice(0, 80))}` : '';
	const k = live ? '&kind=avatar' : '';
	return `${base}/api/ar?src=${encodeURIComponent(glbUrl)}${t}${k}`;
}

// IRL living-agent link: /irl loads the avatar as an agent body in the user's
// real space: camera passthrough, animation, movement, conversation. This is
// the digital-to-physical bridge for the agent economy; static AR placement is
// the fallback for props, not the destination for avatars.
export function irlUrl(base, glbUrl) {
	return `${base}/irl?avatar=${encodeURIComponent(glbUrl)}`;
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
// operator-funded. A high-tier submit degrades to the ungated standard tier
// rather than dead-ending when the gate refuses (402: secret missing or stale)
// OR when the high lane can't hand back a job in time (the free Hunyuan3D lane
// blocks the whole request instead of returning a poll handle, which no ChatGPT
// surface can wait out).
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

	let res;
	let data;
	try {
		({ res, data } = await attempt(tier, !!internal));
	} catch (err) {
		if (err?.code !== 'timeout' || tier !== 'high') throw err;
		({ res, data } = await attempt('standard', false));
	}
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

// IBM Granite prompt director. Rewrites a rough idea into a tight single-subject
// 3D spec. Runs IN PROCESS: watsonx Granite leads, and the shared free-first LLM
// chain (llmComplete, the same one forge-enhance rides) is the fallback. The
// previous implementation POSTed provider=watsonx to its own /api/chat, which
// the anonymous-provider gate 401s (chat.js pins anon callers to the free
// providers), so the director silently never ran on any surface. Fail-soft:
// returns null on any failure so the caller forwards the original prompt
// unchanged, never faked.
const DIRECTOR_MAX_TOKENS = 200;
const DIRECTOR_TIMEOUT_MS = 20_000;

export async function directPrompt(instruction, rawPrompt) {
	const user = `Idea: ${rawPrompt}`;
	let text = null;

	// watsonxChatComplete carries no abort signal of its own, so cap it here; a
	// hung IAM or inference call must degrade to the free chain, not stall the
	// whole generation submit.
	const cfg = watsonxConfig();
	if (cfg.configured) {
		let timer;
		try {
			const result = await Promise.race([
				watsonxChatComplete(cfg, {
					messages: [
						{ role: 'system', content: instruction },
						{ role: 'user', content: user },
					],
					maxTokens: DIRECTOR_MAX_TOKENS,
				}),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('watsonx director timed out')), DIRECTOR_TIMEOUT_MS);
				}),
			]);
			text = result?.text || null;
		} catch {
			text = null;
		} finally {
			clearTimeout(timer);
		}
	}

	if (!text) {
		try {
			const result = await llmComplete({
				system: instruction,
				user,
				maxTokens: DIRECTOR_MAX_TOKENS,
				timeoutMs: DIRECTOR_TIMEOUT_MS,
				track: { tool: 'forge-director' },
			});
			text = result?.text || null;
		} catch {
			return null;
		}
	}

	if (!text) return null;
	// First line only, then strip wrapping quotes; the reverse order leaves a
	// dangling quote when the model adds commentary lines after a quoted prompt.
	const firstLine = text.trim().split('\n')[0].trim();
	const refined = firstLine.replace(/^["'“”]+|["'“”]+$/g, '').trim();
	return refined.length >= 3 && refined.length <= 1000 ? refined : null;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
