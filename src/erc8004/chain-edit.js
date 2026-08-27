/**
 * On-chain agent edit flow — /a/:chainId/:agentId/edit
 *
 * Loads the current manifest from tokenURI, verifies wallet ownership,
 * lets the user edit name/description/avatar, then re-pins the manifest
 * and calls setAgentURI on-chain.
 */

import { BrowserProvider, Contract } from 'ethers';
import { IDENTITY_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from './abi.js';
import { CHAIN_META, readProvider } from './chain-meta.js';
import { fetchAgentMetadata, findAvatar3D } from './queries.js';
import { buildRegistrationJSON, pinFile } from './agent-registry.js';
import { resolveURI } from '../ipfs.js';

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

/**
 * Mount the chain-edit UI into `rootEl`.
 * @param {HTMLElement} rootEl
 * @param {number} chainId
 * @param {string|bigint} agentId
 */
export async function mountChainEdit(rootEl, chainId, agentId) {
	const chainMeta = CHAIN_META[chainId];
	if (!chainMeta) {
		rootEl.innerHTML = `<div class="ce-error">Chain ${esc(chainId)} is not supported.</div>`;
		return;
	}

	const deployment = REGISTRY_DEPLOYMENTS[chainId];
	if (!deployment?.identityRegistry) {
		rootEl.innerHTML = `<div class="ce-error">No registry on chain ${esc(chainId)}.</div>`;
		return;
	}

	rootEl.innerHTML = renderShell(chainId, agentId, chainMeta);

	const statusEl = rootEl.querySelector('#ce-status');
	const formEl = rootEl.querySelector('#ce-form');
	const connectBtn = rootEl.querySelector('#ce-connect');
	const saveBtn = rootEl.querySelector('#ce-save');
	const viewerEl = rootEl.querySelector('#ce-viewer');

	setStatus(statusEl, 'Loading agent…');

	// ── 1. Load current manifest ───────────────────────────────────────────
	let currentManifest = null;
	let currentTokenURI = null;
	let currentGlbUrl = null;

	try {
		const provider = readProvider(chainId);
		const registry = new Contract(deployment.identityRegistry, IDENTITY_REGISTRY_ABI, provider);
		currentTokenURI = await registry.tokenURI(agentId).catch(() => null);

		if (currentTokenURI) {
			const { ok, data } = await fetchAgentMetadata(currentTokenURI);
			if (ok && data) {
				currentManifest = data;
				const rawGlb = findAvatar3D(data);
				if (rawGlb) currentGlbUrl = await resolveURI(rawGlb).catch(() => rawGlb);
			}
		}
	} catch (err) {
		setStatus(statusEl, `Could not load agent: ${esc(err.message)}`, 'error');
		return;
	}

	// Pre-fill form
	const nameInput = rootEl.querySelector('#ce-name');
	const descInput = rootEl.querySelector('#ce-desc');
	nameInput.value = currentManifest?.name || '';
	descInput.value = currentManifest?.description || '';

	if (currentGlbUrl) {
		viewerEl.src = currentGlbUrl;
		viewerEl.removeAttribute('hidden');
	}

	setStatus(statusEl, 'Connect your wallet to edit.');
	formEl.removeAttribute('hidden');

	// ── 2. Wallet connect + ownership check ───────────────────────────────
	let signer = null;
	let connectedAddress = null;

	connectBtn.addEventListener('click', async () => {
		connectBtn.disabled = true;
		connectBtn.textContent = 'Connecting…';
		setStatus(statusEl, '');

		try {
			if (!window.ethereum) throw new Error('No wallet detected — install MetaMask.');
			const browserProvider = new BrowserProvider(window.ethereum);
			signer = await browserProvider.getSigner();
			connectedAddress = await signer.getAddress();

			// Verify chain
			const network = await browserProvider.getNetwork();
			const walletChainId = Number(network.chainId);
			if (walletChainId !== chainId) {
				try {
					await window.ethereum.request({
						method: 'wallet_switchEthereumChain',
						params: [{ chainId: '0x' + chainId.toString(16) }],
					});
					// Re-get signer after switch
					const switched = new BrowserProvider(window.ethereum);
					signer = await switched.getSigner();
				} catch {
					throw new Error(
						`Switch your wallet to ${chainMeta.name} (chainId ${chainId}) to edit this agent.`,
					);
				}
			}

			// Verify ownership
			const provider2 = signer.provider;
			const registry = new Contract(deployment.identityRegistry, IDENTITY_REGISTRY_ABI, provider2);
			const owner = await registry.ownerOf(agentId).catch(() => null);

			if (!owner || owner.toLowerCase() !== connectedAddress.toLowerCase()) {
				throw new Error(`This wallet (${connectedAddress.slice(0, 6)}…) does not own agent #${agentId}.`);
			}

			connectBtn.textContent = `${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)} ✓`;
			connectBtn.classList.add('ce-btn--connected');
			saveBtn.disabled = false;
			setStatus(statusEl, 'Ownership verified. Make your edits and save.');
		} catch (err) {
			connectBtn.disabled = false;
			connectBtn.textContent = 'Connect Wallet';
			setStatus(statusEl, esc(err.message), 'error');
		}
	});

	// ── 3. GLB file picker preview ────────────────────────────────────────
	const glbInput = rootEl.querySelector('#ce-glb');
	let pendingGlbFile = null;

	glbInput.addEventListener('change', () => {
		const file = glbInput.files?.[0];
		if (!file) return;
		pendingGlbFile = file;
		const url = URL.createObjectURL(file);
		viewerEl.src = url;
		viewerEl.removeAttribute('hidden');
	});

	// ── 4. Save ───────────────────────────────────────────────────────────
	saveBtn.addEventListener('click', async () => {
		if (!signer) return;
		saveBtn.disabled = true;
		saveBtn.textContent = 'Saving…';
		setStatus(statusEl, '');

		try {
			const name = nameInput.value.trim() || currentManifest?.name || `Agent #${agentId}`;
			const description = descInput.value.trim();

			// Pin new GLB if provided
			let glbUrl = currentGlbUrl;
			if (pendingGlbFile) {
				setStatus(statusEl, 'Uploading new avatar…');
				glbUrl = await pinFile(pendingGlbFile);
			}

			// Rebuild manifest preserving existing services + fields
			const updatedManifest = {
				...(currentManifest || {}),
				name,
				description,
			};

			if (glbUrl) {
				// Update avatar service in-place if present, else use buildRegistrationJSON logic
				const services = Array.isArray(updatedManifest.services) ? [...updatedManifest.services] : [];
				const avatarIdx = services.findIndex((s) => s.name === 'avatar' || s.name === 'avatar-3d');
				const avatarEntry = { name: 'avatar', endpoint: glbUrl, version: 'gltf-2.0' };
				if (avatarIdx >= 0) services[avatarIdx] = avatarEntry;
				else services.unshift(avatarEntry);
				updatedManifest.services = services;
				updatedManifest.body = { uri: glbUrl, format: 'gltf-binary' };
			}

			// Pin the updated manifest
			setStatus(statusEl, 'Pinning updated manifest…');
			const jsonBlob = new Blob([JSON.stringify(updatedManifest, null, 2)], {
				type: 'application/json',
			});
			const newManifestUrl = await pinFile(jsonBlob);

			// Call setAgentURI on-chain
			setStatus(statusEl, 'Submitting transaction…');
			const registry = new Contract(deployment.identityRegistry, IDENTITY_REGISTRY_ABI, signer);
			const tx = await registry.setAgentURI(agentId, newManifestUrl);
			setStatus(statusEl, `Transaction submitted: ${tx.hash.slice(0, 10)}… — waiting for confirmation.`);
			await tx.wait();

			setStatus(statusEl, 'Saved! Agent updated on-chain.', 'success');
			saveBtn.textContent = 'Saved ✓';

			// Link to the agent page
			const agentPageUrl = `/a/${encodeURIComponent(chainId)}/${encodeURIComponent(agentId)}`;
			setStatus(
				statusEl,
				`Agent updated. <a href="${esc(agentPageUrl)}" class="ce-link">View agent →</a>`,
				'success',
			);
		} catch (err) {
			setStatus(statusEl, esc(err.message), 'error');
			saveBtn.disabled = false;
			saveBtn.textContent = 'Save Changes';
		}
	});
}

function setStatus(el, html, type = '') {
	el.innerHTML = html;
	el.className = `ce-status${type ? ` ce-status--${type}` : ''}`;
}

function renderShell(chainId, agentId, chainMeta) {
	return `
		<h1 class="ce-title">Edit Agent <span class="ce-chain-label">${esc(chainMeta.shortName)} #${esc(agentId)}</span></h1>

		<model-viewer
			id="ce-viewer"
			camera-controls
			auto-rotate
			rotation-per-second="15deg"
			exposure="0.9"
			shadow-intensity="0.4"
			interaction-prompt="none"
			class="ce-viewer"
			hidden
			alt="Agent avatar preview"
		></model-viewer>

		<div id="ce-status" class="ce-status">Loading…</div>

		<form id="ce-form" hidden>
			<label class="ce-label" for="ce-name">Name</label>
			<input id="ce-name" class="ce-input" type="text" maxlength="80" placeholder="Agent name" />

			<label class="ce-label" for="ce-desc">Description</label>
			<textarea id="ce-desc" class="ce-input ce-textarea" rows="3" maxlength="500" placeholder="What does this agent do?"></textarea>

			<label class="ce-label" for="ce-glb">Avatar GLB <span class="ce-optional">(optional — replaces current)</span></label>
			<input id="ce-glb" class="ce-input ce-file" type="file" accept=".glb,.gltf" />

			<div class="ce-actions">
				<button type="button" id="ce-connect" class="ce-btn ce-btn--ghost">Connect Wallet</button>
				<button type="button" id="ce-save" class="ce-btn ce-btn--primary" disabled>Save Changes</button>
			</div>
		</form>
	`;
}
