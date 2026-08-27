import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { solanaConnection } from './solana/connection.js';
import { ataExists } from './solana/read-guards.js';
import { submitProtected } from './execution-engine.js';
import {
	getAssociatedTokenAddress,
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

/**
 * Transfer SPL tokens from the platform treasury to a recipient address.
 * @param {object} opts
 * @param {string} opts.fromWallet   base58-encoded treasury keypair (64 bytes)
 * @param {string} opts.toAddress    recipient Solana address
 * @param {bigint|number} opts.amount  token amount in smallest units (e.g. 6-decimal USDC)
 * @param {string} opts.mint         SPL mint address
 * @returns {Promise<string>}        transaction signature
 */
export async function transferSolanaUSDC({ fromWallet, toAddress, amount, mint }) {
	const kp = Keypair.fromSecretKey(bs58.decode(fromWallet));
	const mintPubkey = new PublicKey(mint);
	const recipientPubkey = new PublicKey(toAddress);

	const connection = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });

	const senderATA = await getAssociatedTokenAddress(mintPubkey, kp.publicKey);
	const recipientATA = await getAssociatedTokenAddress(mintPubkey, recipientPubkey);

	const instructions = [];
	// Idempotent create paired with the fail-open probe: when the chain cannot be
	// read the probe answers "missing", and an unnecessary create is a no-op
	// rather than a transaction-killing error. It also closes the race where the
	// ATA appears between the probe and the submit.
	if (!(await ataExists(connection, recipientATA))) {
		instructions.push(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, recipientATA, recipientPubkey, mintPubkey));
	}
	instructions.push(createTransferInstruction(senderATA, recipientATA, kp.publicKey, BigInt(amount)));

	// Protected send: data-driven priority fee + CU, rebroadcast with blockhash
	// refresh until it lands, and a hard throw on an on-chain revert — replaces the
	// previous send-once-and-confirm, which dropped silently under congestion.
	const { signature } = await submitProtected({
		network: 'mainnet',
		connection,
		payer: kp,
		instructions,
	});
	return signature;
}

/**
 * Transfer native SOL from a signing keypair to a recipient address. Used by the
 * trading-swarm treasury to pay pro-rata profit distributions and exit
 * redemptions on-chain. Same protected-send path as the SPL transfer above:
 * data-driven priority fee + CU, rebroadcast with blockhash refresh until it
 * lands, and a hard throw on an on-chain revert.
 *
 * @param {object} opts
 * @param {import('@solana/web3.js').Keypair} opts.fromKeypair  the funded sender (treasury)
 * @param {string}  opts.toAddress   recipient Solana address
 * @param {bigint|number} opts.lamports  amount in lamports (must be > 0)
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @returns {Promise<string>}  transaction signature
 */
export async function transferNativeSol({ fromKeypair, toAddress, lamports, network = 'mainnet' }) {
	const amount = BigInt(lamports);
	if (amount <= 0n) throw new Error('transferNativeSol: lamports must be > 0');
	const recipient = new PublicKey(toAddress);
	const connection = solanaConnection({ network, commitment: 'confirmed' });

	const instructions = [
		SystemProgram.transfer({
			fromPubkey: fromKeypair.publicKey,
			toPubkey: recipient,
			lamports: amount,
		}),
	];

	const { signature } = await submitProtected({
		network,
		connection,
		payer: fromKeypair,
		instructions,
	});
	return signature;
}
