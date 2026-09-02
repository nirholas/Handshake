// The agent-reclaim leg's plan-only mode (reclaimIdleAgentSol in
// api/_lib/economy-sweepback.js).
//
// `POST /api/cron/treasury-topup?dry=1` is the one command every triage path
// points at to decide whether the treasury can self-heal or whether the owner
// has to move SOL. It used to answer from planAgentReclaim() alone, without ever
// touching a wallet key, so the 8 custodial wallets sealed under the retired
// WALLET_ENCRYPTION_KEY (0.49 SOL, of which 0.35 is customer money) were
// advertised as reclaimable on every run. The real leg then failed all of them
// at the recover stage, and the next reader saw the same plan again.
//
// Two sessions on 2026-08-01 read that plan and concluded "the */30 cron
// self-heals from here". It could not. So the property under test is that the
// dry run reports only SOL that a real run could actually move: a wallet whose
// secret does not decrypt is `failed` at stage `recover`, never a `move`, and
// never counted in `reclaimedSol`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';

const { OPEN, SEALED, IMPOSTOR } = vi.hoisted(() => ({
	OPEN: 'open-secret',
	SEALED: 'sealed-secret',
	IMPOSTOR: 'impostor-secret',
}));

const rows = vi.hoisted(() => ({ current: [] }));
const sendSol = vi.hoisted(() => vi.fn(async () => 'live-signature'));
const recordEvent = vi.hoisted(() => vi.fn());

// The keypair each secret opens to. `sealed` throws the exact WebCrypto error a
// record encrypted under a retired key produces; `impostor` decrypts fine but
// yields a different pubkey than the row claims.
const KEYS = vi.hoisted(() => ({ current: new Map() }));

vi.mock('../api/_lib/db.js', () => ({ sql: async () => rows.current }));
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	sendSol: (...args) => sendSol(...args),
	LAMPORTS_PER_SOL: 1_000_000_000,
}));
vi.mock('../api/_lib/solana-signers.js', () => ({ SOLANA_SIGNERS: [], loadSignerKeypair: async () => ({ configured: false }) }));
vi.mock('../api/_lib/execution-engine.js', () => ({ submitProtected: async () => ({ signature: 'x' }) }));
vi.mock('../api/_lib/agent-wallet.js', () => ({
	recoverSolanaAgentKeypair: async (secret, audit) => {
		if (secret === SEALED) throw new Error('The operation failed for an operation-specific reason.');
		const kp = KEYS.current.get(secret);
		if (!kp) throw new Error(`no key for ${secret}`);
		// The real implementation audits only AFTER the decrypt succeeds.
		if (audit?.agentId) recordEvent(audit);
		return kp;
	},
}));

const { reclaimIdleAgentSol, PLATFORM_AGENT_OWNER_EMAIL } = await import('../api/_lib/economy-sweepback.js');

const openKp = Keypair.generate();
const impostorKp = Keypair.generate();
// A real base58 pubkey: the sealed wallet is on chain and readable, it is only
// its stored secret that no key in the fleet opens.
const SEALED_ADDRESS = Keypair.generate().publicKey.toBase58();

// Balances are well clear of every floor so the ONLY thing that can remove a
// wallet from the plan is the key gate this test is about.
function agentRow(id, name, address, secret, sol) {
	return {
		agent_id: id,
		name,
		address,
		secret,
		owner: PLATFORM_AGENT_OWNER_EMAIL,
		strategy_enabled: false,
		per_trade_lamports: null,
		auto_fund_enabled: false,
		open_positions: 0,
		__sol: sol,
	};
}

function connectionFor(list) {
	const byAddress = new Map(list.map((r) => [r.address, r.__sol]));
	return { getBalance: async (pk) => Math.round((byAddress.get(pk.toBase58()) ?? 0) * 1_000_000_000) };
}

beforeEach(() => {
	sendSol.mockClear();
	recordEvent.mockClear();
	KEYS.current = new Map([
		[OPEN, openKp],
		[IMPOSTOR, impostorKp],
	]);
	rows.current = [
		agentRow('ag-open', 'bot-open', openKp.publicKey.toBase58(), OPEN, 0.5),
		agentRow('ag-sealed', 'bot-sealed', SEALED_ADDRESS, SEALED, 0.4),
	];
});

