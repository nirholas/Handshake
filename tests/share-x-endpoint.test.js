import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the thin glue deps so the test covers the endpoint's OWN logic: the
// same-site guard, media validation, caption composition and the X error ->
// HTTP status mapping. The network/DB beneath publishTweet is exercised
// separately (tests/x-post-impact.test.js) and by the live curl sweep.
vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: (req, res, allowed) => {
		if (allowed.includes(req.method)) return true;
		res._json = { status: 405, body: { error: 'method_not_allowed' } };
		return false;
	},
	json: (res, status, body) => { res._json = { status, body }; return res; },
	error: (res, status, code, message, extra = {}) => {
		res._json = { status, body: { error: code, error_description: message, ...extra } };
		return res;
	},
	readBody: (req, limit) => {
		const buf = req._buffer ?? Buffer.alloc(0);
		if (buf.length > limit) return Promise.reject(Object.assign(new Error('payload too large'), { status: 413 }));
		return Promise.resolve(buf);
	},
}));

const getSessionUser = vi.fn(async () => ({ id: 'user-1' }));
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUser(...a),
	isSameSiteOrigin: (req) => req.headers.origin === 'https://three.ws',
}));
vi.mock('../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'https://three.ws' } }));

class XPostError extends Error {
	constructor(code, message, status = 400, extra = {}) {
		super(message);
		this.code = code;
		this.status = status;
		this.extra = extra;
	}
}
const publishTweet = vi.fn(async () => ({ tweet_id: '1', url: 'https://x.com/walker/status/1' }));
vi.mock('../api/_lib/x-post.js', () => ({
	publishTweet: (...a) => publishTweet(...a),
	XPostError,
	MAX_TWEET_LEN: 280,
}));

const handler = (await import('../api/share/x.js')).default;

function makeReq({ method = 'POST', url = '/api/share/x', contentType = 'image/png', body = Buffer.from('png-bytes'), origin = 'https://three.ws' } = {}) {
	return {
		method,
		url,
		headers: { origin, 'content-type': contentType },
		_buffer: body,
	};
}
function makeRes() { return { setHeader() {}, end() {}, statusCode: 200 }; }

async function call(reqOverrides) {
	const req = makeReq(reqOverrides);
	const res = makeRes();
	await handler(req, res);
	return res._json;
}

describe('POST /api/share/x', () => {
	beforeEach(() => {
		publishTweet.mockReset();
		publishTweet.mockResolvedValue({ tweet_id: '1', url: 'https://x.com/walker/status/1' });
		getSessionUser.mockReset();
		getSessionUser.mockResolvedValue({ id: 'user-1' });
	});

	it('rejects a cross-site POST before touching the session', async () => {
		const out = await call({ origin: 'https://evil.example' });
		expect(out.status).toBe(403);
		expect(out.body.error).toBe('forbidden');
		expect(getSessionUser).not.toHaveBeenCalled();
	});

	it('answers 401 with a login_url when no session is present', async () => {
		getSessionUser.mockResolvedValue(null);
		const out = await call();
		expect(out.status).toBe(401);
		expect(out.body).toMatchObject({ error: 'auth_required', login_url: '/login' });
	});

	it('rejects an unsupported media type', async () => {
		const out = await call({ contentType: 'application/json' });
		expect(out.status).toBe(415);
		expect(out.body.error).toBe('unsupported_media_type');
	});

	it('rejects an empty body', async () => {
		const out = await call({ body: Buffer.alloc(0) });
		expect(out.status).toBe(400);
		expect(out.body.error).toBe('empty_body');
	});

	it('rejects an image over the 5 MB still-image ceiling', async () => {
		const out = await call({ body: Buffer.alloc(5 * 1024 * 1024 + 1) });
		expect(out.status).toBe(413);
		expect(out.body).toMatchObject({ error: 'too_large', error_description: 'image exceeds the 5 MB limit' });
	});

	it('accepts a video under the 64 MB clip ceiling', async () => {
		const out = await call({ contentType: 'video/mp4', body: Buffer.alloc(6 * 1024 * 1024) });
		expect(out.status).toBe(200);
		expect(publishTweet.mock.calls[0][0].mediaMimeType).toBe('video/mp4');
	});

	it('composes the default caption with the avatar deep link', async () => {
		const out = await call({ url: '/api/share/x?avatar=abc123' });
		expect(out.status).toBe(200);
		expect(out.body).toMatchObject({ ok: true, tweet_id: '1' });
		expect(publishTweet.mock.calls[0][0].text).toBe('I walked my avatar around three.ws. Try yours: three.ws/walk?avatar=abc123');
	});

	it('uses the caller caption when one is supplied, truncated to a tweet', async () => {
		const long = 'x'.repeat(400);
		await call({ url: `/api/share/x?text=${long}` });
		expect(publishTweet.mock.calls[0][0].text).toHaveLength(280);
	});

	it('maps not_connected to 409 with a connect_url', async () => {
		publishTweet.mockRejectedValue(new XPostError('not_connected', 'X account not connected', 400));
		const out = await call();
		expect(out.status).toBe(409);
		expect(out.body).toMatchObject({ error: 'not_connected', connect_url: '/api/auth/x/connect' });
	});

	// An unrefreshable X token is a reconnect, not a three.ws sign-in. Answering
	// 401 there made the client show "Sign in to three.ws" and link /login to a
	// user who was already signed in, with no way to reach the X connect flow.
	it('maps reauth_required to 409 with a connect_url, never 401', async () => {
		publishTweet.mockRejectedValue(new XPostError('reauth_required', 'refresh_token missing, reconnect X account', 401));
		const out = await call();
		expect(out.status).toBe(409);
		expect(out.body).toMatchObject({ error: 'reauth_required', connect_url: '/api/auth/x/connect' });
	});

	it('passes other X errors through with their own status and extras', async () => {
		publishTweet.mockRejectedValue(new XPostError('quota_exceeded', 'free tier limit reached', 402, { upgrade_url: '/pricing' }));
		const out = await call();
		expect(out.status).toBe(402);
		expect(out.body).toMatchObject({ error: 'quota_exceeded', upgrade_url: '/pricing' });
		expect(out.body.connect_url).toBeUndefined();
	});

	it('rejects a non-POST method', async () => {
		const out = await call({ method: 'GET' });
		expect(out.status).toBe(405);
	});
});
