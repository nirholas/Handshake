/**
 * Tip an agent — non-custodial, viewer-signed Solana transfer.
 *
 * Any visitor (owner or not) can fund/tip an agent's public custodial wallet
 * directly from their own browser wallet (Phantom / Backpack / Solflare). The
 * transfer is built and signed client-side and submitted through our
 * Helius-backed same-origin RPC proxy — three.ws never custodies, signs, or
 * touches the funds. The destination is the agent's PUBLIC `solana_address`
 * (the same value GET /api/agents/:id/solana serves anonymously), so no secret
 * material is involved on either side.
 *
 * Two assets are supported, matching what the platform can price 1:1:
 *   • SOL  — native transfer (SystemProgram.transfer).
 *   • USDC — SPL transferChecked; the recipient's associated token account is
 *            created in the same tx when it doesn't exist yet (sender pays rent).
 *
 * The tip lands on-chain and surfaces automatically in the agent's existing
 * activity feed (GET /api/agents/:id/solana/activity) — there is no separate
 * server write, so there is nothing to fake and no unauthenticated endpoint to
 * abuse. The returned signature + explorer link IS the receipt.
 */

import {
	Connection,
	PublicKey,
	SystemProgram,
	Transaction,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import {
	getAssociatedTokenAddress,
	getAccount,
	createAssociatedTokenAccountInstruction,
	createTransferCheckedInstruction,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { detectSolanaWallet, SOLANA_RPC, solanaTxExplorerUrl } from '../erc8004/solana-deploy.js';
import { resolveTokenProgramId } from './spl-token-program.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// USDC mints per cluster — mirrors api/agents/solana-wallet.js. USDC has 6 decimals.
export const USDC_MINT = {
	mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
const USDC_DECIMALS = 6;

/** Supported tip assets with the display metadata the modal needs. */
export const TIP_TOKENS = Object.freeze([
	{ id: 'SOL', label: 'SOL', symbol: '◎', decimals: 9, presets: [0.05, 0.1, 0.25, 1] },
	{ id: 'USDC', label: 'USDC', symbol: '$', decimals: USDC_DECIMALS, presets: [1, 5, 10, 25] },
]);

/** A tip error that carries a machine code so the UI can tailor recovery copy. */
export class TipError extends Error {
	constructor(message, code = 'tip_failed') {
		super(message);
		this.name = 'TipError';
		this.code = code;
	}
}

// Poll signature status over HTTP (the proxy refuses WebSocket subscriptions,
// so Connection.confirmTransaction would hang). Mirrors solana-deploy.js.
async function waitForConfirmation(conn, signature, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { value } = await conn.getSignatureStatuses([signature]);
		const status = value?.[0];
		if (status) {
			if (status.err) throw new TipError(`Transfer failed on-chain: ${JSON.stringify(status.err)}`, 'onchain_error');
			if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	throw new TipError('Timed out waiting for confirmation. The tip may still land — check the explorer.', 'timeout');
}

/**
 * Send a tip to an agent's public Solana address.
 *
 * @param {object} opts
 * @param {string} opts.toAddress              Recipient base58 address (agent's solana_address).
 * @param {'SOL'|'USDC'|'SPL'} [opts.token='SOL']  'SPL' transfers an arbitrary
 *        SPL token supplied at runtime via opts.mint + opts.decimals (coin-agnostic
 *        plumbing — the caller chooses the mint; this module hardcodes none).
 * @param {string} [opts.mint]                 SPL mint (base58), required when token==='SPL'.
 * @param {number} [opts.decimals]             SPL token decimals, required when token==='SPL'.
 * @param {string} [opts.noBalanceMsg]         Custom "you hold none" error copy for the SPL branch.
 * @param {number} opts.amount                 Human amount (e.g. 0.1 SOL or 5 USDC).
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @param {(stage: string) => void} [opts.onStage]  Lifecycle: 'connecting'|'building'|'signing'|'sending'|'confirming'.
 * @returns {Promise<{ signature: string, explorerUrl: string, from: string }>}
 */
export async function tipAgent({ toAddress, token = 'SOL', amount, mint: splMint, decimals: splDecimals, noBalanceMsg, network = 'mainnet', onStage } = {}) {
	const stage = (s) => { try { onStage?.(s); } catch { /* listener best-effort */ } };

	if (!toAddress || !BASE58_RE.test(String(toAddress))) {
		throw new TipError('This agent has no valid wallet address to tip.', 'no_address');
	}
	const amt = Number(amount);
	if (!Number.isFinite(amt) || amt <= 0) {
		throw new TipError('Enter a tip amount greater than zero.', 'bad_amount');
	}

	const wallet = detectSolanaWallet();
	if (!wallet) throw new TipError('No Solana wallet found. Install Phantom, Backpack, or Solflare to tip.', 'no_wallet');

	stage('connecting');
	let fromPubkey;
	try {
		const conn = await wallet.connect();
		fromPubkey = conn?.publicKey || wallet.publicKey;
	} catch (e) {
		if (e?.code === 4001 || /reject|cancel/i.test(e?.message || '')) {
			throw new TipError('Wallet connection cancelled.', 'cancelled');
		}
		throw new TipError(e?.message || 'Could not connect your wallet.', 'connect_failed');
	}
	if (!fromPubkey) throw new TipError('Could not read your wallet address.', 'connect_failed');

	const from = new PublicKey(fromPubkey.toString());
	const to = new PublicKey(String(toAddress));
	if (from.equals(to)) throw new TipError('That wallet is the agent — pick a different wallet to tip from.', 'self_tip');

	const endpoint = SOLANA_RPC[network] || SOLANA_RPC.mainnet;
	const connection = new Connection(endpoint, 'confirmed');

	stage('building');
	const tx = new Transaction();
	try {
		if (token === 'USDC') {
			const mint = new PublicKey(USDC_MINT[network] || USDC_MINT.mainnet);
			const fromAta = await getAssociatedTokenAddress(mint, from);
			const toAta = await getAssociatedTokenAddress(mint, to);
			// Sender must actually hold USDC — surface a clear, actionable error if not.
			try {
				await getAccount(connection, fromAta);
			} catch {
				throw new TipError('Your wallet has no USDC. Switch to SOL or fund your wallet with USDC first.', 'no_usdc');
			}
			// Create the recipient's USDC account in-band if it doesn't exist yet.
			let recipientHasAta = true;
			try {
				await getAccount(connection, toAta);
			} catch {
				recipientHasAta = false;
			}
			if (!recipientHasAta) {
				tx.add(createAssociatedTokenAccountInstruction(from, toAta, to, mint));
			}
			const raw = BigInt(Math.round(amt * 10 ** USDC_DECIMALS));
			tx.add(createTransferCheckedInstruction(fromAta, mint, toAta, from, raw, USDC_DECIMALS, [], TOKEN_PROGRAM_ID));
		} else if (token === 'SPL') {
			// Generic SPL transfer — the mint + decimals are supplied at runtime by
			// the caller (e.g. the Living Stages tip flow passing the $THREE mint). This
			// module hardcodes no token; it only moves whatever the caller names.
			if (!splMint || !BASE58_RE.test(String(splMint))) {
				throw new TipError('Missing or invalid token mint for this tip.', 'bad_mint');
			}
			const dec = Number.isInteger(splDecimals) && splDecimals >= 0 && splDecimals <= 18 ? splDecimals : 6;
			const mint = new PublicKey(String(splMint));
			// The caller's mint may be Token-2022 ($THREE is), and the spl-token defaults
			// are the legacy program, which derives the wrong ATAs and fails simulation
			// with "incorrect program id for instruction". Read the owning program off
			// the mint and build every leg against it.
			const tokenProgramId = await resolveTokenProgramId(connection, mint, splToken);
			const fromAta = await getAssociatedTokenAddress(mint, from, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
			const toAta = await getAssociatedTokenAddress(mint, to, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
			try {
				await getAccount(connection, fromAta, undefined, tokenProgramId);
			} catch {
				throw new TipError(noBalanceMsg || 'Your wallet holds none of this token to tip with.', 'no_balance');
			}
			let recipientHasAta = true;
			try {
				await getAccount(connection, toAta, undefined, tokenProgramId);
			} catch {
				recipientHasAta = false;
			}
			if (!recipientHasAta) {
				tx.add(
					createAssociatedTokenAccountInstruction(
						from,
						toAta,
						to,
						mint,
						tokenProgramId,
						ASSOCIATED_TOKEN_PROGRAM_ID,
					),
				);
			}
			const raw = BigInt(Math.round(amt * 10 ** dec));
			tx.add(createTransferCheckedInstruction(fromAta, mint, toAta, from, raw, dec, [], tokenProgramId));
		} else {
			const lamports = Math.round(amt * LAMPORTS_PER_SOL);
			tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
		}
	} catch (e) {
		if (e instanceof TipError) throw e;
		throw new TipError(e?.message || 'Could not build the transfer.', 'build_failed');
	}

	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	tx.recentBlockhash = blockhash;
	tx.lastValidBlockHeight = lastValidBlockHeight;
	tx.feePayer = from;

	stage('signing');
	let signed;
	try {
		signed = await wallet.signTransaction(tx);
	} catch (e) {
		if (e?.code === 4001 || /reject|cancel/i.test(e?.message || '')) {
			throw new TipError('You cancelled the tip.', 'cancelled');
		}
		throw new TipError(e?.message || 'Signing failed.', 'sign_failed');
	}

	stage('sending');
	let signature;
	try {
		signature = await connection.sendRawTransaction(signed.serialize(), {
			skipPreflight: false,
			preflightCommitment: 'confirmed',
			maxRetries: 5,
		});
	} catch (e) {
		const msg = e?.message || 'Transaction was rejected by the network.';
		if (/insufficient|0x1\b/i.test(msg)) {
			throw new TipError('Insufficient balance for this tip plus network fees.', 'insufficient');
		}
		throw new TipError(msg, 'send_failed');
	}

	stage('confirming');
	await waitForConfirmation(connection, signature);

	return { signature, explorerUrl: solanaTxExplorerUrl(network, signature), from: from.toBase58() };
}
