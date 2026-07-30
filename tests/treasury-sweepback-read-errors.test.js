// Sweepback alerts when a transfer FAILS but, until now, said nothing when a
// wallet could not be READ. That asymmetry hides the exact failure the Solana
// RPC tier produces when every lane is in quota cooldown (2026-07-29): an
// unreadable wallet is neither swept nor listed as skipped, so the run looks
// clean while consolidating less than it should, and the master stays short.
//
// The alert has to say that an rpc_error is NOT an empty wallet, because the two
// lead to opposite actions (fix the RPC tier vs send funds).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above module scope, so anything they close over
// has to be hoisted too.
const { MASTER } = vi.hoisted(() => ({ MASTER: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW' }));

const result = vi.hoisted(() => ({
	current: {
		master: 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW',
		masterSolBefore: 0.0038,
		masterSolAfter: 0.0038,
		sweptSol: 0,
		sweptTokens: [],
		receivedSol: 0,
		failed: [],
		skipped: [],
		readErrors: [],
	},
}));

vi.mock('../api/_lib/economy-sweepback.js', () => ({ sweepBack: vi.fn(async () => result.current) }));
vi.mock('../api/_lib/economy-master.js', () => ({ ECONOMY_MASTER_ADDRESS: MASTER }));
vi.mock('../api/_lib/economy-ledger.js', () => ({
	recordSweepback: vi.fn(async () => ({ wrote: 1, skippedWrite: null })),
}));

const sendOpsAlert = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert }));

import handler from '../api/cron/treasury-sweepback.js';

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

async function run() {
	const res = mockRes();
	await handler(
		{
			method: 'POST',
			url: '/api/cron/treasury-sweepback',
			headers: { authorization: 'Bearer test-cron-secret', host: 'three.ws' },
			socket: { remoteAddress: '127.0.0.1' },
		},
		res,
	);
	return JSON.parse(res._body);
}

const titles = () => sendOpsAlert.mock.calls.map((c) => String(c[0]));
const alertFor = (needle) => sendOpsAlert.mock.calls.find((c) => String(c[0]).includes(needle));

beforeEach(() => {
	process.env.CRON_SECRET = 'test-cron-secret';
	sendOpsAlert.mockClear();
	result.current = {
		master: MASTER, masterSolBefore: 0.0038, masterSolAfter: 0.0038,
		sweptSol: 0, sweptTokens: [], receivedSol: 0, failed: [], skipped: [], readErrors: [],
	};
});

describe('treasury-sweepback surfaces wallets it could not read', () => {
	it('alerts once for unreadable wallets and calls the sweep incomplete', async () => {
		result.current.readErrors = [
			{ name: 'a2a-payer', pubkey: 'Huch5SM1bw6jXPJR5HA21k8aNYF4h1LRjfbJH6XLmh6Z', reason: 'rpc_error: solana rpc 429 @ https://mainnet.helius-rpc.com' },
			{ name: 'pump-x402-launcher', pubkey: 'x', reason: 'rpc_error: solana rpc 403 @ https://solana-rpc.publicnode.com' },
			{ name: 'coin-launcher-master', pubkey: 'y', reason: 'rpc_error: solana rpc 503' },
		];
		const body = await run();
		expect(body.ok).toBe(true);

		const call = alertFor('could not read');
		expect(call, `no read-error alert in ${JSON.stringify(titles())}`).toBeTruthy();
		expect(call[0]).toMatch(/3 wallet\(s\)/);
		expect(call[1]).toMatch(/INCOMPLETE/);
		expect(call[1]).toMatch(/a2a-payer/);
		// The distinction that decides what an operator does next.
		expect(call[1]).toMatch(/not that the wallets are empty/);
		// ONE alert, not one per wallet: a dark RPC tier must not become a storm.
		expect(titles().filter((t) => t.includes('could not read'))).toHaveLength(1);
		expect(call[2]).toMatchObject({ signature: 'economy-sweepback-read-errors' });
	});

	it('stays quiet when every wallet was readable', async () => {
		result.current.receivedSol = 0.4;
		const body = await run();
		expect(body.ok).toBe(true);
		expect(titles().join(' ')).not.toMatch(/could not read/);
	});

	it('still alerts per failed transfer, and separately from read errors', async () => {
		result.current.failed = [{ name: 'a2a-payer', pubkey: 'Huch5', sol: 0.02, reason: 'blockhash not found' }];
		result.current.readErrors = [{ name: 'three', pubkey: 'z', reason: 'rpc_error: solana rpc 429' }];
		await run();
		expect(alertFor('transfer failed')).toBeTruthy();
		expect(alertFor('could not read')).toBeTruthy();
	});

	it('tolerates a result with no readErrors field at all', async () => {
		delete result.current.readErrors;
		const body = await run();
		expect(body.ok).toBe(true);
		expect(titles().join(' ')).not.toMatch(/could not read/);
	});
});
