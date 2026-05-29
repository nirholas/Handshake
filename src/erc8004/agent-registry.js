/**
 * ERC-8004 Agent Registry — wallet + contract interaction layer.
 *
 * Handles:
 *  1. Wallet connection (injected provider — MetaMask, Brave, etc.)
 *  2. Uploading GLB + registration JSON to IPFS via web3.storage or Filebase
 *  3. Calling register() on the Identity Registry
 *  4. Building the ERC-8004 registration JSON
 */

import { BrowserProvider, Contract } from 'ethers';
import { IDENTITY_REGISTRY_ABI, REGISTRY_DEPLOYMENTS, agentRegistryId } from './abi.js';
import { glbFileToThumbnail } from './thumbnail.js';

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

let _provider = null;
let _signer = null;
let _address = null;
let _chainId = null;
const _listeners = new Set();
let _walletEventsBound = false;

// localStorage hint — set after a successful explicit connect, cleared on
// `accountsChanged → []`. Lets us decide whether to *attempt* eager reconnect
// on a fresh page load (avoiding noisy `eth_accounts` polls for first-time
// visitors). Not authoritative — the wallet is still the source of truth.
const HINT_KEY = '3dagent:wallet-connected';

function setHint(on) {
	try {
		if (on) localStorage.setItem(HINT_KEY, '1');
		else localStorage.removeItem(HINT_KEY);
	} catch {
		/* private mode / storage disabled */
	}
}

function hasHint() {
	try {
		return localStorage.getItem(HINT_KEY) === '1';
	} catch {
		return false;
	}
}

function notify(reason) {
	const snapshot = {
		address: _address,
		chainId: _chainId,
		signer: _signer,
		reason,
	};
	for (const fn of _listeners) {
		try {
			fn(snapshot);
		} catch {
			/* listener errors must not break the bus */
		}
	}
}

function bindWalletEvents() {
	if (_walletEventsBound || !window.ethereum?.on) return;
	_walletEventsBound = true;

	window.ethereum.on('accountsChanged', async (accounts) => {
		if (!accounts || accounts.length === 0) {
			_provider = null;
			_signer = null;
			_address = null;
			_chainId = null;
			setHint(false);
			notify('disconnected');
			return;
		}
		// Re-derive signer for the new account (no popup).
		try {
			_provider = new BrowserProvider(window.ethereum);
			_signer = await _provider.getSigner();
			_address = await _signer.getAddress();
			const net = await _provider.getNetwork();
			_chainId = Number(net.chainId);
			notify('account-changed');
		} catch {
			/* swallow — next explicit connect will recover */
		}
	});

	window.ethereum.on('chainChanged', async (chainIdHex) => {
		_chainId = Number(chainIdHex);
		// Refresh provider/signer so they bind to the new network.
		if (_address) {
			try {
				_provider = new BrowserProvider(window.ethereum);
				_signer = await _provider.getSigner();
			} catch {
				/* signer may briefly be unavailable mid-switch */
			}
		}
		notify('chain-changed');
	});
}

/**
 * Subscribe to wallet state changes (connect, disconnect, account/chain switch).
 * Returns an unsubscribe function.
 *
 * @param {(state: { address: string|null, chainId: number|null, signer: import('ethers').Signer|null, reason: string }) => void} fn
 * @returns {() => void}
 */
export function onWalletChange(fn) {
	_listeners.add(fn);
	bindWalletEvents();
	return () => _listeners.delete(fn);
}

/**
 * Snapshot of the current wallet state without triggering a connection.
 * @returns {{ address: string|null, chainId: number|null, signer: import('ethers').Signer|null }}
 */
export function getWalletState() {
	return { address: _address, chainId: _chainId, signer: _signer };
}

/**
 * Attempt a *silent* reconnect using `eth_accounts` — no MetaMask popup.
 * Only succeeds if the wallet has previously authorized this origin and is
 * still unlocked. Safe to call on every page mount.
 *
 * @returns {Promise<{address: string, chainId: number, signer: import('ethers').Signer} | null>}
 *   Resolves to null when no eager connection is possible (no wallet, no prior
 *   authorization, locked, or wallet refused). Never throws.
 */
