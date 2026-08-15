// `set_preferences` — update notification delivery preferences. Write, idempotent.
//
// Wraps PUT /api/notifications/preferences { categories, telegram_chat_id } →
//   { ok, prefs }. The body is a sparse override sanitised server-side: only
// known categories (sales, purchases, social, irl, alerts, creations, account) and channels
// (in_app, push, email, telegram) survive; everything else is dropped. Re-sending
// the same matrix is a no-op — idempotent.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

// Kept in step with CATEGORIES in api/_lib/notify-prefs.js, the server-side
// source of truth. A key missing here is a category the model is told does not
// exist and therefore never patches, even though the API would accept it.
const CATEGORY_KEYS = ['sales', 'purchases', 'social', 'irl', 'alerts', 'creations', 'account'];
const CHANNEL_KEYS = ['in_app', 'push', 'email', 'telegram'];

export const def = {
	name: 'set_preferences',
	title: 'Set notification preferences',
	annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
	description:
		"Update the account's notification delivery preferences with a sparse patch. `categories` maps a " +
		`category key (${CATEGORY_KEYS.join(', ')}) to a channel map turning each channel on/off ` +
		`(${CHANNEL_KEYS.join(', ')}) — e.g. { "alerts": { "push": false }, "social": { "email": true } }. ` +
		'Only the category/channel pairs you pass change; unknown keys are dropped server-side and untouched ' +
		'pairs keep their current value (which falls back to the platform default). Pass `telegram_chat_id` ' +
		'(a numeric Telegram chat id, or "" to unlink) to control where the telegram channel delivers. ' +
		'Provide at least one of `categories` or `telegram_chat_id`. `account` locks its `in_app` channel on: ' +
		'security and withdrawal notices always reach the bell inbox, so `false` there is ignored. ' +
		'WRITE but idempotent, re-applying the ' +
		'same values is a no-op. Returns the full resolved preference matrix after the update. Read it first ' +
		'with get_preferences.',
	inputSchema: {
		categories: z
			.record(z.string(), z.record(z.string(), z.boolean()))
			.optional()
			.describe(
				`Per-category channel toggles. Outer keys: ${CATEGORY_KEYS.join(', ')}. Inner keys: ` +
					`${CHANNEL_KEYS.join(', ')} → boolean. Unrecognised keys are ignored. Example: ` +
					'{ "alerts": { "push": true, "telegram": false } }.',
			),
		telegram_chat_id: z
			.string()
			.max(24)
			.optional()
			.describe('Numeric Telegram chat id to deliver the telegram channel to, or "" to unlink it.'),
	},
	async handler(args) {
		const body = {};
		const hasCategories = args?.categories && typeof args.categories === 'object';
		if (hasCategories) body.categories = args.categories;
		const hasTelegram = typeof args?.telegram_chat_id === 'string';
		if (hasTelegram) body.telegram_chat_id = args.telegram_chat_id;

		if (!hasCategories && !hasTelegram) {
			throw Object.assign(
				new Error('Provide `categories` (a per-category channel map) and/or `telegram_chat_id`.'),
				{ code: 'validation_error', status: 400 },
			);
		}

		const data = await apiRequest('/api/notifications/preferences', { method: 'PUT', body });
		return { ok: true, prefs: data?.prefs ?? null };
	},
};
