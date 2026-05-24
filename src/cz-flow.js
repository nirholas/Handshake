/**
 * CZ demo claim flow — manages wallet connection, claiming, and transfer flows.
 */

import { ensureWallet, getIdentityRegistry } from './erc8004/agent-registry.js';

/**
 * Start the claim flow based on the current state.
 *
 * @param {object} opts
 * @param {object} opts.state  Current state (status, chainId, agentId, ownerAddress, etc.)
 * @param {(progress) => void} opts.onProgress  Callback with { step, status, txHash?, error? }
 * @returns {Promise<{ ok: true, txHash? } | { ok: false, error }>}
 */
export async function startClaim({ state, onProgress }) {
	const log = (step, status, extra = {}) => {
		onProgress?.({ step, status, ...extra });
	};

	try {
		// Step 1: Connect wallet
		log('connect_wallet', 'connecting');
		const { address, chainId, signer } = await ensureWallet();
		log('connect_wallet', 'connected', { address, chainId });

		// Step 2: Check state
		if (state.status === 'pre-onchain') {
			log('check_state', 'pre_onchain', {
				message:
					'CZ is not yet registered on-chain. Claiming opens once registration is complete.',
			});
			return { ok: true, message: 'pre_onchain' };
		}

		const registry = getIdentityRegistry(chainId, signer);

		// Step 3: If ownerAddress is 0x0 (unclaimed), call claim()
		if (state.ownerAddress === '0x0000000000000000000000000000000000000000') {
			log('claim', 'submitting');
			const tx = await registry.claim(state.agentId);
			log('claim', 'pending', { txHash: tx.hash });

			await tx.wait();
			log('claim', 'confirmed', { txHash: tx.hash });

			fireAnalytics('claim_tx_sent', { txHash: tx.hash, agentId: state.agentId });
			fireAnalytics('claim_complete', { agentId: state.agentId });
			return { ok: true, txHash: tx.hash };
		}

		// Step 4: Already owned by the connected wallet.
		if (state.ownerAddress?.toLowerCase() === address.toLowerCase()) {
			log('claim', 'already_owned', { owner: address });
			return { ok: true, message: 'already_owned' };
		}

		// Step 5: Transfer from the current owner to the connected wallet.
		// ERC-721 transferFrom can only be called by the token owner or an approved
		// operator. Verify the connected wallet is the owner before submitting so we
		// surface a clean error instead of an opaque on-chain revert.
		const onchainOwner = await registry.ownerOf(state.agentId).catch(() => null);
		if (onchainOwner && onchainOwner.toLowerCase() !== address.toLowerCase()) {
			return {
				ok: false,
				error: `Transfer failed: the connected wallet (${address}) is not the current owner. The agent is owned by ${onchainOwner}.`,
			};
		}
		log('transfer', 'submitting', { from: state.ownerAddress, to: address });
		const tx = await registry.transferFrom(state.ownerAddress, address, state.agentId);
		log('transfer', 'pending', { txHash: tx.hash });
		await tx.wait();
		log('transfer', 'confirmed', { txHash: tx.hash });
		fireAnalytics('transfer_complete', { txHash: tx.hash, agentId: state.agentId });
		return { ok: true, txHash: tx.hash };
	} catch (err) {
		log('claim', 'error', { error: err.message });
		fireAnalytics('claim_error', { error: err.message });
		return { ok: false, error: err.message };
	}
}

/**
 * Mount the embed copy CTA to a container.
 * Copies an <agent-3d> snippet to clipboard with chain/agentId interpolated.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {object} opts.state  Current state
 */
export function mountEmbedCopy(container, { state }) {
	const button = document.createElement('button');
	button.id = 'cz-embed-copy';
	button.textContent = 'Copy embed';
	button.setAttribute('aria-label', 'Copy embed code to clipboard');

	button.addEventListener('click', async () => {
		const snippet = buildEmbedSnippet(state);
		try {
			await navigator.clipboard.writeText(snippet);
			const orig = button.textContent;
			button.textContent = 'Copied!';
			fireAnalytics('embed_copied', {
				hasChainId: !!state.chainId,
				hasAgentId: !!state.agentId,
			});
			setTimeout(() => {
				button.textContent = orig;
			}, 2000);
		} catch (err) {
			console.error('Copy failed:', err);
			button.textContent = 'Copy failed';
			setTimeout(() => {
				button.textContent = 'Copy embed';
			}, 2000);
		}
	});

	container.appendChild(button);
	return button;
}

/**
 * Build the embed snippet HTML based on state.
 */
function buildEmbedSnippet(state) {
	let agentAttr = '';
	if (state.chainId && state.agentId) {
		agentAttr = ` agent-id="onchain:${state.chainId}:${state.agentId}"`;
	} else {
		// Fallback: just use the GLB directly
		agentAttr = ` body="${state.avatarUrl}"`;
	}

	return `<agent-3d${agentAttr} src="${state.avatarUrl}" eager></agent-3d>
<script type="module" src="https://three.ws/dist-lib/agent-3d.js"><\/script>`;
}

/**
 * Fire a custom event for analytics.
 */
function fireAnalytics(event, props = {}) {
	window.dispatchEvent(
		new CustomEvent('cz-demo-event', {
			detail: { event, props, timestamp: Date.now() },
		}),
	);
}

export { fireAnalytics };
