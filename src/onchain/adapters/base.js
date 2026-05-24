/**
 * WalletAdapter — the contract every chain family implements.
 *
 * The deploy orchestrator only ever sees this interface. New chains plug in by
 * adding a new adapter that conforms to the shape below; the UI stays
 * family-agnostic.
 *
 * This is interface-by-convention: there's no runtime base class to extend
 * because every subclass historically overrode every method, never called
 * super, and never benefited from inherited behavior. The shape lives in
 * JSDoc so static analysis still surfaces missing methods to authors.
 */

/**
 * @typedef {object} ConnectResult
 * @property {string} address     User's wallet address (hex for EVM, base58 for Solana).
 * @property {import('../chain-ref.js').ChainRef} ref  Chain the wallet is currently on.
 */

/**
 * @typedef {object} PrepResponse
 * @property {string} prepId
 * @property {string} metadataUri          ipfs:// or https:// pointing at the manifest
 * @property {string} [contractAddress]    EVM: identity-registry address
 * @property {string} [txBase64]           Solana: serialized unsigned tx
 * @property {string} [assetPubkey]        Solana: mint pubkey
 * @property {string} [chainCaip2]
 */

/**
 * @typedef {object} SignResult
 * @property {string} txHash               EVM tx hash or Solana signature
 * @property {string} [onchainId]          Optional family-specific ID (EVM agentId, Solana asset)
 */

/**
 * @typedef {object} WalletAdapter
 * @property {'evm'|'solana'} family
 *   Chain family this adapter implements.
 * @property {() => boolean} isAvailable
 *   Whether an injected provider is detectable in this browser session.
 * @property {() => string} installUrl
 *   URL to install a typical wallet for this family.
 * @property {(opts?: { ensureLinked?: boolean, csrfToken?: string }) => Promise<ConnectResult>} connect
 *   Connect (and on Solana, optionally SIWS-link) the user's wallet.
 *   Must throw on user rejection with `err.code === 'USER_REJECTED'`.
 * @property {(ref: import('../chain-ref.js').ChainRef) => Promise<void>} switchTo
 *   Switch the wallet to the given ChainRef. EVM wallets prompt the user;
 *   Solana wallets typically have no concept of switching — adapters return
 *   silently if already on the right cluster, or throw if mismatched.
 * @property {(prep: PrepResponse, ref: import('../chain-ref.js').ChainRef) => Promise<SignResult>} signAndSend
 *   Sign and submit the prep transaction returned by the server.
 */

/**
 * Classify a thrown error as a user rejection across providers. Recognizes
 * the union of conventions used by MetaMask, Phantom, Solflare, WalletConnect,
 * and our own adapters.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUserRejection(err) {
	if (!err) return false;
	if (err.code === 'USER_REJECTED') return true;
	if (err.code === 4001) return true;
	if (err.code === 'ACTION_REJECTED') return true;
	const msg = String(err.message || err).toLowerCase();
	return /user rejected|user denied|rejected by user|user cancel|signature cancel|connection cancel/.test(
		msg,
	);
}
