// GET /api/x402/preflight: signed proof that this seller can settle right now.
// Also served at /.well-known/x402-preflight (see vercel.json).
//
//   GET /api/x402/preflight                          all networks
//   GET /api/x402/preflight?network=solana:mainnet   one network
//   GET /api/x402/preflight?endpoint=/api/x402/echo  plus that route's price
//   GET /api/x402/preflight?ttl=30                   shorter validity
//
// This is the I/O half of x402 Preflight; the format, the signing and the
// verification are pure and live in api/_lib/x402/preflight.js. See
// specs/x402-preflight.md for the wire contract and packages/x402-preflight for
// the client that consumes it.
//
// Every field is measured, never declared:
//   * settle rate + window + sample come from gatherX402SettleHealth(), the same
//     sensor healthz uses, reading real rows out of x402_autonomous_log.
//   * sponsor state comes from the live floor guard in self-facilitator.js.
//   * network configuration comes from the same env the 402 challenge builder
//     reads, so preflight cannot claim an accept the challenge would not offer.
//
// It is deliberately CHEAP and public: no auth, no payment, aggressively
// cacheable for its own lifetime. An assurance endpoint that is expensive or
// gated is one nobody calls, and one nobody calls prevents nothing. The whole
// value is that a client can afford to ask before every purchase.

import { cors, json, method, wrap } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { loadAttesterKeypair } from '../_lib/attest-event.js';
import { gatherX402SettleHealth } from '../_lib/ops/x402-settle-health.js';
import {
	SPONSOR_SOL_FLOOR_LAMPORTS,
	sponsorKnownBelowFloor,
	refreshSponsorFloorState,
} from '../_lib/x402/self-facilitator.js';
import {
	buildPreflightReport,
	decideNetworkPayability,
	signPreflight,
	PREFLIGHT_TTL_SECONDS,
	PREFLIGHT_MAX_TTL_SECONDS,
	PREFLIGHT_SPEC,
} from '../_lib/x402/preflight.js';

// Network ids are CAIP-2, the same identifiers the 402 challenge uses, so a
// client can match a preflight verdict to an accept without a translation table.
const SOLANA = 'solana:mainnet';
const BASE = 'eip155:8453';

// USDC, the only asset the platform settles. Named in the report so a client can
// check it is being quoted the asset it holds before it prepares a transfer.
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// One signed report is reused for its whole validity window rather than re-signed
// per request. Signing is cheap but the sensor behind it runs a DB aggregation,
// and a fleet of agents preflighting every purchase would otherwise turn an
// assurance check into its own load problem. The cache can never outlive the
// attestation because both expire off the same instant.
let _cache = null;

function cacheKey(ttl, endpoint) {
	return `${ttl}|${endpoint || ''}`;
}

/**
 * Read the live settle sensor, degrading to `unknown` rather than throwing.
 * A preflight that cannot measure must say so; it must never assume health.
 */
async function readSettle() {
	try {
		const h = await gatherX402SettleHealth();
		const m = h?.metrics || {};
		return {
			status: h?.status ?? 'unknown',
			rate: typeof m.rate === 'number' ? m.rate : null,
			attempts: Number(m.attempts) || 0,
			windowHours: Number(m.windowHours) || null,
			cause: m.cause ?? null,
			floorSignals: Number(m.floorSignals) || 0,
		};
	} catch {
		return { status: 'unknown', rate: null, attempts: 0, windowHours: null, cause: null, floorSignals: 0 };
	}
}

/**
 * Is the Solana fee sponsor under its floor?
 *
 * Two independent sources, because on 2026-08-28 the first one alone was wrong
 * for three hours: the cached floor guard is only written by a balance read, and
 * the RPC lanes that answer balance reads were all over quota. The settle
 * sensor's own diagnosis is the second opinion, derived from failures the chain
 * already returned, and it is available exactly when the balance read is not.
 * Either one saying "below floor" is enough to withhold a payable verdict.
 * @param {{cause: string|null, floorSignals: number}} settle
 * @returns {boolean|null} null when neither source can tell
 */
function sponsorBelowFloor(settle) {
	// Warm the cached guard without blocking: it refreshes at most once per
	// balance-cache window and swallows RPC errors by design.
	try {
		refreshSponsorFloorState();
	} catch {
		/* the guard is advisory; an unreadable balance must not fail preflight */
	}
	if (sponsorKnownBelowFloor()) return true;
	if (settle.cause === 'sponsor_floor' || settle.floorSignals > 0) return true;
	// Not proven below. Only claim "above floor" when the platform is actually
	// configured to sponsor at all; otherwise the answer is genuinely unknown.
	return env.X402_FEE_PAYER_SOLANA ? false : null;
}

