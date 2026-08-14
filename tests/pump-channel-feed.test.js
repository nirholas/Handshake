import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── upstream source mocks ─────────────────────────────────────────────────────

const mintsMock = vi.fn();
const whalesMock = vi.fn();
const claimsMock = vi.fn();
const signalsMock = vi.fn();

vi.mock('../api/_lib/channel-feed-sources.js', () => ({
	getMints: (...a) => mintsMock(...a),
	getWhales: (...a) => whalesMock(...a),
	getClaims: (...a) => claimsMock(...a),
	getSignals: (...a) => signalsMock(...a),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { mcpIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://test', ISSUER: 'http://test', MCP_RESOURCE: 'http://test' },
}));

// The endpoint lives in the consolidated pump dispatcher, reached as
// /api/pump/channel-feed -> /api/pump/[action]?action=channel-feed. Exercising
// the dispatcher (rather than a sibling file the route table never reaches)
// is what makes these assertions describe production.
const { default: handler } = await import('../api/pump/[action].js');

// ── helpers ────────────────────────────────────────────────────────────────────

function mockRes() {
	const res = {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; },
	};
	return res;
}

function mockReq(search = '') {
	return {
		method: 'GET',
		headers: { host: 'localhost' },
		url: `/api/pump/channel-feed${search}`,
		// Populated by the filesystem router in production; the dispatcher switches on it.
		query: { action: 'channel-feed' },
	};
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('channel-feed endpoint', () => {
	beforeEach(() => {
		mintsMock.mockReset();
		whalesMock.mockReset();
		claimsMock.mockReset();
		signalsMock.mockReset();
		mintsMock.mockResolvedValue([]);
		whalesMock.mockResolvedValue([]);
		claimsMock.mockResolvedValue([]);
		signalsMock.mockResolvedValue([]);
	});

	it('returns 200 with items array', async () => {
		mintsMock.mockResolvedValueOnce([
			{ signature: 'sig1', mint: 'MINT1', timestamp: 1000, name: 'Alpha', symbol: 'ALPHA' },
		]);

		const res = mockRes();
		await handler(mockReq(), res);

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body).toHaveProperty('items');
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.items[0]).toMatchObject({ kind: 'mint', mint: 'MINT1', signature: 'sig1' });
	});

	it('dedupes items sharing a signature across sources', async () => {
		mintsMock.mockResolvedValueOnce([
			{ signature: 'dup', mint: 'MINT1', timestamp: 1000 },
		]);
		whalesMock.mockResolvedValueOnce([
			{ signature: 'dup', mint: 'MINT1', timestamp: 1000 }, // duplicate
			{ signature: 'unique', mint: 'MINT2', timestamp: 2000 },
		]);

		const res = mockRes();
		await handler(mockReq(), res);

		const body = JSON.parse(res.body);
		expect(body.items).toHaveLength(2);
		const sigs = body.items.map((i) => i.signature);
		expect(sigs).toContain('dup');
		expect(sigs).toContain('unique');
		expect(sigs.filter((s) => s === 'dup')).toHaveLength(1);
	});

	it('sorts newest first by ts', async () => {
		mintsMock.mockResolvedValueOnce([
			{ signature: 'old', mint: 'M1', timestamp: 100 },
			{ signature: 'new', mint: 'M2', timestamp: 9000 },
		]);

		const res = mockRes();
		await handler(mockReq(), res);

		const body = JSON.parse(res.body);
		expect(body.items[0].signature).toBe('new');
		expect(body.items[1].signature).toBe('old');
	});

	it('kinds=mint,claim excludes whale events', async () => {
		mintsMock.mockResolvedValueOnce([
			{ signature: 'mint1', mint: 'M1', timestamp: 100 },
		]);
		whalesMock.mockResolvedValueOnce([
			{ signature: 'whale1', mint: 'M2', timestamp: 200 },
		]);
		claimsMock.mockResolvedValueOnce([
			{ tx_signature: 'claim1', mint: 'M3', timestamp: 300 },
		]);

		const res = mockRes();
		await handler(mockReq('?kinds=mint,claim'), res);

		const body = JSON.parse(res.body);
		const kinds = body.items.map((i) => i.kind);
		expect(kinds).not.toContain('whale');
		expect(kinds).toContain('mint');
		expect(kinds).toContain('claim');
		// whale source should not have been called (or its results excluded)
		const hasWhale = body.items.some((i) => i.signature === 'whale1');
		expect(hasWhale).toBe(false);
	});

	it('respects limit param', async () => {
		mintsMock.mockResolvedValueOnce(
			Array.from({ length: 30 }, (_, i) => ({
				signature: `s${i}`,
				mint: `M${i}`,
				timestamp: i,
			})),
		);

		const res = mockRes();
		await handler(mockReq('?limit=5'), res);

		const body = JSON.parse(res.body);
		expect(body.items.length).toBeLessThanOrEqual(5);
	});

	it('serves the default page when limit is not a number', async () => {
		// `Number('abc')` is NaN and NaN survives every Math.min/Math.max clamp, so
		// the old parse handed a NaN limit to each source query and to the feed
		// slice: a single typo'd limit answered 200 with an empty feed. A caller
		// that mistypes the page size still gets the feed, never a silent blank.
		mintsMock.mockResolvedValueOnce(
			Array.from({ length: 30 }, (_, i) => ({
				signature: `nan${i}`,
				mint: `M${i}`,
				timestamp: i,
			})),
		);

		const res = mockRes();
		await handler(mockReq('?limit=abc'), res);

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.items.length).toBe(30);
		// The sources are asked for a real number, never NaN.
		expect(mintsMock).toHaveBeenCalledWith(50);
	});

	it('clamps a limit above the ceiling instead of forwarding it', async () => {
		mintsMock.mockResolvedValueOnce([]);

		const res = mockRes();
		await handler(mockReq('?limit=9999'), res);

		expect(res.statusCode).toBe(200);
		expect(mintsMock).toHaveBeenCalledWith(200);
	});

	it('normalizes tx_signature fallback', async () => {
		claimsMock.mockResolvedValueOnce([
			{ tx_signature: 'claimsig', mint: 'CM1', timestamp: 500 },
		]);

		const res = mockRes();
		await handler(mockReq(), res);

		const body = JSON.parse(res.body);
		const claim = body.items.find((i) => i.kind === 'claim');
		expect(claim?.signature).toBe('claimsig');
	});

	it('returns empty items when all sources are empty', async () => {
		const res = mockRes();
		await handler(mockReq(), res);

		const body = JSON.parse(res.body);
		expect(body.items).toEqual([]);
	});

	it('includes agent-attributed signals in the default feed', async () => {
		signalsMock.mockResolvedValueOnce([
			{
				signature: 'signal:gradtx:graduation',
				tx_signature: 'gradtx',
				mint: 'GM',
				signal_kind: 'graduation',
				weight: 0.3,
				agent_name: 'Atlas',
				summary: 'Atlas — graduated a token (+0.3)',
				timestamp: 5000,
			},
		]);

		const res = mockRes();
		await handler(mockReq(), res);

		const body = JSON.parse(res.body);
		const sig = body.items.find((i) => i.kind === 'signal');
		expect(sig).toBeTruthy();
		expect(sig.signature).toBe('signal:gradtx:graduation');
		expect(sig.signal_kind).toBe('graduation');
	});

	it('kinds=mint excludes the signal lane', async () => {
		mintsMock.mockResolvedValueOnce([{ signature: 'mint1', mint: 'M1', timestamp: 100 }]);
		signalsMock.mockResolvedValueOnce([
			{ signature: 'signal:x:launch', tx_signature: 'x', signal_kind: 'launch', timestamp: 200 },
		]);

		const res = mockRes();
		await handler(mockReq('?kinds=mint'), res);

		const body = JSON.parse(res.body);
		expect(body.items.some((i) => i.kind === 'signal')).toBe(false);
		expect(body.items.some((i) => i.kind === 'mint')).toBe(true);
		// signal source must not even be queried when filtered out
		expect(signalsMock).not.toHaveBeenCalled();
	});
});
