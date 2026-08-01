// Confirm a Solana transaction over HTTP polling — NEVER via a WebSocket subscription.
//
// Why not `Connection.confirmTransaction` / `sendAndConfirmTransaction`? Both open a
// web3.js `signatureSubscribe` WebSocket against the Connection's `wsEndpoint`. That
// WS path bypasses the rotating-fetch failover in `solana/connection.js` entirely, so
// when the primary RPC rate-limits the WS upgrade (HTTP 429) web3.js's internal
// rpc-websockets client reconnects in a tight background loop for the whole life of a
// warm serverless instance — the `ws error: Unexpected server response: 429` storm
// that flooded `/api/cron/pulse-tick` with thousands of errors in minutes. Polling
// `getSignatureStatuses` over HTTP goes through the failover fetch (multi-provider
// rotation + cooldowns) and opens no socket, so a throttled provider is transparently
// skipped instead of hammered.
//
// `confirmOrThrow` additionally THROWS on a landed-but-reverted transaction — the
// single most dangerous money-path bug class. `Connection.confirmTransaction` resolves
// normally for a tx that was included in a block but failed execution; the on-chain
// error lives in `result.value.err`, not in a thrown exception. Discarding that result
// records a reverted launch/buy/transfer as `confirmed`, charges the spend cap, and
// tells the user it succeeded. Every server-signed send path routes its confirmation
// through this helper so a revert becomes a thrown error the caller handles.
//
// Drop-in: replace
//   const res = await conn.confirmTransaction(strategy, 'confirmed'); if (res.value?.err) …
// with
//   await confirmOrThrow(conn, strategy, 'confirmed');
// `strategy` is whatever confirmTransaction accepts — a bare signature string or the
// `{ signature, blockhash, lastValidBlockHeight }` object form. Callers that need the
// raw result without the throw-on-revert (to map their own error) use
// `pollConfirmation`. Legacy `sendAndConfirmTransaction` call sites use `sendAndConfirm`.

// Commitment ordering — a status at or above the requested level satisfies the wait.
const COMMITMENT_RANK = { processed: 0, confirmed: 1, finalized: 2 };
const MAX_CONFIRM_MS = 90_000; // absolute ceiling, even for the bare-signature form
// Block height advances ~2.5 slots/s while a blockhash stays valid for ~150 slots
// (~60s), so checking expiry every few polls is ample and saves an RPC round-trip.
const BLOCKHEIGHT_CHECK_EVERY = 3;

// Poll cadence. This loop is the single hottest Solana RPC consumer on the money
// path: every server-signed send, every x402 settle, every launch confirms through
// it. A flat 1.2s cadence over the 90s ceiling costs up to ~75 getSignatureStatuses
// calls plus ~25 getBlockHeight calls for ONE transaction that never lands, and a
// transaction that never lands is exactly what happens when the RPC tier is
// throttled, so the flat cadence spent the most requests precisely when requests
// were scarcest.
//
// Backing off geometrically after the fast opening costs nothing user-visible: a
// healthy confirm lands in the first two or three polls, which keep the original
// cadence. Only the doomed tail slows down, and the tail's polls were never going
// to change the outcome. Same 90s ceiling, roughly a third of the requests.
//
// All three knobs are read per call, not at module load, so an operator can retune
// the cadence with a config-only `gcloud run services update --update-env-vars`
// and no rebuild.
function pollCadence(env = process.env) {
	const num = (v, d) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? n : d;
	};
	const base = num(env.SOLANA_CONFIRM_POLL_INTERVAL_MS, 1_200);
	return {
		base,
		// Never below the base: a "max" under the opening cadence would mean the loop
		// speeds up as it backs off, which is the opposite of the intent.
		max: Math.max(base, num(env.SOLANA_CONFIRM_POLL_MAX_INTERVAL_MS, 6_000)),
		// <1 would shrink the interval each poll. Clamped so a typo cannot turn the
		// backoff into a request storm against an already-throttled tier.
		factor: Math.max(1, num(env.SOLANA_CONFIRM_POLL_BACKOFF, 1.5)),
		// Polls served at the base cadence before the backoff starts. Covers the
		// window nearly every confirm lands in, so the common path is unchanged.
		fastPolls: Math.max(1, Math.floor(num(env.SOLANA_CONFIRM_FAST_POLLS, 3))),
	};
}

/**
 * Wait before poll `i` (0-based): the base cadence for the opening polls, then a
 * geometric backoff capped at `max`.
 */
