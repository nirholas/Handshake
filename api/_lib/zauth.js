// zauthx402 SDK adapter for Vercel serverless.
//
// The upstream `@zauthx402/sdk/middleware` is shaped for Express: it expects
// `req.path`, `req.protocol`, `req.get(name)`, `req.originalUrl`, `req.ip`,
// and patches `res.json/send/end`. Our endpoints run as bare Vercel Node
// handlers (http.IncomingMessage / http.ServerResponse), so we shim the
// missing properties before invoking the middleware once per request.
//
// Disabled cleanly when ZAUTH_API_KEY is unset — `instrument()` becomes a
// no-op so unrelated environments don't pay any cost.
//
// Import from the main entry — `zauthProvider` is re-exported there. The
// docs use `@zauthx402/sdk/middleware`, but Vercel's @vercel/nft fails to
// bundle that subpath (conditional exports import/require split), so the
// dist/middleware/index.js is missing in /var/task at runtime. The main
// entry traces correctly.

import { zauthProvider } from '@zauthx402/sdk';
import { env } from './env.js';

let cached;
let _bootLogged = false;

function buildMiddleware() {
	const apiKey = env.ZAUTH_API_KEY;
	if (!apiKey) {
		if (env.ZAUTH_DEBUG === '1' && !_bootLogged) {
			console.log('[zauth] disabled: ZAUTH_API_KEY not set');
			_bootLogged = true;
		}
		return null;
	}
	try {
		// Vercel serverless freezes the function the moment res.end returns,
		// killing the SDK's default 5-second batch timer (and any in-flight
		// POST to back.zauthx402.com). Force flush-per-event so submission
		// starts immediately; the `drain()` helper below keeps the lambda
		// alive long enough for that POST to complete.
		const mw = zauthProvider(apiKey, {
			shouldMonitor: shouldMonitorReq,
			debug: env.ZAUTH_DEBUG === '1',
			batching: { maxBatchSize: 1, maxBatchWaitMs: 0, retry: false },
		});
		if (env.ZAUTH_DEBUG === '1' && !_bootLogged) {
			console.log('[zauth] middleware initialized');
			_bootLogged = true;
		}
		return mw;
	} catch (err) {
		console.error('[zauth] failed to build middleware:', err.message);
		return null;
	}
}

function shouldMonitorReq(req) {
	if (req.headers?.['x-payment-intent'] || req.headers?.['x-payment']) return true;
	const p = req.path || '';
	return /\/api\/(wk-x402|mcp)(\/|$)|\/api\/agents\/x402\/|\/api\/agents\/[^/]+\/x402\/|\/api\/agents\/payments\//.test(
		p,
	);
}

function getMiddleware() {
	if (cached === undefined) cached = buildMiddleware();
	return cached;
}

/**
 * Diagnostic snapshot — does not invoke the middleware. Returns whether the
 * SDK initialized successfully and a key prefix safe to surface in responses.
 */
export function status() {
	const apiKey = env.ZAUTH_API_KEY;
	const initialized = getMiddleware() != null;
	return {
		initialized,
		hasKey: Boolean(apiKey),
		keyPrefix: apiKey ? apiKey.slice(0, 14) : null,
		debug: env.ZAUTH_DEBUG === '1',
	};
}

function shimResponse(res) {
	// The Express middleware does `res.json.bind(res)` / `res.send.bind(res)`
	// up-front, even if the handler never calls them. Provide Express-shaped
	// no-op fallbacks (delegating to `res.end`) so binding works. Our handlers
	// only call `res.end` directly, so these patched versions are never run.
	if (typeof res.json !== 'function') {
		res.json = function (body) {
			if (!res.getHeader('content-type')) {
				res.setHeader('content-type', 'application/json; charset=utf-8');
			}
			res.end(JSON.stringify(body));
		};
	}
	if (typeof res.send !== 'function') {
		res.send = function (body) {
			res.end(typeof body === 'string' ? body : JSON.stringify(body));
		};
	}
}

function shimRequest(req) {
	const url = req.url || '/';
	const qIdx = url.indexOf('?');
	const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
	const xfProto = req.headers['x-forwarded-proto'];
	const protocol = (Array.isArray(xfProto) ? xfProto[0] : xfProto) || 'https';
	const xfFor = req.headers['x-forwarded-for'];
	const ip =
		(typeof xfFor === 'string' ? xfFor.split(',')[0].trim() : null) ||
		req.socket?.remoteAddress ||
		'';

	if (!('path' in req)) Object.defineProperty(req, 'path', { value: path });
	if (!('originalUrl' in req)) Object.defineProperty(req, 'originalUrl', { value: url });
	if (!('protocol' in req)) Object.defineProperty(req, 'protocol', { value: protocol });
	if (!('ip' in req)) Object.defineProperty(req, 'ip', { value: ip });
	if (typeof req.get !== 'function') {
		req.get = (name) => {
			const v = req.headers[String(name).toLowerCase()];
			return Array.isArray(v) ? v[0] : v;
		};
	}
	// `req.body` is undefined on raw Vercel handlers; the SDK only reads it
	// for an optional byte-size estimate, so leaving it undefined is fine.
}

/**
 * Run the zauth middleware once for this request. Safe to call on every
 * request — internal `shouldMonitor` filters non-x402 traffic. Returns
 * `true` if this request will be reported (caller should `await drain()`
 * after `res.end` to keep the lambda alive long enough to flush).
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
export function instrument(req, res) {
	const mw = getMiddleware();
	if (!mw) return false;
	try {
		shimRequest(req);
		shimResponse(res);
		const monitored = shouldMonitorReq(req);
		mw(req, res, () => {});
		return monitored;
	} catch (err) {
		console.error('[zauth] middleware error:', err.message);
		return false;
	}
}

/**
 * Wait briefly for the SDK's fire-and-forget POST to `back.zauthx402.com`
 * to complete before Vercel freezes the function. Only call this on
 * requests where `instrument()` returned true.
 */
export function drain() {
	return new Promise((resolve) => setTimeout(resolve, 250));
}
