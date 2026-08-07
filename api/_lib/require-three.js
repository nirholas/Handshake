// Server enforcement for the $THREE hold-to-access lever.
//
// The keystone that turns the `three-access.js` registry from a read into an
// actual gate: one helper any Vercel function calls to require a minimum holder
// tier for a feature, with a hold-OR-pay 402 when the caller falls short.
//
// Semantics mirror cors()/method() in http.js — on a BLOCKED request it writes
// the response itself and returns `{ ok: false }`; on an ALLOWED request it
// writes nothing and returns `{ ok: true, access, level, wallet }`:
//
//   const gate = await requireFeatureAccess(req, res, 'forge.high', { body });
//   if (!gate.ok) return; // 402 three_hold_required already sent
//
// Resolution is pass-first: a signed tier pass is pure-HMAC (no RPC), so a holder
// presenting one is never wrongly blocked during a price/RPC outage. It then
// falls back to the session user's on-chain tier, then anonymous Member. Every
// failure degrades to Member (a normal 402), never a 500.

import { json, error } from './http.js';
import { verifyTierPass, resolveUserTier } from './three-tier.js';
import { accessFromTierLevel, gatedFeature, requiredTierFor } from './three-access.js';
import { catalogEntry } from './pricing/catalog.js';
import { getSessionUser } from './auth.js';
import { resolveCompAccess, COMP_TIER_LEVEL } from './comp-access.js';
import { TOKEN_MINT, publicConfig } from './token/config.js';

// The "how to acquire $THREE" block the 402 surfaces so a non-holder can act
// without leaving the error. Mint is the platform config; the swap/pump URLs are
// derived from the canonical mint. Symbol drops a leading "$" for clean URLs/copy.
function acquireBlock() {
	let symbol = 'THREE';
	try {
		symbol = String(publicConfig().symbol || 'THREE').replace(/^\$/, '') || 'THREE';
	} catch {
		symbol = 'THREE';
	}
	return {
		mint: TOKEN_MINT,
		symbol,
		swap_url: `https://jup.ag/swap/SOL-${TOKEN_MINT}`,
		pump_url: `https://pump.fun/coin/${TOKEN_MINT}`,
	};
}

// Resolve the caller's verified holder level for gating. Comp-first (an allowlisted
// account is entitled regardless of what it holds), then a signed tier pass (pure
// HMAC, never depends on a live RPC), then the session user's on-chain tier, then
// anonymous Member (level 0). Never throws.
async function resolveCaller(req, res, body) {
	// 0. Comped account (api/_lib/comp-access.js): full access with no wallet, no
	//    hold, no payment. Checked FIRST so a stale low-tier pass in the client's
	//    storage can't under-resolve a comped caller, and it costs an anonymous
	//    request nothing (the lookup short-circuits without a session cookie).
	const comp = await resolveCompAccess(req, res);
	if (comp.comped) {
		return {
			level: COMP_TIER_LEVEL,
			wallet: comp.user?.wallet_address || null,
			usd: null,
			source: 'comp',
			hasUser: true,
			hasWallet: Boolean(comp.user?.wallet_address),
		};
	}

	// 1. Signed tier pass — header or parsed body. Pure HMAC, no RPC.
	const token = req.headers?.['x-three-tier-pass'] || body?.tier_pass || null;
	if (token) {
		const payload = verifyTierPass(token);
		if (payload) {
			return {
				level: Math.max(0, Number(payload.level) || 0),
				wallet: payload.wallet || null,
				usd: null,
				source: 'pass',
				hasUser: false,
				hasWallet: Boolean(payload.wallet),
			};
		}
	}

	// 2. Session user → on-chain tier (degrades to Member on any failure).
	let user = null;
	try {
		user = await getSessionUser(req, res);
	} catch {
		user = null;
	}
	if (user?.wallet_address) {
		try {
			const { tier, usd } = await resolveUserTier(user);
			return {
				level: tier.level,
				wallet: user.wallet_address,
				usd: Math.round((Number(usd) || 0) * 100) / 100,
				source: 'onchain',
				hasUser: true,
				hasWallet: true,
			};
		} catch {
			return {
				level: 0,
				wallet: user.wallet_address,
				usd: 0,
				source: 'onchain',
				hasUser: true,
				hasWallet: true,
			};
		}
	}

	// 3. Anonymous / signed-in without a linked wallet.
	return {
		level: 0,
		wallet: null,
		usd: 0,
		source: 'anon',
		hasUser: Boolean(user),
		hasWallet: false,
	};
}

