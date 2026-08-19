// The $THREE deploy fee: tier math, fee resolution, and the on-chain shape of
// the fee instruction.
//
// The fee moves real money, so the rules it obeys are pinned here:
//   • devnet never pays, and a disabled/zero fee never pays
//   • the discount comes from a live balance, and an unreadable balance charges
//     standard rather than silently waiving
//   • the fee is ONE System Program transfer, and it sits in the SAME
//     transaction as `create`, so a mint that fails costs nothing
//
// Offline: no RPC, no fetch. The Umi instance is built read-only with a noop
// signer, and every balance read is stubbed.
//
// Run: node --test packages/metaplex-agent-mcp/test/three-fee.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNoopSigner, publicKey as umiPublicKey, signerIdentity } from '@metaplex-foundation/umi';

import { buildUmi, LAMPORTS_PER_SOL } from '../src/lib/solana.js';
import { buildAgentMint } from '../src/lib/mint.js';
import { feeSchedule, tierFor, nextTier, resolveDeployFee } from '../src/lib/three.js';

const WALLET = 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const MINT_ARGS = {
	network: 'mainnet',
	creator: WALLET,
	name: 'Astra',
	description: 'An autonomous 3D agent',
	image: 'https://example.com/astra.png',
	modelUrl: 'https://example.com/astra.glb',
};

/** A read-only Umi with a noop identity and a stubbed token-balance RPC. */
function umiWithThree(tokens, { fail = false } = {}) {
	const umi = buildUmi({ network: 'mainnet' });
	umi.use(signerIdentity(createNoopSigner(umiPublicKey(WALLET))));
	umi.rpc.call = async () => {
		if (fail) throw new Error('rpc unavailable');
		return {
			value: [
				{
					account: {
						data: { parsed: { info: { tokenAmount: { amount: String(Math.round(tokens * 1e6)) } } } },
					},
				},
			],
		};
	};
	return umi;
}

test('tiers key off the configured thresholds', () => {
	const s = feeSchedule();
	assert.equal(tierFor(0).tier, 'standard');
	assert.equal(tierFor(s.half_price_at_three - 1).tier, 'standard');
	assert.equal(tierFor(s.half_price_at_three).tier, 'holder_half');
	assert.equal(tierFor(s.free_at_three - 1).tier, 'holder_half');
	assert.equal(tierFor(s.free_at_three).tier, 'holder_free');
	assert.equal(tierFor(s.free_at_three * 10).multiplier, 0);
});

test('next_tier names what the wallet is short, and disappears at the top', () => {
	const s = feeSchedule();
	assert.deepEqual(nextTier(0), {
		tier: 'holder_half',
		at_three: s.half_price_at_three,
		need_three: s.half_price_at_three,
	});
	assert.equal(nextTier(s.half_price_at_three).tier, 'holder_free');
	assert.equal(nextTier(s.free_at_three), null);
});

test('devnet is free', async () => {
	const fee = await resolveDeployFee(umiWithThree(0), { network: 'devnet', payer: WALLET });
	assert.equal(fee.lamports, 0);
	assert.equal(fee.tier, 'devnet');
	assert.equal(fee.wallet, null);
});

test('a non-holder pays the standard fee to the fee wallet', async () => {
	const s = feeSchedule();
	const fee = await resolveDeployFee(umiWithThree(0), { network: 'mainnet', payer: WALLET });
	assert.equal(fee.lamports, s.standard_lamports);
	assert.equal(fee.tier, 'standard');
	assert.equal(fee.wallet, s.fee_wallet);
});

test('holding $THREE halves the fee, then waives it', async () => {
	const s = feeSchedule();
	const half = await resolveDeployFee(umiWithThree(s.half_price_at_three), { network: 'mainnet', payer: WALLET });
	assert.equal(half.lamports, Math.round(s.standard_lamports / 2));
	assert.equal(half.tier, 'holder_half');

	const free = await resolveDeployFee(umiWithThree(s.free_at_three), { network: 'mainnet', payer: WALLET });
	assert.equal(free.lamports, 0);
	assert.equal(free.tier, 'holder_free');
	assert.equal(free.wallet, null, 'a waived fee names no recipient');
});

