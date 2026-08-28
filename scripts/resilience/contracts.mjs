// Degradation contracts.
//
// A fallback is not automatically an improvement. Serving a remembered value is
// the right answer for a price chip and the wrong answer for a question whose
// whole purpose is to be current: this repo shipped four of those in one week.
// A payment retry re-signed the blockhash the facilitator had just refused. A
// token security endpoint assembled a clean bill of health out of remembered
// on-chain state at the exact moment the chain was unreadable. An access gate
// answered from a cached verdict. An alert feed went quiet in a way that looked
// like a calm market.
//
// Every one of those passed a "does it have a fallback" review. What none of
// them had was a stated answer to a different question: when this upstream is
// down, what is this endpoint ALLOWED to say? That is the contract, and this
// module is the vocabulary plus the harness that proves it by actually breaking
// the upstream and looking at the response.

/**
 * The contracts an endpoint can declare.
 *
 * MAY_SERVE_STALE
 *   A remembered value is a better answer than an error, and the response says
 *   so (a stale marker, an as_of stamp, or a header). Prices, feeds, boards.
 *
 * MUST_REFUSE
 *   There is no honest answer without a live read, so the endpoint must return a
 *   typed error rather than invent one. The failure mode this prevents is not a
 *   crash: it is a confident, wrong, cacheable 200.
 *
 * MUST_NOT_SERVE_STALE
 *   Stronger than MUST_REFUSE. The endpoint may answer 200 from live data, but
 *   a remembered value must never reach the caller, because acting on a stale
 *   answer costs money or grants access. Payment retries, security verdicts,
 *   authorization gates.
 */
export const CONTRACT = {
	MAY_SERVE_STALE: 'may-serve-stale',
	MUST_REFUSE: 'must-refuse',
	MUST_NOT_SERVE_STALE: 'must-not-serve-stale',
};

export const CONTRACT_VALUES = new Set(Object.values(CONTRACT));

/** Status codes that count as a typed refusal rather than a crash. */
const REFUSAL_STATUSES = new Set([424, 425, 429, 502, 503, 504]);

/**
 * Markers that say "this body is remembered, not live". A contract that allows
 * stale data requires one of these to be present, because degrading silently is
 * how a stale answer gets mistaken for a current one.
 */
export function staleMarkers(body, headers = {}) {
	const found = [];
	if (body && typeof body === 'object') {
		if (body.stale === true) found.push('body.stale');
		if (body.as_of !== undefined && body.as_of !== null) found.push('body.as_of');
		if (body.data && typeof body.data === 'object') {
			if (body.data.stale === true) found.push('body.data.stale');
			if (body.data.as_of !== undefined && body.data.as_of !== null) found.push('body.data.as_of');
		}
	}
	for (const key of Object.keys(headers || {})) {
		const k = key.toLowerCase();
		if (k.includes('stale')) found.push(`header.${k}`);
	}
	return found;
}

/**
 * Judge one observed response against a contract.
 *
 * Deliberately pure and transport-agnostic: the caller performs the fault
 * injection however its endpoint needs, then hands the outcome here. That keeps
 * the judgement identical whether the response came from an HTTP handler, an
 * exported library function, or a worker.
 *
 * @param {string} contract  one of CONTRACT
 * @param {{ status?: number, body?: any, headers?: object, threw?: unknown }} observed
 * @returns {{ ok: boolean, reason: string }}
 */
export function judge(contract, observed) {
	const { status, body, headers = {}, threw } = observed;

	if (threw !== undefined && threw !== null) {
		// A rejection that carries a typed status is a refusal expressed as an
		// exception, which the HTTP boundary turns into the same envelope.
		const typed = Number(threw?.status ?? threw?.statusCode);
		if (contract === CONTRACT.MAY_SERVE_STALE) {
			return { ok: false, reason: `threw instead of serving a remembered value: ${threw?.message || threw}` };
		}
		if (Number.isFinite(typed) && REFUSAL_STATUSES.has(typed)) {
			return { ok: true, reason: `refused with a typed ${typed}` };
		}
		if (threw?.code) return { ok: true, reason: `refused with code ${threw.code}` };
		return { ok: false, reason: `threw an untyped error: ${threw?.message || threw}` };
	}

	const markers = staleMarkers(body, headers);
	const is2xx = status === undefined || (status >= 200 && status < 300);

	switch (contract) {
		case CONTRACT.MAY_SERVE_STALE: {
			if (!is2xx) {
				// Refusing is allowed only when nothing was ever remembered; the
				// caller distinguishes those two cases by warming the endpoint first.
				return REFUSAL_STATUSES.has(status)
					? { ok: true, reason: `refused with a typed ${status} (nothing remembered yet)` }
					: { ok: false, reason: `answered ${status}, which is neither stale data nor a typed refusal` };
			}
			if (!markers.length) {
				return {
					ok: false,
					reason: 'served a 200 during a total upstream outage without marking it stale, so a remembered value is indistinguishable from a live one',
				};
			}
			return { ok: true, reason: `served remembered data, marked by ${markers.join(', ')}` };
		}

		case CONTRACT.MUST_REFUSE: {
			if (is2xx) {
				return {
					ok: false,
					reason: 'answered 2xx with every upstream down, which states as fact something it could not check',
				};
			}
			return REFUSAL_STATUSES.has(status)
				? { ok: true, reason: `refused with a typed ${status}` }
				: { ok: false, reason: `answered ${status}, which is not a typed "try again" refusal` };
		}

		case CONTRACT.MUST_NOT_SERVE_STALE: {
			if (is2xx && markers.length) {
				return {
					ok: false,
					reason: `served remembered data (${markers.join(', ')}) on a path where acting on a stale answer costs money or grants access`,
				};
			}
			if (is2xx) {
				return {
					ok: false,
					reason: 'answered 2xx with every upstream down, so the answer came from somewhere other than a live read',
				};
			}
			return REFUSAL_STATUSES.has(status)
				? { ok: true, reason: `refused with a typed ${status} rather than reusing a remembered answer` }
				: { ok: false, reason: `answered ${status}, which is not a typed refusal` };
		}

		default:
			return { ok: false, reason: `unknown contract "${contract}"` };
	}
}

/**
 * A fetch replacement that fails the way a dead upstream fails, for injecting a
 * total outage. `mode` picks the shape of the failure, because a refused
 * connection and a socket that accepts and never answers are different bugs and
 * have caught different ones here.
 *
 * @param {'network' | 'timeout' | 'status'} mode
 * @param {{ status?: number }} [opts]
 */
export function failingFetch(mode = 'network', { status = 503 } = {}) {
	if (mode === 'status') {
		return async () =>
			new Response(JSON.stringify({ error: 'upstream is down' }), {
				status,
				headers: { 'content-type': 'application/json' },
			});
	}
	if (mode === 'timeout') {
		return async (_url, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;
				const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
				if (!signal) return; // no deadline: hangs, which is itself the finding
				if (signal.aborted) return fail();
				signal.addEventListener('abort', fail, { once: true });
			});
	}
	return async () => {
		const err = new TypeError('fetch failed');
		err.cause = { code: 'ECONNREFUSED' };
		throw err;
	};
}
