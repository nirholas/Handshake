// The shared classifier that decides what a failed recurring charge means.
//
// Before api/_lib/recurring.js existed, both crons treated every failure the
// same way: pause the schedule, write the raw error string, and offer no way
// back. A one-off RPC blip therefore ended a schedule as permanently as a
// revoked delegation. These tests pin the four behaviours that replaced it,
// because each one is a different promise to the person paying:
//
//   fatal      pause now, the owner has to fix something
//   retryable  keep the schedule, try again next tick, pause after a bound
//   ambiguous  never retry, because a retry here can double-charge
//   skipped    give up this period only, do not hold it against the schedule
//
// plus the platform-outage carve-out, where the fault is ours and no owner
// should have to resume by hand once we fix it.

import { describe, it, expect } from 'vitest';
import {
	MAX_CONSECUTIVE_FAILURES,
	OUTCOME,
	applyChargeFailure,
	chargeStatusFor,
	classifyChargeFailure,
	describePeriod,
	formatUnits,
	planStatusChange,
	sumUnits,
} from '../api/_lib/recurring.js';

const classify = (code, message = '') => classifyChargeFailure({ code, message });

describe('classifyChargeFailure: revoked and expired authority', () => {
	it('treats a revoked delegation as fatal, with an actionable reason', () => {
		const r = classify('delegation_revoked', 'delegation has been revoked');
		expect(r.outcome).toBe(OUTCOME.FATAL);
		expect(r.code).toBe('delegation_revoked');
		expect(r.reason).toMatch(/revoked/i);
		expect(r.reason).toMatch(/grant a new one/i);
	});

	it('pauses immediately on a fatal failure rather than burning the retry budget', () => {
		const applied = applyChargeFailure({ outcome: OUTCOME.FATAL, consecutiveFailures: 0 });
		expect(applied).toEqual({ pause: true, retry: false, consecutiveFailures: 1 });
	});

	it.each(['delegation_expired', 'delegation_not_found', 'delegation_gone'])(
		'treats %s as fatal too',
		(code) => {
			expect(classify(code).outcome).toBe(OUTCOME.FATAL);
		},
	);

	it('treats a scope that no longer covers the charge as fatal, not a retry', () => {
		// Retrying a scope_exceeded every hour would just hammer the relayer for
		// a period cap that cannot change until the owner signs a wider grant.
		const r = classify('scope_exceeded', 'token spend would exceed scope.maxAmount');
		expect(r.outcome).toBe(OUTCOME.FATAL);
		expect(r.reason).toMatch(/larger than the permission/i);
	});
});

