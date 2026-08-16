/**
 * Input guards + degraded-config behaviour for the agent-facing api/*.js batch:
 * agent-og, agent-share, agent-reflect-digest, agent-skill-price, agent-skills,
 * agent-screen-push, agent-screen-stream.
 *
 * Every case here is a defect these endpoints actually shipped, found by curling
 * them against a local server on 2026-08-16:
 *
 *   1. agent_identities.id is a uuid column. Four handlers interpolated a
 *      caller-supplied agentId straight into it, so `?agentId=notauuid` threw
 *      Postgres 22P02 and answered 500 (with a Sentry event and an ops alert per
 *      hit) for what is plainly a 400. api/agent-og.js had already documented and
 *      fixed the trap; its neighbours had not.
 *   2. /api/agents/:id/skills/set-price accepted ANY 100-char string as
 *      currency_mint and wrote it to agent_skill_prices, while the sibling entry
 *      point onto the same table enforced base58. A typo became a listing whose
 *      quoted price is payable to nothing.
 *   3. Both share surfaces 503'd a crawler when S3_PUBLIC_DOMAIN was unset:
 *      agent-share's `env.S3_PUBLIC_DOMAIN || fallback` could never reach the
 *      fallback (the getter throws), and agent-og let getAvatar's throw escape.
 *      An unconfigured bucket must degrade the image, never the page.
 *   4. agent-screen-stream only emitted `dark` from inside its Redis poll, so
 *      with no frame store configured a viewer sat on "Connecting…" for the full
 *      280s instead of being told the agent is offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (req) => {
		const h = req?.headers?.authorization || '';
		return h.startsWith('Bearer ') ? h.slice(7) : null;
	},
}));

vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		apiIp: vi.fn(async () => ({ success: true, reset: 1_000 })),
		authIp: vi.fn(async () => ({ success: true, reset: 1_000 })),
		mcpIp: vi.fn(async () => ({ success: true, reset: 1_000 })),
	},
	clientIp: () => '203.0.113.24',
}));

vi.mock('../api/_lib/skill-price-cache.js', () => ({
	invalidateSkillPriceCache: vi.fn(async () => {}),
}));

const getRedisMock = vi.fn(() => null);
vi.mock('../api/_lib/redis.js', () => ({ getRedis: (...a) => getRedisMock(...a) }));

const getAvatarMock = vi.fn();
vi.mock('../api/_lib/avatars.js', () => ({ getAvatar: (...a) => getAvatarMock(...a) }));

const { default: agentOg } = await import('../api/agent-og.js');
const { default: agentShare } = await import('../api/agent-share.js');
const { default: reflectDigest } = await import('../api/agent-reflect-digest.js');
const { default: skillPrice } = await import('../api/agent-skill-price.js');
const { default: agentSkills } = await import('../api/agent-skills.js');
const { default: screenPush } = await import('../api/agent-screen-push.js');
const { default: screenStream } = await import('../api/agent-screen-stream.js');

const USER = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// $THREE, the only coin this platform promotes.
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function mkReq({ url = '/', method = 'GET', headers = {}, body = null } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	const closers = [];
	return {
		method,
		url,
		headers: hdrs,
		// server/index.mjs pre-parses JSON bodies onto req.body; readJson reads it
		// from there rather than re-draining an already-ended stream.
		body: body == null ? undefined : body,
		on(evt, cb) { if (evt === 'close') closers.push(cb); },
		fireClose() { for (const cb of closers) cb(); },
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		chunks: [],
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		writeHead(status, hdrs = {}) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v);
			this.headersSent = true;
		},
		flushHeaders() { this.headersSent = true; },
		write(chunk) { this.chunks.push(String(chunk)); return true; },
		end(b) { if (b != null) this.body = b; this.writableEnded = true; },
	};
}

const parseBody = (res) => (res.body ? JSON.parse(res.body) : undefined);

let s3Before;
beforeEach(() => {
	sqlMock.mockReset().mockResolvedValue([]);
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	getRedisMock.mockReset().mockReturnValue(null);
	getAvatarMock.mockReset().mockResolvedValue(null);
	s3Before = process.env.S3_PUBLIC_DOMAIN;
});
afterEach(() => {
	if (s3Before === undefined) delete process.env.S3_PUBLIC_DOMAIN;
	else process.env.S3_PUBLIC_DOMAIN = s3Before;
});

describe('a malformed agentId is a 400, never a Postgres 22P02 500', () => {
	it('agent-reflect-digest rejects it before the query runs', async () => {
		const res = mkRes();
		await reflectDigest(mkReq({ url: '/api/agent-reflect-digest?agentId=notauuid' }), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('agent-skill-price rejects it before the query runs', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		const res = mkRes();
		await skillPrice(mkReq({
			url: '/api/agent-skill-price?agentId=notauuid',
			method: 'POST',
			body: { skill: 's', amount: 1, currency_mint: MINT },
		}), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('agent-skills set-price rejects it before the query runs', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		const res = mkRes();
		await agentSkills(mkReq({
			url: '/api/agent-skills?agentId=notauuid&action=set-price',
			method: 'POST',
			body: { skill: 's', amount: 1, currency_mint: MINT },
		}), res);
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('agent-screen-push rejects it before the ownership lookup', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		const res = mkRes();
		await screenPush(mkReq({
			url: '/api/agent-screen-push',
			method: 'POST',
			body: { agentId: 'notauuid', frame: { activity: 'x' } },
		}), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error).toBe('invalid_agent_id');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('still serves a well-formed id', async () => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlMock.mockResolvedValue([]); // no such agent
		const res = mkRes();
		await reflectDigest(mkReq({ url: `/api/agent-reflect-digest?agentId=${AGENT}` }), res);
		expect(res.statusCode).toBe(404);
		expect(sqlMock).toHaveBeenCalled();
	});
});

describe('agent-skills set-price validates the mint it will quote a buyer', () => {
	const req = (mint) => mkReq({
		url: `/api/agent-skills?agentId=${AGENT}&action=set-price`,
		method: 'POST',
		body: { skill: 'render', amount: 5, currency_mint: mint },
	});

	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: USER });
		sqlMock.mockResolvedValue([{ id: AGENT, user_id: USER }]);
	});

	it('refuses a mint that is not a base58 address', async () => {
		const res = mkRes();
		await agentSkills(req('!!! not a mint !!!'), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res).error_description).toBe('invalid mint address');
	});

	it('accepts a real base58 mint', async () => {
		const res = mkRes();
		await agentSkills(req(MINT), res);
		expect(res.statusCode).toBe(200);
		expect(parseBody(res)).toEqual({ data: { ok: true } });
	});

	it('answers an unknown action with CORS headers a browser can read', async () => {
		const res = mkRes();
		await agentSkills(mkReq({
			url: '/api/agent-skills?action=bogus',
			headers: { origin: 'https://three.ws' },
		}), res);
		expect(res.statusCode).toBe(404);
		expect(res.getHeader('access-control-allow-methods')).toBe('POST,OPTIONS');
	});
});

describe('an unconfigured bucket degrades the image, never the page', () => {
	beforeEach(() => {
		delete process.env.S3_PUBLIC_DOMAIN;
	});

	it('agent-share renders the card with an origin-relative CDN base', async () => {
		sqlMock.mockResolvedValue([{
			id: AGENT, name: 'Probe', description: 'A probe agent', chain_id: null,
			erc8004_agent_id: null, meta: null,
			thumbnail_key: 'u/owner/thumb.png', storage_key: 'u/owner/model.glb', visibility: 'public',
		}]);
		const res = mkRes();
		await agentShare(mkReq({ url: `/api/agent-share?id=${AGENT}` }), res);
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toContain('text/html');
		expect(res.body).toContain('/cdn/u/owner/thumb.png');
	});

	it('agent-og falls back to the SVG card when the avatar url cannot be built', async () => {
		sqlMock.mockResolvedValue([{ id: AGENT, name: 'Probe', description: 'A probe agent', avatar_id: 'av-1' }]);
		getAvatarMock.mockRejectedValue(new Error('Missing required env var: S3_PUBLIC_DOMAIN'));
		const res = mkRes();
		await agentOg(mkReq({ url: `/api/agent-og?id=${AGENT}` }), res);
		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toContain('image/svg+xml');
		expect(res.body).toContain('Probe');
	});

	it('agent-og still 302s to a real thumbnail when one resolves', async () => {
		sqlMock.mockResolvedValue([{ id: AGENT, name: 'Probe', description: '', avatar_id: 'av-1' }]);
		getAvatarMock.mockResolvedValue({ thumbnail_url: 'https://cdn.example/thumb.png' });
		const res = mkRes();
		await agentOg(mkReq({ url: `/api/agent-og?id=${AGENT}` }), res);
		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('https://cdn.example/thumb.png');
	});
});

describe('agent-screen-stream tells a viewer the agent is dark', () => {
	it('emits dark once up front when no frame store is configured', async () => {
		sqlMock.mockResolvedValue([{ name: 'Probe' }]);
		getRedisMock.mockReturnValue(null);
		const req = mkReq({ url: `/api/agent-screen-stream?agentId=${AGENT}` });
		const res = mkRes();
		await screenStream(req, res);
		req.fireClose(); // stop the poll loop the handler left running
		const sse = res.chunks.join('');
		expect(sse).toContain('event: open');
		expect(sse).toContain('event: dark');
		expect(sse.match(/event: dark/g)).toHaveLength(1);
	});

	it('answers a missing agentId through the shared error envelope', async () => {
		const res = mkRes();
		await screenStream(mkReq({ url: '/api/agent-screen-stream' }), res);
		expect(res.statusCode).toBe(400);
		expect(parseBody(res)).toMatchObject({ error: 'validation_error' });
	});
});
