import { describe, it, expect } from 'vitest';
import { scoreByRules, decide, inQuietHours, shorten, LANE_BASELINE } from '../src/triage-rules.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const inMinutes = (n) => new Date(NOW + n * 60_000).toISOString();

describe('scoreByRules', () => {
	it('reports which signals fired, not just a number', () => {
		const verdict = scoreByRules({
			source_kind: 'telegram',
			sender: 'Sarah',
			title: 'can you call me, it is urgent',
		});
		expect(verdict.signals).toContain('urgent_language');
		expect(verdict.signals).toContain('direct_request');
		expect(verdict.importance).toBeGreaterThan(LANE_BASELINE.telegram);
	});

	it('interrupts for a one-time code from an unknown sender', () => {
		const verdict = scoreByRules({
			source_kind: 'email',
			sender_id: 'security@bank.example',
			title: 'Your verification code is 220913',
		});
		expect(verdict.importance).toBeGreaterThanOrEqual(70);
	});

	it('keeps marketing below the floor even when it shouts', () => {
		const verdict = scoreByRules({
			source_kind: 'email',
			sender_id: 'noreply@deals.example',
			title: 'URGENT: limited time offer, sale ends tonight',
			body: 'Unsubscribe at any time.',
		});
		expect(verdict.importance).toBeLessThan(40);
	});

	it('gives an unknown lane the default baseline rather than NaN', () => {
		const verdict = scoreByRules({ source_kind: 'carrier-pigeon', title: 'hello' });
		expect(verdict.importance).toBe(40);
	});

	it('ranks a meeting by how close it is', () => {
		const soon = scoreByRules({ source_kind: 'calendar', title: 'Standup', occurs_at: inMinutes(3) }, null, { now: NOW });
		const hour = scoreByRules({ source_kind: 'calendar', title: 'Standup', occurs_at: inMinutes(45) }, null, { now: NOW });
		const tomorrow = scoreByRules({ source_kind: 'calendar', title: 'Standup', occurs_at: inMinutes(1500) }, null, { now: NOW });
		expect(soon.importance).toBeGreaterThan(hour.importance);
		expect(hour.importance).toBeGreaterThan(tomorrow.importance);
	});
});

describe('decide', () => {
	const settings = { quiet_start: 22, quiet_end: 7, timezone: 'UTC' };

	it('speaks when the score clears the threshold', () => {
		const verdict = decide({ source_kind: 'bridge', title: 'Sarah is at the door', priority_hint: 'high' }, { threshold: 60, now: NOW });
		expect(verdict.speak).toBe(true);
		expect(verdict.quiet).toBe(false);
	});

	it('stays silent during quiet hours no matter how loud the message is', () => {
		const verdict = decide(
			{ source_kind: 'bridge', title: 'URGENT: emergency, call me now', priority_hint: 'high' },
			{ threshold: 60, settings, now: Date.parse('2026-08-28T03:00:00.000Z') },
		);
		expect(verdict.importance).toBeGreaterThan(60);
		expect(verdict.quiet).toBe(true);
		expect(verdict.speak).toBe(false);
	});

	it('respects a raised bar', () => {
		const event = { source_kind: 'email', sender: 'A colleague', title: 'quick question about the deck' };
		expect(decide(event, { threshold: 20, now: NOW }).speak).toBe(true);
		expect(decide(event, { threshold: 90, now: NOW }).speak).toBe(false);
	});
});

describe('inQuietHours', () => {
	it('handles a window inside one day', () => {
		const settings = { quiet_start: 9, quiet_end: 17, timezone: 'UTC' };
		expect(inQuietHours(settings, new Date('2026-08-28T12:00:00Z'))).toBe(true);
		expect(inQuietHours(settings, new Date('2026-08-28T18:00:00Z'))).toBe(false);
	});

	it('treats an identical start and end as always quiet', () => {
		expect(inQuietHours({ quiet_start: 5, quiet_end: 5, timezone: 'UTC' }, new Date('2026-08-28T18:00:00Z'))).toBe(true);
	});
});

describe('shorten', () => {
	it('never returns more than the cap', () => {
		expect(shorten('a'.repeat(500), 100).length).toBeLessThanOrEqual(101);
	});
});
