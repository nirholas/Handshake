/**
 * Shared lifecycle rules for recurring on-chain payments.
 *
 * Two schedule kinds ride the same rails:
 *   - `agent_subscriptions`: a fixed USDC transfer per period, charged by the
 *     run-subscriptions cron through /api/permissions/redeem.
 *   - `dca_strategies`: a fixed USDC swap per period, executed by the run-dca
 *     cron through the same relayer.
 *
 * Both used to treat every failure identically: pause the schedule and write a
 * raw error string. A one-off RPC blip therefore killed a schedule as
 * permanently as a revoked delegation, and nothing could set it back to
 * 'active'. This module is the single place that decides what a failure means,
 * so the crons, the API and the UI all agree on it.
 *
 * The outcomes:
 *   fatal      the owner has to change something (revoked or expired
 *              delegation, a scope that no longer covers the charge). Retrying
 *              is guaranteed to fail, so the schedule pauses immediately.
 *   retryable  nothing about the schedule is wrong; the attempt did not land
 *              (RPC down, relayer unreachable, wallet short of funds). The
 *              schedule stays active and the next tick tries again, up to
 *              MAX_CONSECUTIVE_FAILURES before it pauses.
 *   ambiguous  the request timed out, so the transfer may or may not be
 *              on-chain. Never retried: the period is consumed and the schedule
 *              pauses for the owner to look at, because a retry here is the one
 *              failure mode that can double-charge.
 *   skipped    the schedule deliberately declined to act this period (a DCA
 *              quote that moved too far between reads). Nothing is wrong, so
 *              the period is simply given up and the next one runs on time.
 *
 * One failure is recorded as retryable but handled apart from it: a
 * platform-side outage (the relayer switched off, or rejecting our own
 * credentials) is nobody's schedule being wrong. Those retry forever without
 * counting toward the pause bound, because pausing every schedule on the
 * platform over one operator config gap would be a far worse outage than the
 * gap itself, and every one of them would then need a manual resume.
 */

/** Consecutive retryable failures a schedule survives before it is paused. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Charge attempt outcomes, mirrored by subscription_charges.outcome. */
export const OUTCOME = {
	CHARGED: 'charged',
	FATAL: 'fatal',
	RETRYABLE: 'retryable',
	AMBIGUOUS: 'ambiguous',
	SKIPPED: 'skipped',
};

// Codes that mean the schedule itself is no longer valid. Sourced from
// api/permissions/[action].js (the redeem handler) plus the cron's own guards.
const FATAL_CODES = new Set([
	'chain_not_supported',
	'delegation_expired',
	'delegation_gone',
	'delegation_not_found',
	'delegation_revoked',
	'scope_exceeded',
	'target_not_allowed',
	'unsupported_chain',
	'validation_error',
]);

// Platform-side outages. Recorded as retryable, but never counted against the
// schedule's pause bound: the owner has nothing to fix and should not have to
// resume by hand once the operator restores the relayer.
const PLATFORM_CODES = new Set(['feature_disabled', 'unauthorized']);

// Codes that mean the attempt never landed and the next tick can try again.
const RETRYABLE_CODES = new Set([
	'db_error',
	'fetch_error',
	'insufficient_balance',
	'internal_error',
	'no_tx_hash',
	'relayer_error',
	'rpc_error',
]);

// A reverted ERC-20 transfer surfaces through the relayer as a generic
// rpc_error. The wallet being short of USDC is the single most common cause and
// the only one the owner can fix by topping up, so it gets its own code rather
// than hiding inside "on-chain call failed".
const INSUFFICIENT_BALANCE_PATTERN =
	/insufficient (?:funds|balance|allowance)|transfer amount exceeds balance|ERC20InsufficientBalance|exceeds balance/i;

