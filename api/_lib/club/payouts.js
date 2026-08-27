// Outbound USDC senders for the Pole Club tip-sweep cron.
//
// Two networks, two implementations:
//   - Solana mainnet: SPL transfer of USDC from the club treasury (b64 keypair
//     env CLUB_SOLANA_TREASURY_SECRET_KEY_B64) to a dancer's Solana address.
//     Creates the recipient ATA if it doesn't exist yet.
//   - Base mainnet:  ERC-20 transfer(address,uint256) of USDC from the club
//     treasury (0x-prefixed hex env CLUB_EVM_TREASURY_PRIVATE_KEY) to a
//     dancer's EVM address.
//
// Both senders return { signature, network, amount_atomics } on success and
// throw on failure (RPC error, insufficient balance, missing key, etc.). The
// cron handler catches per-dancer to keep one bad sweep from blocking the
// rest of the batch.

import {
	Connection,
	Keypair,
	PublicKey,
} from '@solana/web3.js';
import { solanaConnection } from '../solana/connection.js';
import { ataExists } from '../solana/read-guards.js';
import { submitProtected } from '../execution-engine.js';
import {
	getAssociatedTokenAddress,
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferInstruction,
} from '@solana/spl-token';
import {
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { evmTransport } from '../evm/rpc.js';

import { env } from '../env.js';
import { chainOf } from './chain.js';
import { SOLANA_USDC_MINT, EVM_USDC } from '../../payments/_config.js';

const SEND_TIMEOUT_MS = 45_000;

/**
 * Send `amount_atomics` USDC from the club Solana treasury to `recipient`.
 * Creates the recipient's USDC ATA if needed (treasury pays the rent).
 *
 * @param {object} opts
 * @param {string} opts.recipient   Solana address (base58)
 * @param {bigint} opts.amount      USDC atomic units (6 decimals)
 * @returns {Promise<{ signature: string, network: 'solana', amount_atomics: string }>}
 */
export async function sendClubUsdcSolana({ recipient, amount }) {
	const b64 = env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64;
	if (!b64) throw new Error('CLUB_SOLANA_TREASURY_SECRET_KEY_B64 not set');

	const raw = Buffer.from(b64, 'base64');
	if (raw.byteLength !== 64) {
		throw new Error(`CLUB_SOLANA_TREASURY_SECRET_KEY_B64: expected 64-byte secret, got ${raw.byteLength}`);
	}
	const kp = Keypair.fromSecretKey(raw);

	const mint = new PublicKey(SOLANA_USDC_MINT);
	const to = new PublicKey(recipient);
	const amt = typeof amount === 'bigint' ? amount : BigInt(amount);
	if (amt <= 0n) throw new Error('amount must be > 0');

	const connection = solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
	const senderAta = await getAssociatedTokenAddress(mint, kp.publicKey);
	const recipientAta = await getAssociatedTokenAddress(mint, to);

	const instructions = [];
	// Idempotent create paired with the fail-open probe: when the chain cannot be
	// read the probe answers "missing", and an unnecessary create is a no-op
	// rather than a transaction-killing error. It also closes the race where the
	// ATA appears between the probe and the submit.
	if (!(await ataExists(connection, recipientAta))) {
		instructions.push(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, recipientAta, to, mint));
	}
	instructions.push(createTransferInstruction(senderAta, recipientAta, kp.publicKey, amt));

	// Protected send: priority fee + CU estimate, rebroadcast with blockhash
	// refresh, hard throw on revert. (submitProtected sets its own compute-budget.)
	const { signature } = await submitProtected({ network: 'mainnet', connection, payer: kp, instructions });
	return { signature, network: 'solana', amount_atomics: amt.toString() };
}

const ERC20_TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

/**
 * Send `amount_atomics` USDC from the club EVM treasury to `recipient` on
 * Base mainnet. Uses a self-signed legacy/EIP-1559 tx via viem.
 *
 * @param {object} opts
 * @param {string} opts.recipient   0x-prefixed EVM address
 * @param {bigint} opts.amount      USDC atomic units (6 decimals)
 * @returns {Promise<{ signature: string, network: 'base', amount_atomics: string }>}
 */
export async function sendClubUsdcBase({ recipient, amount }) {
	const pk = env.CLUB_EVM_TREASURY_PRIVATE_KEY;
	if (!pk) throw new Error('CLUB_EVM_TREASURY_PRIVATE_KEY not set');

	const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
	const usdc = EVM_USDC[base.id];
	if (!usdc) throw new Error('USDC address for Base mainnet not configured');

	const amt = typeof amount === 'bigint' ? amount : BigInt(amount);
	if (amt <= 0n) throw new Error('amount must be > 0');
	if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
		throw new Error(`invalid EVM recipient: ${recipient}`);
	}

	const transport = evmTransport(8453, { primaryUrl: env.CLUB_BASE_RPC_URL });
	const publicClient = createPublicClient({ chain: base, transport });
	const walletClient = createWalletClient({ account, chain: base, transport });

	const data = encodeFunctionData({
		abi: ERC20_TRANSFER_ABI,
		functionName: 'transfer',
		args: [recipient, amt],
	});

	const hash = await walletClient.sendTransaction({
		to: usdc,
		data,
		value: 0n,
	});

	// Wait for inclusion so the cron can confidently mark tips paid_at.
	const receipt = await publicClient.waitForTransactionReceipt({
		hash,
		timeout: SEND_TIMEOUT_MS,
		confirmations: 1,
	});
	if (receipt.status !== 'success') {
		throw new Error(`base_tx_reverted: ${hash}`);
	}
	return { signature: hash, network: 'base', amount_atomics: amt.toString() };
}

/**
 * Dispatch helper: pick the right per-network sender for a sweep group.
 */
export async function sendClubPayout({ network, recipient, amount }) {
	// Accept either a bare chain key or a CAIP-2 id — the sweep already
	// normalizes, but normalize here too so any caller is routed correctly.
	const chain = chainOf(network);
	if (chain === 'solana') return sendClubUsdcSolana({ recipient, amount });
	if (chain === 'base') return sendClubUsdcBase({ recipient, amount });
	throw new Error(`unsupported network for club sweep: ${network}`);
}
