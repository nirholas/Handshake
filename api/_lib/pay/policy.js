// Payment session policy predicates — the single source of truth for every
// "may this agent spend?" decision on the platform.
//
// Two callers depend on this module and they must never disagree:
//
//   api/_lib/pay/spend-governor.js  enforces policy on a real payment
//   api/pay/simulate.js             predicts policy on a hypothetical one
//
// Before this module existed, the simulator would have had to reimplement the
// allowlist and ceiling rules, and any later fix to one copy would silently
// leave the other lying. A dry run that says "this call is allowed" and an
// enforcer that then rejects it is worse than having no dry run at all, because
// the user authorizes a budget against a promise the platform does not keep.
// So the rules live here, as pure functions over plain values: no DB, no clock
// reads except the one passed in, no network. Both callers import them.
//
// One thing deliberately does NOT live here: the atomic budget reservation.
// Checking `remaining >= amount` in JavaScript is advisory only, because two
// concurrent requests can both read the same remaining balance and both pass.
// The authoritative check is the SQL `UPDATE ... WHERE (budget - spent) >= amt`
// in the governor. This module exposes `budgetVerdict()` for prediction and for
// building the error message, and the governor calls it only to describe a
// failure the database already decided.

/**
 * The limits session creation enforces (api/_lib/pay/payment-session.js).
 *
 * They live here, next to the rules, so the dry-run simulator can clamp a
 * proposed policy to exactly what the create endpoint will accept. A simulator
 * that blessed a $2000 budget would be recommending a session the API refuses.
 */
export const SESSION_LIMITS = Object.freeze({
	MAX_LABEL_LEN: 120,
	MAX_ALLOWED_HOSTS: 50,
	MIN_BUDGET_USD: 0.001,
	MAX_BUDGET_USD: 1000,
	MIN_TTL_SECONDS: 60,
	MAX_TTL_SECONDS: 90 * 24 * 3600, // 90 days
});

// USDC has 6 decimals everywhere we settle (Solana mainnet and Base mainnet).
export const USDC_DECIMALS = 6;
const USDC_SCALE = 10 ** USDC_DECIMALS;

export function usdToAtomics(usd) {
	return BigInt(Math.round(Number(usd) * USDC_SCALE));
}

export function atomicsToUsd(atomics) {
	return Number(atomics) / USDC_SCALE;
}

/** Bare lowercase hostname from a URL or an already-bare host. Never throws. */
export function normalizeHost(raw) {
	const s = String(raw || '').trim().toLowerCase();
	if (!s) return '';
	try {
		const u = new URL(s.includes('://') ? s : `https://${s}`);
		return u.hostname;
	} catch {
		return s.split('/')[0].split(':')[0] || '';
	}
}

/**
 * Canonicalize a session's allowlist for comparison.
 * Entries may be written as bare hosts, full URLs, or hosts with a port.
 */
export function canonicalizeAllowlist(allowedHosts) {
	if (!Array.isArray(allowedHosts)) return [];
	return allowedHosts.map(normalizeHost).filter(Boolean);
}

/**
 * Does `targetHost` match `entry`, treating the entry as a domain suffix?
 *
 * `api.example.com` matches the entry `example.com` because it is a true
 * subdomain. `evil-example.com` does NOT, which is the whole reason this is a
 * named function with a test rather than an inline `endsWith`: `endsWith` alone
 * would hand an attacker every domain that merely ends in the allowed string.
 */
export function hostMatches(targetHost, entry) {
	if (!targetHost || !entry) return false;
	return targetHost === entry || targetHost.endsWith(`.${entry}`);
}

// ── Individual verdicts ─────────────────────────────────────────────────────
// Each returns either null (this rule permits the call) or a rejection object
// { code, message, detail }. `code` is the machine-readable governance error the
// API layer maps to an HTTP status; the strings are user-facing.

const INACTIVE_MESSAGES = {
	exhausted: 'Session budget is exhausted',
	expired: 'Session has expired',
	cancelled: 'Session has been cancelled',
};

/** Rule 1: the session must be in the `active` state. */
export function statusVerdict(status) {
	if (status === 'active') return null;
	return {
		code: 'session_inactive',
		message: INACTIVE_MESSAGES[status] ?? `Session is ${status}`,
		detail: { status },
	};
}

/** Rule 2: the session's TTL must not have elapsed. */
export function expiryVerdict(expiresAt, now = new Date()) {
	if (expiresAt == null) return null;
	const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
	if (Number.isNaN(expiry.getTime())) return null;
	if (expiry >= now) return null;
	return { code: 'session_expired', message: 'Session has expired', detail: {} };
}

