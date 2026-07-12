// Notification preference model — the single source of truth shared by the
// preference-center API, the push fan-out, and the email gating.
//
// A notification has a `type` (e.g. 'skill_purchased'). Types roll up into a
// small set of user-facing CATEGORIES. The user controls, per category, which
// CHANNELS deliver it. Channels: in_app (the bell inbox), push (Web Push),
// email (Resend transactional), telegram (per-account bot alerts).
//
// Preferences are stored sparsely in notification_preferences.prefs as
//   { categories: { sales: { push: false }, ... }, telegram_chat_id: '123' }
// Any key a user hasn't touched falls back to DEFAULTS below — so new
// categories light up without a backfill, and a user with no row at all gets
// sensible behaviour.

import { sql } from './db.js';

/** Ordered for display in the preference center. */
export const CATEGORIES = [
	{
		key: 'sales',
		label: 'Sales & earnings',
		description: 'Your launch filled, a skill or asset sold, a tip or payout arrived.',
	},
	{
		key: 'purchases',
		label: 'Your purchases',
		description: 'Receipts and confirmations for things you bought or were gifted.',
	},
	{
		key: 'social',
		label: 'Social & mentions',
		description: 'Your agent was embedded, forked, remixed, or replied to.',
	},
	{
		key: 'irl',
		label: 'In person (IRL)',
		description: 'Someone met, messaged, or paid your agent in the real world.',
	},
	{
		key: 'alerts',
		label: 'Market alerts',
		description: 'Pump.fun rules and token signals you configured.',
	},
	{
		key: 'account',
		label: 'Account & security',
		description: 'Withdrawals, payment issues, and security-sensitive events.',
	},
];

export const CHANNELS = ['in_app', 'push', 'email', 'telegram'];

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

// notification `type` → category. Unmapped types fall back to 'account' so a
// new notification type is never silently undeliverable.
const TYPE_CATEGORY = {
	skill_purchased: 'sales',
	asset_purchased: 'sales',
	sale: 'sales',
	'payment-earned': 'sales',
	payment_received: 'sales',
	referral_earned: 'sales',
	referral_signup: 'sales',
	referral_reward: 'sales',
	pump_launch_filled: 'sales',

	skill_purchase_confirmed: 'purchases',
	asset_purchase_confirmed: 'purchases',
	skill_gift_received: 'purchases',
	skill_gift_sent: 'purchases',

	remix: 'social',
	reply: 'social',
	embed: 'social',
	mention: 'social',
	fork: 'social',
	follow: 'social',
	dm_received: 'social',
	agent_review: 'social',

	irl_interaction: 'irl',
	irl_reply: 'irl',

	pump_alert: 'alerts',

	withdrawal_completed: 'account',
	withdrawal_failed: 'account',
	payment_mismatch: 'account',
	asset_payment_mismatch: 'account',
	skill_payment_mismatch: 'account',
	security_alert: 'account',
	wallet_anomaly_frozen: 'account',
};

export function categoryForType(type) {
	return TYPE_CATEGORY[type] || 'account';
}

// Default channel matrix. in_app is on everywhere (the bell is the baseline).
// push is on by default *for users who have subscribed a device* — a user with
// no push subscription simply never receives one, so defaulting it on is not
// spammy. email defaults on only for money + security; off for the higher-
// frequency social/irl/alerts categories. telegram is always opt-in (needs a
// linked chat id) so it defaults off.
const DEFAULTS = {
	sales:     { in_app: true,  push: true,  email: true,  telegram: false },
	purchases: { in_app: true,  push: true,  email: true,  telegram: false },
	social:    { in_app: true,  push: true,  email: false, telegram: false },
	irl:       { in_app: true,  push: true,  email: false, telegram: false },
	alerts:    { in_app: true,  push: true,  email: false, telegram: true  },
	account:   { in_app: true,  push: true,  email: true,  telegram: false },
};