test('an unreadable balance charges standard and says why', async () => {
	const s = feeSchedule();
	const fee = await resolveDeployFee(umiWithThree(0, { fail: true }), { network: 'mainnet', payer: WALLET });
	assert.equal(fee.lamports, s.standard_lamports);
	assert.equal(fee.tier, 'standard');
	assert.match(fee.three_balance_error, /rpc unavailable/);
	assert.equal(fee.three_tokens, null);
});

test('the fee is one System transfer inside the create transaction', () => {
	const umi = umiWithThree(0);
	const lamports = Math.round(0.02 * LAMPORTS_PER_SOL);
	const mint = buildAgentMint(umi, { ...MINT_ARGS, feeLamports: lamports, feeWallet: WALLET });

	const createIxs = mint.createBuilder.getInstructions();
	assert.equal(createIxs.length, 2, 'transfer + create');
	assert.equal(createIxs[0].programId.toString(), SYSTEM_PROGRAM);
	assert.equal(mint.feeLamports, lamports);
	assert.equal(mint.feeWallet, WALLET);

	// The register instruction must NOT carry a second fee.
	assert.equal(mint.registerBuilder.getInstructions().length, 1);
	assert.equal(mint.combinedBuilder.getInstructions().length, 3);
});

test('no fee means no extra instruction at all', () => {
	const umi = umiWithThree(0);
	const mint = buildAgentMint(umi, MINT_ARGS);
	assert.equal(mint.createBuilder.getInstructions().length, 1);
	assert.equal(mint.feeLamports, 0);
	assert.equal(mint.feeWallet, null);
});

test('a fee without a recipient is refused', () => {
	const umi = umiWithThree(0);
	assert.throws(
		() => buildAgentMint(umi, { ...MINT_ARGS, feeLamports: 1000 }),
		(err) => err.code === 'validation_error',
	);
});

test('the fee costs 17 bytes, and a compact mint stays atomic', () => {
	const umi = umiWithThree(0);
	const compact = { network: 'mainnet', creator: WALLET, name: 'A', image: 'https://t.io/a.png' };
	const plain = buildAgentMint(umi, compact);
	const paid = buildAgentMint(umi, { ...compact, feeLamports: feeSchedule().standard_lamports, feeWallet: WALLET });

	assert.equal(plain.atomic, true);
	assert.equal(paid.atomic, true);
	assert.equal(
		paid.combinedBuilder.getTransactionSize(umi) - plain.combinedBuilder.getTransactionSize(umi),
		17,
		'one System transfer against an account already in the message',
	);
});

test('a mint too big to stay atomic splits with the fee on the create leg only', () => {
	const umi = umiWithThree(0);
	// Long data: URIs are what push a mint past 1232 bytes; the Genesis 333
	// themselves landed split. The fee must not end up on the register tx, or a
	// failed create would still have moved money.
	const bulky = {
		...MINT_ARGS,
		description: 'An autonomous 3D agent that pays for its own inference and renders itself in the browser.',
		modelUrl: `https://example.com/${'a'.repeat(120)}.glb`,
	};
	const mint = buildAgentMint(umi, { ...bulky, feeLamports: feeSchedule().standard_lamports, feeWallet: WALLET });

	assert.equal(mint.atomic, false);
	assert.equal(mint.builders.length, 2);
	assert.equal(mint.builders[0].getInstructions()[0].programId.toString(), SYSTEM_PROGRAM);
	assert.equal(mint.builders[0].getInstructions().length, 2, 'transfer + create');
	assert.equal(mint.builders[1].getInstructions().length, 1, 'register only, no fee');
});
