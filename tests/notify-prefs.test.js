// Unit tests for api/_lib/notify-prefs.js — the preference model that gates
// every notification channel (in-app / push / email / telegram / avatar).
//
// These are pure functions; resolvePrefs (the only DB-touching export) is not
// exercised here. Importing the module is safe because api/_lib/db.js creates
// its neon client lazily, so no connection is attempted at import time.

import { describe, it, expect } from 'vitest';
import {
	CATEGORIES,
	CHANNELS,
	categoryForType,
	defaultMatrix,
	mergeWithDefaults,
	channelEnabled,
	sanitizePrefs,
	pushPayloadFor,
} from '../api/_lib/notify-prefs.js';

describe('category model', () => {
	it('exposes the nine display categories and five channels', () => {
		expect(CATEGORIES.map((c) => c.key)).toEqual([
			'sales', 'purchases', 'social', 'irl', 'alerts', 'creations', 'companion', 'knock', 'account',
		]);
		expect(CHANNELS).toEqual(['in_app', 'push', 'email', 'telegram', 'avatar']);
	});

	it('every category has a label and description for the preference center', () => {
		for (const c of CATEGORIES) {
			expect(typeof c.label).toBe('string');
			expect(c.label.length).toBeGreaterThan(0);
			expect(typeof c.description).toBe('string');
			expect(c.description.length).toBeGreaterThan(0);
		}
	});
});

describe('categoryForType', () => {
	it('maps known notification types to their category', () => {
		expect(categoryForType('skill_purchased')).toBe('sales');
		expect(categoryForType('skill_purchase_confirmed')).toBe('purchases');
		expect(categoryForType('remix')).toBe('social');
		expect(categoryForType('irl_interaction')).toBe('irl');
		expect(categoryForType('pump_alert')).toBe('alerts');
		expect(categoryForType('forge_complete')).toBe('creations');
		expect(categoryForType('forge_failed')).toBe('creations');
		expect(categoryForType('withdrawal_failed')).toBe('account');
	});

	it('falls back to account for unknown types (never silently undeliverable)', () => {
		expect(categoryForType('something_brand_new')).toBe('account');
		expect(categoryForType('')).toBe('account');
	});

	it('every mapped category is one of the declared categories', () => {
		const keys = new Set(CATEGORIES.map((c) => c.key));
		for (const c of CATEGORIES) expect(keys.has(c.key)).toBe(true);
		// spot a few types
		for (const t of ['sale', 'referral_earned', 'skill_gift_sent', 'security_alert']) {
			expect(keys.has(categoryForType(t))).toBe(true);
		}
	});
});

describe('defaultMatrix / mergeWithDefaults', () => {
	it('default matrix turns in_app + push on for every category', () => {
		const m = defaultMatrix();
		for (const c of CATEGORIES) {
			expect(m[c.key].in_app).toBe(true);
			expect(m[c.key].push).toBe(true);
		}
	});

	it('email defaults on only for money, security, and unattended creations', () => {
		const m = defaultMatrix();
		expect(m.sales.email).toBe(true);
		expect(m.purchases.email).toBe(true);
		expect(m.account.email).toBe(true);
		// Creations email only ever fires for an unattended completion (the
		// finalizer path), so defaulting on is the feature the user asked for.
		expect(m.creations.email).toBe(true);
		expect(m.social.email).toBe(false);
		expect(m.irl.email).toBe(false);
		expect(m.alerts.email).toBe(false);
	});

	it('telegram defaults off everywhere except opt-in alerts', () => {
		const m = defaultMatrix();
		expect(m.sales.telegram).toBe(false);
		expect(m.alerts.telegram).toBe(true);
	});

	// The avatar channel physically interrupts: the corner companion walks on
	// screen and speaks. It is on only where an interruption is welcome.
	it('avatar defaults on for money, finished creations, and account events', () => {
		const m = defaultMatrix();
		expect(m.sales.avatar).toBe(true);
		expect(m.creations.avatar).toBe(true);
		expect(m.account.avatar).toBe(true);
		expect(m.purchases.avatar).toBe(false);
		expect(m.social.avatar).toBe(false);
		expect(m.irl.avatar).toBe(false);
		expect(m.alerts.avatar).toBe(false);
	});

	it('every category carries a value for every channel', () => {
		const m = defaultMatrix();
		for (const c of CATEGORIES) {
			for (const ch of CHANNELS) {
				expect(typeof m[c.key][ch]).toBe('boolean');
			}
		}
	});

	it('a fresh mutation of the default matrix does not leak across calls', () => {
		const a = defaultMatrix();
		a.sales.push = false;
		const b = defaultMatrix();
		expect(b.sales.push).toBe(true);
	});

	it('overlays stored sparse prefs onto defaults', () => {
		const merged = mergeWithDefaults({ categories: { sales: { email: false } } });
		expect(merged.categories.sales.email).toBe(false); // overridden
		expect(merged.categories.sales.push).toBe(true);   // default kept
		expect(merged.categories.account.email).toBe(true); // untouched category default
	});

	it('surfaces a stored telegram chat id, null otherwise', () => {
		expect(mergeWithDefaults({ telegram_chat_id: '12345' }).telegram_chat_id).toBe('12345');
		expect(mergeWithDefaults({}).telegram_chat_id).toBe(null);
	});
});

