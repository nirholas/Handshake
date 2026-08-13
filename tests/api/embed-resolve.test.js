// Tests for GET /api/embed/resolve, the endpoint every 3D embed on the public
// internet calls to find out what to render.
//
// What it pins is the one decision that has to be right every single time: a
// token-gated asset must never hand back its glbUrl to a caller who has not
// proved the holding. The lock is enforced here, on the read path, rather than
// in the widget, so a caller with curl gets the same answer as the browser.
//
// Everything below the database seam is the real implementation: the real
// asset resolver, the real gate reader, and the real HMAC token module, so a
// token that unlocks in this test is a token the production verifier minted
// the same way. Only `sql` is stubbed, standing in for rows the endpoint would
// have read from Postgres.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
	process.env.JWT_SECRET = 'test-jwt-secret-embed-resolve-0123456789';
	// The avatar branch builds its glbUrl through api/_lib/r2.js, which requires
	// the asset host to be configured rather than guessing one.
	process.env.S3_PUBLIC_DOMAIN = 'assets.test.three.ws';
});

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: true, limit: 240, remaining: 239, reset: 0 })) },
	clientIp: () => '203.0.113.7',
}));

const handler = (await import('../../api/embed/resolve.js')).default;
const { signEmbedGateToken } = await import('../../api/_lib/embed-gate-token.js');
const { DEFAULT_GATE_MINT } = await import('../../api/_lib/embed-gate.js');

const AVATAR_ID = '8e3f1c22-0000-4000-8000-0000000000c1';
const ASSET = `avatar:${AVATAR_ID}`;
const GATE_ID = 'gate_0000000000000001';

const avatarRow = {
	id: AVATAR_ID,
	name: 'Nova',
	description: 'A public avatar',
	storage_key: 'avatars/nova.glb',
	thumbnail_key: 'avatars/nova.jpg',
};

const gateRow = {
	id: GATE_ID,
	asset_id: ASSET,
	owner_user_id: 'user_1',
	chain: 'solana',
	mint: DEFAULT_GATE_MINT,
	min_amount: 5000,
	created_at: new Date().toISOString(),
};

/** Answer each query by the table it names, so the order of reads inside the
 *  handler is free to change without rewriting the fixtures. */
function stubRows({ avatar = [avatarRow], gate = [] } = {}) {
	sqlMock.mockImplementation((strings) => {
		const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
		if (/from\s+avatars/i.test(text)) return Promise.resolve(avatar);
		if (/from\s+embed_gates/i.test(text)) return Promise.resolve(gate);
		return Promise.resolve([]);
	});
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		ended: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			this.ended = true;
			if (chunk) this.body += chunk;
		},
	};
}

async function get(query) {
	const req = { method: 'GET', url: `/api/embed/resolve?${query}`, headers: {} };
	const res = mkRes();
	await handler(req, res);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	sqlMock.mockReset();
});

describe('an ungated asset', () => {
	it('returns the render payload and lets the edge cache it', async () => {
		stubRows();
		const { res, json } = await get(`id=${encodeURIComponent(ASSET)}`);

		expect(res.statusCode).toBe(200);
		expect(json.name).toBe('Nova');
		expect(json.glbUrl).toBeTruthy();
		expect(json.gated).toBeUndefined();
		// Cross-origin by design: the embed runs on someone else's page.
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
		expect(res.getHeader('cache-control')).toMatch(/public/);
	});

	it('404s an id that resolves to nothing', async () => {
		stubRows({ avatar: [] });
		const { res, json } = await get(`id=${encodeURIComponent(ASSET)}`);
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});
});

