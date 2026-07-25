// Bounded-concurrency executor for the ring tick's paid calls.
//
// The sequential for-loop in x402-ring-tick.js topped out around 15-20 paid
// calls per 60 s tick (each call is a full 402 dance + on-chain settle +
// confirm). Scaling the ring to ~94 calls/minute (the $100/day fee budget the
// owner approved 2026-07-25) needs the cheap calls in flight together.
//
// Budget safety under concurrency works by RESERVATION: before a call
// launches, a worst-case slice of the remaining tick budget is reserved and
// passed to the call as its own remainingCap — payX402 refuses to pay any
// challenge above that cap, so the sum of all in-flight spends can never
// exceed the reservations, and the reservations never exceed the tick budget.
// When a call finishes, the unspent part of its reservation is refunded.
//
// The ring-settle carrier (the $1.00 volume call) still runs ALONE first: it
// is the big-ticket item, and running it before the swarm keeps the old
// degrade semantics (settle unaffordable → cheap-only tick) observable.
//
// Floor back-pressure: the first result carrying a facilitator SOL-floor
// signal stops all further launches; in-flight calls drain, nothing new fires.
//
// Pure orchestration — no network, no DB, no solana imports. The caller
// injects `pay(ep, capForCall)` (the settleAndRecord closure) and
// `isFloorSignal(result)`. Unit-tested in tests/x402-ring-tick-exec.test.js.

/**
 * @param {object} opts
 * @param {Array<object>} opts.picks              ordered endpoints; a settle-tick's ring-settle is picks[0]
 * @param {number} opts.remaining                 tick budget still available (USDC atomics)
 * @param {number} opts.concurrency               max cheap calls in flight (>=1)
 * @param {boolean} opts.settleFirst              picks[0] is the ring-settle carrier — run it alone first
 * @param {number} opts.ringSettlePriceAtomic     reservation for the settle carrier
 * @param {number} opts.worstCaseCheapAtomic      reservation per cheap call (must cover the priciest cheap endpoint)
 * @param {(ep: object, capForCall: number) => Promise<{result: object, paidAmount: number}>} opts.pay
 * @param {(result: object) => boolean} opts.isFloorSignal
 * @returns {Promise<{results: Array<object>, calls: number, paid: number, errors: number,
 *                    spent: number, remaining: number, lastTxSig: string|null,
 *                    floorHit: boolean, capReached: boolean}>}
 */
export async function runTickPicks({
	picks,
	remaining,
	concurrency,
	settleFirst,
	ringSettlePriceAtomic,
	worstCaseCheapAtomic,
	pay,
	isFloorSignal,
}) {
	const state = {
		results: new Array(picks.length),
		calls: 0,
		paid: 0,
		errors: 0,
		spent: 0,
		remaining: Math.max(0, remaining),
		lastTxSig: null,
		floorHit: false,
		capReached: false,
	};

	const settleOne = async (index, reservation) => {
		const ep = picks[index];
		state.remaining -= reservation;
		state.calls += 1;
		let outcome;
		try {
			outcome = await pay(ep, reservation);
		} catch (err) {
			outcome = {
				result: { success: false, paid: false, errorMsg: err?.message || 'pay_failed' },
				paidAmount: 0,
			};
		}
		const { result, paidAmount } = outcome;
		// Refund the unspent slice. payX402 enforces paidAmount <= reservation
		// (remainingCap), so the refund is never negative; clamp anyway.
		state.remaining += Math.max(0, reservation - (paidAmount || 0));
		if (!result.success) state.errors += 1;
		if (result.paid) {
			state.paid += 1;
			state.spent += paidAmount || 0;
			if (result.txSig) state.lastTxSig = result.txSig;
		}
		if (!result.success && isFloorSignal(result)) state.floorHit = true;
		state.results[index] = {
			key: ep.key,
			paid: result.paid === true,
			success: result.success,
			status: result.status,
			amount_usdc: (paidAmount || 0) / 1e6,
		};
	};

	let next = 0;

	// The ring-settle carrier runs alone, reserving its full price (clamped to
	// what is left — payX402 then refuses cleanly if that cannot cover it,
	// matching the old sequential behavior).
	if (settleFirst && picks.length > 0) {
		const reservation = Math.min(state.remaining, Math.max(0, ringSettlePriceAtomic));
		await settleOne(0, reservation);
		next = 1;
	}

	// Cheap swarm: N workers pull from the shared cursor. A worker stops when
	// picks run out, the budget cannot cover another worst-case reservation, or
	// a floor signal appeared.
	const worker = async () => {
		while (true) {
			if (state.floorHit) return;
			if (state.remaining < worstCaseCheapAtomic) {
				if (next < picks.length) state.capReached = true;
				return;
			}
			const index = next;
			if (index >= picks.length) return;
			next += 1;
			await settleOne(index, worstCaseCheapAtomic);
		}
	};

	const workers = [];
	const lanes = Math.max(1, Math.floor(concurrency) || 1);
	for (let i = 0; i < lanes; i++) workers.push(worker());
	await Promise.all(workers);

	// Drop unfilled slots (calls never launched because of cap/floor stops).
	state.results = state.results.filter(Boolean);
	return state;
}
