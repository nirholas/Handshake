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
import { IDENTITY_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from './abi.js';
import { glbFileToThumbnail } from './thumbnail.js';
import { buildRegistrationJSON } from './registration-json.js';
import { buildAgentManifest } from './agent-manifest.js';
import { CHAIN_META, switchChain } from './chain-meta.js';

// Re-exported so existing browser callers (src/mint/index.js) keep their import
// path. The builder itself lives in registration-json.js — a dependency-light
// module server-side code can import without the ethers/Three.js stack.
export { buildRegistrationJSON };
// Re-exported so callers can build the rich manifest without a second import.
export { buildAgentManifest };

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
		// A caller-supplied Pinata token is a preference, not a requirement: this
		// runs mid-registration, so an unbounded upload used to leave the flow
		// hanging with a half-built agent, and a Pinata outage failed it outright
		// even though the platform's own pinning route was right there. Bound it,
		// and fall through to that route rather than losing the registration.
		try {
			const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
				method: 'POST',
				headers: { Authorization: `Bearer ${apiToken}` },
				body: form,
				signal: AbortSignal.timeout(60_000),
			});
			if (!res.ok) throw new Error(`Pinata upload failed (${res.status})`);
			const data = await res.json();
			return `ipfs://${data.IpfsHash}`;
		} catch (err) {
			console.warn('[agent-registry] direct Pinata pin failed, using the platform pinning route:', err?.message || err);
		}
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

	// ── 9. Kick a best-effort glTF validation attestation. The platform
	// validator key signs recordValidation() server-side; this is async and
	// non-blocking — a validation failure (or unconfigured validator) never
	// affects the registration. The "Validated" badge appears once it lands.
	if (glbUrl) {
		log('Requesting validation attestation…');
		fetch('/api/erc8004/validate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ chainId, agentId: String(agentId), glbUrl }),
		})
			.then(async (r) => {
				const data = await r.json().catch(() => ({}));
				if (r.ok && data?.validation) {
					log(
						data.validation.passed
							? 'Validation attested on-chain ✓'
							: 'Validation recorded (model has issues).',
					);
				} else if (data?.code) {
					log(`Validation deferred (${data.code}).`);
				}
			})
			.catch(() => {
				/* best-effort — badge stays "not yet validated" until re-run */
			});
	}

	return { agentId, registrationUrl, txHash: tx.hash, chainId };
}

// ---------------------------------------------------------------------------
// Bind an existing agent to an on-chain identity
// ---------------------------------------------------------------------------

/**
 * Bind an agent that already exists in `agent_identities` to a fresh ERC-8004
 * on-chain identity — reusing its stored body, persona, voice, and skills with
 * no re-entry. The flow:
 *
 *   1. Load the agent (GET /api/agents/:id) — body GLB + metadata.
 *   2. Idempotency guard — if already bound on this chain, return the existing
 *      identity without minting a second token.
 *   3. Ensure the wallet is connected and on the target chain (reusing any prior
 *      authorization — no forced popup; switches network if needed).
 *   4. `register(seedURI)` — mint, seeded with the existing GLB.
 *   5. Build + pin the agent-manifest/0.2 bundle (reuses the GLB URL, no re-pin).
 *   6. Build the 3D Agent Card v1 with `manifest` set to the bundle URI; pin it.
 *   7. `setAgentURI(agentId, cardURI)` — point the on-chain pointer at the card.
 *   8. POST /api/erc8004/register-confirm with `agentDbId` so the backend writes
 *      `agent_identities.meta.onchain` after re-verifying the tx on-chain.
 *
 * @param {string} agentId   three.ws agent UUID (agent_identities.id)
 * @param {number} chainId   target EVM chain id (must be in REGISTRY_DEPLOYMENTS)
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.onStatus]
 * @returns {Promise<{alreadyBound: boolean, agentId: number|string, chainId: number,
 *   registrationUrl?: string, manifestUri?: string, txHash?: string,
 *   onchain?: object, warnings?: string[]}>}
 */
