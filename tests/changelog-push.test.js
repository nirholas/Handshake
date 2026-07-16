import { describe, it, expect } from 'vitest';
import {
	entryKey,
	pendingEntries,
	formatTelegramMessage,
	formatTweet,
	weightedLength,
	pushTelegramLane,
	pushXLane,
} from '../api/_lib/changelog-push.js';

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const entry = (over = {}) => ({
	date: day(0),
	title: 'A test release',
	summary: 'Something shipped.',
	tags: ['feature'],
	...over,
});

describe('entryKey', () => {
	it('is date:title', () => {
		expect(entryKey({ date: '2026-07-16', title: 'X' })).toBe('2026-07-16:X');
	});
});

describe('pendingEntries', () => {
	it('filters posted, launches, and entries older than the cutoff', () => {
		const feed = {
			entries: [
				entry({ title: 'fresh' }),
				entry({ title: 'already posted' }),
				entry({ title: 'a launch', type: 'launch' }),
				entry({ title: 'ancient', date: day(-30) }),
			],
		};
		const posted = new Set([`${day(0)}:already posted`]);
		const { pending, backlog } = pendingEntries(feed, posted, 10);
		expect(pending.map((e) => e.title)).toEqual(['fresh']);
		expect(backlog).toBe(1);
	});

	it('sorts chronologically and slices oldest-first by default, newest-first with newestWin', () => {
		const feed = {
			entries: [
				entry({ title: 'today', date: day(0) }),
				entry({ title: 'yesterday', date: day(-1) }),
				entry({ title: 'two days ago', date: day(-2) }),
			],
		};
		const none = new Set();
		expect(pendingEntries(feed, none, 2).pending.map((e) => e.title)).toEqual(['two days ago', 'yesterday']);
		expect(pendingEntries(feed, none, 2, { newestWin: true }).pending.map((e) => e.title)).toEqual(['yesterday', 'today']);
	});
});

describe('formatTelegramMessage', () => {
	it('escapes HTML and carries the detail link, date, and hashtags', () => {
		const msg = formatTelegramMessage(entry({ title: 'A <b>bold</b> & brave release', tags: ['fix', 'infra'] }));
		expect(msg).toContain('A &lt;b&gt;bold&lt;/b&gt; &amp; brave release');
		expect(msg).toContain(`https://three.ws/changelog/${day(0)}-a-b-bold-b-brave-release`);
		expect(msg).toContain('#fix #infra');
		expect(msg).toContain(day(0));
	});
});

describe('formatTweet', () => {
	it('keeps a short entry intact and appends the detail URL', () => {
		const t = formatTweet(entry());
		expect(t).toContain('A test release');
		expect(t).toContain('Something shipped.');
		expect(t).toMatch(/https:\/\/three\.ws\/changelog\/\S+$/);
	});

	it('trims a long summary to the 280 weighted-char budget on a word boundary', () => {
		const t = formatTweet(entry({ summary: 'word '.repeat(200).trim() }));
		// Weigh the t.co-wrapped URL at 23 like X does.
		const weighted = weightedLength(t.replace(/https:\/\/\S+$/, 'x'.repeat(23)));
		expect(weighted).toBeLessThanOrEqual(280);
		expect(t).toContain('…');
	});
});

describe('lanes without credentials', () => {
	it('report not_configured without touching network or db', async () => {
		const saved = {};
		for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANGELOG_CHAT_ID', 'X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET']) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		try {
			expect(await pushTelegramLane({ entries: [entry()] })).toEqual({ skipped: 'not_configured' });
			expect(await pushXLane({ entries: [entry()] })).toEqual({ skipped: 'not_configured' });
		} finally {
			for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
		}
	});
});