// What the owner should do about each code, in plain language. Rendered
// verbatim in the recurring-payments UI, so it never shows a raw revert string.
const REASONS = {
	chain_not_supported: 'This chain is no longer supported for recurring charges.',
	delegation_expired: 'The signed permission behind this schedule expired. Grant a new one to restart it.',
	delegation_gone: 'The signed permission behind this schedule is gone. Grant a new one to restart it.',
	delegation_not_found: 'The signed permission behind this schedule no longer exists. Grant a new one to restart it.',
	delegation_revoked: 'The signed permission was revoked. Grant a new one to restart this schedule.',
	feature_disabled: 'On-chain relaying is switched off on this deployment. Nothing was charged.',
	insufficient_balance: 'Your wallet did not hold enough USDC for this charge. Top it up and the next run will retry.',
	internal_error: 'The charge failed inside the relayer. The next run will retry.',
	no_tx_hash: 'The relayer accepted the charge but returned no transaction. The next run will retry.',
	quote_divergence: 'The swap price moved too far between quotes, so the swap was abandoned rather than filled at a bad rate.',
	relayer_error: 'The relayer rejected the charge. The next run will retry.',
	rpc_error: 'The network could not be reached. The next run will retry.',
	scope_exceeded: 'This charge is larger than the permission you signed allows for the period. Grant a wider permission to restart it.',
	target_not_allowed: 'The permission you signed does not cover this payment target.',
	timeout: 'The charge timed out, so we cannot tell whether it landed. The schedule is paused so it can never double-charge; check the transaction before resuming.',
	unauthorized: 'The relayer rejected our credentials. Nothing was charged.',
	unsupported_chain: 'This chain is no longer supported for recurring charges.',
	validation_error: 'The charge was rejected as malformed. Nothing was charged.',
};

/**
 * Turn a raw relayer/skill failure into the code, outcome and owner-facing
 * reason the rest of the product uses.
 *
 * @param {{ code?: string|null, message?: string|null }} failure
 * @returns {{ code: string, outcome: string, reason: string }}
 */
export function classifyChargeFailure({ code, message } = {}) {
	const raw = String(code || '').trim();
	const text = String(message || '');

	if (raw === 'timeout' || /^timeout\b/i.test(text)) {
		return { code: 'timeout', outcome: OUTCOME.AMBIGUOUS, reason: REASONS.timeout };
	}

	// A quote that moved between reads is the market, not a broken schedule.
	// Give up this period only; the next one runs on time and the failure
	// counter is untouched.
	if (raw === 'quote_divergence') {
		return {
			code: 'quote_divergence',
			outcome: OUTCOME.SKIPPED,
			reason: REASONS.quote_divergence,
		};
	}

	// An HTTP status the skill could not name: 4xx is ours to fix, 5xx is theirs
	// and worth another tick.
	const httpMatch = /^http_(\d{3})$/.exec(raw);
	if (httpMatch) {
		const status = Number(httpMatch[1]);
		if (status >= 500) {
			return {
				code: 'relayer_error',
				outcome: OUTCOME.RETRYABLE,
				reason: REASONS.relayer_error,
			};
		}
		return {
			code: 'validation_error',
			outcome: OUTCOME.FATAL,
			reason: REASONS.validation_error,
		};
	}

	if (INSUFFICIENT_BALANCE_PATTERN.test(text)) {
		return {
			code: 'insufficient_balance',
			outcome: OUTCOME.RETRYABLE,
			reason: REASONS.insufficient_balance,
		};
	}

	if (PLATFORM_CODES.has(raw)) {
		return {
			code: raw,
			outcome: OUTCOME.RETRYABLE,
			platform: true,
			reason: REASONS[raw],
		};
	}
	if (FATAL_CODES.has(raw)) {
		return { code: raw, outcome: OUTCOME.FATAL, reason: REASONS[raw] };
	}
	if (RETRYABLE_CODES.has(raw)) {
		return { code: raw, outcome: OUTCOME.RETRYABLE, reason: REASONS[raw] };
	}

	// An unrecognised code is treated as retryable on purpose: the failure
	// counter bounds it to MAX_CONSECUTIVE_FAILURES attempts, so an unknown
	// transient recovers on its own while an unknown permanent still stops.
	return {
		code: raw || 'unknown',
		outcome: OUTCOME.RETRYABLE,
		reason: text ? `The charge failed: ${text}` : 'The charge failed. The next run will retry.',
	};
}