/** The full default matrix, used to seed the preference-center UI. */
export function defaultMatrix() {
	return JSON.parse(JSON.stringify(DEFAULTS));
}

/**
 * Resolve the effective channel matrix for a user by overlaying their stored
 * sparse prefs onto DEFAULTS. Returns { categories, telegram_chat_id }.
 */
export async function resolvePrefs(userId) {
	let stored = {};
	try {
		const [row] = await sql`
			select prefs from notification_preferences where user_id = ${userId}
		`;
		stored = row?.prefs && typeof row.prefs === 'object' ? row.prefs : {};
	} catch (err) {
		// A missing table or transient DB error must never block delivery — fall
		// back to defaults (in_app + push on) rather than dropping the notice.
		console.error('[notify-prefs] resolve failed:', err.message);
	}
	return mergeWithDefaults(stored);
}

export function mergeWithDefaults(stored) {
	const out = { categories: {}, telegram_chat_id: stored?.telegram_chat_id || null };
	const storedCats = (stored && stored.categories) || {};
	for (const { key } of CATEGORIES) {
		out.categories[key] = { ...DEFAULTS[key], ...(storedCats[key] || {}) };
	}
	return out;
}

/** Is `channel` enabled for the category that `type` belongs to? */
export function channelEnabled(prefs, type, channel) {
	const cat = categoryForType(type);
	const row = prefs?.categories?.[cat];
	if (!row) return DEFAULTS[cat]?.[channel] ?? false;
	// An explicit stored boolean (including `false`) wins; only fall back to the
	// default when the channel is unset (null/undefined). The previous form
	// short-circuited on `false` and wrongly returned the default — so a user who
	// turned a channel OFF still received it.
	return row[channel] != null ? !!row[channel] : (DEFAULTS[cat]?.[channel] ?? false);
}

/**
 * Sanitise an incoming preference body to the known category/channel shape.
 * Anything unrecognised is dropped, so the client can't smuggle arbitrary keys
 * into the JSONB. Returns the sparse object to store.
 */
export function sanitizePrefs(body) {
	const out = { categories: {} };
	const cats = body?.categories;
	if (cats && typeof cats === 'object') {
		for (const [cat, row] of Object.entries(cats)) {
			if (!CATEGORY_KEYS.has(cat) || !row || typeof row !== 'object') continue;
			const clean = {};
			for (const ch of CHANNELS) {
				if (typeof row[ch] === 'boolean') clean[ch] = row[ch];
			}
			if (Object.keys(clean).length) out.categories[cat] = clean;
		}
	}
	if (typeof body?.telegram_chat_id === 'string') {
		const t = body.telegram_chat_id.trim();
		if (/^-?\d{1,20}$/.test(t)) out.telegram_chat_id = t;
		else if (t === '') out.telegram_chat_id = null;
	}
	return out;
}

// ── Push payload shaping ─────────────────────────────────────────────────────
// Build the title/body/url shown in the OS notification from a stored
// notification row. Mirrors the labels in src/notifications.js so the push and
// the in-app inbox read identically. Only $THREE is ever referenced.

