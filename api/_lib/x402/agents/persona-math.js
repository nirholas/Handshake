// @ts-check
// api/_lib/x402/agents/persona-math.js
//
// The PURE core of the ring agent buyers: deterministic RNG, seed helpers, float-
// band arithmetic, and small formatting utilities. Zero imports — no Solana, no
// DB, no env — so it is trivially unit-testable in isolation and cannot drag
// heavy dependencies into a test that only exercises the maths. persona-kit.js
// re-exports everything here, so callers still import from one place.

// ── Deterministic RNG ─────────────────────────────────────────────────────────

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Seeded, deterministic,
 * dependency-free. Persona selection and per-tick endpoint choice are pure
 * functions of the tick seed (reproducible across processes and tests).
 * @param {number} seed
 * @returns {() => number} next float in [0,1)
 */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return function next() {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Fold an arbitrary string (e.g. a runId) into a 32-bit seed. Lets the driver
 * derive a stable seed when no monotonic tick counter is available.
 * @param {string} str
 * @returns {number}
 */
export function seedFromString(str) {
	let h = 2166136261 >>> 0;
	const s = String(str || '');
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * Deterministically pick `n` distinct items from `items` given a seed. Stable:
 * same (items, seed, n) ⇒ same picks in the same order.
 * @template T
 * @param {T[]} items
 * @param {number} seed
 * @param {number} [n=1]
 * @returns {T[]}
 */
export function pickDeterministic(items, seed, n = 1) {
	const pool = items.slice();
	const rng = mulberry32(seed);
	const out = [];
	const take = Math.min(n, pool.length);
	for (let i = 0; i < take; i++) {
		const idx = Math.floor(rng() * pool.length);
		out.push(pool.splice(idx, 1)[0]);
	}
	return out;
}

// ── Float math (shared with ring-rebalance float-top-up) ───────────────────────

/**
 * Pure float-band arithmetic. Given an agent's current USDC balance and the band,
 * decide the single next move that returns it toward target:
 *   balance < floor   → 'top_up'  by (target − balance)   (treasury → agent)
 *   balance > ceiling → 'sweep'   by (balance − target)   (agent → treasury)
 *   otherwise         → 'none'
 * All amounts are atomic USDC (6dp). Never returns a negative amount.
 *
 * @param {{ balanceAtomic: number|bigint, floorAtomic: number, targetAtomic: number, ceilingAtomic: number }} p
 * @returns {{ action: 'top_up'|'sweep'|'none', amountAtomic: number }}
 */
export function planFloatMove({ balanceAtomic, floorAtomic, targetAtomic, ceilingAtomic }) {
	const bal = Number(balanceAtomic);
	if (bal < floorAtomic) {
		return { action: 'top_up', amountAtomic: Math.max(0, targetAtomic - bal) };
	}
	if (bal > ceilingAtomic) {
		return { action: 'sweep', amountAtomic: Math.max(0, bal - targetAtomic) };
	}
	return { action: 'none', amountAtomic: 0 };
}

/**
 * Can this agent actually pay for the purchase it is about to attempt?
 *
 * The ring-tick driver has asked this of its shared payer since day one
 * (assessBackpressure → `insufficient_payer_usdc` in ring-tick-plan.js), but the
 * agent-buyer roster never did: each persona pays from its OWN custodial wallet,
 * and when the float top-up upstream is dry those wallets run to zero without
 * anything stopping the next tick from shopping anyway.
 *
 * What that costs, measured on production 2026-08-01: 180 purchases in one 3h
 * window, every one of them probing the endpoint, building and signing a USDC
 * transfer, and paying for a facilitator `verify` that SIMULATES the transfer
 * against an RPC node, only for the simulation to come back
 * `InstructionError:[2,{Custom:1}]` (SPL insufficient funds). The caller then
 * recorded `http_402`, which the settle sensor counts as a payment-RAIL fault:
 * an empty wallet was reading as a broken rail, at ~9% of the settle rate.
 *
 * A wallet that cannot fund a transfer is not a rail fault and not an error. It
 * is the same benign back-pressure the shared payer already reports, so it
 * carries the same reason token the sensor already excludes.
 *
 * Pure, so the arithmetic is testable without a wallet, an RPC or a DB. An
 * unreadable balance ADMITS (returns ok): a balance read that failed must never
 * be the thing that stops the economy, and the simulation downstream remains the
 * authoritative check.
 *
 * @param {{ usdcAtomic: number|null|undefined, priceAtomic: number }} p
 * @returns {{ ok: boolean, reason: string|null, detail?: string }}
 */
export function assessAgentBuyingPower({ usdcAtomic, priceAtomic }) {
	// null/undefined is UNKNOWN, and `Number(null)` is 0, which would read as
	// "broke" and refuse a funded agent every time a balance read failed. Reject
	// the nullish case before the numeric one.
	if (usdcAtomic == null) return { ok: true, reason: null };
	const have = Number(usdcAtomic);
	if (!Number.isFinite(have)) return { ok: true, reason: null };
	const need = Math.max(0, Number(priceAtomic) || 0);
	if (need === 0) return { ok: true, reason: null };
	if (have < need) {
		return {
			ok: false,
			reason: 'insufficient_payer_usdc',
			detail: `${Math.max(0, Math.floor(have))}<${need}`,
		};
	}
	return { ok: true, reason: null };
}

/**
 * Resolve the float band from env, once per call. FLOAT is the target; floor is
 * half of it, ceiling is double — a symmetric band that keeps a small working
 * balance without letting winnings accumulate off-ledger.
 * @returns {{ floorAtomic: number, targetAtomic: number, ceilingAtomic: number }}
 */
export function floatBand() {
	const target = Math.max(0, Number(process.env.X402_RING_AGENT_FLOAT_ATOMIC || 2_000_000));
	const floor = Math.max(0, Number(process.env.X402_RING_AGENT_FLOAT_FLOOR_ATOMIC || Math.floor(target / 2)));
	const ceiling = Math.max(target, Number(process.env.X402_RING_AGENT_FLOAT_CEIL_ATOMIC || target * 2));
	return { floorAtomic: floor, targetAtomic: target, ceilingAtomic: ceiling };
}

// ── Small utilities ────────────────────────────────────────────────────────────

/**
 * Is `address` inside the platform-controlled ring set? Accepts a pre-resolved
 * allowlist Set to avoid re-querying per purchase within a tick.
 * @param {string} address
 * @param {Set<string>} allowed
 * @returns {boolean}
 */
export function isRingAddress(address, allowed) {
	return typeof address === 'string' && allowed.has(address);
}

/** Compact liveness summary — keeps a log row small while proving a real reply. */
export function summarizeLiveness(body) {
	if (body == null) return { ok: false, shape: 'empty' };
	if (typeof body === 'string') return { ok: body.length > 0, shape: 'text', length: body.length };
	if (Array.isArray(body)) return { ok: body.length > 0, shape: 'array', length: body.length };
	if (typeof body === 'object') {
		const keys = Object.keys(body);
		return { ok: keys.length > 0 && !body.error, shape: 'object', keys: keys.slice(0, 10) };
	}
	return { ok: true, shape: typeof body };
}

/** Build a GET URL with query params, or return the path unchanged for POST. */
export function buildUrl(origin, path, query) {
	if (!query || Object.keys(query).length === 0) return `${origin}${path}`;
	const qs = new URLSearchParams(query).toString();
	const sep = path.includes('?') ? '&' : '?';
	return `${origin}${path}${sep}${qs}`;
}

/** True on ticks where the on-chain step should fire. Pure — unit-testable. */
export function isOnchainTick(seed, everyN) {
	if (!everyN || everyN <= 0) return false;
	return (seed >>> 0) % everyN === 0;
}
