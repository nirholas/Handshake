// The custody thesis, proven against the real SPL Token program.
//
// solana-bankrun runs the actual token program ELF in process, so these are not
// assertions about our own code: they are the token program itself refusing an
// agent that tries to spend past the ceiling its owner approved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { start } from 'solana-bankrun';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
	MINT_SIZE,
	TOKEN_PROGRAM_ID,
	createInitializeMint2Instruction,
	createAssociatedTokenAccountInstruction,
	createMintToInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import {
	createVaultInstructions,
	depositInstructions,
	withdrawInstructions,
	delegatedTransferInstructions,
	revokeInstruction,
	readVault,
	spendableUnits,
} from '../src/lib/vault.js';

const DECIMALS = 6;
const unit = (n) => BigInt(Math.round(n * 10 ** DECIMALS));

/**
 * The two Connection methods our vault code actually calls, backed by bankrun.
 * This exercises the real readVault and createVaultInstructions rather than a
 * parallel reimplementation.
 */
function connectionAdapter(client, rent) {
	return {
		rpcEndpoint: 'bankrun://test',
		async getAccountInfo(address) {
			const account = await client.getAccount(new PublicKey(address));
			if (!account) return null;
			return { ...account, data: Buffer.from(account.data) };
		},
		async getMinimumBalanceForRentExemption(space) {
			return Number(rent.minimumBalance(BigInt(space)));
		},
	};
}

async function send(ctx, instructions, signers) {
	const tx = new Transaction();
	tx.recentBlockhash = ctx.lastBlockhash;
	tx.feePayer = signers[0].publicKey;
	for (const ix of instructions) tx.add(ix);
	tx.sign(...signers);
	return ctx.banksClient.processTransaction(tx);
}

