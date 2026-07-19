// mayhem-filter.js — enforce "no pump.fun Mayhem tokens" for the sniper fleet.
//
// pump.fun tokens can launch in "Mayhem mode" (a higher-fee degen mode), flagged
// on the on-chain bonding curve as `isMayhemMode`. The new-mint firehose does NOT
// carry this flag, so we read the bonding curve once per mint (cached, shared
// across all agents) and gate the buy: Mayhem tokens are skipped, only normal
// pump.fun launches are sniped.
//
// Wires into the engine as an `oracleGate` hook:
//   (p:{ candidate, ... }) => { pass:false, reason:'mayhem_excluded' } to skip.
//
// Immutable per mint, so one RPC read covers every agent evaluating that mint.

import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Re-run `fn` while it resolves null, with exponential backoff. A brand-new
 * mint's curve account exists from creation, so a null read is an RPC hiccup
 * (throttled endpoint, not-yet-synced node); a short backoff usually resolves
 * it to a real answer instead of forfeiting the buy on a strict gate. Exported
 * for unit tests; the answer being retried is immutable, so retrying is safe.
 */
export async function retryWhileNull(fn, { retries = 2, delayMs = 350 } = {}) {
	let v = await fn();
	for (let attempt = 0; v === null && attempt < retries; attempt++) {
		await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt));
		v = await fn();
	}
	return v;
}

/**
 * @param {object} o
 * @param {string} [o.rpcUrl]                RPC endpoint (falls back to public mainnet)
 * @param {object} [o.connection]            pre-built web3 Connection (e.g. the platform's
 *   rotating multi-endpoint connection). Takes precedence over rpcUrl, so a single
 *   throttled provider can't starve the gate into permanent "unknown".
 * @param {boolean} [o.strictOnUnknown=false] if the curve can't be read, skip the buy
 *   (honor the rule strictly) instead of allowing it. Default allows-on-unknown so a
 *   flaky RPC read doesn't silently halt all trading — unknowns are logged.
 * @param {number} [o.retries=2]             extra read attempts before resolving "unknown".
 *   The flag is immutable per mint, so retrying is always safe; on a strict gate each
 *   retry converts a would-be skipped buy into a definitive pass/fail.
 * @param {number} [o.retryDelayMs=350]      base backoff between attempts (doubles per retry)
 * @returns {{ oracleGate: Function, isMayhem: Function, stats: Function }}
 */
export function createMayhemFilter({ rpcUrl, connection = null, strictOnUnknown = false, retries = 2, retryDelayMs = 350 } = {}) {
	const conn = connection || new Connection(rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
	const cache = new Map();      // mint → boolean (true = mayhem)
	const inflight = new Map();   // mint → Promise<boolean|null>
	let sdkPromise = null;
	let warnedNoField = false;
	const counts = { checked: 0, mayhem: 0, unknown: 0 };

	function loadSdk() {
		// @nirholas/pump-sdk is the fork that surfaces `isMayhemMode` on the bonding
		// curve (the platform reads it there); the official @pump-fun/pump-sdk does
		// NOT carry the field, so it can't detect Mayhem. Prefer the fork, fall back
		// to the official only so the import never hard-fails.
		if (!sdkPromise) {
			sdkPromise = import('@nirholas/pump-sdk').catch(() => import('@pump-fun/pump-sdk'));
		}
		return sdkPromise;
	}

	async function readMayhem(mint) {
		try {
			const mod = await loadSdk();
			const Sdk = mod.OnlinePumpSdk || mod.PumpSdk || mod.default?.OnlinePumpSdk;
			if (typeof Sdk !== 'function') throw new Error('OnlinePumpSdk not found in @pump-fun/pump-sdk');
			const sdk = new Sdk(conn);
			const bc = await sdk.fetchBondingCurve(new PublicKey(mint));
			if (bc && typeof bc.isMayhemMode === 'undefined' && !warnedNoField) {
				warnedNoField = true;
				console.log('  [mayhem] WARNING: SDK bonding curve has no isMayhemMode field — filter may be ineffective; verify the SDK version.');
			}
			return Boolean(bc?.isMayhemMode);
		} catch (e) {
			// Missing account (not yet indexed) or transient RPC — treat as unknown.
			return null;
		}
	}

	async function isMayhem(mint) {
		if (!mint) return null;
		if (cache.has(mint)) return cache.get(mint);
		if (inflight.has(mint)) return inflight.get(mint);
		const p = retryWhileNull(() => readMayhem(mint), { retries, delayMs: retryDelayMs }).then((v) => {
			inflight.delete(mint);
			if (v !== null) cache.set(mint, v);   // only cache definitive answers
			return v;
		});
		inflight.set(mint, p);
		return p;
	}

	async function oracleGate({ candidate }) {
		const mint = candidate?.mint;
		const m = await isMayhem(mint);
		counts.checked++;
		if (m === true) { counts.mayhem++; return { pass: false, reason: 'mayhem_excluded' }; }
		if (m === null) {
			counts.unknown++;
			if (strictOnUnknown) return { pass: false, reason: 'mayhem_unknown' };
			return { pass: true, skipped: true };   // allow-on-unknown (logged via stats)
		}
		return { pass: true };
	}

	return { oracleGate, isMayhem, stats: () => ({ ...counts }) };
}

export default createMayhemFilter;