export async function eagerConnectWallet() {
	if (!window.ethereum) return null;
	// Skip the RPC roundtrip for users who've never connected — no hint, no try.
	// (Doesn't apply if the wallet was authorized in a previous session before
	// we shipped the hint; on first visit after deploy they get one extra
	// silent `eth_accounts` call which is free.)
	if (!hasHint() && _address === null) {
		// Still attempt once — `eth_accounts` is cheap and may surface an
		// already-authorized session that predates the hint mechanism.
	}
	try {
		const accounts = await window.ethereum.request({ method: 'eth_accounts' });
		if (!accounts || accounts.length === 0) {
			setHint(false);
			return null;
		}
		_provider = new BrowserProvider(window.ethereum);
		_signer = await _provider.getSigner();
		_address = await _signer.getAddress();
		const network = await _provider.getNetwork();
		_chainId = Number(network.chainId);
		setHint(true);
		bindWalletEvents();
		notify('eager-connected');
		return { address: _address, chainId: _chainId, signer: _signer };
	} catch {
		return null;
	}
}

/**
 * Connect a wallet via the injected EIP-1193 provider (MetaMask, Brave, etc.).
 *
 * @returns {Promise<{provider: BrowserProvider, signer: import('ethers').Signer, address: string, chainId: number}>}
 */
export async function connectWallet() {
	if (!window.ethereum) {
		throw new Error('No wallet detected. Install a wallet extension (MetaMask, Coinbase Wallet, etc.) or use a wallet-enabled browser.');
	}

	_provider = new BrowserProvider(window.ethereum);
	_signer = await _provider.getSigner();
	_address = await _signer.getAddress();
	const network = await _provider.getNetwork();
	_chainId = Number(network.chainId);

	setHint(true);
	bindWalletEvents();
	notify('connected');

	return { provider: _provider, signer: _signer, address: _address, chainId: _chainId };
}

/**
 * @returns {import('ethers').Signer | null}
 */
export function getSigner() {
	return _signer;
}

/**
 * Get a usable wallet for an action, preferring an existing connection.
 *
 * Resolution order:
 *   1. Already-connected signer (no popup)
 *   2. Eager `eth_accounts` reconnect (no popup)
 *   3. Explicit `connectWallet()` (popup if user hasn't authorized yet)
 *
 * Use this in any flow that needs `{ signer, address, chainId }` — instead of
 * calling `connectWallet()` directly, which always shows a popup if the
 * wallet's internal session has been forgotten.
 *
 * @returns {Promise<{signer: import('ethers').Signer, address: string, chainId: number}>}
 */
export async function ensureWallet() {
	if (_signer && _address && _chainId) {
		return { signer: _signer, address: _address, chainId: _chainId };
	}
	const eager = await eagerConnectWallet();
	if (eager) return eager;
	const fresh = await connectWallet();
	return { signer: fresh.signer, address: fresh.address, chainId: fresh.chainId };
}

/**
 * Tear down the in-memory wallet state and clear the eager-reconnect hint.
 * Does NOT revoke wallet-side permissions — there is no standard EIP-1193 RPC
 * for that; users must revoke from their wallet UI. After calling this, the
 * next `ensureWallet()` will prompt unless they re-authorize.
 */
export function disconnectWallet() {
	_provider = null;
	_signer = null;
	_address = null;
	_chainId = null;
	setHint(false);
	notify('disconnected');
}

// ---------------------------------------------------------------------------
// File upload — backend R2 (default) or Pinata (if token supplied)
// ---------------------------------------------------------------------------

/**
 * Upload a file blob. Returns the public URL.
 *
 * Without a token: POSTs to /api/erc8004/pin which stores to R2.
 * With a Pinata JWT token: POSTs to Pinata and returns an ipfs:// URL.
 *
 * @param {Blob|File} blob
 * @param {string} [apiToken]  Pinata JWT (optional)
 * @returns {Promise<string>}  Public URL for the uploaded file.
 */
export async function pinFile(blob, apiToken) {
	if (apiToken) {
		const form = new FormData();
		form.append('file', blob, blob.name || 'upload');
		const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiToken}` },
			body: form,
		});
		if (!res.ok) throw new Error(`Pinata upload failed (${res.status})`);
		const data = await res.json();
		return `ipfs://${data.IpfsHash}`;
	}

	const res = await fetch('/api/erc8004/pin', {
		method: 'POST',
		headers: { 'content-type': blob.type || 'application/octet-stream' },
		body: blob,
		credentials: 'include',
	});
	if (!res.ok) {
		const text = await res.text().catch(() => res.status);
		throw new Error(`Upload failed (${res.status}): ${text}`);
	}
	const data = await res.json();
	return data.url;
}

// ---------------------------------------------------------------------------
// Registration JSON builder
// ---------------------------------------------------------------------------

