// Unified notification preference center.
//
//   GET /api/notifications/preferences
//     → { categories: [...], channels: [...], type_categories: {...},
//         prefs: {...}, push: {...} }
//        the full resolved matrix + metadata the UI renders from.
//   PUT /api/notifications/preferences   { categories: {...}, telegram_chat_id }
//     → merge a sanitised sparse override onto what is already stored; unknown
//       keys are dropped. A PUT carries only what the caller is changing, so
//       omitting a key preserves it. Send telegram_chat_id: null (or '') to
//       clear it deliberately.
//
// Defaults live in api/_lib/notify-prefs.js, so a user who has never saved gets
// a sensible matrix and new categories appear automatically.

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getRequestUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import {
	CATEGORIES,
	CHANNELS,
	readStoredPrefs,
	resolvePrefs,
	sanitizePrefs,
	typeCategoryMap,
} from '../_lib/notify-prefs.js';

const putBody = z.object({
	categories: z.record(z.record(z.boolean())).optional(),
	// Numeric Telegram chat id, or '' / null to disconnect. Rejecting a
	// malformed one here is what makes the difference visible: the sanitiser
	// silently drops it, which would read to the caller as a successful save.
	telegram_chat_id: z
		.string()
		.max(24)
		.regex(/^(-?\d{1,20})?$/, 'telegram_chat_id must be a numeric Telegram chat ID')
		.nullable()
		.optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT'])) return;

	const user = await getRequestUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const prefs = await resolvePrefs(user.id);
		const [pushRow] = await sql`
			select count(*)::int as count from push_subscriptions where user_id = ${user.id}
		`;
		return json(res, 200, {
			categories: CATEGORIES,
			channels: CHANNELS,
			// The avatar channel is delivered client-side (src/notification-herald.js),
			// so the browser needs the same type to category mapping the server
			// gates push and email with. Shipping it here keeps one source of truth.
			type_categories: typeCategoryMap(),
			prefs,
			push: { subscribed_devices: pushRow?.count ?? 0 },
		});
	}

	if (!(await requireCsrf(req, res, user.id))) return;
	const rl = await limits.notifPrefsWrite(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(putBody, await readJson(req));
	const next = mergeStored(await readStoredPrefs(user.id), sanitizePrefs(body), body);

	await sql`
		insert into notification_preferences (user_id, prefs, updated_at)
		values (${user.id}, ${JSON.stringify(next)}::jsonb, now())
		on conflict (user_id) do update set
			prefs = ${JSON.stringify(next)}::jsonb,
			updated_at = now()
	`;

	return json(res, 200, { ok: true, prefs: await resolvePrefs(user.id) });
});

// The stored row is the whole preference state, so writing the request body over
// it drops everything the caller did not resend. The settings panel saves the
// category matrix alone, which used to wipe a connected Telegram chat id on
// every save and silently stop those alerts. Merge instead: each category the
// caller sent overlays the stored one, and a key nobody sent survives untouched.
function mergeStored(stored, clean, body) {
	const categories = { ...(stored?.categories || {}) };
	for (const [category, channels] of Object.entries(clean.categories)) {
		categories[category] = { ...(categories[category] || {}), ...channels };
	}
	const telegram =
		body.telegram_chat_id === undefined
			? stored?.telegram_chat_id ?? null
			: clean.telegram_chat_id ?? null;
	return { categories, telegram_chat_id: telegram };
}