/** Rule 3: the target host must be on the allowlist, when one is set. */
export function allowlistVerdict(url, allowedHosts) {
	const canonical = canonicalizeAllowlist(allowedHosts);
	if (canonical.length === 0) return null; // empty allowlist means "any host"

	let targetHost;
	try {
		targetHost = new URL(url).hostname.toLowerCase();
	} catch {
		return {
			code: 'allowlist_blocked',
			message: `Invalid target URL: ${url}`,
			detail: {},
		};
	}

	if (canonical.some((entry) => hostMatches(targetHost, entry))) return null;

	return {
		code: 'allowlist_blocked',
		message: `Host ${targetHost} is not in this session's allowlist`,
		detail: { host: targetHost, allowlist: canonical },
	};
}

/** Rule 4: a single payment must not exceed the per-transaction ceiling. */
export function perTxVerdict(amountAtomics, maxPerTxAtomics) {
	if (maxPerTxAtomics == null) return null;
	const cap = BigInt(maxPerTxAtomics);
	const amount = BigInt(amountAtomics);
	if (amount <= cap) return null;
	return {
		code: 'per_tx_exceeded',
		message: `Payment $${atomicsToUsd(amount)} exceeds the per-transaction limit $${atomicsToUsd(cap)}`,
		detail: { amount_usd: atomicsToUsd(amount), cap_usd: atomicsToUsd(cap) },
	};
}

/**
 * Rule 5: the remaining budget must cover the payment.
 *
 * Advisory in the enforcer (the SQL predicate is authoritative), authoritative
 * in the simulator, where the spend curve is replayed in memory and nothing is
 * concurrent. Callers pass `remainingAtomics` so this stays a pure function.
 */
export function budgetVerdict(amountAtomics, remainingAtomics) {
	const amount = BigInt(amountAtomics);
	const remaining = BigInt(remainingAtomics);
	if (remaining >= amount) return null;
	return {
		code: 'insufficient_budget',
		message: `Insufficient session budget. Need $${atomicsToUsd(amount)}, remaining $${atomicsToUsd(remaining)}`,
		detail: { need_usd: atomicsToUsd(amount), remaining_usd: atomicsToUsd(remaining) },
	};
}

/**
 * Run every rule in enforcement order and return the first rejection, or null.
 *
 * Order matters and mirrors the governor exactly: state, then expiry, then
 * allowlist, then ceiling, then budget. A caller that reordered these would
 * report "insufficient budget" for a call that is actually blocked by the
 * allowlist, which sends the user off to fund a session that still would not
 * work.
 *
 * @param {object} call
 * @param {string} call.url                 target endpoint
 * @param {bigint|string|number} call.amountAtomics  price in USDC atomics
 * @param {object} call.policy              { status, expiresAt, allowedHosts, maxPerTxAtomics }
 * @param {bigint|string|number} call.remainingAtomics budget left before this call
 * @param {Date} [call.now]
 * @returns {{code: string, message: string, detail: object} | null}
 */
export function evaluateCall({ url, amountAtomics, policy, remainingAtomics, now = new Date() }) {
	return (
		statusVerdict(policy.status ?? 'active') ??
		expiryVerdict(policy.expiresAt ?? null, now) ??
		allowlistVerdict(url, policy.allowedHosts) ??
		perTxVerdict(amountAtomics, policy.maxPerTxAtomics ?? null) ??
		budgetVerdict(amountAtomics, remainingAtomics)
	);
}

/**
 * Replay a sequence of priced calls against a policy, in order.
 *
 * This is what makes a dry run more useful than checking each call in
 * isolation: a call can be individually affordable and still fail because the
 * eleven calls before it drained the budget. The returned steps carry the
 * running balance so a UI can draw the exact point of exhaustion.
 *
 * A denied call consumes nothing, which matches the enforcer: the atomic
 * reservation only increments `spent_usdc` on the success path, and every
 * failure path either never reserved or rolled back.
 *
 * @param {Array<{url: string, amountAtomics: bigint|string|number, [k: string]: any}>} calls
 * @param {object} policy { budgetAtomics, maxPerTxAtomics, allowedHosts, status, expiresAt }
 * @param {Date} [now]
 */
export function replay(calls, policy, now = new Date()) {
	const budget = BigInt(policy.budgetAtomics ?? 0);
	let spent = 0n;
	const steps = [];

	for (const call of calls) {
		const amount = BigInt(call.amountAtomics ?? 0);
		const remainingBefore = budget - spent;
		const rejection = evaluateCall({
			url: call.url,
			amountAtomics: amount,
			policy,
			remainingAtomics: remainingBefore,
			now,
		});

		if (!rejection) spent += amount;

		steps.push({
			call,
			allowed: rejection === null,
			rejection,
			amountAtomics: amount,
			remainingBeforeAtomics: remainingBefore,
			remainingAfterAtomics: budget - spent,
		});
	}

	return { steps, spentAtomics: spent, remainingAtomics: budget - spent };
}