export function pollDelayMs(i, cadence = pollCadence()) {
	if (i < cadence.fastPolls) return cadence.base;
	return Math.min(cadence.max, Math.round(cadence.base * cadence.factor ** (i - cadence.fastPolls + 1)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function txExpiredError(signature) {
	return Object.assign(
		new Error(`Transaction ${signature} expired: block height exceeded`),
		{ code: 'tx_expired', signature },
	);
}

function confirmTimeoutError(signature, ms) {
	return Object.assign(
		new Error(`Transaction ${signature} not confirmed within ${Math.round(ms / 1000)}s`),
		{ code: 'tx_confirm_timeout', signature },
	);
}

/**
 * Poll `getSignatureStatuses` until `signature` reaches `commitment`, reverts, expires,
 * or the confirm window elapses. Opens no WebSocket. Returns a confirmTransaction-shaped
 * result `{ context: { slot }, value: { err, confirmationStatus, slot } }` — `value.err`
 * is set (not thrown) when the tx landed but reverted, so callers that map their own
 * error can inspect it. Throws `tx_expired` (blockhash no longer valid) or
 * `tx_confirm_timeout` (window elapsed) when the tx never lands.
 *
 * @param {import('@solana/web3.js').Connection} conn
 * @param {string | { signature: string, blockhash?: string, lastValidBlockHeight?: number }} strategy
 * @param {import('@solana/web3.js').Commitment} [commitment]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ context: { slot: number|null }, value: { err: any, confirmationStatus?: string, slot: number|null } }>}
 */
export async function pollConfirmation(conn, strategy, commitment = 'confirmed', { timeoutMs = MAX_CONFIRM_MS } = {}) {
	const signature = typeof strategy === 'string' ? strategy : strategy?.signature;
	if (!signature) throw Object.assign(new Error('confirm: missing signature'), { code: 'confirm_no_signature' });
	const lastValidBlockHeight = typeof strategy === 'object' && strategy ? strategy.lastValidBlockHeight : undefined;
	const target = COMMITMENT_RANK[commitment] ?? COMMITMENT_RANK.confirmed;
	const deadline = Date.now() + timeoutMs;
	const cadence = pollCadence();

	for (let i = 0; ; i++) {
		let st = null;
		try {
			const res = await conn.getSignatureStatuses([signature]);
			st = res?.value?.[0] ?? null;
		} catch {
			// Transient RPC blip — the rotating fetch already failed over across
			// providers; treat this poll as "not yet known" and retry.
		}

		if (st) {
			// A landed-but-reverted tx carries `err`; surface it (don't throw here) so
			// confirmOrThrow / call-site logic can classify it.
			if (st.err) return { context: { slot: st.slot ?? null }, value: { err: st.err, slot: st.slot ?? null } };
			const rank = COMMITMENT_RANK[st.confirmationStatus] ?? -1;
			if (rank >= target) {
				return {
					context: { slot: st.slot ?? null },
					value: { err: null, confirmationStatus: st.confirmationStatus, slot: st.slot ?? null },
				};
			}
		}

		// Expiry only matters before the tx lands: once we've seen any status it will
		// climb to the target commitment on its own. Checked periodically to save RPC.
		if (lastValidBlockHeight != null && st == null && i % BLOCKHEIGHT_CHECK_EVERY === 0) {
			let height = null;
			try { height = await conn.getBlockHeight(commitment); } catch { /* retry next poll */ }
			if (height != null && height > lastValidBlockHeight) throw txExpiredError(signature);
		}

		if (Date.now() >= deadline) throw confirmTimeoutError(signature, timeoutMs);
		await sleep(pollDelayMs(i, cadence));
	}
}

/**
 * Confirm `strategy` and THROW if it landed but reverted (code `tx_reverted`, with the
 * on-chain error attached), expired, or timed out. Returns the confirmation result on
 * success. HTTP polling only — opens no WebSocket.
 *
 * @param {import('@solana/web3.js').Connection} conn
 * @param {string | { signature: string, blockhash?: string, lastValidBlockHeight?: number }} strategy
 * @param {import('@solana/web3.js').Commitment} [commitment]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ context: { slot: number|null }, value: { err: any, confirmationStatus?: string, slot: number|null } }>}
 */
export async function confirmOrThrow(conn, strategy, commitment = 'confirmed', opts = {}) {
	const result = await pollConfirmation(conn, strategy, commitment, opts);
	if (result?.value?.err) {
		const signature = typeof strategy === 'string' ? strategy : strategy?.signature;
		throw Object.assign(
			new Error(
				`transaction ${signature ?? '<unknown>'} reverted on-chain: ${JSON.stringify(result.value.err)}`,
			),
			{ code: 'tx_reverted', signature, onChainErr: result.value.err },
		);
	}
	return result;
}

/**
 * HTTP-polling replacement for @solana/web3.js `sendAndConfirmTransaction`. Signs the
 * legacy `Transaction` with `signers`, broadcasts it, and confirms via
 * `confirmOrThrow` — opening no WebSocket and throwing on a reverted tx. Fills in
 * `recentBlockhash` / `feePayer` when unset, mirroring web3.js. Returns the signature.
 *
 * @param {import('@solana/web3.js').Connection} conn
 * @param {import('@solana/web3.js').Transaction} tx
 * @param {import('@solana/web3.js').Signer[]} signers  first entry is the fee payer when unset
 * @param {{ commitment?: import('@solana/web3.js').Commitment, skipPreflight?: boolean, maxRetries?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<string>} the transaction signature
 */
export async function sendAndConfirm(conn, tx, signers, opts = {}) {
	const { commitment = 'confirmed', skipPreflight = false, maxRetries = 3, timeoutMs } = opts;
	if (!Array.isArray(signers) || signers.length === 0) {
		throw new Error('sendAndConfirm: at least one signer is required');
	}
	let lastValidBlockHeight = tx.lastValidBlockHeight;
	if (!tx.recentBlockhash) {
		const bh = await conn.getLatestBlockhash(commitment);
		tx.recentBlockhash = bh.blockhash;
		tx.lastValidBlockHeight = bh.lastValidBlockHeight;
		lastValidBlockHeight = bh.lastValidBlockHeight;
	}
	if (!tx.feePayer) tx.feePayer = signers[0].publicKey;
	tx.sign(...signers);
	const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries });
	await confirmOrThrow(
		conn,
		{ signature, blockhash: tx.recentBlockhash, lastValidBlockHeight },
		commitment,
		timeoutMs != null ? { timeoutMs } : {},
	);
	return signature;
}
