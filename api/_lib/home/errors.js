// The one error contract the whole Home surface speaks.
//
// Three different readers consume a failure from /api/home/*: the connect UI,
// which has to say something a person can act on; the agent tool layer, which
// hands the result to a language model; and the bridge runtime itself. If each
// route invented its own shape those three would disagree, and the disagreement
// would surface as an agent treating a refusal as a success. So the vocabulary
// lives here, once, and every route maps through `homeError`.
//
// The vocabulary is the `@three-ws/home-bridge` ERR set (bad_url, auth,
// unreachable, call_failed, needs_confirmation, no_mcp, not_connected) plus the
// transport codes a client library cannot produce on its own (not_found,
// unauthorized, validation_error). One table for the client, not two.
//
// Two mappings in here are deliberate and worth stating out loud:
//
//   * `needs_confirmation` is 409, not 403 and not 200. It is a conflict with
//     the current authorization state and it is retryable with the same body
//     plus a human's explicit yes. A 403 reads as terminal to every HTTP client
//     ever written, and a 200 with an error field reads as SUCCESS to a language
//     model, which is exactly how an agent talks itself into unlocking a door.
//   * `auth` is 400, not 401. A 401 from us would mean "your three.ws session is
//     bad"; this code means "Home Assistant rejected the token you gave us",
//     which is a problem with the submitted data. Conflating them makes a
//     browser log the user out because their house's token expired.
//
// The response body carries the code twice on purpose. `error` /
// `error_description` is the platform-wide envelope that every existing three.ws
// client and the shared `error()` helper in api/_lib/http.js already read;
// `code` / `message` is the shape the Home surface's own clients (orders 04 and
// 05) were specified against. Emitting both costs 30 bytes and means neither
// reader needs a special case.

import { ERR, HomeBridgeError } from '@three-ws/home-bridge';

import { error as httpError } from '../http.js';
import { HOME_RUNTIME_ERR } from './runtime.js';

/** The bridge vocabulary plus the codes only a transport can produce. */
export const HOME_ERR = Object.freeze({
	...ERR,
	/** Not this caller's home. Also what an unknown id returns: never confirm existence. */
	NOT_FOUND: 'not_found',
	/** No three.ws session and no valid bearer token. */
	UNAUTHORIZED: 'unauthorized',
	/** The request body or query is malformed. */
	VALIDATION: 'validation_error',
});

/**
 * HTTP status per code. Anything absent from this table is a bug in the caller,
 * not a client error, so it falls through to 500 and gets reported.
 */
const STATUS_BY_CODE = Object.freeze({
	[HOME_ERR.BAD_URL]: 400,
	[HOME_ERR.AUTH]: 400,
	[HOME_ERR.VALIDATION]: 400,
	[HOME_ERR.UNAUTHORIZED]: 401,
	[HOME_ERR.NOT_FOUND]: 404,
	[HOME_ERR.NEEDS_CONFIRMATION]: 409,
	[HOME_ERR.UNREACHABLE]: 502,
	[HOME_ERR.CALL_FAILED]: 502,
	[HOME_ERR.NOT_CONNECTED]: 503,
	// no_mcp is not an error on any route: a home without the Model Context
	// Protocol Server integration is an ordinary home. It reaches the client as
	// `capabilities.mcp = false` plus the setting path to turn it on. It is
	// mapped here only so a stray throw from the MCP probe still lands as a
	// client-fixable 400 rather than a 500 someone has to page about.
	[HOME_ERR.NO_MCP]: 400,
});

/**
 * The runtime raises three codes of its own (api/_lib/home/runtime.js) so its
 * internal states stay distinguishable in a log. A client must not have to learn
 * a second vocabulary for them, so each one collapses onto the published code
 * that means the same thing to a person, and the precise one rides along as
 * `detail_code` for whoever is reading the server log at 3am.
 *
 *   home_not_found   -> not_found      "no such home", said without confirming one
 *   home_revoked     -> auth           the credential is gone; reconnect the home
 *   home_breaker_open-> not_connected  retries are paused; try again shortly
 */
