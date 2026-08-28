// The companion's decision rules: what is worth interrupting a person for.
//
// Only the deterministic pass is exercised here. It is the one that always
// runs (api/_lib/companion/triage.js), it needs no key, and it is the floor the
// LLM refinement is measured against, so a regression in it is a regression in
// every delivery the platform makes.

import { describe, it, expect } from 'vitest';
import { scoreByRules, defaultLine, shorten } from '../api/_lib/companion/triage.js';
import { normalizeIdentifier } from '../api/_lib/companion/store.js';
import { inQuietHours } from '../api/_lib/companion/poll.js';

const contact = (over = {}) => ({ id: 'c1', display_name: 'Sarah', priority_boost: 0, ...over });

describe('scoreByRules', () => {
	it('puts a saved contact asking for something above a stranger saying the same thing', () => {
		const message = { source_kind: 'telegram', sender: 'Sarah', body: 'call me when you can' };
		const known = scoreByRules(message, contact());
		const stranger = scoreByRules(message, null);
		expect(known.importance).toBeGreaterThan(stranger.importance);
		expect(known.reason).toContain('Sarah');
	});

	it('treats a login code as urgent even from nobody in particular', () => {
		const verdict = scoreByRules({
			source_kind: 'email',
			sender: 'Bank',
			sender_id: 'alerts@bank.example',
			title: 'Your verification code is 483920',
			body: 'Use this one-time code to finish signing in.',
		});
		expect(verdict.importance).toBeGreaterThanOrEqual(70);
	});

	it('floors marketing mail from an unattended address', () => {
		const verdict = scoreByRules({
			source_kind: 'email',
			sender: 'Shop',
			sender_id: 'noreply@shop.example',
			title: '50% off, sale ends tonight',
			body: 'Shop the promotion now. Unsubscribe any time.',
		});
		expect(verdict.importance).toBeLessThan(20);
	});

	it('scores a calendar event by how soon it starts', () => {
		const base = { source_kind: 'calendar', title: 'Design review' };
		const soon = scoreByRules({ ...base, occurs_at: new Date(Date.now() + 4 * 60_000).toISOString() });
		const later = scoreByRules({ ...base, occurs_at: new Date(Date.now() + 50 * 60_000).toISOString() });
		expect(soon.importance).toBeGreaterThan(later.importance);
	});

	it('honours the priority the sending device already decided', () => {
		const base = { source_kind: 'bridge', sender: 'Messages', title: 'ping' };
		const high = scoreByRules({ ...base, priority_hint: 'high' });
		const low = scoreByRules({ ...base, priority_hint: 'low' });
		expect(high.importance - low.importance).toBe(40);
	});

	it('never leaves the 0 to 100 range', () => {
		const loud = scoreByRules(
			{
				source_kind: 'calendar',
				title: 'URGENT: emergency, call me now',
				body: 'verification code, payment declined, flight cancelled, where are you?',
				occurs_at: new Date(Date.now() + 60_000).toISOString(),
				priority_hint: 'high',
			},
			contact({ priority_boost: 100 }),
		);
		expect(loud.importance).toBe(100);
		const quiet = scoreByRules({
			source_kind: 'email',
			sender_id: 'noreply@x.example',
			title: 'newsletter',
			body: 'unsubscribe promotion webinar survey',
		});
		expect(quiet.importance).toBe(0);
	});
});

describe('defaultLine', () => {
	it('names the contact rather than the raw handle', () => {
		const line = defaultLine(
			{ source_kind: 'telegram', sender: '@sarah_k', body: 'I am downstairs' },
			contact(),
		);
		expect(line).toBe('Sarah says: I am downstairs');
	});

	it('says how long is left before a calendar event', () => {
		const line = defaultLine({
			source_kind: 'calendar',
			title: 'Design review',
			occurs_at: new Date(Date.now() + 9 * 60_000).toISOString(),
		});
		expect(line).toMatch(/Design review is in \d+ minutes/);
	});
});

describe('shorten', () => {
	it('leaves a short line untouched and clips a long one', () => {
		expect(shorten('all good')).toBe('all good');
		const long = shorten('word '.repeat(200), 60);
		expect(long.length).toBeLessThanOrEqual(61);
		expect(long.endsWith('…')).toBe(true);
	});

	it('collapses the whitespace an email preview arrives with', () => {
		expect(shorten('one\n\n   two\t three')).toBe('one two three');
	});
});

describe('normalizeIdentifier', () => {
	it('resolves the same person across lanes', () => {
		expect(normalizeIdentifier('@Sarah')).toBe('sarah');
		expect(normalizeIdentifier('Sarah K <Sarah@Example.com>')).toBe('sarah@example.com');
		expect(normalizeIdentifier('+1 (415) 555-0100')).toBe('+14155550100');
		expect(normalizeIdentifier('  ')).toBe('');
	});
});

describe('inQuietHours', () => {
	const settings = { quiet_start: 22, quiet_end: 7, timezone: 'America/New_York' };

	it('covers a window that wraps midnight', () => {
		expect(inQuietHours(settings, new Date('2026-08-28T07:00:00Z'))).toBe(true);  // 03:00 NY
		expect(inQuietHours(settings, new Date('2026-08-28T16:00:00Z'))).toBe(false); // 12:00 NY
		expect(inQuietHours(settings, new Date('2026-08-29T03:00:00Z'))).toBe(true);  // 23:00 NY
	});

	it('is off entirely when no window is set', () => {
		expect(inQuietHours({ quiet_start: null, quiet_end: null, timezone: 'UTC' })).toBe(false);
	});

	it('falls back to UTC rather than throwing on a bad timezone', () => {
		expect(inQuietHours({ quiet_start: 0, quiet_end: 6, timezone: 'Not/AZone' }, new Date('2026-08-28T03:00:00Z'))).toBe(true);
	});
});