describe('channelEnabled', () => {
	const prefs = mergeWithDefaults({
		categories: { social: { push: false }, sales: { email: false } },
	});

	it('respects an explicit off override', () => {
		expect(channelEnabled(prefs, 'remix', 'push')).toBe(false);     // social.push off
		expect(channelEnabled(prefs, 'skill_purchased', 'email')).toBe(false); // sales.email off
	});

	it('falls back to the default when no override exists', () => {
		expect(channelEnabled(prefs, 'remix', 'in_app')).toBe(true);
		expect(channelEnabled(prefs, 'skill_purchased', 'push')).toBe(true);
	});

	it('handles a totally empty prefs object via defaults', () => {
		const empty = mergeWithDefaults({});
		expect(channelEnabled(empty, 'pump_alert', 'telegram')).toBe(true); // alerts default
		expect(channelEnabled(empty, 'remix', 'email')).toBe(false);        // social default
	});
});

describe('sanitizePrefs', () => {
	it('drops unknown categories and non-boolean channel values', () => {
		const clean = sanitizePrefs({
			categories: {
				sales: { push: false, email: 'yes', bogus_channel: true },
				not_a_category: { push: true },
			},
		});
		expect(clean.categories.sales).toEqual({ push: false });
		expect(clean.categories.not_a_category).toBeUndefined();
	});

	it('accepts a numeric telegram chat id and clears on empty string', () => {
		expect(sanitizePrefs({ telegram_chat_id: '-1009876' }).telegram_chat_id).toBe('-1009876');
		expect(sanitizePrefs({ telegram_chat_id: '' }).telegram_chat_id).toBe(null);
		expect(sanitizePrefs({ telegram_chat_id: 'not-a-number' }).telegram_chat_id).toBeUndefined();
	});

	it('never returns categories with zero usable keys', () => {
		const clean = sanitizePrefs({ categories: { sales: { email: 'no' } } });
		expect(clean.categories.sales).toBeUndefined();
	});
});

describe('pushPayloadFor', () => {
	it('builds a title/body/url and carries the notification id + category', () => {
		const p = pushPayloadFor('skill_purchased', { skill: 'Voice Pack', agent_id: 'a1' }, 'n-123');
		expect(p.title).toMatch(/sale/i);
		expect(p.body).toContain('Voice Pack');
		expect(p.url).toBe('/agents/a1');
		expect(p.notificationId).toBe('n-123');
		expect(p.category).toBe('sales');
		expect(p.tag).toBe('skill_purchased');
	});

	it('builds forge completion copy with the prompt and the share link', () => {
		const p = pushPayloadFor(
			'forge_complete',
			{ prompt: 'a brass desk lamp', link: '/forge?share=abc-123' },
			'n-9',
		);
		expect(p.title).toMatch(/ready/i);
		expect(p.body).toContain('a brass desk lamp');
		expect(p.url).toBe('/forge?share=abc-123');
		expect(p.category).toBe('creations');
	});

	it('builds forge failure copy that points back at the forge', () => {
		const p = pushPayloadFor('forge_failed', { prompt: 'a lamp', link: '/forge' });
		expect(p.title).toMatch(/failed/i);
		expect(p.url).toBe('/forge');
		expect(p.category).toBe('creations');
	});

	it('prefers an explicit safe link and rejects javascript: urls', () => {
		expect(pushPayloadFor('reply', { link: '/agent/x' }).url).toBe('/agent/x');
		expect(pushPayloadFor('reply', { link: 'javascript:alert(1)' }).url).toBe('/dashboard/');
		expect(pushPayloadFor('reply', { link: '//evil.com' }).url).toBe('/dashboard/');
		expect(pushPayloadFor('reply', { link: 'https://solscan.io/tx/abc' }).url).toBe('https://solscan.io/tx/abc');
	});

	it('falls back to a generic payload for unknown types', () => {
		const p = pushPayloadFor('mystery_event', {});
		expect(p.title).toBe('three.ws');
		expect(p.body).toBe('mystery event');
		expect(p.url).toBe('/dashboard/');
	});
});
