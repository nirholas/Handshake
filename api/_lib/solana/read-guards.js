// Guarded Solana reads for the money paths.
//
// Every checkout, payout, and funding handler performs the same three reads
// before it can build a transaction: the mint's decimals, whether the
// recipient's ATA exists, and a recent blockhash. Each one used to be a bare
// web3.js call, so a single transport failure inside the RPC rotation
// (`TypeError: fetch failed` on getAccountInfo for the USDC mint, or
// `failed to get recent blockhash`) surfaced as an opaque `[api] unhandled` 500
// on a request that could have been served from what we already knew.
//
// These helpers were proven on the USDC checkout modal (api/x402-checkout.js)
// and are generalised here so every money path shares one posture:
//
//   mintDecimals            never touches the network for canonical mints, and
//                           tags a transport failure as a retryable 503
//   ataExists               fails OPEN to "missing" (the create is idempotent)
//   getRecentBlockhash      serves a cached blockhash inside its validity window
//                           when the chain cannot be read, per process and
//                           through the shared cache so other instances benefit
//   readAccountInfoOrNull   null on transport failure for decorative reads
//   readBalanceOrNull       null lamports on transport failure
//   rpcUnavailableError     the typed error every handler boundary can rely on
//   respondRpcUnavailable   503 rpc_unavailable + Retry-After: 15 at the boundary

import { getMint } from '@solana/spl-token';
import { cacheGet, cacheSet } from '../cache.js';
import { isTransientRpcError } from './connection.js';
import { error as httpError } from '../http.js';

