// Unit tests for the notification WRITE path in api/_lib/notify.js.
//
// The preference center (api/_lib/notify-prefs.js) has always stored and
// rendered a per-category `in_app` toggle, but the bell row used to be inserted
// unconditionally, so muting a category did nothing: the notification still
// landed in the inbox and still counted toward unread. These tests pin the fix
// from the user-value campaign, work order 04 task 6 ("store it, respect it in
// the write path"): the `user_notifications` insert is gated on
// channelEnabled(prefs, type, 'in_app'), independently of every other channel.
//
// Mocks: sql (the only DB touch, in both notify.js and notify-prefs.js) and
// web-push's sendPushToUser. notify-prefs itself is exercised for real so the
// stored-prefs → defaults overlay is part of what's under test. All offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls = [];
const prefsState = { stored: null }; // null = user has never saved preferences

vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...values) => {
			const text = strings.join(' ? ');
			sqlCalls.push({ text, values });
			if (/from notification_preferences/.test(text)) {
				return Promise.resolve(prefsState.stored ? [{ prefs: prefsState.stored }] : []);
			}
			if (/insert into user_notifications/.test(text)) {
				return Promise.resolve([{ id: 'notif-1' }]);
			}
			return Promise.resolve([]);
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const sendPushToUser = vi.fn(async () => 1);
vi.mock('../../api/_lib/web-push.js', () => ({
	sendPushToUser: (...a) => sendPushToUser(...a),
	pushConfigured: () => true,
	vapidPublicKey: () => 'test-key',
}));

const { insertNotification, emailAllowedForType } = await import('../../api/_lib/notify.js');

const USER = '00000000-0000-0000-0000-0000000000aa';

const inboxInserts = () => sqlCalls.filter((c) => /insert into user_notifications/.test(c.text));
const funnelEvents = () => sqlCalls
	.filter((c) => /insert into notification_events/.test(c.text))
	.map((c) => ({ channel: c.values[2], event: c.values[3] }));

beforeEach(() => {
	sqlCalls.length = 0;
	prefsState.stored = null;
	sendPushToUser.mockClear().mockResolvedValue(1);
});

describe('insertNotification: default preferences', () => {
	it('inserts the bell row, records the in_app send, and fans out to push', async () => {
		const out = await insertNotification(USER, 'remix', { actor: 'alice' });

		expect(out.id).toBe('notif-1');
		expect(out.in_app).toBe(true);
		expect(inboxInserts()).toHaveLength(1);
		expect(funnelEvents()).toEqual([
			{ channel: 'in_app', event: 'sent' },
			{ channel: 'push', event: 'sent' },
		]);
		expect(sendPushToUser).toHaveBeenCalledTimes(1);
		expect(sendPushToUser.mock.calls[0][1]).toMatchObject({ category: 'social', notificationId: 'notif-1' });
	});

	it('stores the payload as jsonb against the recipient and type', async () => {
		await insertNotification(USER, 'skill_purchased', { skill: 'Voice Pack' });
		const [insert] = inboxInserts();
		expect(insert.values[0]).toBe(USER);
		expect(insert.values[1]).toBe('skill_purchased');
		expect(JSON.parse(insert.values[2])).toEqual({ skill: 'Voice Pack' });
	});
});

describe('insertNotification: a muted in_app category', () => {
	it('writes no bell row at all, so the inbox and unread count stay silent', async () => {
		prefsState.stored = { categories: { social: { in_app: false } } };

		const out = await insertNotification(USER, 'remix', { actor: 'alice' });

		expect(out.id).toBeNull();
		expect(out.in_app).toBe(false);
		expect(inboxInserts()).toHaveLength(0);
		// No in_app funnel row either, because nothing was delivered on that channel.
		expect(funnelEvents().some((e) => e.channel === 'in_app')).toBe(false);
	});

	it('still fans out on the channels the user left enabled', async () => {
		prefsState.stored = { categories: { social: { in_app: false } } };

		await insertNotification(USER, 'remix', { actor: 'alice' });

		expect(sendPushToUser).toHaveBeenCalledTimes(1);
		// The push carries a null notification id: there is no inbox row to
		// attribute an open back to, which the service worker already tolerates.
		expect(sendPushToUser.mock.calls[0][1]).toMatchObject({ category: 'social', notificationId: null });
		expect(funnelEvents()).toEqual([{ channel: 'push', event: 'sent' }]);
	});

	it('mutes only the category it was set on', async () => {
		prefsState.stored = { categories: { social: { in_app: false } } };

		const muted = await insertNotification(USER, 'remix', {});
		const other = await insertNotification(USER, 'skill_purchased', {});

		expect(muted.id).toBeNull();
		expect(other.id).toBe('notif-1');
		expect(inboxInserts()).toHaveLength(1);
		expect(inboxInserts()[0].values[1]).toBe('skill_purchased');
	});

	it('delivers nothing when every channel for the category is off', async () => {
		prefsState.stored = { categories: { social: { in_app: false, push: false, email: false, telegram: false } } };

		const out = await insertNotification(USER, 'dm_received', { actor: 'bob' });

		expect(out).toEqual({ id: null, in_app: false });
		expect(inboxInserts()).toHaveLength(0);
		expect(sendPushToUser).not.toHaveBeenCalled();
		expect(funnelEvents()).toEqual([]);
	});

	it('keeps the bell row for Account & security even when in_app is muted', async () => {
		// 'account' is a locked in_app category (notify-prefs lockedChannelsFor):
		// the bell is the durable record of what happened to the account, so
		// muting it quiets push, email and telegram only. Without this, a user
		// could hide their own security_alert and wallet_anomaly_frozen rows.
		prefsState.stored = {
			categories: { account: { in_app: false, push: false, email: false, telegram: false } },
		};

		const out = await insertNotification(USER, 'security_alert', {});

		expect(out.in_app).toBe(true);
		expect(inboxInserts()).toHaveLength(1);
		expect(sendPushToUser).not.toHaveBeenCalled(); // the mutable channels still obey
	});

	it('routes unmapped types through the account fallback, so they are never silently hidden', async () => {
		prefsState.stored = { categories: { account: { in_app: false } } };

		const out = await insertNotification(USER, 'some_brand_new_type', {});

		expect(out.in_app).toBe(true);
		expect(inboxInserts()).toHaveLength(1);
	});
});

describe('insertNotification: failure handling', () => {
	it('never throws when the inbox insert fails, and reports no id', async () => {
		const { sql } = await import('../../api/_lib/db.js');
		sql.mockImplementationOnce((strings, ...values) => {
			sqlCalls.push({ text: strings.join(' ? '), values });
			return Promise.resolve([]); // prefs lookup: no stored row
		}).mockImplementationOnce((strings, ...values) => {
			sqlCalls.push({ text: strings.join(' ? '), values });
			return Promise.reject(new Error('deadlock detected'));
		});

		const out = await insertNotification(USER, 'remix', {});
		expect(out).toEqual({ id: null, in_app: false });
		// A failed insert must not be reported as a delivered push either.
		expect(sendPushToUser).not.toHaveBeenCalled();
	});

	it('delivers on default channels when the preference lookup itself fails', async () => {
		const { sql } = await import('../../api/_lib/db.js');
		sql.mockImplementationOnce(() => Promise.reject(new Error('connection terminated')));

		const out = await insertNotification(USER, 'remix', {});
		expect(out.in_app).toBe(true);
		expect(inboxInserts()).toHaveLength(1);
	});
});

describe('emailAllowedForType', () => {
	it('honours an explicit email opt-out for the category of the type', async () => {
		prefsState.stored = { categories: { sales: { email: false } } };
		expect(await emailAllowedForType(USER, 'skill_purchased')).toBe(false);
	});

	it('falls back to the category default when nothing is stored', async () => {
		expect(await emailAllowedForType(USER, 'skill_purchased')).toBe(true);
		expect(await emailAllowedForType(USER, 'remix')).toBe(false);
	});
});
