// @three-ws/x402-preflight — ask an x402 seller whether it can settle, before
// you sign anything.
//
// x402 tells you what a resource COSTS. It does not tell you whether the seller
// can currently complete the transaction it is charging for. Those look
// identical until you have already signed, and the difference is paid for by the
// buyer: a burned signature, a consumed blockhash, a 502, and no service.
//
// This is the client half of x402 Preflight. It fetches a seller's signed
// attestation, verifies it offline, and gives you three levels of use depending
// on how much control you want:
//
//   preflight(origin)             fetch + verify, get the verdict yourself
//   assertPayable(origin, net)    throw a typed error if that rail cannot settle
//   guardedFetch()                a drop-in fetch that refuses unpayable sellers
//                                 and re-routes to a rail that works
//
// Nothing here trusts the network. Every response is verified against the
// issuer's key, checked for expiry, and pinned to the origin you asked about
// before a single field is read.

export {
	verifyPreflight,
	networkVerdict,
	payableNetworks,
	normalizeOrigin,
	PREFLIGHT_SPEC,
	PREFLIGHT_ENVELOPE_VERSION,
	DEFAULT_CLOCK_SKEW_MS,
} from './verify.js';

import { verifyPreflight, networkVerdict, payableNetworks, normalizeOrigin } from './verify.js';

/** Where a compliant seller publishes its attestation. */
export const PREFLIGHT_WELL_KNOWN = '/.well-known/x402-preflight';

/**
 * A seller could not be shown to be able to settle. Carries the machine reason,
 * the back-off the seller asked for, and the rails that WOULD work, so a caller
 * can recover without re-fetching anything.
 */
export class PreflightError extends Error {
	/**
	 * @param {string} message
	 * @param {{ code: string, reason?: string, retryAfter?: number|null,
	 *   alternates?: string[], origin?: string, network?: string }} info
	 */
	constructor(message, info) {
		super(message);
		this.name = 'PreflightError';
		this.code = info.code;
		this.reason = info.reason ?? null;
		this.retryAfter = info.retryAfter ?? null;
		this.alternates = info.alternates ?? [];
		this.origin = info.origin ?? null;
		this.network = info.network ?? null;
	}
}

// Attestations are short-lived and self-describing, so the cache key is the
// origin and the eviction time is the attestation's own expiry. Nothing is ever
// served past that instant, which means the cache cannot do what the format
// exists to prevent.
const _cache = new Map();

/** Drop every cached attestation. Useful in tests and after a network change. */
export function clearPreflightCache() {
	_cache.clear();
}

function cached(origin, now) {
	const hit = _cache.get(origin);
	if (!hit) return null;
	if (hit.expiresAt <= now) {
		_cache.delete(origin);
		return null;
	}
	return hit.envelope;
}

/**
 * Fetch and verify a seller's preflight attestation.
 *
 * @param {string} origin        seller origin, e.g. 'https://three.ws'
 * @param {object} [opts]
 * @param {string} [opts.issuer]      pin the signer's public key you trust
 * @param {number} [opts.timeoutMs]   default 5000
 * @param {boolean} [opts.cache]      default true
 * @param {typeof fetch} [opts.fetch] inject a fetch (tests, proxies, edge)
 * @param {number} [opts.now]         injected clock, for tests
 * @returns {Promise<{ envelope: object, verification: object, report: object }>}
 * @throws {PreflightError} on transport failure, a malformed body, or a
 *   signature/expiry/subject check that does not pass
 */
export async function preflight(origin, opts = {}) {
	const {
		issuer,
		timeoutMs = 5000,
		cache = true,
		fetch: fetchImpl = globalThis.fetch,
		now = Date.now(),
	} = opts;

	if (typeof fetchImpl !== 'function') {
		throw new PreflightError('no fetch implementation available; pass opts.fetch', { code: 'no_fetch', origin });
	}
	const base = normalizeOrigin(origin);
	if (!base.startsWith('http')) {
		throw new PreflightError(`not an origin: ${origin}`, { code: 'bad_origin', origin });
	}

	if (cache) {
		const hit = cached(base, now);
		if (hit) return { envelope: hit, verification: { valid: true, reason: 'cached' }, report: hit.report };
	}

	// A hung seller must not hang the buyer. Every request is deadlined, and the
	// abort is surfaced as its own code so a caller can tell "slow" from "broken".
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let res;
	try {
		res = await fetchImpl(`${base}${PREFLIGHT_WELL_KNOWN}`, {
			headers: { accept: 'application/json' },
			signal: controller.signal,
		});
	} catch (err) {
		const aborted = err?.name === 'AbortError';
		throw new PreflightError(
			aborted ? `preflight timed out after ${timeoutMs}ms` : `preflight request failed: ${err?.message || err}`,
			{ code: aborted ? 'timeout' : 'transport_error', origin: base },
		);
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) {
		// 503 is the documented "I cannot sign right now" answer, and it is a
		// meaningful signal rather than an error to swallow: a seller that cannot
		// attest is a seller you should not assume is fine.
		const retryAfter = Number(res.headers?.get?.('retry-after')) || null;
		throw new PreflightError(`seller returned HTTP ${res.status} for preflight`, {
			code: res.status === 404 ? 'not_supported' : 'unavailable',
			retryAfter,
			origin: base,
		});
	}

	let envelope;
	try {
		envelope = await res.json();
	} catch {
		throw new PreflightError('preflight response was not JSON', { code: 'malformed', origin: base });
	}

	const verification = verifyPreflight(envelope, { issuer, subject: base, now });
	if (!verification.valid) {
		throw new PreflightError(`preflight attestation did not verify: ${verification.reason}`, {
			code: 'verification_failed',
			reason: verification.reason,
			origin: base,
		});
	}

	if (cache) {
		const expiresAt = Date.parse(envelope.report.expires_at);
		if (Number.isFinite(expiresAt)) _cache.set(base, { envelope, expiresAt });
	}
	return { envelope, verification, report: envelope.report };
}