test('an agent cannot spend past the allowance its owner approved', async (t) => {
	const ctx = await start([], []);
	const client = ctx.banksClient;
	const rent = await client.getRent();
	const connection = connectionAdapter(client, rent);

	const owner = ctx.payer;
	const agent = Keypair.generate();
	const merchant = Keypair.generate();
	const mint = Keypair.generate();
	const agentId = 'researcher';

	// A real mint, and 1000 tokens in the owner's own account.
	const ownerAta = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey);
	await send(
		ctx,
		[
			SystemProgram.createAccount({
				fromPubkey: owner.publicKey,
				newAccountPubkey: mint.publicKey,
				lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
				space: MINT_SIZE,
				programId: TOKEN_PROGRAM_ID,
			}),
			createInitializeMint2Instruction(mint.publicKey, DECIMALS, owner.publicKey, null),
			createAssociatedTokenAccountInstruction(owner.publicKey, ownerAta, owner.publicKey, mint.publicKey),
			createMintToInstruction(mint.publicKey, ownerAta, owner.publicKey, unit(1000)),
			// The agent needs its own SOL to pay fees, and nothing else.
			SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: 50_000_000 }),
		],
		[owner, mint],
	);

	await t.test('the owner creates the vault and delegates a capped allowance', async () => {
		const { vault, instructions } = await createVaultInstructions({
			connection,
			owner: owner.publicKey,
			agentId,
			mint: mint.publicKey,
			delegate: agent.publicKey,
			allowance: unit(100),
			decimals: DECIMALS,
		});
		instructions.push(
			...depositInstructions({
				owner: owner.publicKey,
				vault,
				mint: mint.publicKey,
				amount: unit(500),
				decimals: DECIMALS,
			}),
		);
		await send(ctx, instructions, [owner]);

		const state = await readVault({ connection, vault });
		assert.equal(state.exists, true);
		assert.equal(state.owner, owner.publicKey.toBase58(), 'the vault is owned by the owner, not the agent');
		assert.equal(state.balance, unit(500), 'the vault holds the deposit');
		assert.equal(state.delegate, agent.publicKey.toBase58(), 'the agent is the delegate');
		assert.equal(state.delegatedAmount, unit(100), 'capped at the approved allowance');
		assert.equal(spendableUnits(state), unit(100), 'spendable is the allowance, not the balance');
	});

	await t.test('the agent spends inside the allowance, and the chain decrements it', async () => {
		const { vault } = await createVaultInstructions({
			connection,
			owner: owner.publicKey,
			agentId,
			mint: mint.publicKey,
			delegate: agent.publicKey,
			allowance: 0n,
			decimals: DECIMALS,
		});
		const { instructions } = delegatedTransferInstructions({
			vault,
			mint: mint.publicKey,
			recipientOwner: merchant.publicKey,
			agent: agent.publicKey,
			amount: unit(40),
			decimals: DECIMALS,
		});
		await send(ctx, instructions, [agent]);

		const state = await readVault({ connection, vault });
		assert.equal(state.balance, unit(460), 'the vault paid out 40');
		assert.equal(state.delegatedAmount, unit(60), 'the allowance dropped by exactly what was spent');
	});

	await t.test('the token program refuses a spend above the remaining allowance', async () => {
		const vault = (
			await createVaultInstructions({
				connection,
				owner: owner.publicKey,
				agentId,
				mint: mint.publicKey,
				delegate: agent.publicKey,
				allowance: 0n,
				decimals: DECIMALS,
			})
		).vault;

		// 61 is under the 460 sitting in the vault, and over the 60 left on the
		// delegation. Only the on-chain cap can stop this.
		const { instructions } = delegatedTransferInstructions({
			vault,
			mint: mint.publicKey,
			recipientOwner: merchant.publicKey,
			agent: agent.publicKey,
			amount: unit(61),
			decimals: DECIMALS,
		});

		await assert.rejects(
			() => send(ctx, instructions, [agent]),
			(err) => /0x1|insufficient/i.test(String(err)),
			'the SPL Token program must reject a transfer above delegated_amount',
		);

		const state = await readVault({ connection, vault });
		assert.equal(state.balance, unit(460), 'nothing moved');
		assert.equal(state.delegatedAmount, unit(60), 'the allowance is untouched');
	});

	await t.test('revoke is a hard stop the agent cannot route around', async () => {
		const vault = (
			await createVaultInstructions({
				connection,
				owner: owner.publicKey,
				agentId,
				mint: mint.publicKey,
				delegate: agent.publicKey,
				allowance: 0n,
				decimals: DECIMALS,
			})
		).vault;

		await send(ctx, [revokeInstruction({ vault, owner: owner.publicKey })], [owner]);

		const revoked = await readVault({ connection, vault });
		assert.equal(revoked.delegate, null, 'no delegate remains');
		assert.equal(spendableUnits(revoked), 0n, 'nothing is spendable');

		const { instructions } = delegatedTransferInstructions({
			vault,
			mint: mint.publicKey,
			recipientOwner: merchant.publicKey,
			agent: agent.publicKey,
			amount: unit(1),
			decimals: DECIMALS,
		});
		await assert.rejects(
			() => send(ctx, instructions, [agent]),
			'a revoked agent cannot move even one unit',
		);
	});

	await t.test('the owner recovers the balance without the agent', async () => {
		const vault = (
			await createVaultInstructions({
				connection,
				owner: owner.publicKey,
				agentId,
				mint: mint.publicKey,
				delegate: agent.publicKey,
				allowance: 0n,
				decimals: DECIMALS,
			})
		).vault;

		await send(
			ctx,
			withdrawInstructions({
				owner: owner.publicKey,
				vault,
				mint: mint.publicKey,
				amount: unit(460),
				decimals: DECIMALS,
			}),
			[owner],
		);

		const state = await readVault({ connection, vault });
		assert.equal(state.balance, 0n, 'the vault is empty');
		const ownerAccount = await readVault({ connection, vault: ownerAta });
		assert.equal(ownerAccount.balance, unit(960), 'the owner holds 500 kept back plus the 460 recovered');
	});
});
