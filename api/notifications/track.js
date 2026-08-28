// POST /api/notifications/track: record a re-engagement funnel event.
//
//   { notification_id, channel: 'push'|'in_app'|'avatar', event: 'opened'|'returned' }
//
// Closes the sent→opened→returned loop:
//   • the service worker fires `opened` when a push notification is clicked,
//   • the corner companion fires `opened` when a visitor clicks through from a
//     notification it announced out loud (channel 'avatar'),
//   • the app fires `returned` when it boots from a push-sourced open
//     (?source=push), proving the notification actually pulled the user back.
//
// Only `sent` is written server-side (by api/_lib/notify.js); the open/return
// signals can only come from the client, so this endpoint owns them. It's an
// idempotent analytics beacon (deduped by a partial unique index), so it auths
// on the session but is CSRF-exempt: there is no state a forged call could
// corrupt, only a funnel row for the caller's own notification.

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';

const body = z.object({
	notification_id: z.string().uuid().optional(),
	channel: z.enum(['push', 'in_app', 'avatar']),
	event: z.enum(['opened', 'returned']),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.notifTrack(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const { notification_id, channel, event } = parse(body, await readJson(req));

	// If a notification id is given, confirm it belongs to the caller so the
	// funnel can't be poisoned with another user's notifications.
	if (notification_id) {
		const [row] = await sql`
			select 1 from user_notifications
			where id = ${notification_id} and user_id = ${user.id}
		`;
		if (!row) return error(res, 404, 'not_found', 'notification not found');
	}

	await sql`
		insert into notification_events (notification_id, user_id, channel, event)
		values (${notification_id ?? null}, ${user.id}, ${channel}, ${event})
		on conflict do nothing
	`;

	return json(res, 200, { ok: true });
});
