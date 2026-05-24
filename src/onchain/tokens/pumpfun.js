/**
 * PumpfunTokenAdapter — front-end facade for launching an agent's token on
 * Pump.fun's bonding curve.
 *
 * Most of the heavy lifting (mint keypair generation, fetching `global`,
 * building the `createV2Instruction` tx) happens server-side in
 * api/agents/tokens/launch-prep.js — this module only:
 *
 *  1. Validates that the agent has a Solana identity (Pump.fun is Solana-only).
 *  2. Calls the prep endpoint, gets back a base64 partially-signed tx.
 *  3. Hands the tx to the user's Solana wallet for the user-signature.
 *  4. Submits the fully-signed tx through our own Connection on the chosen
 *     cluster (mirroring the SolanaAdapter discipline of not trusting the
 *     wallet's RPC).
 *  5. Calls the confirm endpoint to verify + persist `meta.token`.
 */

import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAdapter as getWalletAdapter } from '../adapters/index.js';

// Route through our same-origin proxy. The public mainnet RPC returns 403 to
// most browser origins; the proxy forwards server-side to Helius when
// HELIUS_API_KEY is set. Absolute URL because Connection() derives a WS URL.
const RPC_ORIGIN =
	typeof window !== 'undefined' && window.location?.origin
		? window.location.origin
		: 'https://three.ws';
const SOLANA_RPC = {
	mainnet: `${RPC_ORIGIN}/api/solana-rpc`,
	devnet: `${RPC_ORIGIN}/api/solana-rpc?net=devnet`,
};

function decodeTx(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	try {
		return VersionedTransaction.deserialize(bytes);
	} catch {
		return Transaction.from(bytes);
	}
}

/** @implements {import('./base.js').TokenAdapter} */
export class PumpfunTokenAdapter {
	get provider() {
		return 'pumpfun';
	}

	get family() {
		return 'solana';
	}

	/** @param {{ agent: object }} ctx */
	validatePreconditions({ agent }) {
		const onchain = agent?.onchain;
		if (!onchain) {
			return {
				ok: false,
				reason: 'Agent must be deployed on-chain before launching a token.',
			};
		}
		if (onchain.family !== 'solana') {
			return {
				ok: false,
				reason: 'Pump.fun launches require a Solana-deployed agent.',
			};
		}
		if (agent?.token?.mint) {
			return { ok: false, reason: 'This agent already has a launched token.' };
		}
		return { ok: true };
	}

	/**
	 * @param {object} opts
	 * @param {object} opts.agent
	 * @param {{ name: string, symbol: string, description?: string, image?: string, initialBuySol?: number }} opts.params
	 * @param {(step: 'connect'|'prep'|'sign'|'submit'|'confirm') => void} [opts.onProgress]
	 * @returns {Promise<{ mint: string, txHash: string, provider: 'pumpfun', cluster: 'mainnet'|'devnet' }>}
	 */
	async launch({ agent, params, onProgress = () => {} }) {
		const pre = this.validatePreconditions({ agent });
		if (!pre.ok) {
			const err = new Error(pre.reason);
			err.code = 'PRECONDITION_FAILED';
			throw err;
		}

		const cluster = agent.onchain.cluster || 'mainnet';
		const wallet = getWalletAdapter('solana');
		if (!wallet.isAvailable()) {
			const err = new Error('No Solana wallet detected.');
			err.code = 'NO_PROVIDER';
			err.installUrl = wallet.installUrl();
			throw err;
		}

		onProgress('connect');
		const { address } = await wallet.connect({ ensureLinked: true, cluster });
		if (address !== agent.onchain.wallet) {
			const err = new Error(
				'Connected wallet does not match the agent owner. Switch wallets and retry.',
			);
			err.code = 'WALLET_MISMATCH';
			throw err;
		}

		onProgress('prep');
		const prepResp = await fetch('/api/agents/tokens/launch-prep', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				agent_id: agent.id,
				provider: 'pumpfun',
				cluster,
				wallet_address: address,
				name: params.name,
				symbol: params.symbol,
				description: params.description || '',
				image: params.image || agent.thumbnailUrl || '',
				initial_buy_sol: Number.isFinite(params.initialBuySol) ? params.initialBuySol : 0,
			}),
		});
		if (!prepResp.ok) {
			const data = await prepResp.json().catch(() => ({}));
			const err = new Error(
				data.error_description || `launch-prep returned ${prepResp.status}`,
			);
			err.status = prepResp.status;
			err.code = data.error;
			throw err;
		}
		const prep = await prepResp.json();

		onProgress('sign');
		const provider =
			window.phantom?.solana || window.solana || window.backpack?.solana || window.solflare;
		if (!provider) throw new Error('Solana wallet vanished mid-flow.');

		const tx = decodeTx(prep.tx_base64);
		const signed = await provider.signTransaction(tx);

		onProgress('submit');
		const conn = new Connection(SOLANA_RPC[cluster], 'confirmed');
		const signature = await conn.sendRawTransaction(signed.serialize(), {
			skipPreflight: false,
			preflightCommitment: 'confirmed',
		});

		// Bounded poll (Pump.fun launches occasionally take 10–20s on devnet).
		await this.#waitForConfirmation(conn, signature, 90_000);

		onProgress('confirm');
		const confirmResp = await fetch('/api/agents/tokens/launch-confirm', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				prep_id: prep.prep_id,
				tx_signature: signature,
				wallet_address: address,
			}),
		});
		if (!confirmResp.ok) {
			const data = await confirmResp.json().catch(() => ({}));
			const err = new Error(
				data.error_description || `launch-confirm returned ${confirmResp.status}`,
			);
			err.status = confirmResp.status;
			err.code = data.error;
			err.txSignature = signature;
			throw err;
		}
		const confirmed = await confirmResp.json();
		return {
			mint: prep.mint,
			txHash: signature,
			provider: 'pumpfun',
			cluster,
			agent: confirmed.agent,
			pumpfunUrl:
				cluster === 'mainnet'
					? `https://pump.fun/${prep.mint}`
					: `https://explorer.solana.com/address/${prep.mint}?cluster=devnet`,
		};
	}

	async #waitForConfirmation(conn, signature, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const { value } = await conn.getSignatureStatuses([signature]);
			const s = value?.[0];
			if (s) {
				if (s.err) {
					const e = new Error(`Token launch failed: ${JSON.stringify(s.err)}`);
					e.code = 'TX_FAILED';
					throw e;
				}
				if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
					return;
				}
			}
			await new Promise((r) => setTimeout(r, 1500));
		}
		const e = new Error('Launch confirmation timed out. Tx may still land — check explorer.');
		e.code = 'TX_TIMEOUT';
		throw e;
	}
}
