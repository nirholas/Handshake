// Unit tests for the Knock policy rules (api/_lib/knock/policy.js): what a
// door costs, what a stranger is allowed to send through it, how loudly a paid
// knock lands, and exactly what the recipient's avatar says out loud.
//
// These are the parts of Knock a person will argue with, so they are pinned
// here rather than only exercised through HTTP. The module is pure: no
// database, no network, no clock.

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_PRICE_ATOMICS,
	MAX_PRICE_ATOMICS,
	MIN_PRICE_ATOMICS,
	blockKeysFor,
	doorRefusal,
	formatUsdc,
	importanceFor,
	knockError,
	normalizeHandle,
	parsePrice,
	spokenLineFor,
	titleFor,
	validateKnock,
} from '../api/_lib/knock/policy.js';

const DOOR = { open: true, max_chars: 600, daily_cap: 25 };

describe('formatUsdc', () => {
	it('renders whole dollars and cents', () => {
		expect(formatUsdc(0n)).toBe('$0.00');
		expect(formatUsdc('50000')).toBe('$0.05');
		expect(formatUsdc('1000000')).toBe('$1.00');
		expect(formatUsdc('1234500000')).toBe('$1234.50');
	});

	it('keeps sub-cent precision instead of rounding a price to zero', () => {
		expect(formatUsdc(MIN_PRICE_ATOMICS)).toBe('$0.001');
		expect(formatUsdc('1')).toBe('$0.000001');
	});
});

describe('parsePrice', () => {
	it('accepts what a person actually types', () => {
		expect(parsePrice('0.05')).toBe(50000n);
		expect(parsePrice('$0.05')).toBe(50000n);
		expect(parsePrice('1,000')).toBe(1000000000n);
		expect(parsePrice(String(DEFAULT_PRICE_ATOMICS), { unit: 'atomics' })).toBe(DEFAULT_PRICE_ATOMICS);
	});

	it('treats zero as a free door, not an out-of-range price', () => {
		expect(parsePrice('0')).toBe(0n);
	});

	it('refuses a price the settle rail cannot carry', () => {
		expect(() => parsePrice('0.0005')).toThrow(/between/);
		expect(() => parsePrice('1001')).toThrow(/between/);
		expect(() => parsePrice('abc')).toThrow(/USDC amount/);
		expect(() => parsePrice('0.1234567')).toThrow(/USDC amount/);
	});

	it('round-trips the documented bounds', () => {
		expect(parsePrice(formatUsdc(MIN_PRICE_ATOMICS))).toBe(MIN_PRICE_ATOMICS);
		expect(parsePrice(formatUsdc(MAX_PRICE_ATOMICS))).toBe(MAX_PRICE_ATOMICS);
	});
});

describe('normalizeHandle', () => {
	it('strips the @ and lowercases', () => {
		expect(normalizeHandle('@Nirholas')).toBe('nirholas');
	});

	it('drops anything a username could never contain', () => {
		expect(normalizeHandle('ni r/ho..las!')).toBe('nirho..las');
		expect(normalizeHandle('')).toBe('');
		expect(normalizeHandle(null)).toBe('');
	});
});

describe('importanceFor', () => {
	it('puts every paid knock above the default interrupt bar of 60', () => {
		for (const price of ['1000', '50000', '1000000', '1000000000']) {
			expect(importanceFor(price)).toBeGreaterThan(60);
		}
	});

	it('keeps a free knock below it, so a free door cannot interrupt anyone', () => {
		expect(importanceFor(0)).toBeLessThan(60);
	});

	it('ranks a bigger payment higher without letting one buy the whole feed', () => {
		expect(importanceFor('1000000')).toBeGreaterThan(importanceFor('50000'));
		expect(importanceFor('1000000000')).toBeLessThanOrEqual(99);
	});
});

