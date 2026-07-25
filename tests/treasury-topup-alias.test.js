// A signer whose secret resolves to the economy master's own wallet must never
// become a refill target.
//
// Production hit this for three days in July 2026: THREE_BUYBACK_SECRET_KEY_B64
// held the master's keypair, so every 30-minute sweep listed "three-buyback" as
// an underfunded engine, filterToRegistry refused the master-to-itself transfer,
// and the paired alerts ("could not refill 3 engine(s)" / "blocked an
// off-registry target (is_master)") re-fired ~10k times each while the count of
// genuinely dry engines read one too high. The alias is a standing config
// condition, not a per-sweep event: it belongs in `master_aliased`, out of
// `targets`, and in one info alert, not two warn storms.
//
// Exercised through the real handler in ?dry=1 mode: same signer resolution and
// target building as a live sweep, no SOL movement, no alerts, no ledger.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { MASTER, ENGINE } = vi.hoisted(() => ({
	MASTER: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW',
	ENGINE: 'EngineEngineEngineEngineEngineEngineEngine1',
}));

vi.mock('../api/_lib/solana-signers.js', () => ({
	SOLANA_SIGNERS: [
		{ name: 'economy-master', env: 'ECONOMY_MASTER_SECRET_BASE58', isMaster: true, minSol: 0.05, network: 'mainnet' },
		{ name: 'three-buyback', env: 'THREE_BUYBACK_SECRET_KEY_B64', minSol: 0.05, network: 'mainnet' },
		{ name: 'pump-cron-relayer', env: 'PUMP_RELAYER_SECRET', minSol: 0.05, network: 'mainnet' },
	],
	resolveSignerPubkey: vi.fn(async (spec) => {
		// The alias under test: three-buyback's secret decodes to the MASTER wallet.
		if (spec.name === 'three-buyback') return { configured: true, pubkey: MASTER };
		if (spec.name === 'pump-cron-relayer') return { configured: true, pubkey: ENGINE };
		return { configured: true, pubkey: MASTER };
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
vi.mock('../api/_lib/economy-sweepback.js', () => ({
	reclaimIdleSol: vi.fn(async () => ({ reclaimedSol: 0, moves: [], skipped: [], failed: [] })),
}));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn(async () => {}) }));
vi.mock('../api/_lib/solana/connection.js', () => ({
	// Every wallet reads under-floor so both candidate specs would qualify as
	// targets if the alias guard failed.
	solanaConnection: () => ({ getBalance: vi.fn(async () => 10_000_000) }),
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

describe('treasury-topup master aliasing', () => {
	it('excludes a master-aliased signer from refill targets and reports it', async () => {
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

		// The alias is surfaced, not treated as a dry engine.
		expect(body.master_aliased).toEqual(['three-buyback']);
		expect(body.targets.map((t) => t.name)).toEqual(['pump-cron-relayer']);
		expect(body.targets.some((t) => t.pubkey === MASTER)).toBe(false);
	});
});
