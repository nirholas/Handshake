// x402 payment-bypass hook (USE-23).
//
// Wraps the v2 SDK lifecycle hook `onProtectedRequest` shape but adapted to
// our plain Vercel Node handlers + the in-house `paidEndpoint(spec)` factory
// in api/_lib/x402-paid-endpoint.js. Three callers can short-circuit the
// 402 challenge:
//
//   1. Internal services           — request supplies `X-API-Key: $INTERNAL_API_KEY`.
//   2. Subscriptions / partners    — `X-API-Key: <x402_live_...>` looked up in
//                                    x402_subscriptions, rate-limited per route.
//   3. OAuth Bearer tokens         — `Authorization: Bearer <jwt>` with the
//                                    route's declared `requiredScope`.
//
// When no bypass applies the hook returns `null` and the 402 flow continues
// unchanged. Every bypass (and every denial — invalid key, expired, rate
// limited, wrong scope) writes one row to x402_access_log so USE-24 can
// reconstruct who used which endpoint for free.

import { authenticateBearer, extractBearer, hasScope } from '../auth.js';
import { constantTimeEquals } from '../crypto.js';
import {
	checkRateLimit,
	logAccess,
	lookupSubscription,
} from './api-keys.js';
import { clientIp } from '../rate-limit.js';
import {
	isAwsCustomerInactive,
	meterAwsSubscriptionUsage,
} from '../aws-marketplace-bridge.js';

const API_KEY_HEADER = 'x-api-key';

/**
 * Build an `accessControl` hook for `paidEndpoint(spec)`. Returns an async
 * function `(req, routeConfig) => result` matching the v2 `onProtectedRequest`
 * contract:
 *   • return `{ grantAccess: true, reason, callerId, headers? }` → skip payment
 *   • return `{ abort: true, reason, status? }`                  → reject with 4xx
 *   • return `null` / `undefined`                                → continue to 402
 *
 * @param {object} [opts]
 * @param {string} [opts.requiredScope]          OAuth scope required to bypass
 *                                               via Bearer token (e.g. "x402:bypass").
 *                                               When unset, OAuth bypass is disabled.
 * @param {(ctx: { req, route }) => Promise<null | { grantAccess, reason, callerId }>}
 *        [opts.resolveCaller]                   Custom resolver run BEFORE the
 *                                               built-in API-key / OAuth checks.
 *                                               Useful for IP allowlists, partner-
 *                                               specific signed headers, etc.
 */
