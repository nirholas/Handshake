// submitProtected — engine-primitive tests for the two behaviors that 19 money
// paths now depend on after migrating off hand-rolled send/confirm:
//   1. It strips any caller-supplied ComputeBudget instructions and sets exactly
//      its own (a duplicate ComputeBudget ix makes the runtime reject the tx).
//   2. It signs with the fee-payer PLUS any opts.extraSigners (e.g. a mint).
// The Connection is a hand-built mock — no RPC. We capture the raw bytes handed
// to sendRawTransaction and deserialize them to assert on the real wire tx.

import { describe, it, expect, vi } from 'vitest';
import {
	Keypair,
	PublicKey,
	VersionedTransaction,
	SystemProgram,
	ComputeBudgetProgram,
	TransactionInstruction,
} from '@solana/web3.js';
import { submitProtected } from '../api/_lib/execution-engine.js';

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

function mockConnection(captured) {
	return {
		getLatestBlockhash: vi.fn(async () => ({
			blockhash: '11111111111111111111111111111111',
			lastValidBlockHeight: 1000,
		})),
		simulateTransaction: vi.fn(async () => ({ value: { err: null, unitsConsumed: 50_000, logs: [] } })),
		getRecentPrioritizationFees: vi.fn(async () => [{ prioritizationFee: 1000 }]),
		sendRawTransaction: vi.fn(async (raw) => {
			captured.raw = raw;
			return 'sigSENT';
		}),
		// HTTP-polling confirm reads getSignatureStatuses (plural); getSignatureStatus
		// (singular) backs the ambiguous-timeout re-check path.
		getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed', slot: 7 }], context: { slot: 7 } })),
		getSignatureStatus: vi.fn(async () => ({ value: { err: null, confirmationStatus: 'confirmed', slot: 7 } })),
		getBlockHeight: vi.fn(async () => 10),
	};
}

function decodeSent(captured) {
	const vtx = VersionedTransaction.deserialize(captured.raw);
	const keys = vtx.message.staticAccountKeys.map((k) => k.toBase58());
	const programIds = vtx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
	const nonEmptySigs = vtx.signatures.filter((s) => s.some((b) => b !== 0)).length;
	return { vtx, programIds, nonEmptySigs };
}

describe('submitProtected', () => {
	it('strips caller ComputeBudget ixs and sets exactly one limit + one price', async () => {
		const captured = {};
		const conn = mockConnection(captured);
		const payer = Keypair.generate();
		const dest = Keypair.generate().publicKey;
		// Caller passes its OWN compute-budget ixs plus a transfer — they must be dropped.
		const instructions = [
			ComputeBudgetProgram.setComputeUnitLimit({ units: 999_999 }),
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12345 }),
			SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 1000 }),
		];
		const res = await submitProtected({ network: 'mainnet', connection: conn, payer, instructions });
		// The returned signature is the tx's own derived signature, not the RPC echo.
		expect(typeof res.signature).toBe('string');
		expect(res.signature.length).toBeGreaterThan(40);
		expect(conn.sendRawTransaction).toHaveBeenCalled();

		const { programIds } = decodeSent(captured);
		const cbCount = programIds.filter((p) => p === COMPUTE_BUDGET_PROGRAM).length;
		// Exactly the engine's two (limit + price) — the caller's duplicates are gone.
		expect(cbCount).toBe(2);
		// The transfer survived.
		expect(programIds).toContain('11111111111111111111111111111111');
	});

	it('races the protected lane against the Jito bundle instead of waiting out the poll window', async () => {
		// Jito lane: sendBundle accepts, then statuses stay pending forever; tip
		// floor endpoint 404s (engine falls back to the mode floor). Chain status
		// confirms instantly, so the protected lane should land within ms while the
		// serial flow would have burned the first 700ms bundle-poll sleep and
		// returned a jito route label.
		const fetchMock = vi.fn(async (url, init) => {
			if (String(url).includes('tip_floor')) return { ok: false, status: 404, text: async () => '' };
			const body = init?.body ? JSON.parse(init.body) : {};
			if (body.method === 'sendBundle') return { ok: true, json: async () => ({ result: 'bundle-1' }) };
			return { ok: true, json: async () => ({ result: { value: [{ status: 'Pending' }] } }) };
		});
		vi.stubGlobal('fetch', fetchMock);
		try {
			const captured = {};
			const conn = mockConnection(captured);
			const payer = Keypair.generate();
			const dest = Keypair.generate().publicKey;
			const t0 = Date.now();
			const res = await submitProtected({
				network: 'mainnet',
				connection: conn,
				payer,
				instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports: 1000 })],
				opts: { tipMode: 'economy' },
			});
			expect(res.route).toBe('protected');
			expect(res.fallbackReason).toBeTruthy();
			expect(conn.sendRawTransaction).toHaveBeenCalled();
			// Well under one bundle-poll sleep: the lanes ran in parallel.
			expect(Date.now() - t0).toBeLessThan(700);
			// The economy tip transfer still rode along on the protected tx.
			expect(res.tipLamports).toBeGreaterThan(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('signs with the fee-payer plus extraSigners', async () => {
		const captured = {};
		const conn = mockConnection(captured);
		const payer = Keypair.generate();
		const extra = Keypair.generate();
		// An instruction that requires `extra` to sign (extra is a signer account).
		const ix = new TransactionInstruction({
			programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
			keys: [{ pubkey: extra.publicKey, isSigner: true, isWritable: false }],
			data: Buffer.from('hi'),
		});
		await submitProtected({
			network: 'mainnet',
			connection: conn,
			payer,
			instructions: [ix],
			opts: { extraSigners: [extra] },
		});
		const { nonEmptySigs } = decodeSent(captured);
		// Both the fee-payer and the extra signer produced signatures.
		expect(nonEmptySigs).toBe(2);
	});

	it('throws SIM_FAILED when the pre-broadcast simulation reverts', async () => {
		const captured = {};
		const conn = mockConnection(captured);
		conn.simulateTransaction = vi.fn(async () => ({ value: { err: { InstructionError: [0, 'Custom'] }, logs: [] } }));
		const payer = Keypair.generate();
		const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
		await expect(
			submitProtected({ network: 'mainnet', connection: conn, payer, instructions: [ix] }),
		).rejects.toMatchObject({ code: 'SIM_FAILED' });
		expect(conn.sendRawTransaction).not.toHaveBeenCalled();
	});
});
