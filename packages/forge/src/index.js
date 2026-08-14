// @three-ws/forge — text/image/sketch → textured, rig-ready 3D GLB.
// Thin client over the public, auth-free /api/forge endpoint (the SDK twin of
// the 3D Studio MCP server). See README.md for the full reference.

import { createHttp, delay, ThreeWsError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

const TIERS = ['draft', 'standard', 'high'];
const PATHS = ['image', 'geometry', 'sketch'];
const PAY_LANES = ['credits', 'x402'];

// The browser-facing lane (account credits / free draft) and its pay-per-call
// twin. They are separate endpoints, not a flag on one endpoint.
const FORGE_ROUTE = '/api/forge';
const X402_ROUTE = '/api/x402/forge';

/**
 * Create a Forge client bound to a base URL, fetch, and optional auth/provider key.
 * For most callers the default export `forge()` / `rig()` is enough; use this
 * when you want to reuse configuration (a payment-aware fetch, a custom origin,
 * a BYOK provider key) across many calls.
 */
export function createForge(options = {}) {
	const request = createHttp(options);
	const clientProviderKey = options.providerKey || null;

	// A BYOK key rides on every request that touches the job, submit AND poll:
	// the API re-resolves it per poll and fails the job without it.
	function providerHeaders(extra, perCallKey) {
		const h = { ...(extra || {}) };
		const key = perCallKey || clientProviderKey;
		if (key) h['x-forge-provider-key'] = key;
		return h;
	}

	/** Submit a generation and resolve once the GLB is ready. */
	async function forge(promptOrInput, opts = {}) {
		const input = typeof promptOrInput === 'string' ? { prompt: promptOrInput } : { ...(promptOrInput || {}) };
		const path = normalizeEnum(opts.path, PATHS, 'path');
		const tier = normalizeEnum(opts.tier, TIERS, 'tier');
		const payWith = normalizeEnum(opts.payWith, PAY_LANES, 'payWith');

		if (!input.prompt && !(input.images && input.images.length)) {
			throw new ThreeWsError('forge() needs a `prompt` or at least one image.', { code: 'invalid_input' });
		}
		if (path === 'sketch' && !input.prompt) {
			throw new ThreeWsError('The sketch path needs a `prompt` naming what the drawing depicts.', { code: 'invalid_input' });
		}

		if (payWith === 'x402') return forgeOverX402({ input, tier, path, opts });

		const body = {
			prompt: input.prompt,
			image_urls: input.images,
			aspect_ratio: input.aspectRatio,
			path,
			tier,
			backend: opts.backend,
			pay_with: payWith,
		};

		const headers = providerHeaders(opts.headers, opts.providerKey);
		const submitted = await request(FORGE_ROUTE, {
			method: 'POST',
			body: prune(body),
			headers,
			signal: opts.signal,
		});

		return resolveJob(submitted, opts, headers);
	}

	// The pay-per-call twin. One USDC payment buys one generation, with no
	// account and no key, so the BYOK/backend/path knobs of the credits lane do
	// not apply: the server picks the lane from the input. Without a payment-aware
	// `fetch` the first call throws PaymentRequiredError carrying the challenge.
	async function forgeOverX402({ input, tier, path, opts }) {
		const unsupported = [
			opts.backend ? 'backend' : null,
			path ? 'path' : null,
			opts.providerKey || clientProviderKey ? 'providerKey' : null,
		].filter(Boolean);
		if (unsupported.length) {
			throw new ThreeWsError(
				`The x402 lane picks its own generation lane, so it does not accept: ${unsupported.join(', ')}. ` +
					'Drop them, or use the default credits lane.',
				{ code: 'invalid_input' },
			);
		}

		const submitted = await request(X402_ROUTE, {
			method: 'POST',
			body: prune({
				prompt: input.prompt,
				image_urls: input.images,
				aspect_ratio: input.aspectRatio,
				tier,
			}),
			headers: { ...(opts.headers || {}) },
			signal: opts.signal,
		});
		// The job token is polled for free on the shared endpoint, so resolution
		// runs against /api/forge exactly as the credits lane does.
		return resolveJob(submitted, opts, opts.headers || {});
	}

	/** Auto-rig an existing GLB into an animation-ready humanoid. */
	async function rig(glbUrl, opts = {}) {
		if (!glbUrl || typeof glbUrl !== 'string') {
			throw new ThreeWsError('rig() needs a GLB url string.', { code: 'invalid_input' });
		}
		const headers = providerHeaders(opts.headers, opts.providerKey);
		const submitted = await request(FORGE_ROUTE, {
			method: 'POST',
			query: { action: 'rig' },
			body: { glb_url: glbUrl },
			headers,
			signal: opts.signal,
		});
		return resolveJob(submitted, opts, headers);
	}

	/** Fetch the live tier / backend / cost matrix. */
	async function catalog(opts = {}) {
		return request(FORGE_ROUTE, { query: { catalog: '1' }, signal: opts.signal });
	}

	/** Poll a single job once. */
	async function getJob(jobId, opts = {}) {
		const res = await request(FORGE_ROUTE, {
			query: { job: jobId },
			headers: providerHeaders(opts.headers, opts.providerKey),
			signal: opts.signal,
		});
		return shape(res, options.baseUrl);
	}

	// Poll a submitted job to completion (sync backends return done immediately).
	async function resolveJob(submitted, opts, headers) {
		let job = shape(submitted, options.baseUrl);
		opts.onProgress?.(job);
		if (job.status === 'done' || !job.jobId) {
			if (job.status === 'failed') throw failed(job);
			return job;
		}
		const intervalMs = opts.pollIntervalMs ?? 2500;
		const timeoutMs = opts.timeoutMs ?? 180_000;
		const start = now();
		while (job.status !== 'done') {
			if (now() - start > timeoutMs) {
				throw new ThreeWsError(`Forge job ${job.jobId} did not finish within ${Math.round(timeoutMs / 1000)}s.`, { code: 'timeout' });
			}
			await delay(intervalMs, opts.signal);
			const polled = await request(FORGE_ROUTE, { query: { job: job.jobId }, headers, signal: opts.signal });
			job = shape(polled, options.baseUrl);
			opts.onProgress?.(job);
			if (job.status === 'failed') throw failed(job);
		}
		return job;
	}

	return { forge, rig, catalog, getJob };
}

// A module-level default client for the zero-config path: `import { forge }`.
let shared = null;
function defaultClient() {
	return (shared ||= createForge());
}

/** Generate a GLB from text, image(s), or a sketch. */
export function forge(promptOrInput, opts) {
	return defaultClient().forge(promptOrInput, opts);
}
/** Auto-rig a GLB into an animation-ready humanoid. */
export function rig(glbUrl, opts) {
	return defaultClient().rig(glbUrl, opts);
}
/** Fetch the live tier / backend / cost matrix. */
export function catalog(opts) {
	return defaultClient().catalog(opts);
}
/** Read one job's current state without waiting for it to finish. */
export function getJob(jobId, opts) {
	return defaultClient().getJob(jobId, opts);
}

function shape(res, baseUrl) {
	if (!res || typeof res !== 'object') {
		throw new ThreeWsError('Unexpected empty response from /api/forge.', { code: 'bad_response' });
	}
	const origin = String(baseUrl || 'https://three.ws').replace(/\/+$/, '');
	const creationId = res.creation_id ?? null;
	return {
		jobId: res.job_id ?? null,
		creationId,
		status: res.status || (res.glb_url ? 'done' : 'queued'),
		glbUrl: res.glb_url ?? null,
		viewerUrl: creationId ? `${origin}/forge?share=${creationId}` : null,
		path: res.path ?? null,
		tier: res.tier ?? null,
		backend: res.backend ?? null,
		etaSeconds: res.eta_seconds ?? null,
		estimatedCredits: res.estimated_credits ?? null,
		durable: Boolean(res.durable),
		raw: res,
	};
}

function failed(job) {
	return new ThreeWsError(job.raw?.message || 'Forge generation failed to produce a usable mesh.', {
		code: job.raw?.error || 'generation_failed',
		body: job.raw,
	});
}

function normalizeEnum(value, allowed, label) {
	if (value === undefined || value === null) return undefined;
	if (!allowed.includes(value)) {
		throw new ThreeWsError(`Invalid ${label} "${value}". Expected one of: ${allowed.join(', ')}.`, { code: 'invalid_input' });
	}
	return value;
}

function prune(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v) && v.length === 0) continue;
		out[k] = v;
	}
	return out;
}

function now() {
	// Date.now via getTime keeps this testable without relying on a frozen clock.
	return new Date().getTime();
}
