// getWalletBaseBalance: when is a zero balance actually proof the bag is gone?
//
// The caller treats a zero from this function as proof, and parks the position as
// an unreconcilable "vanished bag" that holds its arm's concurrency slot. So a
// zero manufactured from a bad RPC response freezes a healthy position that still
// holds real tokens. Observed in production on a degraded RPC lane: positions
// still being quoted at a real value, marked reconcile_pending, arms stopped.
//
// The connection is a stub, so these are deterministic and make no network calls.

import { describe, it, expect, vi } from 'vitest';
import * as web3 from '@solana/web3.js';

vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(async () => []) }));
vi.mock('../workers/agent-sniper/log.js', () => ({
	log: { warn: vi.fn(), info: vi.fn(), trade: vi.fn() },
}));

const { getWalletBaseBalance, deriveTokenAccounts } = await import('../workers/agent-sniper/reconcile.js');

const MINT = 'ExiTg3av96nbrpAyBMgbAEdGoY8d95jh1EqwdLL6pump';
const OWNER = new web3.PublicKey('HTcNUMcxGDXQPJDspfhf8kCCwVwnHZzzDbEMsPz1w99D');

// A stub matching only the three methods the reader uses.
function ctxWith({ parsed, accountInfo = () => null, tokenBalance = () => null }) {
	return {
		web3,
		connection: {
			getParsedTokenAccountsByOwner: async () => {
				if (typeof parsed === 'function') return parsed();
				return parsed;
			},
			getAccountInfo: async (pk) => accountInfo(pk),
			getTokenAccountBalance: async (pk) => tokenBalance(pk),
		},
	};
}

const parsedAccount = (amount) => ({
	pubkey: web3.Keypair.generate().publicKey,
	account: { data: { parsed: { info: { tokenAmount: { amount: String(amount) } } } } },
});

describe('getWalletBaseBalance', () => {
	it('sums a populated account list', async () => {
		const ctx = ctxWith({ parsed: { value: [parsedAccount(1000), parsedAccount(234)] } });
		expect(await getWalletBaseBalance(ctx, OWNER, MINT)).toBe(1234n);
	});

	it('returns null when the RPC throws', async () => {
		const ctx = ctxWith({ parsed: () => { throw new Error('429 rate limited'); } });
		expect(await getWalletBaseBalance(ctx, OWNER, MINT)).toBe(null);
	});

	it('returns null for a malformed response instead of reading it as zero', async () => {
		// The regression: `res?.value || []` summed these to 0n, which the caller
		// treats as proof the bag is gone.
		for (const parsed of [undefined, null, {}, { value: null }, { value: 'nope' }]) {
			expect(await getWalletBaseBalance(ctxWith({ parsed }), OWNER, MINT)).toBe(null);
		}
	});

	it('trusts an empty list only after the derived accounts confirm it', async () => {
		const ctx = ctxWith({ parsed: { value: [] }, accountInfo: () => null });
		expect(await getWalletBaseBalance(ctx, OWNER, MINT)).toBe(0n);
	});

	it('reports the real balance when an empty list is contradicted by a live account', async () => {
		// A lagging node serving an empty list for a wallet that still holds the bag.
		const [firstAta] = deriveTokenAccounts(ctx0(), OWNER, new web3.PublicKey(MINT));
		const ctx = ctxWith({
			parsed: { value: [] },
			accountInfo: (pk) => (pk.equals(firstAta) ? { lamports: 2039280 } : null),
			tokenBalance: (pk) => (pk.equals(firstAta) ? { value: { amount: '214789578469' } } : null),
		});
		expect(await getWalletBaseBalance(ctx, OWNER, MINT)).toBe(214789578469n);
	});

	it('returns null when a live account balance cannot be read', async () => {
		const [firstAta] = deriveTokenAccounts(ctx0(), OWNER, new web3.PublicKey(MINT));
		const ctx = ctxWith({
			parsed: { value: [] },
			accountInfo: (pk) => (pk.equals(firstAta) ? { lamports: 2039280 } : null),
			tokenBalance: () => ({ value: {} }),
		});
		expect(await getWalletBaseBalance(ctx, OWNER, MINT)).toBe(null);
	});

	it('returns null when confirming an empty list throws', async () => {
		const ctx = ctxWith({
			parsed: { value: [] },
			accountInfo: () => { throw new Error('node behind'); },
		});
		expect(await getWalletBaseBalance(ctx, OWNER, MINT)).toBe(null);
	});

	it('counts an existing but empty token account as gone', async () => {
		const ctx = ctxWith({
			parsed: { value: [] },
			accountInfo: () => ({ lamports: 2039280 }),
			tokenBalance: () => ({ value: { amount: '0' } }),
		});
		expect(await getWalletBaseBalance(ctx, OWNER, MINT)).toBe(0n);
	});
});

describe('deriveTokenAccounts', () => {
	it('derives one address per token program, deterministically', () => {
		const mintPk = new web3.PublicKey(MINT);
		const a = deriveTokenAccounts(ctx0(), OWNER, mintPk);
		const b = deriveTokenAccounts(ctx0(), OWNER, mintPk);
		expect(a).toHaveLength(2);
		expect(a[0].toBase58()).not.toBe(a[1].toBase58());
		expect(a.map((k) => k.toBase58())).toEqual(b.map((k) => k.toBase58()));
	});
});

function ctx0() {
	return { web3 };
}