// access.reason upgraded with auth context: a presented (but short) pass is an
// insufficient-tier case; otherwise no user → sign in, user without a wallet →
// link a wallet, else under the threshold.
function reasonFor(caller) {
	if (caller.source === 'pass') return 'insufficient_tier';
	if (!caller.hasUser) return 'sign_in';
	if (!caller.hasWallet) return 'link_wallet';
	return 'insufficient_tier';
}

/**
 * Require a minimum $THREE holder tier for a feature.
 * @param {object} req
 * @param {object} res
 * @param {string} featureId          a key of GATED_FEATURES (three-access.js)
 * @param {object} [opts]
 * @param {boolean} [opts.allowPayPerUse=true]  include the pay-per-use action in
 *   the 402 so a non-holder can pay once in $THREE instead of holding.
 * @param {object|null} [opts.body]    a pre-parsed request body (so the helper can
 *   read body.tier_pass without re-reading the stream).
 * @returns {Promise<{ ok: true, access, level, wallet } | { ok: false }>}
 */
export async function requireFeatureAccess(req, res, featureId, opts = {}) {
	const { allowPayPerUse = true, body = null } = opts;

	// A typo'd featureId is a clean 404, not a 500.
	try {
		gatedFeature(featureId);
	} catch (err) {
		error(res, 404, 'unknown_feature', err?.message || `unknown gated feature: ${featureId}`);
		return { ok: false };
	}

	const caller = await resolveCaller(req, res, body);
	const access = accessFromTierLevel(caller.level, featureId);

	if (access.eligible) {
		return { ok: true, access, level: caller.level, wallet: caller.wallet };
	}

	// Blocked → structured 402 with everything the UI needs to recover. Build the
	// `required` tier explicitly (level/id/label from the access view + the USD
	// threshold from the tier ladder) so the payload carries `min_usd` regardless
	// of the access registry's display shape.
	const requiredMinUsd = Number(requiredTierFor(featureId).minUsd) || 0;
	const required = {
		level: access.required.level,
		id: access.required.id,
		label: access.required.label,
		min_usd: requiredMinUsd,
	};
	// Only the on-chain path carries a USD value; the pass path proved the level
	// without a price (and a passing holder never reaches here anyway).
	const heldUsd = caller.source === 'onchain' ? Number(caller.usd) || 0 : 0;
	const usdToGo = Math.max(0, Math.round((requiredMinUsd - heldUsd) * 100) / 100);

	let payPerUse = null;
	if (allowPayPerUse && access.pay_per_use) {
		let usd = null;
		try {
			const p = Number(catalogEntry(access.pay_per_use).usd);
			usd = p >= 0 ? p : null;
		} catch {
			usd = null; // a missing/variable price never fails the 402
		}
		payPerUse = { action: access.pay_per_use, usd };
	}

	const held = {
		level: access.held.level,
		id: access.held.id,
		label: access.held.label,
		usd: heldUsd,
	};
	const message = payPerUse
		? `${access.label} requires holding $THREE (${required.label}+) — or pay per use.`
		: `${access.label} requires holding $THREE (${required.label}+).`;

	json(res, 402, {
		error: 'three_hold_required',
		message,
		feature: featureId,
		label: access.label,
		why: access.why,
		reason: reasonFor(caller),
		held,
		required,
		usd_to_go: usdToGo,
		acquire: acquireBlock(),
		pay_per_use: payPerUse,
	});
	return { ok: false };
}