export function installAccessControl({ requiredScope, resolveCaller } = {}) {
	return async function onProtectedRequest(req, routeConfig) {
		const route = routeConfig?.path || routeConfig?.route || req.url || 'unknown';
		const meta = {
			ip: clientIp(req),
			ua: String(req.headers['user-agent'] || '').slice(0, 200),
		};

		// (0) Custom resolver — first say is the user's say.
		if (typeof resolveCaller === 'function') {
			const custom = await resolveCaller({ req, route, routeConfig });
			if (custom?.grantAccess) {
				logAccess({
					callerId: custom.callerId || 'custom',
					route,
					reason: custom.reason || 'custom:granted',
					granted: true,
					meta,
				});
				return custom;
			}
			if (custom?.abort) {
				logAccess({
					callerId: custom.callerId || `abort:${custom.reason || 'custom'}`,
					route,
					reason: custom.reason || 'custom:denied',
					granted: false,
					meta,
				});
				return custom;
			}
		}

		// (1) Internal service key — exact match against env, constant-time.
		const apiKey = readHeader(req, API_KEY_HEADER);
		const internalKey = process.env.INTERNAL_API_KEY;
		if (apiKey && internalKey && constantTimeEquals(apiKey, internalKey)) {
			logAccess({
				callerId: 'internal',
				route,
				reason: 'internal',
				granted: true,
				meta,
			});
			return { grantAccess: true, reason: 'internal', callerId: 'internal' };
		}

		// (2) Subscription key — db lookup + per-route sliding-window limit.
		if (apiKey) {
			const sub = await lookupSubscription(apiKey);
			if (!sub) {
				logAccess({
					callerId: 'abort:invalid_key',
					route,
					reason: 'Invalid API key',
					granted: false,
					meta: { ...meta, key_prefix: apiKey.slice(0, 16) },
				});
				return { abort: true, status: 403, reason: 'Invalid API key' };
			}
			if (sub._status === 'revoked') {
				logAccess({
					callerId: `abort:revoked:${sub.id}`,
					route,
					reason: 'Subscription revoked',
					granted: false,
					meta,
				});
				return { abort: true, status: 403, reason: 'Subscription revoked' };
			}
			if (sub._status === 'expired') {
				logAccess({
					callerId: `abort:expired:${sub.id}`,
					route,
					reason: 'Subscription expired',
					granted: false,
					meta,
				});
				return { abort: true, status: 403, reason: 'Subscription expired' };
			}
			// Defense-in-depth for AWS Marketplace: when AWS has cancelled the
			// customer's subscription but the unsubscribe-success SNS notification
			// hasn't yet revoked the x402 row, abort here. Without this, a few
			// minutes of zombie bypass would slip through during the SNS lag.
			if (await isAwsCustomerInactive(sub)) {
				logAccess({
					callerId: `abort:aws_inactive:${sub.id}`,
					route,
					reason: 'AWS Marketplace subscription inactive',
					granted: false,
					meta,
				});
				return { abort: true, status: 403, reason: 'AWS Marketplace subscription inactive' };
			}
			const rl = await checkRateLimit(sub, route);
			if (!rl.allowed) {
				logAccess({
					callerId: `subscription:${sub.id}`,
					route,
					reason: 'rate_limit_exceeded',
					granted: false,
					meta: { ...meta, limit: rl.limit, resetAt: rl.resetAt },
				});
				return {
					abort: true,
					status: 429,
					reason: `Rate limit exceeded — ${rl.limit}/min, retry after ${new Date(rl.resetAt).toISOString()}`,
					headers: {
						'x-ratelimit-limit': String(rl.limit),
						'x-ratelimit-remaining': '0',
						'x-ratelimit-reset': String(Math.ceil(rl.resetAt / 1000)),
						'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
					},
				};
			}
			logAccess({
				callerId: `subscription:${sub.id}`,
				route,
				reason: `subscription:${sub.id}`,
				granted: true,
				meta: { ...meta, remaining: rl.remaining, limit: rl.limit },
			});
			// AWS Marketplace customers carry source=aws-marketplace in meta;
			// when configured for a Usage product, meter the call to AWS so
			// they're billed for this entitled access.
			if (sub.meta?.source === 'aws-marketplace') {
				meterAwsSubscriptionUsage({ subscriptionId: sub.id, route });
			}
			return {
				grantAccess: true,
				reason: `subscription:${sub.id}`,
				callerId: `subscription:${sub.id}`,
				headers: {
					'x-ratelimit-limit': String(rl.limit),
					'x-ratelimit-remaining': String(rl.remaining),
					'x-ratelimit-reset': String(Math.ceil(rl.resetAt / 1000)),
				},
				subscription: {
					id: sub.id,
					name: sub.name,
				},
			};
		}

		// (3) OAuth Bearer — only when the route declares a required scope.
		if (requiredScope) {
			const bearer = extractBearer(req);
			if (bearer) {
				const claims = await authenticateBearer(bearer);
				if (!claims) {
					logAccess({
						callerId: 'abort:invalid_oauth',
						route,
						reason: 'Invalid OAuth token',
						granted: false,
						meta,
					});
					// Don't 403 — fall through to payment flow. The caller may
					// simply have an unrelated user token they sent along.
					return null;
				}
				if (!hasScope(claims.scope, requiredScope)) {
					logAccess({
						callerId: `abort:oauth_scope:${claims.userId}`,
						route,
						reason: `Missing required scope: ${requiredScope}`,
						granted: false,
						meta: { ...meta, granted_scope: claims.scope },
					});
					// Same — let them pay normally.
					return null;
				}
				logAccess({
					callerId: `oauth:${claims.userId}`,
					route,
					reason: `oauth:${claims.userId}`,
					granted: true,
					meta: { ...meta, source: claims.source, clientId: claims.clientId || null },
				});
				return {
					grantAccess: true,
					reason: `oauth:${claims.userId}`,
					callerId: `oauth:${claims.userId}`,
					oauth: { userId: claims.userId, scope: claims.scope, clientId: claims.clientId },
				};
			}
		}

		// No bypass — payment flow continues.
		return null;
	};
}

function readHeader(req, name) {
	const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
	if (!v) return null;
	return Array.isArray(v) ? String(v[0]).trim() : String(v).trim();
}
