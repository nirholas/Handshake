import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// /api/pump/deliver-telegram now requires an authenticated caller (committed in
// the "webhook hardening" pass — the bot speaks under the platform's verified
// identity and must never be driven anonymously). Mock auth so the delivery
// tests exercise the handler body; the 401 gate gets its own dedicated test.
const { getSessionUserMock } = vi.hoisted(() => ({
	getSessionUserMock: vi.fn(async () => ({ id: 'u-test' })),
}));
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: getSessionUserMock,
	authenticateBearer: async () => null,
	extractBearer: () => null,
	// The dispatcher gates cookie-authed mutations on a same-site Origin before
	// it ever reaches the action; a request without this never gets that far.
	isSameSiteOrigin: () => true,
}));

// The bot-delivery path is rate-limited per IP. Any bucket resolves to allowed
// here; the ceiling itself is not what these tests are about.
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: new Proxy({}, { get: () => vi.fn(async () => ({ success: true })) }),
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// ── helpers ────────────────────────────────────────────────────────────────
function makeReq(body) {
	const stream = body
		? Readable.from([Buffer.from(JSON.stringify(body))])
		: Readable.from([]);
	stream.method = 'POST';
	stream.url = '/api/pump/deliver-telegram';
	stream.headers = {
		host: 'localhost',
		origin: 'https://three.ws',
		'content-type': 'application/json',
	};
	// Populated by the filesystem router in production; the dispatcher switches on it.
	stream.query = { action: 'deliver-telegram' };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function callEndpoint(body) {
	// /api/pump/deliver-telegram -> /api/pump/[action]?action=deliver-telegram.
	// The dispatcher is the only thing the route table reaches, so it is the
	// only thing worth asserting against.
	const { default: handler } = await import('../api/pump/[action].js');
	const res = makeRes();
	await handler(makeReq(body), res);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

const SIGNAL = {
	kind: 'mint',
	mint: 'TokenMint123abc',
	summary: 'New token launched with 1 SOL',
	ts: 1700000000000,
};

beforeEach(() => {
	fetchMock.mockReset();
	delete process.env.TELEGRAM_BOT_TOKEN;
	// Default to an authenticated caller; individual tests can override.
	getSessionUserMock.mockResolvedValue({ id: 'u-test' });
});

// ── sendTelegramSignal ─────────────────────────────────────────────────────

describe('sendTelegramSignal', () => {
	it('posts to the correct URL with POST method and Markdown parse_mode', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ result: { message_id: 42 } }),
		});
		const { sendTelegramSignal } = await import('../src/pump/telegram-delivery.js');
		const result = await sendTelegramSignal({
			botToken: 'bot123',
			chatId: '-100456',
			signal: SIGNAL,
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.telegram.org/botbot123/sendMessage');
		expect(opts.method).toBe('POST');
		const sent = JSON.parse(opts.body);
		expect(sent.chat_id).toBe('-100456');
		expect(sent.parse_mode).toBe('Markdown');
		expect(typeof sent.text).toBe('string');
		expect(result).toEqual({ ok: true, messageId: 42 });
	});

	it('escapes Markdown control characters in attacker-supplied signal text', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ result: { message_id: 7 } }),
		});
		const { sendTelegramSignal } = await import('../src/pump/telegram-delivery.js');
		await sendTelegramSignal({
			botToken: 'bot123',
			chatId: '1',
			signal: {
				kind: 'mint',
				mint: 'Mint_1',
				// Token metadata is attacker-controlled. Unescaped, this renders as a
				// clickable link posted under the platform bot's verified identity.
				summary: '[claim your airdrop](https://evil.example) *urgent*',
				refs: ['`ref_one`'],
				ts: 1700000000000,
			},
		});

		const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(sent.text).toContain('\\[claim your airdrop\\]');
		expect(sent.text).toContain('\\*urgent\\*');
		expect(sent.text).toContain('Mint\\_1');
		expect(sent.text).toContain('\\`ref\\_one\\`');
		// The bot's own formatting survives: the kind label is still bold.
		expect(sent.text.startsWith('*New Mint*')).toBe(true);
	});

	it('throws on a non-2xx Telegram response', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: async () => 'Bad Request',
		});
		const { sendTelegramSignal } = await import('../src/pump/telegram-delivery.js');
		await expect(
			sendTelegramSignal({ botToken: 'bot123', chatId: '1', signal: SIGNAL }),
		).rejects.toThrow(/400/);
	});
});

// ── POST /api/pump/deliver-telegram ────────────────────────────────────────

describe('POST /api/pump/deliver-telegram', () => {
	it('returns 401 when the caller is not authenticated', async () => {
		getSessionUserMock.mockResolvedValueOnce(null);
		process.env.TELEGRAM_BOT_TOKEN = 'test-token';
		const { res, json } = await callEndpoint({ chatId: '123', signal: SIGNAL });
		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
	});

	it('returns 503 not_configured when TELEGRAM_BOT_TOKEN is not set', async () => {
		// An absent bot token is a deployment gap, not a server fault. 503 is what
		// every sibling handler answers, and it tells a client to stop retrying
		// instead of reporting a bug. The message names no env var to a caller who
		// cannot set one.
		const { res, json } = await callEndpoint({ chatId: '123', signal: SIGNAL });
		expect(res.statusCode).toBe(503);
		expect(json.error).toBe('not_configured');
	});

	it('returns 400 when chatId is missing', async () => {
		process.env.TELEGRAM_BOT_TOKEN = 'test-token';
		const { res } = await callEndpoint({ signal: SIGNAL });
		expect(res.statusCode).toBe(400);
	});

	it('returns 200 with ok and messageId on success', async () => {
		process.env.TELEGRAM_BOT_TOKEN = 'test-token';
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ result: { message_id: 99 } }),
		});
		const { res, json } = await callEndpoint({ chatId: '-100789', signal: SIGNAL });
		expect(res.statusCode).toBe(200);
		expect(json).toEqual({ ok: true, messageId: 99 });
	});
});