const PUSH_COPY = {
	skill_purchased:          (p) => ['You made a sale 💵', `Payment received for "${p.skill || 'a skill'}"`],
	skill_purchase_confirmed: (p) => ['Purchase confirmed ✅', `Your purchase of "${p.skill || 'a skill'}" is confirmed`],
	skill_gift_received:      (p) => ['You got a gift 🎁', p.from ? `${p.from} gifted you "${p.skill || 'a skill'}"` : `You received "${p.skill || 'a skill'}" as a gift`],
	skill_gift_sent:          (p) => ['Gift delivered 🎁', p.to ? `Your gift reached ${p.to}` : 'Your gift was delivered'],
	asset_purchased:          (p) => ['You made a sale 💵', `Someone purchased your ${p.item_type || 'asset'}`],
	asset_purchase_confirmed: ()  => ['Purchase confirmed ✅', 'Your asset purchase is confirmed'],
	referral_earned:          ()  => ['Referral earned 💰', 'You earned a referral commission'],
	'payment-earned':         (p) => ['Payment received 💸', p.actor ? `From ${p.actor}` : 'A payment landed in your account'],
	sale:                     ()  => ['You made a sale 🛒', 'Your agent made a sale'],
	pump_launch_filled:       (p) => ['Your launch filled 🚀', p.name ? `${p.name} hit its target` : 'Your launch reached its target'],
	embed:                    ()  => ['New embed 🔗', 'Your creation was embedded somewhere new'],
	remix:                    (p) => ['Remixed 🔄', p.royaltyPaid && p.royaltyUsd ? `Someone remixed your creation — you earned $${Number(p.royaltyUsd).toFixed(3)}` : 'Someone remixed your creation'],
	fork:                     ()  => ['Forked 🍴', 'Someone forked your agent'],
	reply:                    ()  => ['New reply 💬', 'New reply on your agent'],
	mention:                  ()  => ['You were mentioned 📣', 'Your agent was mentioned'],
	follow:                   (p) => ['New follower 👤', p.actor ? `${p.actor} started following you` : 'Someone started following you'],
	dm_received:              (p) => ['New message 💬', p.actor ? `${p.actor} sent you a message` : 'You have a new message'],
	agent_review:             (p) => ['New review ⭐', p.actor ? `${p.actor} reviewed your agent` : 'Your agent received a review'],
	irl_interaction:          (p) => ['Met in person 📍', p.message ? `“${p.message}”` : 'Someone interacted with your agent in person'],
	irl_reply:                (p) => ['Agent replied 💬', p.message ? `“${p.message}”` : 'An agent replied to your message'],
	pump_alert:               (p) => ['Market alert 📈', p.summary || 'A token alert you configured just fired'],
	withdrawal_completed:     ()  => ['Withdrawal complete ✅', 'Your withdrawal has been sent'],
	withdrawal_failed:        ()  => ['Withdrawal failed ⚠️', 'A withdrawal could not be completed — tap to review'],
	payment_mismatch:         ()  => ['Payment mismatch ⚠️', 'Check your agent payment settings'],
	asset_payment_mismatch:   ()  => ['Payment mismatch ⚠️', 'Check your agent payment settings'],
	skill_payment_mismatch:   ()  => ['Payment mismatch ⚠️', 'Check your agent payment settings'],
	security_alert:           (p) => ['Security alert 🔒', p.message || 'A security-sensitive change was made to your account'],
	wallet_anomaly_frozen:    (p) => ['Wallet auto-frozen 🛡️', p.summary || 'Your agent wallet was frozen after an unusual action — tap to approve or keep frozen'],
};

export function pushPayloadFor(type, payload, notificationId) {
	const p = payload || {};
	const fn = PUSH_COPY[type];
	const [title, body] = fn ? fn(p) : ['three.ws', String(type).replace(/_/g, ' ')];
	const url = pushUrlFor(p);
	return {
		title,
		body,
		url,
		tag: type,
		notificationId: notificationId || null,
		// Used by the SW to attribute the 'returned' funnel event.
		category: categoryForType(type),
	};
}

function pushUrlFor(p) {
	const raw = p.link
		|| (p.tx_signature ? `https://solscan.io/tx/${encodeURIComponent(p.tx_signature)}` : null)
		|| (p.agent_id ? `/agent/${encodeURIComponent(p.agent_id)}` : null)
		|| '/dashboard/';
	// Same allowlist as the inbox: same-origin path or absolute http(s).
	if (typeof raw !== 'string') return '/dashboard/';
	const s = raw.trim();
	if (s.startsWith('/') && !s.startsWith('//')) return s;
	if (/^https?:\/\//i.test(s)) return s;
	return '/dashboard/';
}
