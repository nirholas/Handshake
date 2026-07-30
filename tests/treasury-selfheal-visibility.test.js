// A self-heal that cannot heal has to say so, and it has to say WHICH failure
// it hit, because the two have opposite remediations.
//
// On 2026-07-29 the sponsor sat under its SOL settle floor for ~11 hours while
// 0.12 SOL sat reclaimable in platform agent wallets. Every Solana RPC lane was
// in quota cooldown, so reclaim's balance reads failed and no candidate was ever
// planned. Both reclaim legs return their readErrors and failed sends in the
// cron's HTTP response, and that response goes to Cloud Scheduler, which
// discards it: no log line, no alert, and (for the agent leg) no ledger row
// either. Six hours of app logs mentioned neither "reclaim" nor "rpc_error".
//
// So the operator-visible difference this pins down:
//   BLOCKED: could not read or could not send. The RPC tier is the problem and
//             it is free to fix. Sending funds would be the wrong move, and may
//             not even be needed: idle SOL may be sitting in unreadable wallets.
//   NOTHING: every source is genuinely at or below its floor. This is the only
//             case that needs the owner to spend money.
//
// Runs the real handler WITHOUT ?dry=1 (the alerts only fire on a live tick),
// with every money path mocked so nothing moves.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { MASTER, ENGINE } = vi.hoisted(() => ({
	MASTER: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW',
	ENGINE: 'EngineEngineEngineEngineEngineEngineEngine1',
}));

// Mutable per-test reclaim outcomes.
const legs = vi.hoisted(() => ({
	engine: { reclaimedSol: 0, moves: [], skipped: [], failed: [], readErrors: [] },
	agent: { reclaimedSol: 0, moves: [], skipped: [], failed: [], readErrors: [] },
}));

vi.mock('../api/_lib/solana-signers.js', () => ({
	SOLANA_SIGNERS: [
		{ name: 'economy-master', env: 'ECONOMY_MASTER_SECRET_BASE58', isMaster: true, minSol: 0.05, network: 'mainnet' },
	],
	resolveSignerPubkey: vi.fn(async () => ({ configured: true, pubkey: MASTER })),
}));

vi.mock('../api/_lib/economy-master.js', () => ({
	ECONOMY_MASTER_ADDRESS: MASTER,
	RESERVE_SOL: 0.05,
	RUN_CAP_SOL: 0.5,
	PER_TOPUP_MAX_SOL: 0.2,
	sweepTopUps: vi.fn(async () => ({
		configured: true, plan: [], skipped: [], rejected: [], funded: [], failed: [],
		spentSol: 0, masterSol: 0.0038, spendableSol: 0,
	})),
}));

vi.mock('../api/_lib/economy-ledger.js', () => ({ recordSweep: vi.fn(async () => ({ wrote: 0 })) }));
vi.mock('../api/_lib/economy-fuel.js', () => ({
	refuelMasterFromUsdc: vi.fn(async () => ({ acted: false, reason: 'no_spare_usdc' })),
}));
vi.mock('../api/_lib/economy-usdc-topup.js', () => ({
	topUpUsdcEngines: vi.fn(async () => ({ acted: false, reason: 'not_needed' })),
}));
vi.mock('../api/_lib/economy-sweepback.js', () => ({
	reclaimIdleSol: vi.fn(async () => legs.engine),
	reclaimIdleAgentSol: vi.fn(async () => legs.agent),
}));

const sendOpsAlert = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert }));

