// The Telegram lane (api/_lib/companion/lanes/telegram.js): what it reads out of
// an update, how it advances its cursor, and how a reply is routed back.
//
// The Bot API is stubbed at the fetch boundary, so these are real assertions
// about the request we send and the shape we hand the triage pass, without
// talking to Telegram.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { pollTelegram, replyTelegram, verifyTelegram } from '../api/_lib/companion/lanes/telegram.js';

function stubBot(handler) {
	const calls = [];
	vi.stubGlobal('fetch', async (url, init) => {
		const method = String(url).split('/').pop();
		const body = init?.body ? JSON.parse(init.body) : {};
		calls.push({ method, body });
		const result = handler(method, body);
		return {
			ok: result.ok !== false,
			status: result.status || 200,
			json: async () => (result.ok === false
				? { ok: false, description: result.description }
				: { ok: true, result: result.result }),
		};
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

const message = (over = {}) => ({
	message_id: 501,
	date: 1787040000,
	from: { id: 42, first_name: 'Sarah', last_name: 'K', username: 'sarah_k' },
	chat: { id: -1001, title: 'Home' },
	text: 'I am downstairs and cannot find your door',
	...over,
});

describe('pollTelegram', () => {
	it('turns an update into a lane item with every identity the matcher can use', async () => {
		stubBot(() => ({ result: [{ update_id: 900, message: message() }] }));
		const { items, cursor } = await pollTelegram({ config: { bot_token: 't' }, cursor: {} });

		expect(items).toHaveLength(1);
		const [item] = items;
		expect(item.external_id).toBe('tg:900');
		expect(item.sender).toBe('Sarah K');
		expect(item.sender_id).toBe('@sarah_k');
		expect(item.identity_candidates).toEqual(['@sarah_k', '42', 'Home']);
		expect(item.title).toBe('I am downstairs and cannot find your door');
		expect(item.occurs_at).toBe(new Date(1787040000 * 1000).toISOString());
		// Everything a reply needs, captured while the message is in hand.
		expect(item.reply_to).toEqual({ chat_id: -1001, message_id: 501, chat_title: 'Home' });
		// The cursor acknowledges the batch: the next poll starts past it.
		expect(cursor.offset).toBe(901);
	});

	it('describes a message that carries no text so it is still worth hearing', async () => {
		stubBot(() => ({
			result: [
				{ update_id: 1, message: message({ text: undefined, voice: { duration: 3 } }) },
				{ update_id: 2, message: message({ text: undefined, document: { file_name: 'lease.pdf' } }) },
				{ update_id: 3, message: message({ text: undefined, location: { latitude: 1, longitude: 2 } }) },
			],
		}));
		const { items } = await pollTelegram({ config: { bot_token: 't' }, cursor: {} });
		expect(items.map((i) => i.body)).toEqual([
			'sent a voice message',
			'sent a file: lease.pdf',
			'shared a location',
		]);
	});

	it('sends the stored offset and holds it when a poll comes back empty', async () => {
		const calls = stubBot(() => ({ result: [] }));
		const { items, cursor } = await pollTelegram({ config: { bot_token: 't' }, cursor: { offset: 77 } });
		expect(items).toEqual([]);
		expect(calls[0].body.offset).toBe(77);
		expect(cursor.offset).toBe(77);
	});

	it('surfaces the provider\'s own words when the token is wrong', async () => {
		stubBot(() => ({ ok: false, status: 401, description: 'Unauthorized' }));
		await expect(verifyTelegram({ bot_token: 'bad' })).rejects.toThrow(/telegram: Unauthorized/);
	});
});

describe('replyTelegram', () => {
	it('answers in the same chat, quoting the message it replies to', async () => {
		const calls = stubBot(() => ({ result: { message_id: 777 } }));
		const sent = await replyTelegram(
			{ bot_token: 't' },
			{ chat_id: -1001, message_id: 501, chat_title: 'Home' },
			'on my way down',
		);
		expect(calls[0].method).toBe('sendMessage');
		expect(calls[0].body).toEqual({
			chat_id: -1001,
			text: 'on my way down',
			reply_parameters: { message_id: 501, allow_sending_without_reply: true },
		});
		expect(sent).toEqual({ message_id: 777, chat: 'Home' });
	});

	it('still sends when the original message id is gone', async () => {
		const calls = stubBot(() => ({ result: { message_id: 778 } }));
		await replyTelegram({ bot_token: 't' }, { chat_id: 5 }, 'hello');
		expect(calls[0].body.reply_parameters).toBeUndefined();
		expect(calls[0].body.chat_id).toBe(5);
	});

	it('refuses a message that carries no route back', async () => {
		await expect(replyTelegram({ bot_token: 't' }, null, 'hi')).rejects.toThrow(/nothing to reply to/);
	});
});