describe('agent reclaim dry run: the plan is only what a real run could move', () => {
	it('does not count a wallet whose secret cannot be decrypted', async () => {
		const res = await reclaimIdleAgentSol({ connection: connectionFor(rows.current), dryRun: true });

		expect(res.moves.map((m) => m.name)).toEqual(['bot-open']);
		expect(res.moves.every((m) => m.dryRun === true)).toBe(true);
		const sealed = res.failed.find((f) => f.name === 'bot-sealed');
		expect(sealed?.stage).toBe('recover');
		expect(sealed?.reason).toMatch(/^secret_undecryptable/);
	});

	it('reports reclaimedSol as the reachable SOL, not the planned SOL', async () => {
		const res = await reclaimIdleAgentSol({ connection: connectionFor(rows.current), dryRun: true });
		// The sealed wallet's SOL is real and visible on chain, and it is still
		// unreachable. Summing the plan instead of the openable wallets is what made
		// two operators believe the treasury had capital it could not spend.
		const unreachable = res.failed.reduce((s, f) => s + f.sol, 0);
		expect(unreachable).toBeGreaterThan(0);
		expect(res.reclaimedSol).toBe(res.moves.reduce((s, m) => s + m.sol, 0));
		expect(res.reclaimedSol).toBe(res.moves[0].sol);
	});

	it('a fleet where every wallet is sealed plans nothing at all', async () => {
		rows.current = [agentRow('ag-sealed', 'bot-sealed', SEALED_ADDRESS, SEALED, 0.9)];
		const res = await reclaimIdleAgentSol({ connection: connectionFor(rows.current), dryRun: true });

		// This is the shape that must reach the owner as "fund the sponsor", not as
		// "the cron will handle it".
		expect(res.moves).toEqual([]);
		expect(res.reclaimedSol).toBe(0);
		expect(res.failed).toHaveLength(1);
	});

	it('drops a wallet whose key opens to a different address', async () => {
		rows.current = [agentRow('ag-imp', 'bot-impostor', openKp.publicKey.toBase58(), IMPOSTOR, 0.6)];
		const res = await reclaimIdleAgentSol({ connection: connectionFor(rows.current), dryRun: true });

		expect(res.moves).toEqual([]);
		expect(res.failed[0]).toMatchObject({ stage: 'recover', reason: 'keypair_address_mismatch' });
	});

	it('signs and broadcasts nothing, and writes no custody row', async () => {
		await reclaimIdleAgentSol({ connection: connectionFor(rows.current), dryRun: true });

		expect(sendSol).not.toHaveBeenCalled();
		// The real leg's decrypt is a custody event worth a row. A plan-only read
		// runs on the every-minute economy tick, so auditing it would bury the
		// genuine key uses under thousands of inspections.
		expect(recordEvent).not.toHaveBeenCalled();
	});

	it('the real run still audits its decrypts and moves the openable wallet', async () => {
		const res = await reclaimIdleAgentSol({ connection: connectionFor(rows.current), dryRun: false });

		expect(res.moves.map((m) => m.name)).toEqual(['bot-open']);
		expect(res.moves[0].signature).toBe('live-signature');
		expect(sendSol).toHaveBeenCalledTimes(1);
		expect(recordEvent).toHaveBeenCalledTimes(1);
		expect(recordEvent.mock.calls[0][0]).toMatchObject({ agentId: 'ag-open', reason: 'economy_reclaim' });
	});

	it('dry and real runs agree on which wallets are unreachable', async () => {
		const dry = await reclaimIdleAgentSol({ connection: connectionFor(rows.current), dryRun: true });
		const real = await reclaimIdleAgentSol({ connection: connectionFor(rows.current), dryRun: false });

		// The parity that makes ?dry=1 worth reading at all.
		expect(dry.moves.map((m) => m.address)).toEqual(real.moves.map((m) => m.address));
		expect(dry.failed.map((f) => [f.name, f.stage])).toEqual(real.failed.map((f) => [f.name, f.stage]));
		expect(dry.reclaimedSol).toBe(real.reclaimedSol);
	});
});