/**
 * Build an ERC-8004 agent registration JSON.
 *
 * @param {object} opts
 * @param {string} opts.name          Agent display name
 * @param {string} opts.description   Natural-language description
 * @param {string} opts.imageUrl      URL of the 3D GLB model (HTTPS or ipfs://)
 * @param {number} opts.agentId       Token ID from the registry (filled after mint)
 * @param {number} opts.chainId       Chain ID where registered
 * @param {string} opts.registryAddr  Identity Registry contract address
 * @param {string[]} [opts.services]  Additional service objects
 * @returns {object}
 */
/**
 * Build a spec-compliant ERC-8004 registration JSON.
 *
 * `imageUrl` is the 2D thumbnail (per NFT convention). `glbUrl` is optional —
 * when present, the GLB is surfaced as a dedicated `avatar` service entry and
 * a companion `3D` renderer service pointing at 3dagent so other apps can load
 * the body in-browser without coupling to our domain.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.description
 * @param {string} [opts.imageUrl]     2D thumbnail URL (PNG/JPG) — used for `image`
 * @param {string} [opts.glbUrl]       Optional GLB URL — emitted as an `avatar` service
 * @param {number} opts.agentId
 * @param {number} opts.chainId
 * @param {string} opts.registryAddr
 * @param {Array}  [opts.services]     Extra service entries
 * @param {boolean}[opts.x402Support]
 * @param {Array<{name:string,url:string,loop?:boolean,clipName?:string,source?:string}>} [opts.animations]
 *   Optional animation clip list — emitted as a top-level `animations` extension
 *   field (ERC-8004 permits extensions). Viewers that understand the field can
 *   attach extra clips; others ignore it harmlessly.
 */
export function buildRegistrationJSON({
	name,
	description,
	imageUrl,
	glbUrl,
	agentId,
	chainId,
	registryAddr,
	services = [],
	x402Support = false,
	animations,
}) {
	const baseServices = [];
	if (glbUrl) {
		baseServices.push({
			name: 'avatar',
			endpoint: glbUrl,
			version: 'gltf-2.0',
		});
		baseServices.push({
			name: '3D',
			endpoint: `https://three.ws/app#model=${encodeURIComponent(glbUrl)}`,
			version: '1.0',
		});
	}

	const json = {
		type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
		name,
		description,
		image: imageUrl || '',
		active: true,
		x402Support,
		services: [...baseServices, ...services],
		registrations: [
			{
				agentId,
				agentRegistry: agentRegistryId(chainId, registryAddr),
			},
		],
		supportedTrust: ['reputation'],
	};

	// Top-level `body` field follows specs/AGENT_MANIFEST.md convention and is
	// read directly by src/manifest.js → normalize(). Spec-permitted (extension
	// fields MAY be added). Redundant with the `avatar` service entry above but
	// keeps this repo's manifest resolver happy without forcing it to grep services.
	if (glbUrl) {
		json.body = { uri: glbUrl, format: 'gltf-binary' };
	}

	if (Array.isArray(animations) && animations.length > 0) {
		json.animations = animations;
	}

	return json;
}

// ---------------------------------------------------------------------------
// On-chain registration
// ---------------------------------------------------------------------------

/**
 * Get the Identity Registry contract for the connected chain.
 * @param {number} chainId
 * @param {import('ethers').Signer} signer
 * @returns {Contract}
 */
export function getIdentityRegistry(chainId, signer) {
	const deployment = REGISTRY_DEPLOYMENTS[chainId];
	if (!deployment || !deployment.identityRegistry) {
		throw new Error(`No Identity Registry deployment configured for chain ${chainId}.`);
	}
	return new Contract(deployment.identityRegistry, IDENTITY_REGISTRY_ABI, signer);
}

/**
 * Full ERC-8004 registration flow.
 *
 * Resolution order for each asset:
 *   - GLB:  `glbUrl` (already-stable URL, skips re-pinning) → `glbFile` (pinned) → none
 *   - 2D image: `imageUrl` → `imageFile` (pinned) → auto-render from `glbFile`
 *              (unless `autoThumbnail: false`) → empty string
 *
 * On-chain sequence:
 *   1. Pin any files that aren't already URLs
 *   2. (Optional) auto-render a 2D thumbnail from the GLB for ERC-721 marketplace compat
 *   3. Connect wallet + get Identity Registry contract
 *   4. `register(seedURI)` — seeds the mint with whichever URL resolves first
 *   5. Build full registration JSON with the minted agentId
 *   6. Pin the JSON
 *   7. `setAgentURI(agentId, registrationUrl)` — point on-chain pointer at final JSON
 *
 * @param {object}  opts
 * @param {string}  opts.name
 * @param {string}  opts.description
 * @param {File}    [opts.glbFile]        GLB to pin (skipped if `glbUrl` provided)
 * @param {string}  [opts.glbUrl]         Pre-resolved GLB URL — pass instead of `glbFile` to skip re-pin
 * @param {string}  [opts.imageUrl]       Pre-resolved 2D image URL (PNG/JPG)
 * @param {File|Blob} [opts.imageFile]    2D image to pin when `imageUrl` absent
 * @param {boolean} [opts.autoThumbnail=true]  Auto-render thumbnail from GLB if no image provided
 * @param {string}  [opts.apiToken]       Optional Pinata JWT — omit to use built-in R2 backend
 * @param {Array<{name?:string,type?:string,endpoint:string,version?:string}>} [opts.services]
 * @param {boolean} [opts.x402Support=false]
 * @param {(msg: string) => void} [opts.onStatus]  Progress callback
 * @returns {Promise<{agentId: number, registrationUrl: string, txHash: string, chainId: number}>}
 */
