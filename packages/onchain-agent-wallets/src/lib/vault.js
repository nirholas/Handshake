// The custody primitive.
//
// Each agent gets a dedicated token account (its "vault") that the OWNER owns,
// derived deterministically from the owner's pubkey plus the agent id:
//
//     vault = PublicKey.createWithSeed(owner, "oaw1:<agentId>", tokenProgram)
//
// Deterministic derivation matters: the vault is recoverable from the owner
// wallet and the agent name alone, with no local file and no registry. The
// owner can always find it, drain it, and revoke it.
//
// The agent never owns the vault. It is granted an SPL Token DELEGATION over
// it, capped at a fixed amount. From then on the token program itself refuses
// any agent-signed transfer beyond that ceiling, and decrements the remaining
// allowance on every spend. The owner can revoke in one instruction, or simply
// withdraw the balance: neither needs the agent's cooperation.
//
// Why a seed account and not the agent's own associated token account: an ATA
// belongs to whoever holds its key. Money in an agent-owned ATA is the agent's
// money. Money in the vault is still the owner's, and the agent holds nothing
// but permission.

import { SystemProgram } from '@solana/web3.js';
import {
	ACCOUNT_SIZE,
	createInitializeAccount3Instruction,
	createApproveCheckedInstruction,
	createRevokeInstruction,
	createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	getMinimumBalanceForRentExemptAccount,
} from '@solana/spl-token';

import { toPublicKey, tokenAccount, ataFor, TOKEN_PROGRAM_ID } from './solana.js';

// PublicKey.createWithSeed caps the seed at 32 bytes. "oaw1:" leaves 27.
export const SEED_PREFIX = 'oaw1:';
export const MAX_AGENT_ID = 32 - SEED_PREFIX.length;

/** Agent ids are lowercase slugs: they become an on-chain account seed. */
export function assertAgentId(id) {
	const value = String(id || '').trim();
	if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
		throw Object.assign(
			new Error(`agent id must be lowercase letters, digits, and hyphens, starting alphanumeric (got "${id}")`),
			{ code: 'bad_agent_id' },
		);
	}
	if (value.length > MAX_AGENT_ID) {
		throw Object.assign(
			new Error(`agent id must be at most ${MAX_AGENT_ID} characters (it becomes an on-chain account seed)`),
			{ code: 'bad_agent_id' },
		);
	}
	return value;
}

export const seedFor = (agentId) => `${SEED_PREFIX}${assertAgentId(agentId)}`;

/** The deterministic vault address for an owner + agent id. */
export async function vaultAddress(owner, agentId, programId = TOKEN_PROGRAM_ID) {
	const { PublicKey } = await import('@solana/web3.js');
	return PublicKey.createWithSeed(toPublicKey(owner, 'owner'), seedFor(agentId), programId);
}

/**
 * Instructions that create the vault and grant the agent its capped allowance.
 * Signed by the owner alone: the agent is named, never a signer.
 */
export async function createVaultInstructions({
	connection,
	owner,
	agentId,
	mint,
	delegate,
	allowance,
	decimals,
	programId = TOKEN_PROGRAM_ID,
}) {
	const ownerKey = toPublicKey(owner, 'owner');
	const vault = await vaultAddress(ownerKey, agentId, programId);
	const lamports = await getMinimumBalanceForRentExemptAccount(connection);
	const instructions = [
		SystemProgram.createAccountWithSeed({
			fromPubkey: ownerKey,
			newAccountPubkey: vault,
			basePubkey: ownerKey,
			seed: seedFor(agentId),
			lamports,
			space: ACCOUNT_SIZE,
			programId,
		}),
		createInitializeAccount3Instruction(vault, toPublicKey(mint, 'mint'), ownerKey, programId),
	];
	if (allowance > 0n) {
		instructions.push(approveInstruction({ vault, mint, delegate, owner: ownerKey, allowance, decimals, programId }));
	}
	return { vault, instructions, rentLamports: lamports };
}