async function buildEnvelope({ ttl, endpointPath, origin }) {
	const settle = await readSettle();
	const belowFloor = sponsorBelowFloor(settle);

	const solanaConfigured = !!(
		(env.X402_PAY_TO_SOLANA || process.env.X402_PAY_TO) && env.X402_FEE_PAYER_SOLANA
	);
	const baseConfigured = !!process.env.X402_PAY_TO_BASE;

	/** @type {Record<string, object>} */
	const networks = {};
	if (solanaConfigured || env.X402_PAY_TO_SOLANA) {
		networks[SOLANA] = {
			...decideNetworkPayability({
				configured: solanaConfigured,
				sponsorBelowFloor: belowFloor,
				settleStatus: settle.status,
				settleRate: settle.rate,
				attempts: settle.attempts,
				windowHours: settle.windowHours,
			}),
			asset: USDC_SOLANA,
			pay_to: env.X402_PAY_TO_SOLANA || process.env.X402_PAY_TO || undefined,
		};
	}
	if (baseConfigured) {
		networks[BASE] = {
			// Base settles through the buyer's own fee payment, so our Solana
			// sponsor's balance says nothing about it. Passing the Solana floor in
			// here would have marked Base unpayable for three hours on 2026-08-28
			// for a reason that never applied to it.
			...decideNetworkPayability({
				configured: true,
				sponsorBelowFloor: null,
				settleStatus: settle.status,
				settleRate: settle.rate,
				attempts: settle.attempts,
				windowHours: settle.windowHours,
			}),
			asset: USDC_BASE,
			pay_to: process.env.X402_PAY_TO_BASE,
		};
	}

	const report = buildPreflightReport({
		subject: origin,
		networks,
		ttlSeconds: ttl,
		endpoint: endpointPath ? { path: endpointPath } : undefined,
	});

	const keypair = loadAttesterKeypair();
	return signPreflight(report, keypair.secretKey);
}

export default wrap(async function handler(req, res) {
	// Open to every origin on purpose. A browser-side agent, a third-party
	// dashboard and the /preflight page all need to read this cross-origin, and an
	// attestation is public, signed, and carries nothing secret. Locking it down
	// would only stop the clients it exists to serve.
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `https://${req.headers.host || 'three.ws'}`);
	const ttl = Math.min(
		PREFLIGHT_MAX_TTL_SECONDS,
		Math.max(1, Number(url.searchParams.get('ttl')) || PREFLIGHT_TTL_SECONDS),
	);
	const network = url.searchParams.get('network');
	const endpointPath = url.searchParams.get('endpoint');
	const origin = `https://${req.headers.host || 'three.ws'}`;

	const key = cacheKey(ttl, endpointPath);
	const now = Date.now();
	let envelope = null;
	if (_cache && _cache.key === key && _cache.until > now) envelope = _cache.envelope;

	if (!envelope) {
		try {
			envelope = await buildEnvelope({ ttl, endpointPath, origin });
		} catch (err) {
			// The attester key is the one hard dependency. Without it the honest
			// answer is that no assurance is available, NOT an unsigned report a
			// client might mistake for one. 503 so a client backs off and retries.
			return json(res, 503, {
				error: 'preflight_unavailable',
				error_description:
					'This origin cannot sign a preflight attestation right now. An unsigned report ' +
					'is not an assurance, so none is returned.',
				spec: PREFLIGHT_SPEC,
				detail: err?.message || String(err),
			}, { 'cache-control': 'no-store', 'retry-after': '60' });
		}
		// Expire the cache a beat BEFORE the attestation does, so a client can
		// never be handed a copy that dies in flight.
		_cache = { key, envelope, until: now + Math.max(1, ttl - 2) * 1000 };
	}

	if (network) {
		const n = envelope.report.networks[network];
		if (!n) {
			return json(res, 404, {
				error: 'network_not_offered',
				error_description: `this origin does not offer ${network}`,
				offered: Object.keys(envelope.report.networks),
			}, { 'cache-control': 'no-store' });
		}
	}

	// Cacheable for exactly as long as the attestation is valid and no longer.
	// `must-revalidate` keeps a shared cache from serving it one second past
	// expiry, which would hand a client an attestation that fails verification.
	const remaining = Math.max(0, Math.floor((Date.parse(envelope.report.expires_at) - Date.now()) / 1000));
	return json(res, 200, envelope, {
		'cache-control': `public, max-age=${remaining}, must-revalidate`,
		'x-preflight-spec': PREFLIGHT_SPEC,
		'x-preflight-expires': envelope.report.expires_at,
		// Named so a reader of the raw response knows what the floor is measured
		// against without having to find it in the source.
		'x-preflight-sponsor-floor-lamports': String(SPONSOR_SOL_FLOOR_LAMPORTS),
	});
});
