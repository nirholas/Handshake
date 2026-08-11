/**
 * ERC-8004 registry: wallet connection, IPFS pinning, on-chain registration.
 *
 * ethers v6 is an OPTIONAL peer dependency and is loaded at call time, so
 * importing @three-ws/sdk for the panel, the avatar or the manifests works
 * without it installed. Only the functions below that actually touch a chain
 * pay for it.
 */

import { loadEthers } from '../peer.js';
import { IDENTITY_REGISTRY_ABI, agentRegistryId, getRegistry } from './abi.js';

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

let _provider = null;
let _signer = null;

/**
 * Connect to the user's injected wallet (MetaMask, Coinbase Wallet, etc.).
 * @returns {Promise<{provider, signer, address: string, chainId: number}>}
 */
export async function connectWallet() {
	if (!window.ethereum) {
		throw new Error('No wallet detected. Install MetaMask or a compatible wallet.');
	}

	const { BrowserProvider } = await loadEthers('connectWallet()');
	_provider = new BrowserProvider(window.ethereum);
	_signer = await _provider.getSigner();
	const address = await _signer.getAddress();
	const { chainId } = await _provider.getNetwork();

	return { provider: _provider, signer: _signer, address, chainId: Number(chainId) };
}

/** @returns {import('ethers').Signer | null} */
export function getSigner() {
	return _signer;
}

// ---------------------------------------------------------------------------
// IPFS
// ---------------------------------------------------------------------------

/**
 * Pin a Blob/File to IPFS via web3.storage.
 * Pass your API token or set window.__W3S_TOKEN beforehand.
 *
 * @param {Blob|File} blob
 * @param {string} [apiToken]
 * @returns {Promise<string>} IPFS CID
 */
export async function pinToIPFS(blob, apiToken) {
	const token = apiToken || window.__W3S_TOKEN;
	if (!token) {
		throw new Error('IPFS upload requires an API token. Pass one or set window.__W3S_TOKEN.');
	}

	const res = await fetch('https://api.web3.storage/upload', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
		body: blob,
	});

	if (!res.ok) {
		throw new Error(`IPFS upload failed (${res.status}): ${await res.text()}`);
	}

	return (await res.json()).cid;
}

// ---------------------------------------------------------------------------
// Registration JSON
// ---------------------------------------------------------------------------

/**
 * Build an ERC-8004 agent registration document.
 *
 * @param {object} opts
 * @param {string}   opts.name           Agent display name
 * @param {string}   opts.description    Agent description
 * @param {string}   opts.imageCID       IPFS CID of the agent's image/avatar
 * @param {number}   opts.agentId        Token ID returned by the registry
 * @param {number}   opts.chainId        Chain ID where the agent is registered
 * @param {string}   opts.registryAddr   Identity Registry contract address
 * @param {Array}    [opts.services]     Additional service entries
 * @returns {object}
 */
export function buildRegistrationJSON({
	name,
	description,
	imageCID,
	agentId,
	chainId,
	registryAddr,
	services = [],
}) {
	return {
		type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
		name,
		description,
		image: imageCID ? `ipfs://${imageCID}` : undefined,
		active: true,
		services,
		registrations: [
			{
				agentId,
				agentRegistry: agentRegistryId(chainId, registryAddr),
			},
		],
		supportedTrust: ['reputation'],
	};
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Get the Identity Registry contract for the connected chain.
 *
 * Async because ethers is an optional peer loaded on demand. Address
 * resolution goes through `getRegistry`, so a `THREE_WS_REGISTRY_IDENTITY_
 * <chainId>` env override wins over the built-in deployment table and an
 * unconfigured chain throws instead of returning the zero address.
 *
 * @param {number} chainId
 * @param {import('ethers').Signer} signer
 * @returns {Promise<import('ethers').Contract>}
 */
export async function getIdentityRegistry(chainId, signer) {
	const address = getRegistry(chainId, 'identityRegistry');
	const { Contract } = await loadEthers('getIdentityRegistry()');
	return new Contract(address, IDENTITY_REGISTRY_ABI, signer);
}

// ---------------------------------------------------------------------------
// Full registration flow
// ---------------------------------------------------------------------------

/**
 * Register an agent on-chain end-to-end.
 *
 * Steps:
 *  1. Connect wallet
 *  2. Pin image to IPFS (optional — skip if no file provided)
 *  3. Call register() on-chain, capture agentId from event
 *  4. Build + pin registration JSON to IPFS
 *  5. Call setAgentURI() with the final registration CID
 *
 * @param {object}   opts
 * @param {string}   opts.name           Agent name
 * @param {string}   opts.description    Agent description
 * @param {string}   opts.endpoint       Your agent's web endpoint (https://...)
 * @param {File}     [opts.imageFile]    Optional image/avatar to pin to IPFS
 * @param {Array}    [opts.services]     Additional A2A / MCP service entries
 * @param {string}   [opts.apiToken]     IPFS pinning API token
 * @param {Function} [opts.onStatus]     Progress callback (message: string) => void
 * @returns {Promise<{agentId: number, registrationCID: string, txHash: string}>}
 */
export async function registerAgent({
	name,
	description,
	endpoint,
	imageFile,
	services = [],
	apiToken,
	onStatus,
}) {
	const log = onStatus || (() => {});

	log('Connecting wallet...');
	const { signer, chainId } = await connectWallet();

	let imageCID = null;
	if (imageFile) {
		log('Uploading image to IPFS...');
		imageCID = await pinToIPFS(imageFile, apiToken);
		log(`Image pinned: ipfs://${imageCID}`);
	}

	const registry = await getIdentityRegistry(chainId, signer);

	log('Registering agent on-chain...');
	const tx = await registry['register(string)'](imageCID ? `ipfs://${imageCID}` : endpoint);
	log(`Transaction submitted: ${tx.hash}`);
	const receipt = await tx.wait();

	const registeredEvent = receipt.logs
		.map((l) => {
			try {
				return registry.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'Registered');

	if (!registeredEvent) {
		throw new Error('Registration succeeded but Registered event not found in receipt.');
	}

	const agentId = Number(registeredEvent.args.agentId);
	log(`Agent minted — agentId: ${agentId}`);

	const allServices = [{ name: 'web', endpoint }, ...services];

	const registrationJSON = buildRegistrationJSON({
		name,
		description,
		imageCID,
		agentId,
		chainId,
		registryAddr: getRegistry(chainId, 'identityRegistry'),
		services: allServices,
	});

	log('Pinning registration metadata to IPFS...');
	const jsonBlob = new Blob([JSON.stringify(registrationJSON, null, 2)], {
		type: 'application/json',
	});
	const registrationCID = await pinToIPFS(jsonBlob, apiToken);
	log(`Registration JSON pinned: ipfs://${registrationCID}`);

	log('Updating agentURI on-chain...');
	await (await registry.setAgentURI(agentId, `ipfs://${registrationCID}`)).wait();
	log('Done. Agent is live on-chain.');

	return { agentId, registrationCID, txHash: tx.hash };
}