/** Set the agent's ceiling. Approve overwrites: a second approve replaces the first, it does not add. */
export function approveInstruction({ vault, mint, delegate, owner, allowance, decimals, programId = TOKEN_PROGRAM_ID }) {
	return createApproveCheckedInstruction(
		toPublicKey(vault, 'vault'),
		toPublicKey(mint, 'mint'),
		toPublicKey(delegate, 'delegate'),
		toPublicKey(owner, 'owner'),
		allowance,
		decimals,
		[],
		programId,
	);
}

/** The kill switch. One instruction, owner-signed, drops the allowance to zero. */
export function revokeInstruction({ vault, owner, programId = TOKEN_PROGRAM_ID }) {
	return createRevokeInstruction(toPublicKey(vault, 'vault'), toPublicKey(owner, 'owner'), [], programId);
}

/** Owner tops the vault up from their own associated token account. */
export function depositInstructions({ owner, vault, mint, amount, decimals, programId = TOKEN_PROGRAM_ID }) {
	const source = ataFor(mint, owner, programId);
	return [
		createTransferCheckedInstruction(
			source,
			toPublicKey(mint, 'mint'),
			toPublicKey(vault, 'vault'),
			toPublicKey(owner, 'owner'),
			amount,
			decimals,
			[],
			programId,
		),
	];
}

/** Owner pulls funds back out. Works regardless of what the agent is doing. */
export function withdrawInstructions({ owner, vault, mint, amount, decimals, programId = TOKEN_PROGRAM_ID }) {
	const destination = ataFor(mint, owner, programId);
	return [
		createAssociatedTokenAccountIdempotentInstruction(
			toPublicKey(owner, 'owner'),
			destination,
			toPublicKey(owner, 'owner'),
			toPublicKey(mint, 'mint'),
			programId,
		),
		createTransferCheckedInstruction(
			toPublicKey(vault, 'vault'),
			toPublicKey(mint, 'mint'),
			destination,
			toPublicKey(owner, 'owner'),
			amount,
			decimals,
			[],
			programId,
		),
	];
}

/**
 * The agent spends. It signs as DELEGATE over the owner's vault, so the token
 * program checks the amount against delegated_amount and decrements it. The
 * agent also pays the fee and any rent for a new destination account, which is
 * the only reason it needs SOL of its own.
 */
export function delegatedTransferInstructions({
	vault,
	mint,
	recipientOwner,
	agent,
	amount,
	decimals,
	programId = TOKEN_PROGRAM_ID,
}) {
	const destination = ataFor(mint, recipientOwner, programId);
	return {
		destination,
		instructions: [
			createAssociatedTokenAccountIdempotentInstruction(
				toPublicKey(agent, 'agent'),
				destination,
				toPublicKey(recipientOwner, 'recipient'),
				toPublicKey(mint, 'mint'),
				programId,
			),
			createTransferCheckedInstruction(
				toPublicKey(vault, 'vault'),
				toPublicKey(mint, 'mint'),
				destination,
				toPublicKey(agent, 'agent'),
				amount,
				decimals,
				[],
				programId,
			),
		],
	};
}

/** Live vault state straight from the chain. The on-chain numbers, not our notes. */
export async function readVault({ connection, vault, programId = TOKEN_PROGRAM_ID }) {
	const account = await tokenAccount(connection, vault, programId);
	if (!account) {
		return { exists: false, address: String(vault), balance: 0n, delegate: null, delegatedAmount: 0n };
	}
	return {
		exists: true,
		address: String(vault),
		mint: account.mint.toBase58(),
		owner: account.owner.toBase58(),
		balance: account.amount,
		delegate: account.delegate ? account.delegate.toBase58() : null,
		delegatedAmount: account.delegate ? account.delegatedAmount : 0n,
		frozen: account.isFrozen,
	};
}

/** What the agent can still move: the lower of its remaining allowance and the vault balance. */
export function spendableUnits(vaultState) {
	if (!vaultState.exists || !vaultState.delegate) return 0n;
	return vaultState.delegatedAmount < vaultState.balance ? vaultState.delegatedAmount : vaultState.balance;
}
