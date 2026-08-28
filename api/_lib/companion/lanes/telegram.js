// Telegram lane: the user brings their own bot.
//
// Why a bot the user owns rather than an account link: Telegram gives no read
// access to a human account's chats, and no OAuth for one. A bot the user
// creates with @BotFather, then adds to the chats or groups they want relayed,
// is the real supported path, costs nothing, and leaves the user in control (a
// revoked token ends the connection instantly, with nothing to clean up here).
//
// getUpdates is a queue: every update is delivered once, and passing
// `offset = last_update_id + 1` acknowledges everything before it. That offset
// is the cursor stored on the source row, so a redeploy mid-poll re-reads at
// most one batch and the dedupe index in companion_events absorbs it.

const API = 'https://api.telegram.org';

async function callBot(token, method, params = {}) {
	const res = await fetch(`${API}/bot${token}/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(params),
		signal: AbortSignal.timeout(20_000),
	});
	const data = await res.json().catch(() => null);
	if (!res.ok || !data?.ok) {
		const detail = data?.description || `HTTP ${res.status}`;
		throw new Error(`telegram: ${detail}`);
	}
	return data.result;
}

// Used by the "test connection" button, and on save, so a typo in the token is
// reported while the user is still looking at the form.
export async function verifyTelegram(config) {
	const me = await callBot(config.bot_token, 'getMe');
	return {
		bot_username: me.username || null,
		bot_name: me.first_name || null,
		detail: me.username
			? `Connected as @${me.username}. Message that bot, or add it to a group, and anything it can see reaches your companion.`
			: 'Connected.',
	};
}

function senderOf(message) {
	const from = message.from || {};
	const chat = message.chat || {};
	const name = [from.first_name, from.last_name].filter(Boolean).join(' ')
		|| chat.title
		|| from.username
		|| 'Telegram';
	// Most specific identity first: the contact matcher takes the first hit.
	const ids = [from.username ? `@${from.username}` : null, from.id ? String(from.id) : null, chat.title || null]
		.filter(Boolean);
	return { name, ids };
}

function textOf(message) {
	if (message.text) return message.text;
	if (message.caption) return message.caption;
	if (message.photo) return 'sent a photo';
	if (message.voice) return 'sent a voice message';
	if (message.video || message.video_note) return 'sent a video';
	if (message.document) return `sent a file: ${message.document.file_name || 'attachment'}`;
	if (message.location) return 'shared a location';
	if (message.contact) return 'shared a contact';
	if (message.sticker) return `sent a sticker ${message.sticker.emoji || ''}`.trim();
	return '';
}

/**
 * Send an answer back into the conversation the message came from.
 *
 * @param {object} config  the source's stored config (bot token)
 * @param {object} replyTo the event's stored reply_to
 * @param {string} text    what the person typed
 */
export async function replyTelegram(config, replyTo, text) {
	if (!replyTo?.chat_id) throw new Error('this message has nothing to reply to');
	const sent = await callBot(config.bot_token, 'sendMessage', {
		chat_id: replyTo.chat_id,
		text,
		...(replyTo.message_id ? { reply_parameters: { message_id: replyTo.message_id, allow_sending_without_reply: true } } : {}),
	});
	return { message_id: sent.message_id, chat: replyTo.chat_title || null };
}

/**
 * @returns {{ items: Array, cursor: object }}
 */
export async function pollTelegram({ config, cursor = {} }) {
	const offset = Number(cursor.offset) || 0;
	const updates = await callBot(config.bot_token, 'getUpdates', {
		...(offset ? { offset } : {}),
		limit: 40,
		timeout: 0,
		allowed_updates: ['message', 'channel_post'],
	});

	const items = [];
	let highest = offset ? offset - 1 : 0;
	for (const update of updates) {
		highest = Math.max(highest, update.update_id);
		const message = update.message || update.channel_post;
		if (!message) continue;
		const body = textOf(message);
		if (!body) continue;
		const { name, ids } = senderOf(message);
		const firstLine = body.split('\n')[0].slice(0, 120);
		items.push({
			external_id: `tg:${update.update_id}`,
			sender: name,
			sender_id: ids[0] || null,
			identity_candidates: ids,
			title: firstLine || `Message from ${name}`,
			body,
			url: message.chat?.username ? `https://t.me/${message.chat.username}` : null,
			occurs_at: message.date ? new Date(message.date * 1000).toISOString() : null,
			// Everything a reply needs to land in the same conversation, quoting
			// the message it answers. Telegram is the one lane here that can
			// carry an answer back without a second credential.
			reply_to: message.chat?.id
				? { chat_id: message.chat.id, message_id: message.message_id, chat_title: message.chat.title || name }
				: null,
		});
	}

	return { items, cursor: { offset: highest ? highest + 1 : offset } };
}
