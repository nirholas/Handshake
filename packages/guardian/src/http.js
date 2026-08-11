// Zero-dependency HTTP core shared across the @three-ws/* SDK family.
// Copied verbatim into each package so every SDK stays dependency-free while
// resolving the base URL, attaching auth, and mapping the platform's JSON error
// envelope onto typed errors the same way everywhere.

export const DEFAULT_BASE_URL = 'https://three.ws';

/** Base error for every @three-ws/* SDK. Carries a stable `code` + HTTP `status`. */
export class ThreeWsError extends Error {
	constructor(message, { code = 'error', status = null, detail = null, retryAfter = null, body = null } = {}) {
		super(message);
		this.name = 'ThreeWsError';
		this.code = code;
		this.status = status;
		if (detail) this.detail = detail;
		if (retryAfter != null) this.retryAfter = retryAfter;
		this.body = body;
	}
}

/**
 * Thrown on HTTP 402. The endpoint wants payment before it will do the work.
 * `accepts` is the x402 challenge (asset/amount/network/payTo) when present —
 * pass a payment-aware `fetch` (e.g. @three-ws/x402-fetch) to settle it
 * automatically, or read `accepts` and pay it yourself.
 */
export class PaymentRequiredError extends ThreeWsError {
	constructor(message, opts = {}) {
		super(message, { ...opts, code: opts.code || 'payment_required', status: opts.status ?? 402 });
		this.name = 'PaymentRequiredError';
		this.accepts = opts.accepts ?? null;
	}
}

/** Resolve the API origin: explicit option → THREE_WS_BASE_URL env → default. */
export function resolveBaseUrl(baseUrl) {
	const env = typeof process !== 'undefined' && process.env ? process.env.THREE_WS_BASE_URL : null;
	return String(baseUrl || env || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function buildUrl(baseUrl, path, query) {
	const url = new URL(String(path).replace(/^\/+/, '/'), baseUrl + '/');
	if (query && typeof query === 'object') {
		for (const [k, v] of Object.entries(query)) {
			if (v === undefined || v === null) continue;
			url.searchParams.set(k, String(v));
		}
	}
	return url;
}

/**
 * Build a `request(path, opts)` function bound to a base URL + fetch + headers.
 * Returns parsed JSON on success; throws a typed error on any non-2xx.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  API origin (default https://three.ws).
 * @param {typeof fetch} [opts.fetch]  fetch implementation (default globalThis.fetch).
 * @param {string} [opts.apiKey]  bearer token attached as Authorization.
 * @param {Record<string,string>} [opts.headers]  default headers on every call.
 */
export function createHttp(opts = {}) {
	const baseUrl = resolveBaseUrl(opts.baseUrl);
	const fetchImpl = opts.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
	if (typeof fetchImpl !== 'function') {
		throw new ThreeWsError('No fetch implementation available — run on Node 18+ or pass { fetch }.', { code: 'no_fetch' });
	}
	const baseHeaders = { accept: 'application/json', ...(opts.headers || {}) };
	if (opts.apiKey) baseHeaders.authorization = `Bearer ${opts.apiKey}`;

	return async function request(path, { method = 'GET', query, body, headers, signal } = {}) {
		const url = buildUrl(baseUrl, path, query);
		const init = { method, headers: { ...baseHeaders, ...(headers || {}) }, signal };
		if (body !== undefined) {
			init.body = typeof body === 'string' ? body : JSON.stringify(body);
			init.headers['content-type'] = init.headers['content-type'] || 'application/json';
		}

		let res;
		try {
			res = await fetchImpl(url, init);
		} catch (err) {
			if (err?.name === 'AbortError') throw err;
			throw new ThreeWsError(`Network request to ${url.pathname} failed: ${err?.message || err}`, { code: 'network_error' });
		}

		const text = await res.text();
		let payload = null;
		if (text) {
			try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
		}

		if (res.ok) return payload;

		const code = payload?.error || payload?.code || `http_${res.status}`;
		const message = payload?.message || payload?.error_description || payload?.detail || `Request failed with ${res.status}`;
		const retryAfter = numberOr(res.headers.get('retry-after'), payload?.retry_after);

		// An x402 challenge is not always HTTP 402: the three.ws MCP transport
		// issues it over 401 (x402Version + accepts in the body, alongside the
		// OAuth www-authenticate header). Detect the challenge by payload so the
		// caller always gets a PaymentRequiredError carrying `accepts`.
		const isX402Challenge = res.status === 402 ||
			(res.status === 401 && payload != null && payload.x402Version != null && Array.isArray(payload.accepts));
		if (isX402Challenge) {
			// x402 bodies put the human-readable reason under `error`, so prefer it
			// as the message and keep the stable `payment_required` code.
			const challengeMessage = typeof payload?.error === 'string' && payload.error ? payload.error : message;
			throw new PaymentRequiredError(challengeMessage, { code: 'payment_required', status: res.status, accepts: payload?.accepts ?? null, detail: payload?.detail, body: payload });
		}
		throw new ThreeWsError(message, { code, status: res.status, detail: payload?.detail, retryAfter, body: payload });
	};
}

function numberOr(...vals) {
	for (const v of vals) {
		if (v == null) continue;
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

/** Sleep that respects an AbortSignal (used by client-side job pollers). */
export function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const t = setTimeout(() => {
			signal?.removeEventListener?.('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(t);
			reject(abortError());
		}
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});
}

function abortError() {
	const e = new Error('The operation was aborted.');
	e.name = 'AbortError';
	return e;
}