describe('classifyChargeFailure: an underfunded wallet', () => {
	it('names the insufficient balance behind a generic on-chain revert', () => {
		// The relayer reports every revert as rpc_error. A wallet short of USDC
		// is the one cause the owner can fix themselves, so it gets its own code.
		const r = classify('rpc_error', 'execution reverted: ERC20: transfer amount exceeds balance');
		expect(r.code).toBe('insufficient_balance');
		expect(r.outcome).toBe(OUTCOME.RETRYABLE);
		expect(r.reason).toMatch(/top it up/i);
	});

	it.each([
		'insufficient funds for gas * price + value',
		'ERC20InsufficientBalance(0xabc, 0, 5000000)',
		'transfer amount exceeds balance',
	])('recognises %s', (message) => {
		expect(classify('rpc_error', message).code).toBe('insufficient_balance');
	});

	it('keeps the schedule alive across a top-up window, then pauses', () => {
		const outcome = OUTCOME.RETRYABLE;
		const first = applyChargeFailure({ outcome, consecutiveFailures: 0 });
		expect(first).toEqual({ pause: false, retry: true, consecutiveFailures: 1 });

		const last = applyChargeFailure({
			outcome,
			consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
		});
		expect(last.pause).toBe(true);
		expect(last.retry).toBe(false);
		expect(last.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
	});
});

describe('classifyChargeFailure: a timeout is never retried', () => {
	it('classifies a timeout as ambiguous and pauses without retrying', () => {
		// The one failure where a retry can charge twice: the request may have
		// landed on-chain even though we never saw the response.
		const r = classify('timeout', 'onPeriod exceeded 25000ms');
		expect(r.outcome).toBe(OUTCOME.AMBIGUOUS);
		const applied = applyChargeFailure({ outcome: r.outcome, consecutiveFailures: 0 });
		expect(applied.retry).toBe(false);
		expect(applied.pause).toBe(true);
		expect(chargeStatusFor(r.outcome)).toBe('unknown');
	});

	it('catches a timeout that only announced itself in the message', () => {
		expect(classify('unknown', 'timeout: onPeriod exceeded 25000ms').outcome).toBe(
			OUTCOME.AMBIGUOUS,
		);
	});
});

describe('classifyChargeFailure: a diverged DCA quote skips one period', () => {
	it('does not count a skipped period against the schedule', () => {
		const r = classify('quote_divergence', 'Quote divergence 91bps exceeds 50bps limit');
		expect(r.outcome).toBe(OUTCOME.SKIPPED);
		const applied = applyChargeFailure({ outcome: r.outcome, consecutiveFailures: 2 });
		expect(applied).toEqual({ pause: false, retry: false, consecutiveFailures: 2 });
	});
});

describe('classifyChargeFailure: a platform outage is never the owner problem', () => {
	it.each(['feature_disabled', 'unauthorized'])(
		'%s retries forever without counting toward the pause bound',
		(code) => {
			const r = classify(code, 'relayer not enabled on this deployment');
			expect(r.platform).toBe(true);
			const applied = applyChargeFailure({
				outcome: r.outcome,
				platform: r.platform,
				consecutiveFailures: MAX_CONSECUTIVE_FAILURES + 5,
			});
			// Mass-pausing every schedule over one operator config gap would be a
			// worse outage than the gap, and each would then need a manual resume.
			expect(applied.pause).toBe(false);
			expect(applied.retry).toBe(true);
			expect(applied.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES + 5);
		},
	);
});

describe('classifyChargeFailure: HTTP statuses and unknown codes', () => {
	it('treats a 5xx from the relayer as retryable and a 4xx as our bug', () => {
		expect(classify('http_503').outcome).toBe(OUTCOME.RETRYABLE);
		expect(classify('http_503').code).toBe('relayer_error');
		expect(classify('http_400').outcome).toBe(OUTCOME.FATAL);
		expect(classify('http_400').code).toBe('validation_error');
	});

	it('defaults an unrecognised code to retryable so the bound stops it', () => {
		// Unknown-transient recovers on its own; unknown-permanent still stops
		// after MAX_CONSECUTIVE_FAILURES instead of retrying forever.
		const r = classify('something_new', 'a code nobody has seen');
		expect(r.outcome).toBe(OUTCOME.RETRYABLE);
		expect(r.code).toBe('something_new');
		expect(r.reason).toContain('a code nobody has seen');
	});

	it('never returns an empty code, even for an empty failure', () => {
		expect(classifyChargeFailure({}).code).toBe('unknown');
		expect(classifyChargeFailure().code).toBe('unknown');
	});
});

describe('chargeStatusFor', () => {
	it('maps every outcome to a status the ledger constraint accepts', () => {
		const allowed = new Set(['success', 'failed', 'aborted', 'unknown']);
		for (const outcome of Object.values(OUTCOME)) {
			expect(allowed.has(chargeStatusFor(outcome))).toBe(true);
		}
		expect(chargeStatusFor(OUTCOME.CHARGED)).toBe('success');
	});
});

describe('planStatusChange', () => {
	it('allows the two transitions an owner controls', () => {
		expect(planStatusChange('pause', 'active')).toEqual({ ok: true, status: 'paused' });
		expect(planStatusChange('resume', 'paused')).toEqual({ ok: true, status: 'active' });
	});

	it('reports a no-op as a conflict rather than pretending it worked', () => {
		expect(planStatusChange('pause', 'paused')).toMatchObject({ ok: false, code: 'conflict' });
		expect(planStatusChange('resume', 'active')).toMatchObject({ ok: false, code: 'conflict' });
	});

	it('refuses to reanimate a terminal schedule', () => {
		// Cancel is terminal on purpose: restarting means a new schedule, so the
		// charge ledger of the old one stays honest.
		for (const terminal of ['canceled', 'cancelled', 'expired']) {
			expect(planStatusChange('resume', terminal).ok).toBe(false);
			expect(planStatusChange('pause', terminal).ok).toBe(false);
		}
	});

	it('rejects an unknown action', () => {
		expect(planStatusChange('destroy', 'active')).toMatchObject({
			ok: false,
			code: 'validation_error',
		});
	});
});

describe('presentation helpers', () => {
	it('names the periods a schedule can run on', () => {
		expect(describePeriod(86400)).toBe('daily');
		expect(describePeriod(604800)).toBe('weekly');
		expect(describePeriod(2592000)).toBe('monthly');
		expect(describePeriod(1209600)).toBe('every 2 weeks');
		expect(describePeriod(7200)).toBe('every 2 hours');
		expect(describePeriod(0)).toBe('unknown');
	});

	it('renders USDC base units without floating-point drift', () => {
		expect(formatUnits('5000000')).toBe('5');
		expect(formatUnits('1234567')).toBe('1.234567');
		expect(formatUnits('1')).toBe('0.000001');
		expect(formatUnits('0')).toBe('0');
		expect(formatUnits(null)).toBe('0');
		expect(formatUnits('not-a-number')).toBe('0');
	});

	it('sums base units as integers, so a big ledger cannot lose a cent', () => {
		expect(sumUnits(['5000000', '1234567'])).toBe('6234567');
		expect(sumUnits(['9007199254740993', '1'])).toBe('9007199254740994');
		expect(sumUnits([null, undefined, 'x', '10'])).toBe('10');
		expect(sumUnits([])).toBe('0');
	});
});
