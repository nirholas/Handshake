// Unit tests for the notification herald's decision rules
// (src/notification-herald.js): what the corner avatar is allowed to walk on
// screen and say out loud, and what it must stay quiet about.
//
// Only the pure exports are exercised here. The module touches no DOM at import
// time on purpose (every browser dependency is a dynamic import inside a
// function), so it loads in the node test environment as-is.

import { describe, it, expect } from 'vitest';
import {
	holdMsFor,
	isFresh,
	categoryFor,
	announcesCategory,
	pickAnnouncements,
	emoteFor,
} from '../src/notification-herald.js';
import { typeCategoryMap } from '../api/_lib/notify-prefs.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

const TYPES = typeCategoryMap();

// Announce sales; stay quiet about everything else.
const PREFS = {
	categories: {
		sales: { in_app: true, push: true, email: true, telegram: false, avatar: true },
		social: { in_app: true, push: true, email: false, telegram: false, avatar: false },
		account: { in_app: true, push: true, email: true, telegram: false, avatar: true },
	},
};

function notif(over = {}) {
	return {
		id: over.id || 'n1',
		type: over.type || 'sale',
		payload: over.payload || {},
		read_at: over.read_at ?? null,
		created_at: over.created_at || ago(60_000),
	};
}

describe('holdMsFor', () => {
	it('scales the dwell with the length of the line', () => {
		expect(holdMsFor('short')).toBeLessThan(holdMsFor('a considerably longer line of copy'));
	});

	it('never parks the avatar on screen, however long the payload', () => {
		expect(holdMsFor('x'.repeat(5000))).toBe(12_000);
	});

	it('handles a missing line without throwing', () => {
		expect(holdMsFor(undefined)).toBeGreaterThan(0);
	});
});

describe('isFresh', () => {
	it('accepts a notification from the last quarter hour', () => {
		expect(isFresh(ago(60_000), NOW)).toBe(true);
		expect(isFresh(ago(14 * 60_000), NOW)).toBe(true);
	});

	it('rejects anything older: that is inbox history, not news', () => {
		expect(isFresh(ago(16 * 60_000), NOW)).toBe(false);
		expect(isFresh(ago(48 * 3600_000), NOW)).toBe(false);
	});

	it('rejects a far-future timestamp and unparseable input', () => {
		expect(isFresh(new Date(NOW + 3600_000).toISOString(), NOW)).toBe(false);
		expect(isFresh('not a date', NOW)).toBe(false);
		expect(isFresh(undefined, NOW)).toBe(false);
	});
});

describe('categoryFor', () => {
	it('uses the map the server sends', () => {
		expect(categoryFor('sale', TYPES)).toBe('sales');
		expect(categoryFor('follow', TYPES)).toBe('social');
		expect(categoryFor('forge_complete', TYPES)).toBe('creations');
	});

	it('falls back to account for an unmapped type, exactly like the server', () => {
		expect(categoryFor('brand_new_type', TYPES)).toBe('account');
		expect(categoryFor('sale', undefined)).toBe('account');
	});
});

describe('announcesCategory', () => {
	it('requires an explicit true: an absent matrix announces nothing', () => {
		expect(announcesCategory(PREFS, 'sales')).toBe(true);
		expect(announcesCategory(PREFS, 'social')).toBe(false);
		expect(announcesCategory(PREFS, 'irl')).toBe(false);
		expect(announcesCategory(null, 'sales')).toBe(false);
		expect(announcesCategory({}, 'sales')).toBe(false);
	});
});

describe('pickAnnouncements', () => {
	const base = { prefs: PREFS, typeCategories: TYPES, announced: new Set(), now: NOW };

	it('announces a fresh, unread, opted-in notification', () => {
		const { deliver, overflow } = pickAnnouncements([notif()], base);
		expect(deliver.map((n) => n.id)).toEqual(['n1']);
		expect(overflow).toBe(0);
	});

	it('skips read, stale, muted-category, and already-announced rows', () => {
		const rows = [
			notif({ id: 'read', read_at: ago(1000) }),
			notif({ id: 'stale', created_at: ago(60 * 60_000) }),
			notif({ id: 'muted', type: 'follow' }),
			notif({ id: 'said' }),
		];
		const { deliver } = pickAnnouncements(rows, {
			...base,
			announced: new Set(['said']),
		});
		expect(deliver).toEqual([]);
	});

	it('delivers newest first', () => {
		const rows = [
			notif({ id: 'older', created_at: ago(9 * 60_000) }),
			notif({ id: 'newer', created_at: ago(60_000) }),
		];
		expect(pickAnnouncements(rows, base).deliver.map((n) => n.id)).toEqual(['newer', 'older']);
	});

	it('caps the batch at two and reports the rest as overflow', () => {
		const rows = [1, 2, 3, 4, 5].map((i) =>
			notif({ id: `n${i}`, created_at: ago(i * 60_000) }),
		);
		const { deliver, overflow } = pickAnnouncements(rows, base);
		expect(deliver.map((n) => n.id)).toEqual(['n1', 'n2']);
		expect(overflow).toBe(3);
	});

	it('tolerates junk input rather than throwing at delivery time', () => {
		expect(pickAnnouncements(null, base).deliver).toEqual([]);
		expect(pickAnnouncements([null, {}, notif()], base).deliver.map((n) => n.id)).toEqual(['n1']);
	});

	it('an unmapped type follows the account row, which announces by default', () => {
		const rows = [notif({ id: 'x', type: 'brand_new_type' })];
		expect(pickAnnouncements(rows, base).deliver.map((n) => n.id)).toEqual(['x']);
	});
});

describe('emoteFor', () => {
	it('celebrates money and finished work', () => {
		expect(emoteFor('sale')).toBe('dance');
		expect(emoteFor('royalty_paid')).toBe('dance');
		expect(emoteFor('forge_complete')).toBe('dance');
	});

	it('waves for everything else, including a type it has never seen', () => {
		expect(emoteFor('forge_failed')).toBe('wave');
		expect(emoteFor('brand_new_type')).toBe('wave');
	});
});