/**
 * Decide what a classified failure does to the schedule row.
 *
 * @param {{ outcome: string, consecutiveFailures: number }} opts
 *   consecutiveFailures is the count BEFORE this failure.
 * @returns {{ pause: boolean, retry: boolean, consecutiveFailures: number }}
 *   `retry` means release the period claim so the next tick picks the row up
 *   again; `pause` means stop scheduling it until the owner resumes.
 */
export function applyChargeFailure({ outcome, consecutiveFailures = 0 }) {
	const current = Number(consecutiveFailures) || 0;
	// A deliberate skip is not a failure: the counter must not creep toward a
	// pause across a volatile week.
	if (outcome === OUTCOME.SKIPPED) {
		return { pause: false, retry: false, consecutiveFailures: current };
	}
	const next = current + 1;
	if (outcome === OUTCOME.FATAL) return { pause: true, retry: false, consecutiveFailures: next };
	if (outcome === OUTCOME.AMBIGUOUS) {
		return { pause: true, retry: false, consecutiveFailures: next };
	}
	const exhausted = next >= MAX_CONSECUTIVE_FAILURES;
	return { pause: exhausted, retry: !exhausted, consecutiveFailures: next };
}

/** The charge-row status that goes with an outcome. */
export function chargeStatusFor(outcome) {
	if (outcome === OUTCOME.CHARGED) return 'success';
	if (outcome === OUTCOME.FATAL || outcome === OUTCOME.SKIPPED) return 'aborted';
	if (outcome === OUTCOME.AMBIGUOUS) return 'unknown';
	return 'failed';
}

// ── Schedule state machine ──────────────────────────────────────────────────

/** Statuses an owner is allowed to move a schedule between. */
const TRANSITIONS = {
	pause: { from: ['active'], to: 'paused' },
	resume: { from: ['paused'], to: 'active' },
};

/**
 * Validate an owner-initiated pause/resume against the row's current status.
 *
 * Cancel is deliberately not here: it is terminal and each endpoint owns its
 * own column names for it (`canceled_at` vs `cancelled_at`).
 *
 * @param {'pause'|'resume'} action
 * @param {string} currentStatus
 * @returns {{ ok: true, status: string } | { ok: false, code: string, message: string }}
 */
export function planStatusChange(action, currentStatus) {
	const rule = TRANSITIONS[action];
	if (!rule) {
		return { ok: false, code: 'validation_error', message: `unknown action '${action}'` };
	}
	if (currentStatus === rule.to) {
		return {
			ok: false,
			code: 'conflict',
			message: `schedule is already ${rule.to}`,
		};
	}
	if (!rule.from.includes(currentStatus)) {
		return {
			ok: false,
			code: 'conflict',
			message: `cannot ${action} a schedule that is ${currentStatus}`,
		};
	}
	return { ok: true, status: rule.to };
}

// ── Formatting shared by the API responses and the page ─────────────────────

/** Human label for a period length in seconds. */
export function describePeriod(seconds) {
	const s = Number(seconds);
	if (!Number.isFinite(s) || s <= 0) return 'unknown';
	if (s === 86400) return 'daily';
	if (s === 604800) return 'weekly';
	if (s === 2592000) return 'monthly';
	if (s % 604800 === 0) return `every ${s / 604800} weeks`;
	if (s % 86400 === 0) return `every ${s / 86400} days`;
	if (s % 3600 === 0) return `every ${s / 3600} hours`;
	return `every ${Math.round(s / 60)} minutes`;
}

/**
 * Render a base-unit integer string as a decimal amount.
 * USDC is 6 decimals on every chain these schedules run on.
 */
export function formatUnits(baseUnits, decimals = 6) {
	const raw = String(baseUnits ?? '0');
	if (!/^\d+$/.test(raw)) return '0';
	const padded = raw.padStart(decimals + 1, '0');
	const whole = padded.slice(0, padded.length - decimals);
	const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
	return frac ? `${whole}.${frac}` : whole;
}

/** Sum an array of base-unit integer strings without losing precision. */
export function sumUnits(values) {
	return values
		.reduce((acc, v) => acc + (/^\d+$/.test(String(v ?? '')) ? BigInt(v) : 0n), 0n)
		.toString();
}
