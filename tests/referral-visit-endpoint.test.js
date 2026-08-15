/**
 * Referral visit beacon (api/referral/visit.js): the write side of the share
 * funnel, and the only public unauthenticated writer into referral_visits.
 *
 * tests/referral-funnel.test.js pins the read side, so the counts it reports
 * were only ever as trustworthy as the rows this handler writes, which nothing
 * covered. Four behaviours carry the funnel and each fails silently if it
 * regresses (the endpoint answers 200 either way, so no alert would fire):
 * the referrer resolved at write time, the unknown-code row that keeps dead
 * links visible, the once-per-visitor-per-day dedup, and the usage event that
 * fires only on a genuinely new visit.
 *
 * We drive the REAL wrapped handler and mock only the I/O boundary (DB, rate
 * limiter, usage buffer) so the handler's own branching runs unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
	/** Rows the `users` lookup returns; empty means the code matches nobody. */
	referrerRows: [],
	/** Rows the insert's RETURNING clause yields; empty means ON CONFLICT DO NOTHING fired. */
	insertRows: [{ id: '1' }],
	/** Every insert the handler issued, as { code, referrerId, visitorHash, day }. */
	inserts: [],
	/** Every recordEvent() payload. */
	events: [],
	/** Rate limiter verdict. */
	rl: { success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 },
	/** IPs the limiter was asked about, so the per-IP keying is observable. */
	rlCalls: [],
}));

vi.mock('../api/_lib/zauth.js', () => ({ instrument: () => false, drain: async () => {} }));

vi.mock('../api/_lib/db.js', () => {
	const sql = (strings, ...vals) => {
		if (!Array.isArray(strings)) return Promise.resolve({ __frag: true });
		const q = strings.join(' ').toLowerCase();
		if (q.includes('from users')) return Promise.resolve(H.referrerRows);
		if (q.includes('insert into referral_visits')) {
			const [code, referrerId, visitorHash, day] = vals;
			H.inserts.push({ code, referrerId, visitorHash, day });
			return Promise.resolve(H.insertRows);
		}
		return Promise.resolve([]);
	};
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: (req) => req.headers['x-forwarded-for'] || '1.2.3.4',
	limits: {
		referralVisitIp: async (ip) => {
			H.rlCalls.push(ip);
			return H.rl;
		},
	},
}));

vi.mock('../api/_lib/usage.js', () => ({
	recordEvent: (evt) => { H.events.push(evt); },
}));

const handler = (await import('../api/referral/visit.js')).default;

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; },
		get headersSent() { return this.ended; },
		get writableEnded() { return this.ended; },
	};
}

async function visit(body, { method = 'POST', contentType = 'application/json', headers = {} } = {}) {
	const req = {
		method,
		url: '/api/referral/visit',
		headers: { 'content-type': contentType, 'user-agent': 'QA/1.0', ...headers },
		query: {},
		...(body === undefined ? {} : { body }),
	};
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

beforeEach(() => {
	H.referrerRows = [];
	H.insertRows = [{ id: '1' }];
	H.inserts = [];
	H.events = [];
	H.rl = { success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 };
	H.rlCalls = [];
});

describe('referral visit: the recorded row', () => {
	it('resolves the referrer at write time and records the visit', async () => {
		H.referrerRows = [{ id: 'referrer-1' }];

		const r = await visit({ code: 'ADA99' });

		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true });
		expect(H.inserts).toHaveLength(1);
		expect(H.inserts[0].code).toBe('ADA99');
		expect(H.inserts[0].referrerId).toBe('referrer-1');
	});

	it('uppercases a lowercase code so a shared link is matched case-insensitively', async () => {
		H.referrerRows = [{ id: 'referrer-1' }];

		await visit({ code: 'ada99' });

		expect(H.inserts[0].code).toBe('ADA99');
	});

	it('records an unknown code with no referrer, so dead-link traffic stays visible', async () => {
		H.referrerRows = [];

		const r = await visit({ code: 'NOSUCHCODE' });

		expect(r.status).toBe(200);
		expect(H.inserts).toHaveLength(1);
		expect(H.inserts[0].referrerId).toBeNull();
		expect(H.events[0].meta.has_referrer).toBe(false);
	});

	it('stores only a hash of the visitor, never the raw ip or user agent', async () => {
		await visit({ code: 'ADA99' }, { headers: { 'x-forwarded-for': '203.0.113.7' } });

		const { visitorHash } = H.inserts[0];
		expect(visitorHash).toMatch(/^[0-9a-f]{64}$/);
		expect(visitorHash).not.toContain('203.0.113.7');
		expect(visitorHash).not.toContain('QA/1.0');
	});

	it('stamps the UTC day so the dedup window does not move with the server timezone', async () => {
		await visit({ code: 'ADA99' });

		expect(H.inserts[0].day).toBe(new Date().toISOString().slice(0, 10));
	});

	it('separates visitors by ip, so two people on one link are two visits', async () => {
		await visit({ code: 'ADA99' }, { headers: { 'x-forwarded-for': '203.0.113.7' } });
		await visit({ code: 'ADA99' }, { headers: { 'x-forwarded-for': '198.51.100.4' } });

		expect(H.inserts[0].visitorHash).not.toBe(H.inserts[1].visitorHash);
	});
});

