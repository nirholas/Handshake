// The marketplace funnel had no exit. Circulation agents were granted skill
// trials by `actionTrial`, but nothing ever spent one: `consumeTrialUse` is
// reachable only from the x402 agent-action route, which these agents never
// call. So `trial_remaining` stayed at its full count forever, and because
// `actionBuySkill` treated ANY trial row as ownership, every trial permanently
// retired its (buyer, seller, skill) triple from the paid path.
//
// Measured on production before the fix: 10,282 skill_purchases rows, every one
// kind='trial', zero confirmed purchases ever, and zero rows with
// trial_remaining <= 0. Marketplace GMV was a structural zero, not a demand
// problem.
//
// These tests hold the two halves of the fix in place: a free `use_trial`
// action that actually drains trials, and a weight table whose every entry has
// a real handler.
import { describe, it, expect } from 'vitest';
import { LIGHT_ACTION_WEIGHTS, actionKinds, isCostlyAction } from '../api/_lib/circulation.js';

describe('circulation action mix', () => {
	it('has a real handler for every weighted action kind', () => {
		const handlers = new Set(actionKinds());
		const missing = LIGHT_ACTION_WEIGHTS.map(([kind]) => kind).filter((k) => !handlers.has(k));
		expect(missing).toEqual([]);
	});

	it('registers use_trial so granted trials can actually be spent', () => {
		expect(actionKinds()).toContain('use_trial');
		expect(LIGHT_ACTION_WEIGHTS.map(([kind]) => kind)).toContain('use_trial');
	});

	it('keeps use_trial free so it still runs when the paid budget is zero', () => {
		// The whole point: a treasury too lean to fund buy_skill must still be
		// able to advance trials toward exhaustion, or the funnel stalls exactly
		// when it most needs to convert.
		expect(isCostlyAction('use_trial')).toBe(false);
		expect(isCostlyAction('trial')).toBe(false);
		expect(isCostlyAction('buy_skill')).toBe(true);
	});

	it('leaves at least one free action eligible at zero paid budget', () => {
		const free = LIGHT_ACTION_WEIGHTS.filter(([kind]) => !isCostlyAction(kind));
		expect(free.length).toBeGreaterThan(0);
	});

	it('grants and spends trials at the same weight so neither outruns the other', () => {
		const weight = Object.fromEntries(LIGHT_ACTION_WEIGHTS);
		expect(weight.use_trial).toBe(weight.trial);
	});

	it('still weights real purchases above every other light action', () => {
		const weight = Object.fromEntries(LIGHT_ACTION_WEIGHTS);
		const others = LIGHT_ACTION_WEIGHTS.filter(([kind]) => kind !== 'buy_skill').map(([, w]) => w);
		expect(weight.buy_skill).toBeGreaterThan(Math.max(...others));
	});
});
