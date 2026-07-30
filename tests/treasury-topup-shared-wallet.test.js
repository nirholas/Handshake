// Two registry entries whose secrets resolve to the SAME wallet must be topped
// up once, judged against the STRICTEST of their specs.
//
// Production hit the opposite on 2026-07-30: the circulation treasury (floor
// 0.2 SOL, refill 0.5) shared a wallet with pump-cron-relayer (floor 0.01),
// and the first-spec-wins dedupe kept only the relayer's trivial floor. The
// shared wallet sat at 0.012 SOL (above 0.01, far below 0.2), so it was never
// a refill target, the sweep's deficit read zero, the USDC→SOL fuel lane never
// fired, and the circulation engine ran free-actions-only: the Money Pulse
// showed reviews and trials but no tips, payments, trades, or launches.
//
// Exercised through the real handler in ?dry=1 mode: same signer resolution and
// target building as a live sweep, no SOL movement, no alerts, no ledger.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { MASTER, SHARED, LONER } = vi.hoisted(() => ({
	MASTER: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW',
	SHARED: 'SharedSharedSharedSharedSharedSharedShared1',
	LONER: 'EngineEngineEngineEngineEngineEngineEngine1',
}));

vi.mock('../api/_lib/solana-signers.js', () => ({
	SOLANA_SIGNERS: [
		{ name: 'economy-master', env: 'ECONOMY_MASTER_SECRET_BASE58', isMaster: true, minSol: 0.05, network: 'mainnet' },
		// The permissive spec resolves FIRST: the regression this test pins is
		// its low floor shadowing the strict spec below.
		{ name: 'pump-cron-relayer', env: 'PUMP_RELAYER_SECRET', minSol: 0.01, network: 'mainnet' },
		{ name: 'circulation-treasury', env: 'CIRCULATION_TREASURY_SECRET', minSol: 0.2, refillTo: 0.5, network: 'mainnet' },
		{ name: 'a2a-payer', env: 'A2A_PAYER_SECRET', minSol: 0.02, network: 'mainnet' },
	],
	resolveSignerPubkey: vi.fn(async (spec) => {
		if (spec.name === 'a2a-payer') return { configured: true, pubkey: LONER };
		if (spec.isMaster) return { configured: true, pubkey: MASTER };
		// The shared-wallet condition under test: relayer and circulation
		// treasury secrets decode to the same pubkey.
		return { configured: true, pubkey: SHARED };
	}),
}));

vi.mock('../api/_lib/economy-master.js', () => ({
	ECONOMY_MASTER_ADDRESS: MASTER,
	RESERVE_SOL: 0.05,
	RUN_CAP_SOL: 0.5,
	PER_TOPUP_MAX_SOL: 0.2,
	sweepTopUps: vi.fn(async ({ targets }) => ({
		configured: true,
		plan: targets.map((t) => ({ name: t.name, pubkey: t.pubkey, sol: 0.1 })),
		skipped: [],
		rejected: [],
		funded: [],
		failed: [],
		spentSol: 0,
		masterSol: 0.02,
		spendableSol: 0,
	})),
}));

vi.mock('../api/_lib/economy-ledger.js', () => ({ recordSweep: vi.fn(async () => ({ wrote: 0 })) }));
vi.mock('../api/_lib/economy-fuel.js', () => ({
	refuelMasterFromUsdc: vi.fn(async () => ({ acted: false, reason: 'no_spare_usdc' })),
}));
vi.mock('../api/_lib/economy-usdc-topup.js', () => ({
	topUpUsdcEngines: vi.fn(async () => ({ funded: [], skipped: [], failed: [] })),
}));
vi.mock('../api/_lib/economy-sweepback.js', () => ({
	reclaimIdleSol: vi.fn(async () => ({ reclaimedSol: 0, moves: [], skipped: [], failed: [] })),
	reclaimIdleAgentSol: vi.fn(async () => ({ reclaimedSol: 0, moves: [], skipped: [], failed: [] })),
}));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn(async () => {}) }));
vi.mock('../api/_lib/solana/connection.js', () => ({
	// 0.012 SOL everywhere: above the relayer's 0.01 floor, below the
	// circulation treasury's 0.2 and the loner's 0.02.
	solanaConnection: () => ({ getBalance: vi.fn(async () => 12_214_000) }),
}));

import handler from '../api/cron/treasury-topup.js';

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: null,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; this.writableEnded = true; },
		writableEnded: false,
		headersSent: false,
	};
}

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
});

describe('treasury-topup shared-wallet floors', () => {
	it('judges a shared wallet against the strictest spec and tops it up once', async () => {
		const res = mockRes();
		await handler(
			{
				method: 'GET',
				url: '/api/cron/treasury-topup?dry=1',
				headers: { authorization: 'Bearer test-cron-secret' },
				socket: { remoteAddress: '127.0.0.1' },
			},
			res,
		);

		const body = JSON.parse(res._body);
		expect(body.ok).toBe(true);
		expect(body.dry_run).toBe(true);

		// The shared wallet appears exactly once, under the merged name, with the
		// strictest floor's refill target, not silently dropped by the relayer's
		// 0.01 floor.
		const shared = body.targets.filter((t) => t.pubkey === SHARED);
		expect(shared).toHaveLength(1);
		expect(shared[0].name).toBe('pump-cron-relayer+circulation-treasury');
		expect(shared[0].refillToSol).toBe(0.5);
		expect(shared[0].currentSol).toBeCloseTo(0.012214, 6);

		// The unshared under-floor engine is still its own target.
		expect(body.targets.some((t) => t.pubkey === LONER && t.name === 'a2a-payer')).toBe(true);
	});
});