describe('referral visit: dedup replay', () => {
	it('answers 200 without counting a usage event when the row already existed', async () => {
		// ON CONFLICT DO NOTHING returns no row: the visitor already counted today.
		H.insertRows = [];

		const r = await visit({ code: 'ADA99' });

		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true });
		expect(H.events).toHaveLength(0);
	});

	it('counts a usage event exactly once, on the insert that actually landed', async () => {
		H.referrerRows = [{ id: 'referrer-1' }];
		await visit({ code: 'ADA99' });
		H.insertRows = [];
		await visit({ code: 'ADA99' });

		expect(H.events).toHaveLength(1);
		expect(H.events[0]).toMatchObject({ userId: 'referrer-1', kind: 'referral_visit' });
	});
});

describe('referral visit: rejected requests never reach the database', () => {
	it('400s a malformed code rather than mangling it into a valid one', async () => {
		const r = await visit({ code: 'my-code' });

		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_code');
		expect(H.inserts).toHaveLength(0);
	});

	it('400s a missing code', async () => {
		const r = await visit({});

		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_code');
		expect(H.inserts).toHaveLength(0);
	});

	it('400s a code that is not a string', async () => {
		const r = await visit({ code: { nested: true } });

		expect(r.status).toBe(400);
		expect(r.body.error).toBe('invalid_code');
	});

	it('415s a non-JSON content type instead of blaming the referral code', async () => {
		// The old catch-all reported `invalid_code` here, sending integrators to
		// debug a code that was never read.
		const r = await visit({ code: 'ADA99' }, { contentType: 'application/x-www-form-urlencoded' });

		expect(r.status).toBe(415);
		expect(r.body.error).toBe('unsupported_media_type');
		expect(H.inserts).toHaveLength(0);
	});

	it('405s a GET, since the beacon is POST only', async () => {
		const r = await visit(undefined, { method: 'GET' });

		expect(r.status).toBe(405);
		expect(H.inserts).toHaveLength(0);
	});

	it('204s a preflight without touching the database', async () => {
		const r = await visit(undefined, { method: 'OPTIONS' });

		expect(r.status).toBe(204);
		expect(H.inserts).toHaveLength(0);
	});
});

describe('referral visit: rate limiting', () => {
	it('429s over the per-ip limit, before the body is read or a row is written', async () => {
		H.rl = { success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 };

		const r = await visit({ code: 'ADA99' });

		expect(r.status).toBe(429);
		expect(r.body.error).toBe('rate_limited');
		expect(r.headers['retry-after']).toBeTruthy();
		expect(H.inserts).toHaveLength(0);
	});

	it('keys the limiter on the caller ip, so one flooder cannot mute everyone', async () => {
		await visit({ code: 'ADA99' }, { headers: { 'x-forwarded-for': '203.0.113.7' } });
		await visit({ code: 'ADA99' }, { headers: { 'x-forwarded-for': '198.51.100.4' } });

		expect(H.rlCalls).toEqual(['203.0.113.7', '198.51.100.4']);
	});
});
