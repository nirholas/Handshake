// api/cron/oracle-digest.js: the daily Oracle conviction digest.
//
// platformDayStats and buildChannelDigest are exported "for tests" but had
// none, so nothing pinned the one property that matters for a message posted
// to a public channel: it renders from real DB rows, degrades to honest
// "nothing today" copy when the query returns nothing, and escapes the
// attacker-controlled strings it interpolates (a coin symbol is on-chain
// metadata, so it is untrusted input, and the digest is parse_mode HTML).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));

const { default: handler, platformDayStats, buildChannelDigest } =
	await import('../../api/cron/oracle-digest.js');

function call(method = 'GET', auth = 'Bearer test-cron-secret') {
	const res = {
		statusCode: 0,
		body: null,
		headers: {},
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b ? JSON.parse(b) : null; },
		get headersSent() { return this.body !== null; },
		get writableEnded() { return this.body !== null; },
	};
	const req = { method, url: '/api/cron/oracle-digest', headers: { authorization: auth } };
	return handler(req, res).then(() => res);
}

const originalFetch = global.fetch;

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	delete process.env.TELEGRAM_BOT_TOKEN;
	delete process.env.TELEGRAM_ORACLE_CHAT_ID;
	sqlMock.mockReset();
	sqlMock.mockResolvedValue([]);
	global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
});
afterEach(() => {
	delete process.env.CRON_SECRET;
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('the digest handler gates', () => {
	it('rejects a method it does not serve', async () => {
		expect((await call('DELETE')).statusCode).toBe(405);
	});

	it('rejects a bad cron secret', async () => {
		expect((await call('GET', 'Bearer wrong')).statusCode).toBe(401);
	});

	it('reports the missing credential instead of failing, and sends nothing', async () => {
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ ok: true, sent: 0, reason: 'TELEGRAM_BOT_TOKEN not set' });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('posts the channel anchor even with zero personal subscribers', async () => {
		process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
		process.env.TELEGRAM_ORACLE_CHAT_ID = '-100123';
		const res = await call();
		expect(res.statusCode).toBe(200);
		expect(res.body.channel).toBe(true);
		expect(res.body.subscribers).toBe(0);
		expect(res.body.sent).toBe(1);
		const [url, opts] = global.fetch.mock.calls[0];
		expect(String(url)).toContain('/botbot-token/sendMessage');
		expect(JSON.parse(opts.body).chat_id).toBe('-100123');
		expect(JSON.parse(opts.body).parse_mode).toBe('HTML');
	});
});

describe('platformDayStats', () => {
	it('reads the scored count, action rollup and top coins for the window', async () => {
		sqlMock
			.mockResolvedValueOnce([{ n: 412 }])
			.mockResolvedValueOnce([{ total: 9, wins: 5, losses: 4, pnl: '1.25' }])
			.mockResolvedValueOnce([{ mint: 'Mint1', symbol: 'ABC', score: 91, tier: 'prime', category: 'meme' }]);
		const day = await platformDayStats('mainnet');
		expect(day.scored).toBe(412);
		expect(day.actions).toMatchObject({ total: 9, wins: 5, losses: 4 });
		expect(day.top).toHaveLength(1);
	});

	it('degrades to zeroes when the tables are not there yet', async () => {
		sqlMock.mockRejectedValue(new Error('relation "oracle_conviction" does not exist'));
		const day = await platformDayStats('mainnet');
		expect(day.scored).toBe(0);
		expect(day.actions).toMatchObject({ total: 0, wins: 0, losses: 0 });
		expect(day.top).toEqual([]);
	});
});

describe('buildChannelDigest', () => {
	const base = { scored: 1234, actions: { total: 0, wins: 0, losses: 0, pnl: 0 }, top: [] };

	it('renders the scored count and the referral offers', () => {
		const msg = buildChannelDigest(base);
		expect(msg).toContain('1,234');
		expect(msg).toContain('https://three.ws/oracle');
		expect(msg).toContain('Trade with a fee discount');
	});

	it('says nothing cleared the floor rather than rendering an empty list', () => {
		expect(buildChannelDigest(base)).toContain('No launches cleared the scoring floor today');
	});

	it('renders the agent line only when there were actions, with a signed PnL', () => {
		expect(buildChannelDigest(base)).not.toContain('<b>Agents</b>');
		const msg = buildChannelDigest({ ...base, actions: { total: 3, wins: 2, losses: 1, pnl: 0.5 } });
		expect(msg).toContain('3 actions');
		expect(msg).toContain('2W / 1L');
		expect(msg).toContain('+0.5000 SOL');
	});

	it('escapes a hostile coin symbol instead of injecting markup into the channel post', () => {
		const msg = buildChannelDigest({
			...base,
			top: [{ mint: 'Mint1', symbol: '<b>PWN</b>', score: 88, tier: 'strong', category: 'unknown' }],
		});
		expect(msg).toContain('&lt;b&gt;PWN&lt;/b&gt;');
		expect(msg).not.toContain('$<b>PWN</b>');
		// an "unknown" category is omitted, not printed as the literal word
		expect(msg).not.toContain('· unknown');
	});

	it('falls back to a mint prefix when a coin has no symbol', () => {
		const msg = buildChannelDigest({
			...base,
			top: [{ mint: 'AbCdEfGhIjKl', symbol: null, score: 70, tier: 'lean', category: 'meme' }],
		});
		expect(msg).toContain('$AbCdEf');
	});
});
