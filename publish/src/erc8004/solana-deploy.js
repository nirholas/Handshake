/**
 * Solana deploy flow — Metaplex Core NFT minted via the user's wallet.
 *
 * Mirrors the EVM register flow in deploy-button.js but for Solana:
 *   1. POST /api/agents/solana-register-prep    — server builds an unsigned
 *      Metaplex Core createV1 transaction (base64) for `wallet_address`.
 *   2. Phantom (or any compatible Solana wallet) signs and submits the tx.
 *   3. POST /api/agents/solana-register-confirm — server verifies the tx and
 *      upserts the agent_identity row with chain_type='solana'.
 *
 * Wallet must be linked to the user account via SIWS first; the prep endpoint
 * returns 403 otherwise.
 */

import { Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { grindVanity } from '../solana/vanity/grinder.js';

/** Detect an injected Solana wallet (Phantom / Backpack / Solflare). */
export function detectSolanaWallet() {
	if (typeof window === 'undefined') return null;
	if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
	if (window.solana?.isPhantom) return window.solana;
	if (window.backpack?.solana) return window.backpack.solana;
	if (window.solflare?.isSolflare) return window.solflare;
	return null;
}

// Route through our same-origin proxy. The public mainnet RPC returns 403 to
// most browser origins; the proxy forwards server-side to Helius when
// HELIUS_API_KEY is set, otherwise to the public RPC from a datacentre IP.
const SOLANA_RPC_ORIGIN =
	typeof window !== 'undefined' && window.location?.origin
		? window.location.origin
		: 'https://three.ws';
export const SOLANA_RPC = {
	mainnet: `${SOLANA_RPC_ORIGIN}/api/solana-rpc`,
	devnet: `${SOLANA_RPC_ORIGIN}/api/solana-rpc?net=devnet`,
};
const RPC = SOLANA_RPC;

export function solanaTxExplorerUrl(network, sig) {
	return network === 'devnet'
		? `https://explorer.solana.com/tx/${sig}?cluster=devnet`
		: `https://solscan.io/tx/${sig}`;
}

/** @param {string} b64 */
function decodeBase64Tx(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	// Server uses Umi's buildAndSign which produces a versioned tx.
	try {
		return VersionedTransaction.deserialize(bytes);
	} catch {
		return Transaction.from(bytes);
	}
}

// Poll signature status over HTTP. Avoids Connection.confirmTransaction, which
// opens a WebSocket subscription — public mainnet-beta refuses WS, so the
// confirm step hangs until the wallet times out.
async function waitForSolanaConfirmation(conn, signature, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { value } = await conn.getSignatureStatuses([signature]);
		const status = value?.[0];
		if (status) {
			if (status.err) {
				throw new Error(`Tx failed: ${JSON.stringify(status.err)}`);
			}
			if (
				status.confirmationStatus === 'confirmed' ||
				status.confirmationStatus === 'finalized'
			) {
				return;
			}
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	throw new Error('Timed out waiting for Solana transaction confirmation.');
}

/**
 * Run the Solana deploy flow end-to-end.
 *
 * @param {object} opts
 * @param {object} opts.agent       Agent record. Required: id, name. Optional: avatarId, description.
 * @param {'mainnet'|'devnet'} opts.network
 * @param {object} [opts.vanity]    Optional vanity prefix config.
 * @param {string} [opts.vanity.prefix]                            Base58 prefix to grind.
 * @param {(p: { attempts: number, rate: number, eta: string }) => void} [opts.vanity.onProgress]
 * @param {AbortSignal} [opts.vanity.signal]
 * @param {Uint8Array} [opts.vanity.preGroundSecretKey]            64-byte Ed25519 secret key from a CLI grinder
 *   (e.g. nirholas/solana-wallet-toolkit). When present, the in-browser grinder
 *   is skipped and this keypair is used directly. The caller is responsible for
 *   verifying the public key matches `vanity.prefix`.
 * @returns {Promise<{ assetPubkey: string, txSignature: string, network: string, agent: object, vanityPrefix?: string }>}
 */
export async function runSolanaDeploy({ agent, network, vanity }) {
	const wallet = detectSolanaWallet();
	if (!wallet) {
		const err = new Error('No Solana wallet detected. Install Phantom to continue.');
		err.code = 'NO_WALLET';
		throw err;
	}

	const conn = await wallet.connect();
	const walletAddress = (conn?.publicKey || wallet.publicKey)?.toString();
	if (!walletAddress) throw new Error('Could not read Solana wallet address.');

	// Optional: grind a vanity asset keypair before asking the server to build the tx.
	// Or accept a pre-ground keypair from a CLI grinder (faster for prefixes >=5 chars).
	let vanityKeypair = null;
	if (vanity?.preGroundSecretKey) {
		vanityKeypair = Keypair.fromSecretKey(vanity.preGroundSecretKey);
		if (vanity.prefix && !vanityKeypair.publicKey.toBase58().startsWith(vanity.prefix)) {
			throw new Error(`Pre-ground keypair does not start with prefix "${vanity.prefix}".`);
		}
	} else if (vanity?.prefix) {
		const result = await grindVanity({
			prefix: vanity.prefix,
			onProgress: vanity.onProgress,
			signal: vanity.signal,
		});
		vanityKeypair = Keypair.fromSecretKey(result.secretKey);
	}

	const prepResp = await fetch('/api/agents/solana-register-prep', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			name: agent.name || 'Agent',
			description: agent.description || '',
			avatar_id: agent.avatarId || agent.avatar_id,
			wallet_address: walletAddress,
			network,
			...(vanityKeypair ? {
				asset_pubkey: vanityKeypair.publicKey.toBase58(),
				vanity_prefix: vanity.prefix,
			} : {}),
		}),
	});
	if (!prepResp.ok) {
		const data = await prepResp.json().catch(() => ({}));
		const err = new Error(
			data.error_description || `solana-register-prep returned ${prepResp.status}`,
		);
		err.status = prepResp.status;
		err.code = data.error;
		throw err;
	}
	const prep = await prepResp.json();
	const tx = decodeBase64Tx(prep.tx_base64);

	// Always sign locally and submit via our Helius-backed proxy. Wallet
	// `signAndSendTransaction` routes through the wallet's own RPC, which
	// returns 403 "Access forbidden" intermittently on mainnet.
	// Phantom Lighthouse requires the wallet to sign FIRST when there are
	// multiple signers; if a vanity keypair is in play, the server built the tx
	// with a noop signer for the asset slot and we fill it in after Phantom.
	// VersionedTransaction.sign() / Transaction.partialSign() only update the
	// matching signer's slot, so Phantom's signature is preserved.
	const endpoint = RPC[network] || RPC.mainnet;
	const signed = await wallet.signTransaction(tx);
	if (vanityKeypair && signed instanceof VersionedTransaction) {
		signed.sign([vanityKeypair]);
	} else if (vanityKeypair && signed instanceof Transaction) {
		signed.partialSign(vanityKeypair);
	}
	const conn2 = new Connection(endpoint, 'confirmed');
	const raw = signed.serialize();
	const signature = await conn2.sendRawTransaction(raw, {
		skipPreflight: false,
		preflightCommitment: 'confirmed',
		maxRetries: 5,
	});

	// Wait for confirmation before calling the server.
	const conn3 = new Connection(endpoint, 'confirmed');
	await waitForSolanaConfirmation(conn3, signature, 60_000);

	const confirmResp = await fetch('/api/agents/solana-register-confirm', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			tx_signature: signature,
			asset_pubkey: prep.asset_pubkey,
			wallet_address: walletAddress,
			network,
			name: agent.name,
			description: agent.description || '',
			avatar_id: agent.avatarId || agent.avatar_id,
		}),
	});
	if (!confirmResp.ok) {
		const data = await confirmResp.json().catch(() => ({}));
		const err = new Error(
			data.error_description || `solana-register-confirm returned ${confirmResp.status}`,
		);
		err.status = confirmResp.status;
		err.code = data.error;
		err.txSignature = signature;
		throw err;
	}
	const confirmed = await confirmResp.json();
	return {
		assetPubkey: prep.asset_pubkey,
		txSignature: signature,
		network,
		agent: confirmed.agent,
		...(vanity?.prefix ? { vanityPrefix: vanity.prefix } : {}),
	};
}