export async function registerAgent({
	name,
	description,
	glbFile,
	glbUrl,
	imageUrl,
	imageFile,
	autoThumbnail = true,
	apiToken,
	services = [],
	x402Support = false,
	onStatus,
}) {
	const log = onStatus || (() => {});

	// ── 1. Resolve GLB: pin file if we don't already have a URL.
	if (glbFile && !glbUrl) {
		log('Uploading 3D model...');
		glbUrl = await pinFile(glbFile, apiToken);
		log(`Model uploaded: ${glbUrl}`);
	}

	// ── 2. Resolve 2D image. Priority: URL → File → auto-thumbnail from GLB.
	if (!imageUrl && imageFile) {
		log('Uploading 2D image...');
		imageUrl = await pinFile(imageFile, apiToken);
		log(`Image uploaded: ${imageUrl}`);
	} else if (!imageUrl && autoThumbnail && glbFile) {
		try {
			log('Rendering 2D thumbnail from GLB...');
			const thumb = await glbFileToThumbnail(glbFile);
			imageUrl = await pinFile(thumb, apiToken);
			log(`Thumbnail uploaded: ${imageUrl}`);
		} catch (err) {
			log(`Thumbnail render failed (${err.message}) — continuing without 2D image.`);
		}
	}
	imageUrl = imageUrl || '';

	// ── 3. Wallet + contract. ensureWallet() reuses any prior connection
	// (no popup) and only prompts for a brand-new authorization.
	log('Connecting wallet...');
	const { signer, chainId } = await ensureWallet();
	const registry = getIdentityRegistry(chainId, signer);

	// ── 4. Mint with seed URI (useful metadata in the Registered event even if
	//     setAgentURI fails before step 7 completes).
	log('Registering agent on-chain...');
	const seedURI = glbUrl || imageUrl || '';
	const tx = seedURI
		? await registry['register(string)'](seedURI)
		: await registry['register()']();
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
		.find((e) => e && e.name === 'Registered');

	if (!registeredEvent) {
		throw new Error('Registration transaction succeeded but Registered event not found.');
	}

	const agentId = Number(registeredEvent.args.agentId);
	log(`Agent minted! agentId = ${agentId}`);

	// ── 5 + 6. Build + pin the full registration JSON.
	const registrationJSON = buildRegistrationJSON({
		name,
		description,
		imageUrl,
		glbUrl,
		agentId,
		chainId,
		registryAddr: REGISTRY_DEPLOYMENTS[chainId].identityRegistry,
		services,
		x402Support,
	});

	log('Uploading registration metadata...');
	const jsonBlob = new Blob([JSON.stringify(registrationJSON, null, 2)], {
		type: 'application/json',
	});
	const registrationUrl = await pinFile(jsonBlob, apiToken);
	log(`Registration metadata uploaded: ${registrationUrl}`);

	// ── 7. Point agentURI at the final JSON.
	log('Updating agentURI on-chain...');
	const updateTx = await registry.setAgentURI(agentId, registrationUrl);
	await updateTx.wait();
	log('Agent URI updated on-chain.');

	// ── 8. Notify backend to index immediately — don't wait for the 15-min cron.
	try {
		log('Indexing agent...');
		await fetch('/api/erc8004/register-confirm', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				chainId,
				txHash: tx.hash,
				agentId: String(agentId),
				metadataUri: registrationUrl,
				ownerAddress: _address,
			}),
		});
		log('Agent indexed.');
	} catch {
		// Non-fatal — the cron crawler will pick it up within 15 minutes.
	}

	return { agentId, registrationUrl, txHash: tx.hash, chainId };
}
