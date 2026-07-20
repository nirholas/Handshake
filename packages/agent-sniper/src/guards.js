// agent-sniper — pre-trade guards + flow control. Pure where possible.
//
// Every check short-circuits BEFORE any transaction is built. Each returns a
// `{ reason }` object on a breach (truthy) or null when the trade may proceed —
// so call sites read as `const x = check(...); if (x) return skip(x.reason)`.

// Leave this much SOL in the wallet for fees + rent so a snipe can't drain the
// account to a state where the very next sell can't pay its own fee. ~0.012 SOL.
export const SOL_FEE_HEADROOM_LAMPORTS = 12_000_000n;

/** @returns {{ reason: string }|null} */
export function checkConcurrency(openCount, maxConcurrent) {
	const cap = Number(maxConcurrent) || 1;
	if (openCount >= cap) return { reason: 'max_concurrency' };
	return null;
}

/** @returns {{ reason: string }|null} */
export function checkDailyBudgetLamports(spentLamports, perTradeLamports, budgetLamports) {
	const spent = BigInt(spentLamports || 0n);
	const trade = BigInt(perTradeLamports || 0n);
	const budget = BigInt(budgetLamports || 0n);
	if (budget <= 0n) return { reason: 'no_budget' };
	if (spent + trade > budget) return { reason: 'daily_budget_exceeded' };
	return null;
}

/** @returns {{ reason: string }|null} */
export function checkSolHeadroom(balanceLamports, perTradeLamports, headroom = SOL_FEE_HEADROOM_LAMPORTS) {
	const bal = BigInt(balanceLamports || 0n);
	const trade = BigInt(perTradeLamports || 0n);
	if (bal < trade + BigInt(headroom)) return { reason: 'insufficient_sol' };
	return null;
}

/** @returns {{ reason: string }|null} */
export function checkPriceImpact(impactPct, maxImpactPct) {
	const max = Number(maxImpactPct);
	if (!Number.isFinite(max) || max <= 0) return null; // unset ⇒ no gate
	// Fails CLOSED on an unusable impact figure. `undefined > 10` and `NaN > 10`
	// are both false, so an unpriced quote used to walk straight through this
	// gate: the exact silent-zero failure a mispriced or half-decoded pool
	// produces. `Number(null)` and `Number('')` are 0, so the absent cases must
	// be rejected BEFORE coercion, or "no data" arrives as a perfect 0% impact.
	if (impactPct == null || impactPct === '') return { reason: 'price_impact_unknown' };
	const impact = Number(impactPct);
	if (!Number.isFinite(impact)) return { reason: 'price_impact_unknown' };
	if (impact > max) return { reason: 'price_impact_too_high' };
	return null;
}

/**
 * Sliding-window throttle: at most `maxPerMin` consumes per rolling 60s. A
 * platform-wide backstop independent of per-agent caps. maxPerMin<=0 disables it.
 */
export function makeThrottle(maxPerMin) {
	const hits = [];
	return {
		tryConsume() {
			if (maxPerMin <= 0) return true;
			const now = Date.now();
			while (hits.length && now - hits[0] > 60_000) hits.shift();
			if (hits.length >= maxPerMin) return false;
			hits.push(now);
			return true;
		},
	};
}

/**
 * Bounded work queue: caps concurrent jobs at `concurrency`, drops (rather than
 * unbounded-buffers) once `maxDepth` are waiting so a launch firehose can't grow
 * memory without bound. A dropped job calls `onDrop`.
 */
export function makeQueue(concurrency, maxDepth, { onError, onDrop } = {}) {
	let active = 0;
	const q = [];
	const pump = () => {
		while (active < concurrency && q.length) {
			const job = q.shift();
			active++;
			Promise.resolve()
				.then(job)
				.catch((err) => onError?.(err))
				.finally(() => { active--; pump(); });
		}
	};
	return {
		push(job) {
			if (q.length >= maxDepth) { onDrop?.(); return false; }
			q.push(job);
			pump();
			return true;
		},
		get inFlight() { return active + q.length; },
	};
}

/** Self-rated entry conviction 0..1 for the optional decision ledger. */
export function snipeConfidence({ priceImpactPct, maxImpactPct, firewallVerdict }) {
	// An unusable impact figure takes the FULL penalty rather than writing a NaN
	// confidence into the decision ledger: "we could not price this" is low
	// conviction, not missing data.
	const impact = priceImpactPct == null || priceImpactPct === '' ? NaN : Number(priceImpactPct);
	const impactPenalty = Number.isFinite(impact)
		? Math.min(1, Math.max(0, impact) / (maxImpactPct > 0 ? maxImpactPct : 10)) * 0.4
		: 0.4;
	const fwBonus = firewallVerdict === 'allow' ? 0.1 : firewallVerdict === 'warn' ? -0.15 : 0;
	const c = 0.6 + fwBonus - impactPenalty;
	return Math.min(0.95, Math.max(0.05, c));
}
