// `get_preferences` — read the agent's notification delivery preferences. Read-only.
//
// Wraps GET /api/notifications/preferences →
//   { categories[], channels[], prefs: { categories, telegram_chat_id }, push }.
// The resolved matrix is what set_preferences edits: for each user-facing
// category, which channels (in_app / push / email / telegram) deliver it.

import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'get_preferences',
	title: 'Get notification preferences',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		"Read the account's notification delivery preferences — the resolved channel matrix the platform " +
		'uses to decide how each kind of event reaches the owner. Returns `categories` (the catalog of ' +
		'user-facing groups: sales, purchases, social, irl, alerts, creations, account, each with a label, a ' +
		'description, and any `lockedChannels` that cannot be switched off), `channels` (the deliverable ' +
		'channels: in_app, push, email, telegram), `prefs` (the ' +
		'effective per-category → per-channel on/off matrix with sparse user overrides already merged onto ' +
		'defaults, plus the linked `telegram_chat_id` if any), and `push` (how many web-push devices are ' +
		'registered). Read this before calling set_preferences so you patch from the real current state. ' +
		'Read-only.',
	inputSchema: {},
	async handler() {
		const data = await apiRequest('/api/notifications/preferences');
		return {
			ok: true,
			categories: Array.isArray(data?.categories) ? data.categories : [],
			channels: Array.isArray(data?.channels) ? data.channels : [],
			prefs: data?.prefs ?? { categories: {}, telegram_chat_id: null },
			push: data?.push ?? { subscribed_devices: 0 },
		};
	},
};
