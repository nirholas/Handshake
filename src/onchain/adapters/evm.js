/**
 * EvmAdapter — wraps an injected EIP-1193 provider (MetaMask, Brave, Rabby…).
 *
 * Reuses the existing ethers integration in src/erc8004/agent-registry.js so we
 * don't fork wallet state. The adapter is a thin facade over those helpers.
 */

import { ensureWallet, getIdentityRegistry } from '../../erc8004/agent-registry.js';
import { switchChain, CHAIN_META } from '../../erc8004/chain-meta.js';
import { evm } from '../chain-ref.js';

/** @implements {import('./base.js').WalletAdapter} */
export class EvmAdapter {
	get family() {
		return 'evm';
	}

	isAvailable() {
		return typeof window !== 'undefined' && !!window.ethereum;
	}

	installUrl() {
		return 'https://metamask.io/download/';
	}

	async connect() {
		const { signer, chainId } = await ensureWallet();
		const address = await signer.getAddress();
		return { address, ref: evm(chainId) };
	}

	async switchTo(ref) {
		if (ref.family !== 'evm') {
			throw new Error('EvmAdapter cannot switch to non-EVM chain');
		}
		await switchChain(ref.chainId);
	}

	async signAndSend(prep, ref) {
		if (ref.family !== 'evm') throw new Error('EvmAdapter expects an EVM ChainRef');
		const { signer } = await ensureWallet();
		const registry = getIdentityRegistry(ref.chainId, signer);

		const tx = await registry['register(string)'](prep.metadataUri);
		const receipt = await tx.wait();
		if (receipt?.status !== 1) {
			const e = new Error('EVM transaction reverted');
			e.code = 'TX_REVERTED';
			throw e;
		}

		// Pull the agentId out of the Registered event for cross-checking server-side.
		let onchainId = null;
		for (const log of receipt.logs || []) {
			try {
				const parsed = registry.interface.parseLog(log);
				if (parsed?.name === 'Registered') {
					onchainId = String(parsed.args.agentId);
					break;
				}
			} catch {
				/* not our event */
			}
		}

		return { txHash: tx.hash, onchainId };
	}

	/** @param {number} chainId */
	chainName(chainId) {
		return CHAIN_META[chainId]?.name || `Chain ${chainId}`;
	}
}
