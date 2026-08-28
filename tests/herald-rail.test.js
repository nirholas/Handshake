// Unit tests for the herald rail's shared record shape (api/_lib/herald.js).
//
// The wire format is the contract between a machine that writes a line and the
// browser that says it out loud, so the parts that matter are the ones that
// stop a hostile or careless integration from turning a spoken sentence into
// something else: URL scheme filtering, length caps, and importance clamping.

import { describe, it, expect } from 'vitest';
import {
	QUEUE_CAP,
	QUEUE_TTL_SECONDS,
	TEXT_MAX,
	cleanText,
	normalizeAnnouncement,
	parseRecord,
	queueKey,
	safeUrl,
} from '../api/_lib/herald.js';

const CLOCK = () => Date.parse('2026-08-28T12:00:00.000Z');
const ID = () => 'fixed-id';

describe('queueKey', () => {
	it('scopes the queue to one user', () => {
		expect(queueKey('u1')).toBe('herald:u1:queue');
		expect(queueKey('u1')).not.toBe(queueKey('u2'));
	});
});

describe('safeUrl', () => {
	it('allows same-origin paths and absolute http(s)', () => {
		expect(safeUrl('/dashboard')).toBe('/dashboard');
		expect(safeUrl('https://three.ws/x')).toBe('https://three.ws/x');
		expect(safeUrl('  /wallet  ')).toBe('/wallet');
	});

	it('rejects every scheme that could execute or redirect off-site', () => {
		expect(safeUrl('javascript:alert(1)')).toBe(null);
		expect(safeUrl('data:text/html,<script>')).toBe(null);
		expect(safeUrl('//evil.example.com')).toBe(null);
		expect(safeUrl('vbscript:x')).toBe(null);
		expect(safeUrl('')).toBe(null);
		expect(safeUrl(null)).toBe(null);
	});
});

describe('cleanText', () => {
	it('collapses whitespace and caps the length', () => {
		expect(cleanText('  hello   world \n new line ')).toBe('hello world new line');
		expect(cleanText('x'.repeat(500)).length).toBe(TEXT_MAX);
		expect(cleanText(undefined)).toBe('');
	});
});

describe('normalizeAnnouncement', () => {
	it('builds the wire record with sane defaults', () => {
		const a = normalizeAnnouncement({ text: 'Deploy is green' }, CLOCK, ID);
		expect(a).toMatchObject({
			id: 'fixed-id',
			text: 'Deploy is green',
			importance: 70,
			tone: 'alert',
			at: CLOCK(),
		});
		expect(a.url).toBeUndefined();
	});

	it('clamps importance and drops an unsafe url', () => {
		const a = normalizeAnnouncement(
			{ text: 'x', importance: 5000, url: 'javascript:alert(1)' },
			CLOCK,
			ID,
		);
		expect(a.importance).toBe(100);
		expect(a.url).toBeUndefined();
	});

	it('keeps a caller dedupe key and arbitrary meta', () => {
		const a = normalizeAnnouncement(
			{ text: 'build', key: 'ci:main', meta: { run: 42 } },
			CLOCK,
			ID,
		);
		expect(a.key).toBe('ci:main');
		expect(a.meta).toEqual({ run: 42 });
	});

	it('mints a distinct id per call by default', () => {
		const a = normalizeAnnouncement({ text: 'one' });
		const b = normalizeAnnouncement({ text: 'one' });
		expect(a.id).not.toBe(b.id);
	});
});

describe('parseRecord', () => {
	it('accepts both shapes Redis can hand back', () => {
		expect(parseRecord('{"text":"hi"}')).toEqual({ text: 'hi' });
		expect(parseRecord({ text: 'hi' })).toEqual({ text: 'hi' });
	});

	it('skips anything unusable instead of throwing', () => {
		expect(parseRecord('not json')).toBe(null);
		expect(parseRecord(42)).toBe(null);
		expect(parseRecord(null)).toBe(null);
	});
});

describe('queue policy', () => {
	it('is a live channel, not an archive', () => {
		expect(QUEUE_TTL_SECONDS).toBeLessThanOrEqual(600);
		expect(QUEUE_CAP).toBeLessThanOrEqual(50);
	});
});