/**
 * Throw unless the seller can settle on the given network right now.
 *
 * `unknown` is treated as NOT payable on purpose. The caller is about to make an
 * irreversible transfer, so the safe reading of "I cannot tell" is to not pay.
 * Pass `allowUnknown: true` to opt into the other trade-off explicitly, which is
 * a decision worth writing down at the call site.
 *
 * @param {string} origin
 * @param {string} network CAIP-2 id, e.g. 'solana:mainnet'
 * @param {object} [opts] everything preflight() takes, plus allowUnknown
 * @returns {Promise<{ verdict: object, envelope: object }>}
 * @throws {PreflightError}
 */
export async function assertPayable(origin, network, opts = {}) {
	const { envelope } = await preflight(origin, opts);
	const verdict = networkVerdict(envelope, network);
	const acceptable = verdict.payable === true || (opts.allowUnknown && verdict.payable === 'unknown');
	if (!acceptable) {
		throw new PreflightError(
			`${origin} cannot settle on ${network} right now (${verdict.reason})` +
				(verdict.alternates.length ? `; payable on ${verdict.alternates.join(', ')}` : ''),
			{
				code: 'not_payable',
				reason: verdict.reason,
				retryAfter: verdict.retry_after,
				alternates: verdict.alternates,
				origin,
				network,
			},
		);
	}
	return { verdict, envelope };
}

/**
 * Pick the rail to pay on: your preference when it works, otherwise the best
 * alternative the seller attested to.
 *
 * Returns null when nothing is payable, rather than throwing, because "pay on
 * nothing" is a routing outcome a scheduler handles, not an exception.
 * @param {object} envelope a VERIFIED envelope
 * @param {string[]} [prefer] your ranked network preference
 * @returns {string|null}
 */
export function chooseNetwork(envelope, prefer = []) {
	const payable = payableNetworks(envelope);
	if (!payable.length) return null;
	for (const p of prefer) if (payable.includes(p)) return p;
	return payable[0];
}

/**
 * A drop-in `fetch` that will not let you pay a seller who cannot settle.
 *
 * Wraps any fetch-shaped function. Before a request that could trigger payment,
 * it preflights the origin once (cached for the attestation's lifetime) and
 * refuses if no rail is payable. The check costs one small cacheable GET and
 * saves a signature, a blockhash and a round trip every time a seller is down.
 *
 * Requests to origins that do not publish an attestation pass through
 * unchanged: this is an enhancement to the ecosystem, not a gate on it, and
 * refusing every non-adopting seller would make the SDK unusable on day one.
 * Set `requirePreflight: true` when you would rather fail closed.
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]
 * @param {string[]} [opts.prefer] ranked network preference
 * @param {boolean} [opts.requirePreflight] fail closed on non-adopting sellers
 * @param {string} [opts.issuer]
 * @param {(info: object) => void} [opts.onSkip] called when a seller is refused
 * @returns {typeof fetch}
 */
export function guardedFetch(opts = {}) {
	const {
		fetch: fetchImpl = globalThis.fetch,
		prefer = ['solana:mainnet'],
		requirePreflight = false,
		issuer,
		onSkip,
	} = opts;

	return async function guarded(input, init) {
		const url = typeof input === 'string' ? input : input?.url || String(input);
		let origin;
		try {
			origin = new URL(url).origin;
		} catch {
			return fetchImpl(input, init);
		}

		let envelope = null;
		try {
			({ envelope } = await preflight(origin, { issuer, fetch: fetchImpl }));
		} catch (err) {
			// A seller that does not publish an attestation is the entire existing
			// x402 ecosystem. Passing through is what makes adoption incremental.
			if (!requirePreflight && (err.code === 'not_supported' || err.code === 'transport_error')) {
				return fetchImpl(input, init);
			}
			throw err;
		}

		const chosen = chooseNetwork(envelope, prefer);
		if (!chosen) {
			const first = Object.values(envelope.report.networks || {})[0] || {};
			onSkip?.({ origin, url, reason: first.reason || 'unknown', retryAfter: first.retry_after ?? null });
			throw new PreflightError(`${origin} cannot settle on any network right now`, {
				code: 'not_payable',
				reason: first.reason || 'unknown',
				retryAfter: first.retry_after ?? null,
				alternates: [],
				origin,
			});
		}

		// Tell the seller which rail we intend to use. A server that reads this can
		// answer its 402 with only the accept we can actually pay, which removes a
		// negotiation round trip; one that ignores it is unaffected.
		const headers = new Headers(init?.headers || (typeof input === 'object' ? input?.headers : undefined));
		headers.set('x-preflight-network', chosen);
		return fetchImpl(input, { ...init, headers });
	};
}