vi.mock('../api/_lib/solana/connection.js', () => ({
	// The master sits under RESERVE_SOL + operating headroom, so there is a real
	// deficit and both reclaim legs are reached. This is the 07-29 balance.
	solanaConnection: () => ({ getBalance: vi.fn(async () => 3_843_137) }),
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

async function runTick() {
	const res = mockRes();
	await handler(
		{
			method: 'POST',
			url: '/api/cron/treasury-topup',
			headers: { authorization: 'Bearer test-cron-secret' },
			socket: { remoteAddress: '127.0.0.1' },
		},
		res,
	);
	return JSON.parse(res._body);
}

const alertTitles = () => sendOpsAlert.mock.calls.map((c) => String(c[0]));
const alertFor = (needle) => sendOpsAlert.mock.calls.find((c) => String(c[0]).includes(needle));

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	sendOpsAlert.mockClear();
	legs.engine = { reclaimedSol: 0, moves: [], skipped: [], failed: [], readErrors: [] };
	legs.agent = { reclaimedSol: 0, moves: [], skipped: [], failed: [], readErrors: [] };
});

describe('treasury-topup surfaces a self-heal that could not run', () => {
	it('reports BLOCKED, and does not ask for money, when the RPC reads failed', () => {
		legs.agent = {
			reclaimedSol: 0, moves: [], skipped: [], failed: [],
			readErrors: [
				{ name: 'Atlas #22', reason: 'rpc_error: solana rpc 429 @ https://mainnet.helius-rpc.com' },
				{ name: 'Echo #22', reason: 'rpc_error: solana rpc 403 @ https://solana-rpc.publicnode.com' },
			],
		};
		return runTick().then(() => {
			const call = alertFor('BLOCKED');
			expect(call, `no BLOCKED alert in ${JSON.stringify(alertTitles())}`).toBeTruthy();
			expect(call[1]).toMatch(/2 balance read error\(s\)/);
			expect(call[1]).toMatch(/helius-rpc\.com/);
			// The whole point: an rpc_error must not read as "the wallets are dry".
			expect(call[1]).toMatch(/NOT that the wallets are dry/);
			expect(call[2]).toMatchObject({ signature: 'economy-selfheal-blocked' });
			// And it must NOT tell the operator to send funds.
			expect(alertTitles().join(' ')).not.toMatch(/nothing to reclaim/);
		});
	});

	it('reports BLOCKED when the reads worked but every send failed', async () => {
		legs.agent = {
			reclaimedSol: 0, moves: [], skipped: [], failed: [
				{ name: 'Atlas #22', sol: 0.068, reason: 'blockhash not found' },
			],
			readErrors: [],
		};
		await runTick();
		const call = alertFor('BLOCKED');
		expect(call).toBeTruthy();
		expect(call[1]).toMatch(/1 failed send\(s\)/);
		expect(call[1]).toMatch(/blockhash not found/);
	});

	it('reports NOTHING TO RECLAIM, the only case that needs owner funding', async () => {
		legs.engine = {
			reclaimedSol: 0, moves: [], failed: [], readErrors: [],
			skipped: [{ name: 'pump-x402-launcher', reason: 'at_or_below_floor' }],
		};
		legs.agent = {
			reclaimedSol: 0, moves: [], failed: [], readErrors: [],
			skipped: [
				{ name: 'three', reason: 'at_or_below_floor' },
				{ name: 'Swarm 5', reason: 'capital_committed' },
			],
		};
		await runTick();
		const call = alertFor('nothing to reclaim');
		expect(call, `no funding alert in ${JSON.stringify(alertTitles())}`).toBeTruthy();
		expect(call[1]).toMatch(/3 source\(s\) skipped/);
		expect(call[1]).toMatch(/send SOL to the economy master/);
		expect(call[2]).toMatchObject({ signature: 'economy-selfheal-nothing-to-reclaim' });
		expect(alertTitles().join(' ')).not.toMatch(/BLOCKED/);
	});

	it('stays quiet when the reclaim actually covered the deficit', async () => {
		// 0.2 SOL against a ~0.196 SOL deficit: healed, so neither alert fires.
		legs.agent = { reclaimedSol: 0.2, moves: [{ name: 'Atlas #22', address: 'x', sol: 0.2 }], skipped: [], failed: [], readErrors: [] };
		await runTick();
		expect(alertTitles().join(' ')).not.toMatch(/BLOCKED|nothing to reclaim/);
	});

	it('never fires on a dry run: a preview must not page anyone', async () => {
		legs.agent = {
			reclaimedSol: 0, moves: [], skipped: [], failed: [],
			readErrors: [{ name: 'Atlas #22', reason: 'rpc_error: solana rpc 429' }],
		};
		const res = mockRes();
		await handler(
			{
				method: 'POST',
				url: '/api/cron/treasury-topup?dry=1',
				headers: { authorization: 'Bearer test-cron-secret' },
				socket: { remoteAddress: '127.0.0.1' },
			},
			res,
		);
		expect(JSON.parse(res._body).dry_run).toBe(true);
		expect(alertTitles().join(' ')).not.toMatch(/BLOCKED|nothing to reclaim/);
	});
});
