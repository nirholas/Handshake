import { describe, it, expect } from 'vitest';
import { STRATEGY_SCHEMA } from '../api/sniper/strategy.js';

// POST /api/sniper/strategy parses its body with zod, and zod STRIPS unknown
// keys. A knob the handler writes but the schema does not declare is therefore
// dropped in silence: the caller sends it, gets a 200 back, and the stored row
// keeps its old value. That is what happened to the laddered-exit fields. The
// 20260725133000 migration documents "setting initials_out_multiple to null
// through the API" as the opt-out, while the API could not read the field at
// all. These tests pin the accepted field set so it cannot rot again.

const base = { agent_id: '11111111-1111-4111-8111-111111111111' };

describe('STRATEGY_SCHEMA: laddered exit knobs are settable', () => {
	it('keeps initials_out_multiple and moonbag_min_pct', () => {
		const r = STRATEGY_SCHEMA.safeParse({ ...base, initials_out_multiple: 3, moonbag_min_pct: 25 });
		expect(r.success).toBe(true);
		expect(r.data.initials_out_multiple).toBe(3);
		expect(r.data.moonbag_min_pct).toBe(25);
	});

	it('accepts them as strings, the way an HTML form posts them', () => {
		const r = STRATEGY_SCHEMA.safeParse({ ...base, initials_out_multiple: '2.5', moonbag_min_pct: '10' });
		expect(r.success).toBe(true);
		expect(r.data.initials_out_multiple).toBe('2.5');
		expect(r.data.moonbag_min_pct).toBe('10');
	});

	it('carries an explicit null through, so the ladder can be turned off', () => {
		const r = STRATEGY_SCHEMA.safeParse({ ...base, initials_out_multiple: null });
		expect(r.success).toBe(true);
		expect('initials_out_multiple' in r.data).toBe(true);
		expect(r.data.initials_out_multiple).toBe(null);
	});

	it('omits an absent knob entirely, which the handler reads as "leave unchanged"', () => {
		const r = STRATEGY_SCHEMA.safeParse(base);
		expect(r.success).toBe(true);
		expect('initials_out_multiple' in r.data).toBe(false);
		expect('moonbag_min_pct' in r.data).toBe(false);
	});
});

describe('STRATEGY_SCHEMA: the boundary', () => {
	it('strips auto_fund_enabled, which is why the handler rejects it before parsing', () => {
		// Treasury auto-funding is operator-granted. The schema dropping it is the
		// safe outcome; the handler 400s on it so the caller is never told a
		// consent flag landed when it did not.
		const r = STRATEGY_SCHEMA.safeParse({ ...base, auto_fund_enabled: true });
		expect(r.success).toBe(true);
		expect('auto_fund_enabled' in r.data).toBe(false);
	});

	it('rejects a body with no agent_id', () => {
		expect(STRATEGY_SCHEMA.safeParse({}).success).toBe(false);
	});

	it('rejects an unknown trigger', () => {
		const r = STRATEGY_SCHEMA.safeParse({ ...base, trigger: 'rugpull' });
		expect(r.success).toBe(false);
		expect(r.error.issues[0].path).toEqual(['trigger']);
	});

	it('rejects a non-numeric telegram chat id', () => {
		expect(STRATEGY_SCHEMA.safeParse({ ...base, telegram_chat_id: 'not-a-number' }).success).toBe(false);
	});
});
