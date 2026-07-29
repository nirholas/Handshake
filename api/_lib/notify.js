/**
 * In-app notification insert + multi-channel fan-out.
 *
 * insertNotification() is the single choke point every notification flows
 * through (sales, purchases, IRL, pump alerts, withdrawals…). It:
 *   1. resolves the recipient's preference matrix,
 *   2. inserts the durable in-app row (the bell inbox) when the category's
 *      `in_app` channel is on,
 *   3. records a `sent` funnel event for in_app,
 *   4. fans out to Web Push for the categories the user left enabled,
 *   5. records a `sent` event per push delivery.
 *
 * Every channel is gated by the user's preference center (api/_lib/notify-prefs)
 * so there is no notification a user can't turn off, including the bell itself:
 * a category with `in_app: false` writes no `user_notifications` row at all, so
 * the inbox and the unread count both stay silent for it while any other channel
 * the user left on (push/email/telegram) still fires. Failures are logged, never
 * thrown — callers must not depend on this for correctness and need not await.
 *
 * @param {string} userId
 * @param {string} type      e.g. 'skill_purchased' (see notify-prefs TYPE_CATEGORY)
 * @param {object} payload
 * @returns {Promise<{ id: string|null, in_app?: boolean }>}
 */
import { sql } from './db.js';
import { resolvePrefs, channelEnabled, pushPayloadFor, categoryForType } from './notify-prefs.js';
import { sendPushToUser } from './web-push.js';

// Categories whose in-app row is written no matter what the user muted. The
// bell is the durable record of what happened to an account, not an
// interruption: muting should quiet push, email and telegram, never erase the
// user's own audit trail. 'account' is "Account & security" and carries
// security_alert, wallet_anomaly_frozen, withdrawal_failed and the payment
// mismatches, and it is also the fallback for any type not yet in
// TYPE_CATEGORY, so honoring a mute here would silently hide future
// security-relevant events too. The interruptive channels stay fully mutable.
const IN_APP_ALWAYS = new Set(['account']);

export function insertNotification(userId, type, payload = {}) {
	return deliver(userId, type, payload).catch((err) => {
		console.error('[notify] delivery failed:', err.message);
		return { id: null };
	});
}

async function deliver(userId, type, payload) {
	// 1: the preference matrix gates every channel, the bell included.
	// resolvePrefs already falls back to defaults on a DB error, so a lookup
	// problem degrades to "deliver on the default channels", never to silence.
	const prefs = await resolvePrefs(userId);
	const wantsInApp =
		IN_APP_ALWAYS.has(categoryForType(type)) || channelEnabled(prefs, type, 'in_app');

	// 2: durable in-app row, only when the user left the bell on for this
	// category. Muting in_app must leave no row behind: the inbox list and the
	// unread count are both derived from user_notifications, so skipping the
	// insert is what keeps the two consistent.
	let id = null;
	if (wantsInApp) {
		try {
			const [row] = await sql`
				insert into user_notifications (user_id, type, payload)
				values (${userId}, ${type}, ${JSON.stringify(payload)}::jsonb)
				returning id
			`;
			id = row?.id ?? null;
		} catch (err) {
			console.error('[notify] insert failed:', err.message);
			return { id: null, in_app: false };
		}

		// 3: record the in-app send.
		recordEvent(id, userId, 'in_app', 'sent');
	}

	// 4 + 5: push fan-out, gated the same way. A muted bell never suppresses
	// push: the notification id is simply null on the payload, which the service
	// worker already tolerates (it only attributes funnel events when present).
	try {
		if (channelEnabled(prefs, type, 'push')) {
			const delivered = await sendPushToUser(userId, pushPayloadFor(type, payload, id));
			if (delivered > 0) recordEvent(id, userId, 'push', 'sent', { count: delivered });
		}
	} catch (err) {
		console.error('[notify] push fan-out failed:', err.message);
	}

	return { id, in_app: wantsInApp };
}

/**
 * Fire-and-forget funnel event. Sent rows are unconstrained (a notification can
 * be sent on several channels); opened/returned are deduped by a partial unique
 * index, so a double notificationclick is idempotent.
 */
export function recordEvent(notificationId, userId, channel, event, meta = {}) {
	if (!userId || !channel || !event) return;
	sql`
		insert into notification_events (notification_id, user_id, channel, event, meta)
		values (${notificationId}, ${userId}, ${channel}, ${event}, ${JSON.stringify(meta)}::jsonb)
		on conflict do nothing
	`.catch((err) => console.error('[notify] event insert failed:', err.message));
}

/**
 * Whether a transactional email for `type` should be sent, per the user's
 * preferences. Used by the few endpoints that send category email directly
 * (receipts, sale alerts) so email honours the same off switch as push.
 * Fails open (returns true) on a lookup error — better a wanted receipt than a
 * dropped one.
 */
export async function emailAllowedForType(userId, type) {
	try {
		const prefs = await resolvePrefs(userId);
		return channelEnabled(prefs, type, 'email');
	} catch {
		return true;
	}
}

export { categoryForType };