describe('spokenLineFor', () => {
	it('leads with who and what they paid, because that is the decision', () => {
		expect(spokenLineFor({ senderName: 'Ada', amountAtomics: '50000', subject: 'Your settle path' }))
			.toBe('Ada paid $0.05 to reach you: Your settle path.');
	});

	it('says a free knock plainly rather than claiming a payment', () => {
		expect(spokenLineFor({ senderName: 'Ada', amountAtomics: 0 })).toBe('Ada is at your door.');
	});

	it('never speaks the message body', () => {
		const line = spokenLineFor({ senderName: 'Ada', amountAtomics: '50000', subject: 'Hi' });
		expect(line).not.toContain('body');
		expect(line.length).toBeLessThan(120);
	});

	it('survives a sender with no name', () => {
		expect(spokenLineFor({ amountAtomics: '50000' })).toBe('Someone paid $0.05 to reach you.');
	});
});

describe('titleFor', () => {
	it('names the sender and the subject', () => {
		expect(titleFor({ senderName: 'Ada', amountAtomics: '50000', subject: 'Settle path' })).toBe('Ada: Settle path');
	});

	it('falls back to the amount when there is no subject', () => {
		expect(titleFor({ senderName: 'Ada', amountAtomics: '50000' })).toBe('Ada knocked ($0.05)');
		expect(titleFor({ senderName: 'Ada', amountAtomics: 0 })).toBe('Ada knocked');
	});
});

describe('validateKnock', () => {
	const ok = { from: 'Ada', message: 'a message long enough to be real' };

	it('returns the cleaned payload', () => {
		const clean = validateKnock({ ...ok, subject: '  Settle path  ', url: 'https://example.com' }, DOOR);
		expect(clean.senderName).toBe('Ada');
		expect(clean.subject).toBe('Settle path');
		expect(clean.senderUrl).toBe('https://example.com');
		expect(clean.senderKind).toBe('unknown');
	});

	it('enforces the door\'s own length limit, not a global one', () => {
		expect(() => validateKnock({ ...ok, message: 'x'.repeat(120) }, { ...DOOR, max_chars: 100 }))
			.toThrow(/up to 100 characters/);
		expect(validateKnock({ ...ok, message: 'x'.repeat(120) }, { ...DOOR, max_chars: 600 }).message.length).toBe(120);
	});

	it('refuses a message with nothing in it', () => {
		expect(() => validateKnock({ ...ok, message: 'hi' }, DOOR)).toThrow(/at least 8/);
		expect(() => validateKnock({ ...ok, from: '   ' }, DOOR)).toThrow(/who you are/);
	});

	it('refuses a link that is not a plain http(s) URL', () => {
		for (const url of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
			expect(() => validateKnock({ ...ok, url }, DOOR)).toThrow(/http\(s\) link/);
		}
	});

	it('only trusts sender_kind from the allowlist', () => {
		expect(validateKnock({ ...ok, sender_kind: 'agent' }, DOOR).senderKind).toBe('agent');
		expect(validateKnock({ ...ok, sender_kind: 'admin' }, DOOR).senderKind).toBe('unknown');
	});
});

describe('doorRefusal', () => {
	it('refuses a door nobody opened', () => {
		expect(doorRefusal(null)?.code).toBe('no_door');
		expect(doorRefusal(null)?.status).toBe(404);
	});

	it('refuses a shut door', () => {
		expect(doorRefusal({ ...DOOR, open: false })?.code).toBe('door_closed');
	});

	it('refuses once the day\'s cap is spent, with a retryable status', () => {
		const refusal = doorRefusal(DOOR, { knocksToday: 25 });
		expect(refusal?.code).toBe('door_full');
		expect(refusal?.status).toBe(429);
	});

	it('lets a knock through below the cap', () => {
		expect(doorRefusal(DOOR, { knocksToday: 24 })).toBeNull();
	});
});

describe('blockKeysFor', () => {
	it('matches on the paying wallet and on the name', () => {
		expect(blockKeysFor({ payerWallet: 'AbC', senderName: 'Ada' })).toEqual(['abc', 'ada']);
	});

	it('deduplicates and drops empties', () => {
		expect(blockKeysFor({ payerWallet: 'ada', senderName: 'Ada' })).toEqual(['ada']);
		expect(blockKeysFor({})).toEqual([]);
	});
});

describe('knockError', () => {
	it('carries a machine code and the right HTTP status', () => {
		expect(knockError('door_full', 'x').status).toBe(429);
		expect(knockError('blocked', 'x').status).toBe(403);
		expect(knockError('duplicate', 'x').status).toBe(409);
		expect(knockError('something_new', 'x').status).toBe(400);
	});
});
