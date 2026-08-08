// Durable, process-wide replay guard for on-chain settlements (paid spins, the
// $THREE boutique, and any future token sink).
//
// The old guard was a Map on each WalkRoom instance, which made "one payment,
// one grant" true only within a single room: the same { quoteToken, txSig }
// pair replayed into N different coin worlds (or after a restart, or against a
// second Cloud Run instance) verified on-chain N times and granted N times.
// This module gives every room in the process one shared consumption ledger,
// and rides Upstash Redis (the same store playerStore uses) when configured so
// consumption also survives restarts and spans instances. SET NX is atomic, so
// two rooms racing the same nonce resolve to exactly one winner.
//
// Both the quote nonce AND the transaction signature are consumed: the nonce
// binds one quote to one grant, and the signature stops a second quote from
// being settled by the same on-chain transfer.
//
// Fail-open on Redis errors, fail-closed on replays: if Redis is unreachable
// the in-process set still blocks every replay this process can see (exactly
// the guarantee the per-room Map thought it had), and we log loudly so the
// degraded window is visible in ops.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

// Consumed keys only need to outlive the 90s quote TTL plus generous clock
// skew; a day bounds Redis growth while making same-day replays impossible
// even against archived transactions.
const CONSUMED_TTL_S = 60 * 60 * 24;
const MEM_TTL_MS = CONSUMED_TTL_S * 1000;

class SettlementGuard {
	constructor() {
		this._mem = new Map(); // key → consumedAt (ms)
		this._redis = null;
		this._redisReady = null;
		if (REDIS_URL && REDIS_TOKEN) {
			this._redisReady = import('@upstash/redis')
				.then(({ Redis }) => {
					this._redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
					console.log('[settlement-guard] replay guard: memory + Upstash Redis');
				})
				.catch((err) => {
					this._redis = null;
					console.error('[settlement-guard] Redis unreachable, replay guard is per-process only:', err?.message);
				});
		} else {
			console.log('[settlement-guard] replay guard: memory-only (set UPSTASH_REDIS_REST_URL/_TOKEN to span instances + restarts)');
		}
		const sweep = setInterval(() => {
			const cutoff = Date.now() - MEM_TTL_MS;
			for (const [k, at] of this._mem) if (at < cutoff) this._mem.delete(k);
		}, 60_000);
		if (typeof sweep.unref === 'function') sweep.unref();
	}

	// Atomically consume one settlement key. Returns true exactly once per key
	// per TTL window; false means "already settled somewhere" and the caller
	// must refuse the grant. The in-process set is written first so a Redis
	// outage can never widen the window within this process.
	async _consume(key) {
		if (this._mem.has(key)) return false;
		this._mem.set(key, Date.now());
		if (this._redisReady) {
			try {
				await this._redisReady;
				if (this._redis) {
					const res = await this._redis.set(key, '1', { nx: true, ex: CONSUMED_TTL_S });
					// Upstash returns 'OK' when NX won, null when the key already existed.
					if (res === null) return false;
				}
			} catch (err) {
				console.error(`[settlement-guard] Redis consume failed for ${key}, continuing on the in-process guard:`, err?.message);
			}
		}
		return true;
	}

	/**
	 * Consume a settlement's nonce + tx signature. True exactly once per
	 * (nonce, txSig) pair across every room in the process, and across
	 * restarts/instances when Redis is configured.
	 * @param {{ nonce: string, txSig: string, purpose?: string }} params
	 * @returns {Promise<boolean>} whether this settlement is fresh and now consumed
	 */
	async consumeSettlement({ nonce, txSig, purpose = 'settle' }) {
		if (typeof nonce !== 'string' || !nonce || typeof txSig !== 'string' || !txSig) return false;
		const nonceOk = await this._consume(`settle:nonce:${purpose}:${nonce}`);
		if (!nonceOk) return false;
		// The signature is consumed unscoped by purpose on purpose: one on-chain
		// transfer settles one grant, ever, regardless of which sink claims it.
		const sigOk = await this._consume(`settle:tx:${txSig}`);
		if (!sigOk) return false;
		return true;
	}
}

// One guard shared by every room in the process.
export const settlementGuard = new SettlementGuard();
export function consumeSettlement(params) { return settlementGuard.consumeSettlement(params); }
