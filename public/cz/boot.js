/**
 * CZ landing page initialization — loads state, wires up CTAs, handles claim flow.
 */

import { startClaim, mountEmbedCopy, fireAnalytics } from '../../src/cz-flow.js';

async function init() {
	// Load state
	let state = {
		status: 'pre-onchain',
		chainId: null,
		agentId: null,
		metadataURI: null,
		ownerAddress: null,
		avatarUrl: '/avatars/cz.glb',
	};

	try {
		const res = await fetch('./state.json');
		if (res.ok) {
			state = await res.json();
		}
	} catch (err) {
		console.warn('Failed to load state.json:', err);
	}

	// Update footer with state
	updateFooter(state);

	// Wire up claim button
	const claimBtn = document.getElementById('cz-claim-btn');
	if (claimBtn) {
		claimBtn.addEventListener('click', () => handleClaimClick(state));
	}

	// Wire up embed copy
	const embedContainer = document.getElementById('cz-embed-container');
	if (embedContainer) {
		mountEmbedCopy(embedContainer, { state });
	}

	// Fire landing view event
	fireAnalytics('landing_view', { status: state.status });
}

function updateFooter(state) {
	const footer = document.getElementById('cz-footer');
	if (!footer) return;

	if (state.status === 'pre-onchain') {
		footer.innerHTML = `
			<p>Not yet onchain</p>
		`;
	} else {
		const chainName = getChainName(state.chainId);
		footer.innerHTML = `
			<p><strong>Chain:</strong> ${chainName}</p>
			<p><strong>Agent ID:</strong> ${state.agentId}</p>
			${state.metadataURI ? `<p><strong>Metadata:</strong> <code>${truncate(state.metadataURI, 40)}</code></p>` : ''}
		`;
	}
}

function getChainName(chainId) {
	const chains = {
		1: 'Ethereum',
		8453: 'Base',
		84532: 'Base Sepolia',
	};
	return chains[chainId] || `Chain ${chainId}`;
}

function truncate(str, len) {
	return str.length > len ? str.slice(0, len - 3) + '…' : str;
}

async function handleClaimClick(state) {
	const claimBtn = document.getElementById('cz-claim-btn');
	const modal = document.getElementById('cz-claim-modal');

	if (!modal) return;

	fireAnalytics('claim_start', {});

	// Show modal with spinner
	modal.style.display = 'flex';
	const content = document.getElementById('cz-modal-content');
	const closeBtn = document.getElementById('cz-modal-close');

	content.innerHTML = `
		<div class="modal-spinner"></div>
		<p>Initializing claim flow…</p>
	`;

	closeBtn.addEventListener('click', () => {
		modal.style.display = 'none';
	});

	modal.addEventListener('click', (e) => {
		if (e.target === modal) modal.style.display = 'none';
	});

	// Run claim flow
	const result = await startClaim({
		state,
		onProgress: (progress) => {
			updateModal(progress, state);
		},
	});

	if (result.ok) {
		if (result.message === 'pre_onchain') {
			content.innerHTML = `
				<h3 style="margin:0 0 1rem">Coming Soon</h3>
				<p>CZ is not yet registered on-chain. Claiming opens once the registration is complete.</p>
				<button class="modal-close-btn" onclick="document.getElementById('cz-claim-modal').style.display='none'">OK</button>
			`;
		} else if (result.message === 'already_owned') {
			content.innerHTML = `
				<h3 style="margin:0 0 1rem">Already Claimed</h3>
				<p>This agent is already owned by <code>${truncate(state.ownerAddress, 20)}</code>.</p>
				<button class="modal-close-btn" onclick="document.getElementById('cz-claim-modal').style.display='none'">OK</button>
			`;
		} else {
			content.innerHTML = `
				<h3 style="margin:0 0 1rem">Claim Successful</h3>
				<p>Transaction: <code>${result.txHash}</code></p>
				<button class="modal-close-btn" onclick="document.getElementById('cz-claim-modal').style.display='none'">OK</button>
			`;
		}
	} else {
		content.innerHTML = `
			<h3 style="margin:0 0 1rem">Error</h3>
			<p>${result.error}</p>
			<button class="modal-close-btn" onclick="document.getElementById('cz-claim-modal').style.display='none'">Dismiss</button>
		`;
	}
}

function updateModal(progress, state) {
	const content = document.getElementById('cz-modal-content');
	const { step, status, error } = progress;

	if (error) {
		content.innerHTML = `
			<h3 style="margin:0 0 1rem">Error</h3>
			<p>${error}</p>
		`;
		return;
	}

	const messages = {
		connect_wallet: {
			connecting: 'Connecting wallet…',
			connected: `Connected: ${progress.address?.slice(0, 10)}…`,
		},
		check_state: {
			pre_onchain: 'Checking agent status…',
		},
		claim: {
			submitting: 'Submitting claim…',
			pending: 'Waiting for confirmation…',
			confirmed: 'Claim confirmed!',
			already_owned: 'Already owned.',
		},
		transfer: {
			submitting: 'Submitting transfer…',
			pending: 'Waiting for confirmation…',
			confirmed: 'Transfer confirmed!',
		},
	};

	const msg = messages[step]?.[status] || `${step}: ${status}`;
	content.innerHTML = `
		<div class="modal-spinner"></div>
		<p>${msg}</p>
	`;
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