/** The $THREE mint (pump.fun launch, 6 decimals like every pump.fun mint). */
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Decimals for canonical mints are immutable and universally known. Resolving
// them locally skips an RPC round-trip on every hot path (USDC is the default
// settlement asset) and immunizes transaction building against a flaky or
// rate-limited RPC returning 404 / fetch failed on getAccountInfo for the mint,
// the failure mode that 500'd every USDC checkout while the public endpoint was
// cooling.
export const WELL_KNOWN_MINT_DECIMALS = new Map([
	['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6], // USDC (mainnet)
	['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6], // USDT (mainnet)
	['So11111111111111111111111111111111111111112', 9], // wrapped SOL
	[THREE_MINT, 6], // $THREE
]);

export const RPC_UNAVAILABLE = 'rpc_unavailable';
export const RPC_RETRY_AFTER_SECONDS = 15;

const MINT_DECIMALS_TTL_MS = 5 * 60 * 1000;
const MINT_DECIMALS_SHARED_TTL_S = 24 * 60 * 60;
// A blockhash is reused for this long before a fresh one is fetched. Well under
// the cluster's validity window, so a buyer signing against a reused hash still
// has the whole window to land the transaction.
const BLOCKHASH_TTL_MS = 8 * 1000;
// Cold-path fail-open window: a Solana blockhash stays valid on-chain for roughly
// 60-90s (150 blocks), so when the chain cannot be read we may still serve a
// cached one this much past its fetch time. Conservatively under the floor.
const BLOCKHASH_STALE_MAX_MS = 45 * 1000;
// Blocks of headroom kept below lastValidBlockHeight when the chain height is
// known: about 12s at 400ms per block, enough for the buyer to sign and send.
const BLOCKHASH_HEIGHT_MARGIN = 30;
const BLOCKHASH_SHARED_TTL_S = 60;

const mintDecimalsCache = new Map(); // mint -> { decimals, at }
const blockhashCache = new Map(); // `${key}:${commitment}` -> { blockhash, lastValidBlockHeight, at }
// The highest block height any successful read has reported, per key. Lets a
// stale blockhash be refused by height even when the live height read fails.
const lastKnownHeight = new Map(); // key -> { height, at }

function pubkeyString(pubkey) {
	return typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
}

/** True when `err` is a token-program verdict (not a mint, wrong owner) rather than a transport failure. */
function isTokenProgramError(err) {
	return typeof err?.name === 'string' && err.name.startsWith('Token');
}

/** True when `err` is a transport / rotation failure the caller should retry. */
export function isRpcTransportError(err) {
	if (!err || isTokenProgramError(err)) return false;
	if (err.code === RPC_UNAVAILABLE) return true;
	if (err.name === 'TypeError' && /fetch failed/i.test(err.message || '')) return true;
	if (err.name === 'AbortError') return true;
	return isTransientRpcError(err);
}

/**
 * Wrap a transport failure as the typed, retryable error every boundary understands:
 * `{ status: 503, code: 'rpc_unavailable', retryable: true, expose: true }`. The
 * original error rides on `.cause`. Already-tagged errors are returned unchanged.
 */
export function rpcUnavailableError(cause, message = null) {
	if (cause && cause.code === RPC_UNAVAILABLE && cause.status === 503) return cause;
	const detail = cause?.message || String(cause || 'unknown');
	const err = new Error(message || `solana rpc unavailable: ${detail}`);
	err.status = 503;
	err.code = RPC_UNAVAILABLE;
	err.retryable = true;
	err.expose = true;
	err.retryAfter = RPC_RETRY_AFTER_SECONDS;
	err.cause = cause;
	return err;
}

/** True when `err` is the tagged rpc_unavailable error. */
export function isRpcUnavailable(err) {
	return Boolean(err) && err.code === RPC_UNAVAILABLE && err.status === 503;
}

/**
 * Re-throw a transport failure as rpc_unavailable and every other error untouched.
 * `await guardRpc(() => conn.getX())` is the one-liner for a read that must fail
 * closed but typed.
 */
export async function guardRpc(fn, message = null) {
	try {
		return await fn();
	} catch (err) {
		if (isRpcTransportError(err)) throw rpcUnavailableError(err, message);
		throw err;
	}
}

/**
 * Handler-boundary response for an RPC outage: 503 `rpc_unavailable` with
 * `Retry-After: 15`, the same shape whether the read died in this handler or
 * deeper in a lib. Returns true when the error was handled, false when it is
 * not an RPC failure (so the caller can fall through to its own handling).
 */
export function respondRpcUnavailable(res, err, extra = {}) {
	if (!isRpcUnavailable(err) && !isRpcTransportError(err)) return false;
	if (typeof res.setHeader === 'function') res.setHeader('retry-after', String(RPC_RETRY_AFTER_SECONDS));
	httpError(res, 503, RPC_UNAVAILABLE, 'solana rpc temporarily unavailable, retry shortly', {
		retryable: true,
		retry_after: RPC_RETRY_AFTER_SECONDS,
		...extra,
	});
	return true;
}

/**
 * Decimals for `mintPubkey`. Canonical mints (USDC, USDT, wSOL, $THREE) resolve
 * from the local table and never touch the network; anything else is read once
 * through getMint and remembered per process and in the shared cache. A
 * transport failure is thrown as rpc_unavailable (503, retryable); a genuine
 * token-program verdict (the address is not a mint) propagates unchanged so the
 * caller can answer 4xx.
 */
export async function mintDecimals(conn, mintPubkey, { programId = undefined } = {}) {
	const mintStr = pubkeyString(mintPubkey);
	const known = WELL_KNOWN_MINT_DECIMALS.get(mintStr);
	if (known != null) return known;

	const hit = mintDecimalsCache.get(mintStr);
	if (hit && Date.now() - hit.at < MINT_DECIMALS_TTL_MS) return hit.decimals;

	const sharedKey = `solana:mint-decimals:${mintStr}`;
	try {
		const info = await getMint(conn, mintPubkey, undefined, programId);
		const decimals = Number(info.decimals);
		mintDecimalsCache.set(mintStr, { decimals, at: Date.now() });
		cacheSet(sharedKey, { decimals }, MINT_DECIMALS_SHARED_TTL_S).catch(() => {});
		return decimals;
	} catch (err) {
		if (!isRpcTransportError(err)) throw err;
		if (hit) return hit.decimals;
		const shared = await cacheGet(sharedKey).catch(() => null);
		if (shared && Number.isInteger(shared.decimals)) {
			mintDecimalsCache.set(mintStr, { decimals: shared.decimals, at: Date.now() });
			return shared.decimals;
		}
		throw rpcUnavailableError(err, `could not read mint ${mintStr}: ${err?.message || err}`);
	}
}

/**
 * Does an ATA (or any account) already exist on-chain? web3.js decodes
 * getAccountInfo's reply through a superstruct union, so a flaky or misconfigured
 * RPC returning a malformed 200 (truncated body, proxy error page, wrong-cluster
 * node) throws StructError instead of a clean null, and a socket failure throws
 * `TypeError: fetch failed`.
 *
 * FAILS OPEN: any probe failure reads as "missing". The only thing the answer
 * gates is an idempotent ATA-create instruction
 * (createAssociatedTokenAccountIdempotentInstruction), which is a no-op when the
 * account already exists, so assuming-missing is always safe: at worst the
 * transaction carries one redundant instruction. Never use this to gate a
 * non-idempotent create.
 */
export async function ataExists(conn, ata, commitment = undefined) {
	try {
		return (await conn.getAccountInfo(ata, commitment)) != null;
	} catch (err) {
		console.warn(
			`[solana-read-guards] getAccountInfo(${pubkeyString(ata)}) failed, assuming ATA missing: ${err?.message || err}`,
		);
		return false;
	}
}

/**
 * getAccountInfo that returns null on transport failure instead of throwing.
 * For decorative reads (a balance line, an "already funded" badge) where the
 * right answer to an outage is "unknown", not a 500. Pass `{ withCause: true }`
 * to receive `{ info, cause }` so the caller can tell "absent" from "unreadable";
 * by default a transport failure is indistinguishable from a missing account.
 * A token-program or argument error still throws: those are bugs, not weather.
 */
export async function readAccountInfoOrNull(conn, pubkey, { commitment = undefined, withCause = false } = {}) {
	try {
		const info = await conn.getAccountInfo(pubkey, commitment);
		return withCause ? { info, cause: null } : info;
	} catch (err) {
		if (!isRpcTransportError(err)) throw err;
		console.warn(`[solana-read-guards] getAccountInfo(${pubkeyString(pubkey)}) unreadable: ${err?.message || err}`);
		return withCause ? { info: null, cause: err } : null;
	}
}

/**
 * getBalance that returns null lamports on transport failure instead of throwing.
 * "Balance unknown" is the honest answer to an outage; callers skip the tick,
 * mark the line unverified, or show "as of" rather than treating null as zero.
 */
export async function readBalanceOrNull(conn, pubkey, commitment = 'confirmed') {
	try {
		return await conn.getBalance(pubkey, commitment);
	} catch (err) {
		if (!isRpcTransportError(err)) throw err;
		console.warn(`[solana-read-guards] getBalance(${pubkeyString(pubkey)}) unreadable: ${err?.message || err}`);
		return null;
	}
}

function noteHeight(key, height, at) {
	if (!Number.isFinite(height)) return;
	const prev = lastKnownHeight.get(key);
	if (!prev || height > prev.height) lastKnownHeight.set(key, { height, at });
}

/** The chain height right now, or null when it cannot be read within this call. */
async function readHeightOrNull(conn, commitment) {
	if (typeof conn?.getBlockHeight !== 'function') return null;
	try {
		const h = await conn.getBlockHeight(commitment);
		return Number.isFinite(h) ? h : null;
	} catch {
		return null;
	}
}

/**
 * Decide whether a cached blockhash may still be served. Height wins when we
 * have one (live or last-known); otherwise the age cap bounds the reuse.
 */
function cachedBlockhashUsable(hit, { now, key, liveHeight }) {
	if (!hit || !hit.blockhash) return false;
	const age = now - hit.at;
	if (age < 0 || age >= BLOCKHASH_STALE_MAX_MS) return false;
	const lastValid = Number(hit.lastValidBlockHeight);
	if (Number.isFinite(lastValid) && lastValid > 0) {
		const known = liveHeight ?? lastKnownHeight.get(key)?.height ?? null;
		if (known != null && known >= lastValid - BLOCKHASH_HEIGHT_MARGIN) return false;
	}
	return true;
}

/**
 * A recent blockhash plus its lastValidBlockHeight, keyed per network (or RPC
 * url) and commitment. Reuses a fresh one for BLOCKHASH_TTL_MS; when the chain
 * cannot be read, serves the last one fetched by this process or by any other
 * instance (shared cache) as long as it is still inside its validity window:
 * never past `lastValidBlockHeight` minus a safety margin when a height is
 * known, and never older than BLOCKHASH_STALE_MAX_MS regardless. A served
 * fallback carries `stale: true` and `as_of` so the caller can surface it.
 *
 * Safe by construction: a blockhash only bounds how long the signer has to land
 * the transaction, never the amount or recipient. A too-stale one simply fails
 * to confirm and prompts a clean retry, never a double charge.
 *
 * `forceFresh` skips the reuse window and reads the chain, for the one caller
 * that must not reuse a hash: the post-402 payment retry. A refused attempt is
 * re-signed there, and re-signing the SAME blockhash with the same payer, payee
 * and amount recompiles byte-identical bytes, so the facilitator refuses it
 * again for the same reason. Only the fast path is skipped; the stale-fallback
 * branch below still applies, because a cached hash inside its validity window
 * beats failing the payment outright when the chain cannot be read at all.
 *
 * `now` is injectable so the staleness branches are unit-testable.
 */
export async function getRecentBlockhashInfo(conn, key, { now = Date.now, commitment = 'confirmed', forceFresh = false } = {}) {
	const cacheKey = `${key}:${commitment}`;
	const sharedKey = `solana:blockhash:${cacheKey}`;
	const hit = blockhashCache.get(cacheKey);
	const t = now();
	if (!forceFresh && hit && t - hit.at < BLOCKHASH_TTL_MS) {
		return { blockhash: hit.blockhash, lastValidBlockHeight: hit.lastValidBlockHeight, stale: false, as_of: hit.at };
	}
	try {
		const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(commitment);
		const entry = { blockhash, lastValidBlockHeight: lastValidBlockHeight ?? null, at: now() };
		blockhashCache.set(cacheKey, entry);
		cacheSet(sharedKey, entry, BLOCKHASH_SHARED_TTL_S).catch(() => {});
		return { blockhash, lastValidBlockHeight: entry.lastValidBlockHeight, stale: false, as_of: entry.at };
	} catch (err) {
		const liveHeight = await readHeightOrNull(conn, commitment);
		if (liveHeight != null) noteHeight(cacheKey, liveHeight, now());
		let candidate = hit;
		if (!cachedBlockhashUsable(candidate, { now: now(), key: cacheKey, liveHeight })) {
			const shared = await cacheGet(sharedKey).catch(() => null);
			candidate = shared && cachedBlockhashUsable(shared, { now: now(), key: cacheKey, liveHeight }) ? shared : null;
		}
		if (candidate) {
			console.warn(
				`[solana-read-guards] getLatestBlockhash(${cacheKey}) failed; serving ${Math.round(
					(now() - candidate.at) / 1000,
				)}s-old cached blockhash inside its validity window: ${err?.message || err}`,
			);
			return {
				blockhash: candidate.blockhash,
				lastValidBlockHeight: candidate.lastValidBlockHeight ?? null,
				stale: true,
				as_of: candidate.at,
			};
		}
		if (isRpcTransportError(err)) throw rpcUnavailableError(err);
		throw err;
	}
}

/** The blockhash string alone; see getRecentBlockhashInfo for the full contract. */
export async function getRecentBlockhash(conn, key, opts = {}) {
	return (await getRecentBlockhashInfo(conn, key, opts)).blockhash;
}

/**
 * Cache key for a connection: the network name when the caller knows it,
 * otherwise the RPC url. Two callers on the same network share one blockhash.
 */
export function blockhashKey({ network = null, url = null } = {}) {
	return network || url || 'mainnet';
}

/** Test hook: forget every cached blockhash, height, and mint decimals. */
export function _resetReadGuardCaches() {
	mintDecimalsCache.clear();
	blockhashCache.clear();
	lastKnownHeight.clear();
}
