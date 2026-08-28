// Break a named upstream for one request, and assert what your code does about it.
//
// This is the client half of Brownout. The server accepts a directive naming
// upstreams and the failure to inject; this builds that directive, attaches it
// to a request, and gives your tests a way to say "when their price provider is
// rate limiting, my integration must still render a price, and label it stale".
//
// It needs a token the operator gave you. Without one the server refuses every
// directive, which is the point: this is a switch that makes a live service
// misbehave, and it must never be reachable by anyone who merely knows the
// header name.

export const CHAOS_HEADER = 'x-brownout-chaos';
export const CHAOS_TOKEN_HEADER = 'x-brownout-chaos-token';
export const CHAOS_STATUS_HEADER = 'x-brownout-chaos-status';

/** @typedef {'timeout'|'network'|'empty'|`http:${number}`|`slow:${number}`} FaultSpec */

/**
 * Render a directive from `{ upstream: fault }`.
 *
 * @param {Record<string, FaultSpec>} faults
 * @returns {string}
 * @example
 *   chaosDirective({ birdeye: 'http:429', 'tokens-xyz': 'timeout' })
 *   // 'birdeye=http:429, tokens-xyz=timeout'
 */
export function chaosDirective(faults) {
	return Object.entries(faults || {})
		.map(([name, spec]) => `${name}=${spec}`)
		.join(', ');
}

/**
 * The headers that carry a fault directive.
 *
 * @param {Record<string, FaultSpec>} faults
 * @param {string} token  the operator's chaos token
 * @returns {Record<string,string>}
 */
export function chaosHeaders(faults, token) {
	if (!token) throw new Error('brownout: a chaos token is required; the server refuses an unauthenticated directive');
	return { [CHAOS_HEADER]: chaosDirective(faults), [CHAOS_TOKEN_HEADER]: token };
}

/**
 * A `fetch` that injects faults on every call it makes.
 *
 * Wrap the fetch your client already uses, so the code under test is the real
 * client with its real retry and caching behaviour, and only the upstreams
 * misbehave.
 *
 * @param {Record<string, FaultSpec>} faults
 * @param {{ token: string, fetch?: typeof globalThis.fetch }} opts
 * @returns {typeof globalThis.fetch}
 * @example
 *   const brokenFetch = withChaos({ birdeye: 'http:429' }, { token });
 *   const res = await brokenFetch('https://three.ws/api/pump/dashboard?agent_id=...');
 *   assertDegraded(res, { tier: ['stale', 'fallback'] });
 */
export function withChaos(faults, { token, fetch: baseFetch = globalThis.fetch } = {}) {
	const injected = chaosHeaders(faults, token);
	return async function chaosFetch(input, init = {}) {
		const headers = new Headers(init.headers || (typeof input === 'object' && input?.headers) || undefined);
		for (const [k, v] of Object.entries(injected)) headers.set(k, v);
		return baseFetch(input, { ...init, headers });
	};
}

/**
 * Whether the server actually applied the directive.
 *
 * Always check this before drawing a conclusion. A refused directive means the
 * request ran normally, so a green assertion after a refusal proves nothing
 * about the fallback, which is the single easiest way to fool yourself with a
 * tool like this.
 *
 * @param {Response} res
 * @returns {{ applied: boolean, reason: string|null, faults: number }}
 */
export function chaosOutcome(res) {
	const raw = res?.headers?.get?.(CHAOS_STATUS_HEADER) || '';
	if (!raw) return { applied: false, reason: 'no_status_header', faults: 0 };
	if (raw.startsWith('applied')) {
		const n = Number((raw.match(/faults=(\d+)/) || [])[1] || 0);
		return { applied: true, reason: null, faults: n };
	}
	return { applied: false, reason: (raw.match(/reason=([a-z_]+)/) || [])[1] || 'refused', faults: 0 };
}