export async function bindExistingAgentOnchain(agentId, chainId, { onStatus } = {}) {
	const log = onStatus || (() => {});

	if (!REGISTRY_DEPLOYMENTS[chainId]?.identityRegistry) {
		throw new Error(`No ERC-8004 registry is deployed on chain ${chainId}.`);
	}

	// ── 1. Load the agent's stored data (owner view includes system_prompt).
	log('Loading agent…');
	const res = await fetch(`/api/agents/${agentId}`, { credentials: 'include' });
	if (!res.ok) {
		throw new Error(
			res.status === 401 || res.status === 403
				? 'Sign in as the owner to register this agent on-chain.'
				: `Could not load agent (${res.status}).`,
		);
	}
	const { agent } = await res.json().catch(() => ({}));
	if (!agent) throw new Error('Agent not found.');

	// ── 2. Idempotency — never mint twice on a chain the agent is already on.
	// Covers both the canonical meta.onchain block and the legacy EVM columns
	// (erc8004_agent_id + chain_id) written by the original mint flow.
	const existingOnchain = agent.onchain || agent.meta?.onchain || null;
	if (existingOnchain && existingOnchain.chain === `eip155:${chainId}`) {
		log('Agent is already registered on this chain.');
		return {
			alreadyBound: true,
			agentId: existingOnchain.onchain_id || null,
			chainId,
			onchain: existingOnchain,
			registrationUrl: existingOnchain.metadata_uri || undefined,
		};
	}
	if (agent.erc8004_agent_id && Number(agent.chain_id) === chainId) {
		log('Agent is already registered on this chain.');
		return {
			alreadyBound: true,
			agentId: String(agent.erc8004_agent_id),
			chainId,
			onchain: existingOnchain || undefined,
		};
	}

	// ── 3. Resolve stored assets — reuse, never re-enter or re-pin the GLB.
	const glbUrl = agent.avatar_model_url || null;
	const imageUrl = agent.avatar_thumbnail_url || null;
	if (!glbUrl && !imageUrl) {
		throw new Error(
			'This agent has no public avatar yet. Make its 3D model public, then register on-chain.',
		);
	}

	// ── 4. Wallet on the target chain (reuse prior connection — no forced popup).
	log('Connecting wallet…');
	let { signer, address, chainId: walletChain } = await ensureWallet();
	if (walletChain !== chainId) {
		log(`Switching wallet to ${CHAIN_META[chainId]?.name || `chain ${chainId}`}…`);
		await switchChain(chainId);
		({ signer, address, chainId: walletChain } = await ensureWallet());
		if (walletChain !== chainId) {
			throw new Error(
				`Wallet is on the wrong network. Switch to ${CHAIN_META[chainId]?.name || `chain ${chainId}`} and try again.`,
			);
		}
	}
	const registry = getIdentityRegistry(chainId, signer);
	const registryAddr = REGISTRY_DEPLOYMENTS[chainId].identityRegistry;

	// ── 5. Mint, seeded with the existing GLB (or thumbnail).
	log('Registering agent on-chain…');
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
	const onchainId = Number(registeredEvent.args.agentId);
	log(`Agent minted! agentId = ${onchainId}`);

	// ── 6. Build + pin the agent-manifest/0.2 bundle (reuses GLB URL, no re-pin).
	const { uri: manifestUri, warnings } = await buildAgentManifest(agent, {
		glbUrl,
		imageUrl,
		onchain: { chainId, agentId: onchainId, registry: registryAddr, owner: address },
		pinFile: (blob) => pinFile(blob),
		onStatus: log,
	});
	for (const w of warnings || []) log(`⚠ ${w}`);

	// ── 7. Build the Card v1 with the manifest pointer, then pin it.
	const card = buildRegistrationJSON({
		name: agent.name,
		description: agent.description || '',
		imageUrl: imageUrl || '',
		glbUrl: glbUrl || undefined,
		agentId: onchainId,
		chainId,
		registryAddr,
		manifest: manifestUri,
		x402Support: true,
	});
	log('Uploading agent card…');
	const cardBlob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
	const registrationUrl = await pinFile(cardBlob);
	log(`Agent card uploaded: ${registrationUrl}`);

	// ── 8. Point agentURI at the final card.
	log('Updating agentURI on-chain…');
	const updateTx = await registry.setAgentURI(onchainId, registrationUrl);
	await updateTx.wait();
	log('Agent URI updated on-chain.');

	// ── 9. Persist meta.onchain (and index) — backend re-verifies the tx.
	const onchain = {
		chain: `eip155:${chainId}`,
		family: 'evm',
		tx_hash: tx.hash,
		onchain_id: String(onchainId),
		contract_or_mint: registryAddr,
		wallet: address,
		metadata_uri: registrationUrl,
		confirmed_at: new Date().toISOString(),
	};
	try {
		log('Saving on-chain identity…');
		const confirm = await fetch('/api/erc8004/register-confirm', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				chainId,
				txHash: tx.hash,
				agentId: String(onchainId),
				metadataUri: registrationUrl,
				ownerAddress: address,
				agentDbId: agentId,
			}),
		});
		if (!confirm.ok) {
			log('On-chain identity saved (indexing will retry shortly).');
		} else {
			log('On-chain identity saved.');
		}
	} catch {
		// Non-fatal — the cron crawler will index the mint within 15 minutes.
		log('On-chain identity saved (indexing will retry shortly).');
	}

	return {
		alreadyBound: false,
		agentId: onchainId,
		chainId,
		registrationUrl,
		manifestUri,
		txHash: tx.hash,
		onchain,
		warnings: warnings || [],
	};
}