const RUNTIME_CODE_ALIASES = Object.freeze({
	[HOME_RUNTIME_ERR.NOT_FOUND]: HOME_ERR.NOT_FOUND,
	[HOME_RUNTIME_ERR.REVOKED]: HOME_ERR.AUTH,
	[HOME_RUNTIME_ERR.BREAKER_OPEN]: HOME_ERR.NOT_CONNECTED,
});

/**
 * Build a coded failure. Returns (never throws) a `HomeBridgeError` so the
 * runtime, the store and the routes all raise one class.
 *
 * @param {string} code one of HOME_ERR
 * @param {string} message a sentence a person can act on
 * @param {{ pending?: object, detail?: object, cause?: unknown }} [extra]
 * @returns {HomeBridgeError}
 */
export function homeFailure(code, message, extra = {}) {
	const err = new HomeBridgeError(code, message, extra.cause);
	if (extra.pending) err.pending = extra.pending;
	if (extra.detail) err.detail = extra.detail;
	return err;
}

/** The 404 every ownership miss returns, worded so it reveals nothing. */
export function notFound(what = 'home') {
	return homeFailure(HOME_ERR.NOT_FOUND, `No such ${what}.`);
}

/**
 * Normalize anything throwable into the wire shape, without deciding to send it.
 * Exported so order 04's tools can render the same fields into a tool result and
 * a test can assert the mapping without an HTTP round trip.
 *
 * @param {unknown} err
 * @returns {{ status: number, code: string, message: string, pending: object|null, unexpected: boolean }}
 */
export function toHomeFailure(err) {
	const raw = err instanceof HomeBridgeError ? err.code : null;
	const code = raw ? RUNTIME_CODE_ALIASES[raw] ?? raw : null;
	const status = code ? STATUS_BY_CODE[code] : undefined;
	if (!code || !status) {
		return {
			status: 500,
			code: 'internal_error',
			// Never echo an unknown throwable's message: it can carry a URL with a
			// token in it, a stack, or a database string. The correlation id in the
			// server log is how this one gets diagnosed.
			message: 'Something went wrong reaching your home.',
			pending: null,
			detailCode: null,
			unexpected: true,
		};
	}
	return {
		status,
		code,
		message: err.message || 'Your home could not be reached.',
		pending: err.pending ? sanitizePending(err.pending) : null,
		detailCode: raw !== code ? raw : null,
		unexpected: false,
	};
}

/**
 * Send a coded failure. The single exit every /api/home/* route uses for a
 * non-2xx, so the body shape cannot drift between them.
 *
 * A 5xx that did not come from the vocabulary is re-thrown to `wrap`, which owns
 * correlation ids, Sentry capture and the ops alert. Swallowing it here would
 * turn a real outage into a quiet 500 nobody sees.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} err
 */
export function homeError(res, err) {
	const failure = toHomeFailure(err);
	if (failure.unexpected) throw err;
	return httpError(res, failure.status, failure.code, failure.message, {
		code: failure.code,
		message: failure.message,
		...(failure.detailCode ? { detail_code: failure.detailCode } : {}),
		...(failure.pending ? { pending: failure.pending } : {}),
	});
}

/**
 * What a 409 tells the client about the action it must confirm.
 *
 * The point of `pending` is that the client can re-POST it verbatim with
 * `confirmed: true` after a human says yes, so it has to carry the RESOLVED
 * target (the entity id the gate actually matched), not the phrase or the area
 * name the caller sent. Confirming "the door" and having a different door open
 * is the failure mode this shape exists to prevent.
 *
 * Nothing but the known keys survives, because `pending` originates inside a
 * bridge error whose `data` came from the caller and is echoed straight back
 * into a model prompt in order 04.
 */
function sanitizePending(pending) {
	const out = {};
	if (pending.domain) out.domain = String(pending.domain);
	if (pending.service) out.service = String(pending.service);
	if (pending.tool) out.tool = String(pending.tool);
	if (pending.entityId) out.entityId = String(pending.entityId);
	if (Array.isArray(pending.targets)) out.targets = pending.targets.map(String);
	if (pending.risk) out.risk = String(pending.risk);
	if (pending.data && typeof pending.data === 'object') out.data = pending.data;
	if (pending.arguments && typeof pending.arguments === 'object') out.arguments = pending.arguments;
	if (pending.phrase) out.phrase = String(pending.phrase);
	return out;
}