describe('a gated asset without a valid token', () => {
	it('withholds the glbUrl and returns the gate terms instead', async () => {
		stubRows({ gate: [gateRow] });
		const { res, json } = await get(`id=${encodeURIComponent(ASSET)}`);

		expect(res.statusCode).toBe(200);
		expect(json.locked).toBe(true);
		expect(json.glbUrl).toBeUndefined();
		// The whole payload, not just the top level: a nested copy would leak it.
		expect(JSON.stringify(json)).not.toContain('avatars/nova.glb');
		expect(json.gate).toMatchObject({ gateId: GATE_ID, mint: DEFAULT_GATE_MINT, minAmount: 5000 });
		// The teaser stays, so a visitor can see what the holding would unlock.
		expect(json.name).toBe('Nova');
		expect(json.poster).toBeTruthy();
	});

	it('never lets a locked or unlocked answer be cached and reused', async () => {
		stubRows({ gate: [gateRow] });
		const locked = await get(`id=${encodeURIComponent(ASSET)}`);
		expect(locked.res.getHeader('cache-control')).toBe('private, no-store');

		const token = await signEmbedGateToken({
			gateId: GATE_ID,
			assetId: ASSET,
			wallet: 'ThreeWsSyntheticTestWallet1111111111111111',
			mint: DEFAULT_GATE_MINT,
			minAmount: 5000,
			amount: 9000,
		});
		stubRows({ gate: [gateRow] });
		const unlocked = await get(`id=${encodeURIComponent(ASSET)}&gate_token=${token}`);
		expect(unlocked.res.getHeader('cache-control')).toBe('private, no-store');
	});

	it('stays locked for a garbage token rather than erroring', async () => {
		stubRows({ gate: [gateRow] });
		const { res, json } = await get(`id=${encodeURIComponent(ASSET)}&gate_token=eg1.nope.nope`);
		expect(res.statusCode).toBe(200);
		expect(json.locked).toBe(true);
		expect(json.glbUrl).toBeUndefined();
	});

	it('rejects a token minted for a different gate on the same asset', async () => {
		const token = await signEmbedGateToken({
			gateId: 'gate_some_superseded_id',
			assetId: ASSET,
			wallet: 'ThreeWsSyntheticTestWallet1111111111111111',
			mint: DEFAULT_GATE_MINT,
			minAmount: 5000,
			amount: 9000,
		});
		stubRows({ gate: [gateRow] });
		const { json } = await get(`id=${encodeURIComponent(ASSET)}&gate_token=${token}`);
		expect(json.locked).toBe(true);
		expect(json.glbUrl).toBeUndefined();
	});

	it('rejects a token minted for a different asset', async () => {
		const token = await signEmbedGateToken({
			gateId: GATE_ID,
			assetId: 'avatar:11111111-0000-4000-8000-000000000001',
			wallet: 'ThreeWsSyntheticTestWallet1111111111111111',
			mint: DEFAULT_GATE_MINT,
			minAmount: 5000,
			amount: 9000,
		});
		stubRows({ gate: [gateRow] });
		const { json } = await get(`id=${encodeURIComponent(ASSET)}&gate_token=${token}`);
		expect(json.locked).toBe(true);
	});
});

describe('a gated asset with a valid token', () => {
	it('unlocks the real glbUrl and says so', async () => {
		const token = await signEmbedGateToken({
			gateId: GATE_ID,
			assetId: ASSET,
			wallet: 'ThreeWsSyntheticTestWallet1111111111111111',
			mint: DEFAULT_GATE_MINT,
			minAmount: 5000,
			amount: 9000,
		});
		stubRows({ gate: [gateRow] });
		const { res, json } = await get(`id=${encodeURIComponent(ASSET)}&gate_token=${token}`);

		expect(res.statusCode).toBe(200);
		expect(json.gated).toBe(true);
		expect(json.unlocked).toBe(true);
		expect(json.locked).toBeUndefined();
		expect(json.glbUrl).toContain('avatars/nova.glb');
	});
});

describe('input validation', () => {
	it('400s a missing id before touching the database', async () => {
		stubRows();
		const { res, json } = await get('');
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('400s an id that is not one of the documented specs', async () => {
		stubRows();
		const { res } = await get('id=javascript:alert(1)');
		expect(res.statusCode).toBe(400);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('405s a method other than GET', async () => {
		const req = { method: 'POST', url: '/api/embed/resolve?id=x', headers: {} };
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(405);
	});
});
