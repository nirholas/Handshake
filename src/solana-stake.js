/**
 * Solana stake helper — builds a single tx that
 *   1. transfers SOL from the staker to the agent's wallet
 *   2. attaches an SPL Memo with kind='threews.stake.v1', score, comment
 * The memo is then indexed by the solana-attestations-crawl cron, which folds
 * the lamports delta into the row's payload.
 */

import {
	Connection,
	PublicKey,
	SystemProgram,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const MIN_STAKE_LAMPORTS = 1_000_000n; // 0.001 SOL
export const SOL_PER_LAMPORT = 1e-9;

// Route through our same-origin proxy. The public mainnet RPC returns 403 to
// most browser origins.
const RPC_ORIGIN =
	typeof window !== 'undefined' && window.location?.origin
		? window.location.origin
		: 'https://three.ws';
const RPC = {
	mainnet: `${RPC_ORIGIN}/api/solana-rpc`,
	devnet: `${RPC_ORIGIN}/api/solana-rpc?net=devnet`,
};

/**
 * Submit a stake-and-memo transaction via the connected Solana wallet adapter.
 *
 * @param {object} opts
 * @param {string} opts.agentAsset      Base58 SPL mint or wallet that identifies the agent
 * @param {string} opts.recipient       Base58 wallet that receives the staked SOL
 * @param {bigint} opts.lamports        Stake amount in lamports (>= MIN_STAKE_LAMPORTS)
 * @param {number} opts.score           1–5
 * @param {string} [opts.comment='']
 * @param {'mainnet'|'devnet'} [opts.network='devnet']
 * @param {object} opts.wallet          Solana wallet adapter (must expose publicKey + signTransaction)
 * @returns {Promise<string>} signature
 */
export async function stakeOnSolana({
	agentAsset,
	recipient,
	lamports,
	score,
	comment = '',
	network = 'devnet',
	wallet,
}) {
	if (!wallet?.publicKey || typeof wallet.signTransaction !== 'function') {
		throw new Error('Solana wallet not connected');
	}
	if (!Number.isInteger(score) || score < 1 || score > 5) {
		throw new Error('score must be 1-5');
	}
	if (lamports < MIN_STAKE_LAMPORTS) {
		throw new Error(`min stake is ${Number(MIN_STAKE_LAMPORTS) * SOL_PER_LAMPORT} SOL`);
	}

	const conn = new Connection(RPC[network] || RPC.devnet, 'confirmed');
	const fromPk = wallet.publicKey;
	const toPk = new PublicKey(recipient);

	const memoPayload = {
		v: 1,
		kind: 'threews.stake.v1',
		agent: agentAsset,
		score,
		comment: comment.slice(0, 280),
	};
	const memoIx = new TransactionInstruction({
		keys: [{ pubkey: fromPk, isSigner: true, isWritable: false }],
		programId: MEMO_PROGRAM_ID,
		data: Buffer.from(JSON.stringify(memoPayload), 'utf8'),
	});

	const transferIx = SystemProgram.transfer({
		fromPubkey: fromPk,
		toPubkey: toPk,
		lamports: Number(lamports),
	});

	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
	const tx = new Transaction({
		feePayer: fromPk,
		blockhash,
		lastValidBlockHeight,
	}).add(transferIx, memoIx);

	const signed = await wallet.signTransaction(tx);
	const sig = await conn.sendRawTransaction(signed.serialize(), {
		skipPreflight: false,
	});
	await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
	return sig;
}

/** The market envelope tag that separates a market stake from a bare conviction memo. */
export const MARKET_TAG = 'rsm.v1';

/**
 * Open a position in the Reputation Staking Market (specs/REPUTATION_STAKING_MARKET.md §3.1).
 *
 * Same shape as stakeOnSolana, with two differences that make the stake
 * *withdrawable*: the lamports go to the market escrow rather than to the
 * agent's own wallet, and the memo carries `market` + `escrow` so the server can
 * recognise the transaction as a position it must honour. A bare stakeOnSolana
 * memo stays what it always was: a conviction signal with no principal to return.
 *
 * @param {object} opts
 * @param {string} opts.agentAsset Base58 pubkey identifying the agent
 * @param {string} opts.escrow     Base58 market escrow pubkey (from GET /api/reputation/market)
 * @param {bigint} opts.lamports   Stake amount (>= MIN_STAKE_LAMPORTS)
 * @param {number} opts.score      1-5 conviction rating
 * @param {'mainnet'|'devnet'} [opts.network='devnet']
 * @param {object} opts.wallet     Solana wallet adapter (publicKey + signTransaction)
 * @returns {Promise<string>} the stake transaction signature, which is the position id
 */
export async function stakeOnMarket({ agentAsset, escrow, lamports, score, network = 'devnet', wallet }) {
	if (!wallet?.publicKey || typeof wallet.signTransaction !== 'function') {
		throw new Error('Solana wallet not connected');
	}
	if (!Number.isInteger(score) || score < 1 || score > 5) {
		throw new Error('score must be 1-5');
	}
	if (lamports < MIN_STAKE_LAMPORTS) {
		throw new Error(`min stake is ${Number(MIN_STAKE_LAMPORTS) * SOL_PER_LAMPORT} SOL`);
	}

	const conn = new Connection(RPC[network] || RPC.devnet, 'confirmed');
	const fromPk = wallet.publicKey;
	const escrowPk = new PublicKey(escrow);

	const memoIx = new TransactionInstruction({
		keys: [{ pubkey: fromPk, isSigner: true, isWritable: false }],
		programId: MEMO_PROGRAM_ID,
		data: Buffer.from(
			JSON.stringify({
				v: 1,
				kind: 'threews.stake.v1',
				market: MARKET_TAG,
				agent: agentAsset,
				score,
				escrow: escrowPk.toBase58(),
			}),
			'utf8',
		),
	});
	const transferIx = SystemProgram.transfer({
		fromPubkey: fromPk,
		toPubkey: escrowPk,
		lamports: Number(lamports),
	});

	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
	const tx = new Transaction({ feePayer: fromPk, blockhash, lastValidBlockHeight }).add(transferIx, memoIx);

	const signed = await wallet.signTransaction(tx);
	const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
	await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
	return sig;
}
