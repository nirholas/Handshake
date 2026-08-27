// Mobile Wallet Adapter (MWA) wrapper for three.ws.
//
// When the page is running inside the Solana Mobile TWA on a Seeker, the
// browser does not inject `window.solana`. Instead, signing must be
// delegated to the on-device Seed Vault via the MWA protocol. This module
// exposes a small, Phantom-shaped API surface so existing three.ws code
// (e.g. src/onchain/adapters/solana.js, src/wallet.js) can call
// `provider.signMessage(...)`, `provider.signTransaction(...)`, and
// `provider.connect()` without caring whether the user is on web or Seeker.
//
// The actual transport library — @solana-mobile/mobile-wallet-adapter-protocol-web3js
// — is loaded lazily on first use so desktop bundles don't pay for it.

import { PublicKey } from '@solana/web3.js';
import { normalizeMwaError } from './mwa-errors.js';

const APP_IDENTITY = Object.freeze({
	name: 'three.ws',
	uri: 'https://three.ws',
	// MWA spec: identity.icon MUST be a relative URI (resolved against uri).
	// An absolute URL here makes every authorize() throw before reaching the
	// wallet.
	icon: '/pwa-192x192.png',
});

const SESSION_KEY = 'threews:mwa:authToken';
const ADDRESS_KEY = 'threews:mwa:address';

let cachedTransact = null;

async function loadTransact() {
	if (cachedTransact) return cachedTransact;
	const mod = await import('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
	if (typeof mod.transact !== 'function') {
		throw new Error('MWA transport is missing transact() export');
	}
	cachedTransact = mod.transact;
	return cachedTransact;
}

// MWA auth tokens are designed to be persisted: the wallet hands one back so
// the app can reauthorize() silently on its next launch. Android kills a
// backgrounded TWA process freely, and sessionStorage dies with it, which
// turned every relaunch into a fresh Seed Vault prompt. localStorage survives
// process death; sessionStorage is the fallback when it is unavailable.
function storageAreas() {
	const areas = [];
	try { if (typeof localStorage !== 'undefined') areas.push(localStorage); } catch { /* blocked */ }
	try { if (typeof sessionStorage !== 'undefined') areas.push(sessionStorage); } catch { /* blocked */ }
	return areas;
}

function readStoredAuth() {
	for (const area of storageAreas()) {
		try {
			const token = area.getItem(SESSION_KEY);
			const address = area.getItem(ADDRESS_KEY);
			if (token && address) return { authToken: token, address };
		} catch {
			/* storage may be unavailable */
		}
	}
	return null;
}

function writeStoredAuth(authToken, address) {
	const [primary] = storageAreas();
	if (!primary) return;
	try {
		primary.setItem(SESSION_KEY, authToken);
		primary.setItem(ADDRESS_KEY, address);
	} catch {
		/* non-fatal */
	}
}

function clearStoredAuth() {
	for (const area of storageAreas()) {
		try {
			area.removeItem(SESSION_KEY);
			area.removeItem(ADDRESS_KEY);
		} catch {
			/* non-fatal */
		}
	}
}

function base64ToBytes(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function addressFromBase64(base64) {
	return new PublicKey(base64ToBytes(base64)).toBase58();
}

function normalizeChain(chain) {
	if (chain === 'mainnet-beta' || chain === 'mainnet') return 'solana:mainnet';
	if (chain === 'devnet') return 'solana:devnet';
	if (chain === 'testnet') return 'solana:testnet';
	if (typeof chain === 'string' && chain.startsWith('solana:')) return chain;
	return 'solana:mainnet';
}

/**
 * MWA wallet wrapper. Public surface mirrors the Phantom provider closely
 * enough that three.ws's existing Solana adapter can use it as a drop-in
 * replacement when isSolanaMobileTwa() is true.
 */
export class MwaWallet {
	#address = null;
	#publicKey = null;
	#authToken = null;
	#chain = 'solana:mainnet';
	#listeners = new Map();
	#connecting = null;

	constructor({ chain = 'mainnet-beta' } = {}) {
		this.#chain = normalizeChain(chain);
		const stored = readStoredAuth();
		if (stored) {
			this.#authToken = stored.authToken;
			this.#address = stored.address;
			this.#publicKey = new PublicKey(stored.address);
		}
	}

	get isThreeWs() { return true; }

	get isPhantom() { return false; }

	get isConnected() { return Boolean(this.#publicKey); }

	get publicKey() { return this.#publicKey; }

	on(event, handler) {
		if (!event || typeof handler !== 'function') return;
		const set = this.#listeners.get(event) || new Set();
		set.add(handler);
		this.#listeners.set(event, set);
	}

	off(event, handler) {
		const set = this.#listeners.get(event);
		if (!set) return;
		set.delete(handler);
	}

	#emit(event, payload) {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const fn of set) {
			try { fn(payload); } catch (err) { console.error('[mwa] listener error', err); }
		}
	}

	async connect({ onlyIfTrusted = false } = {}) {
		if (this.isConnected) return { publicKey: this.#publicKey };
		if (this.#connecting) return this.#connecting;

		this.#connecting = (async () => {
			const transact = await loadTransact();
			const authToken = this.#authToken;
			const onlyResume = onlyIfTrusted && Boolean(authToken);
			if (onlyIfTrusted && !authToken) {
				const err = new Error('No prior MWA session to resume');
				err.code = 4001;
				throw err;
			}
			try {
				await transact(async (wallet) => {
					const result = authToken
						? await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY })
						: await wallet.authorize({
							identity: APP_IDENTITY,
							chain: this.#chain,
							features: ['solana:signTransactions', 'solana:signMessages'],
						});
					this.#applyAuthResult(result);
				});
			} catch (err) {
				if (onlyResume) {
					// reauthorize() failed because the wallet revoked the token.
					// Drop it and let the caller decide whether to prompt.
					this.#reset();
				}
				throw normalizeMwaError(err);
			}
			return { publicKey: this.#publicKey };
		})();

		try {
			return await this.#connecting;
		} finally {
			this.#connecting = null;
		}
	}

	async disconnect() {
		if (!this.#authToken) {
			this.#reset();
			return;
		}
		const transact = await loadTransact();
		const token = this.#authToken;
		this.#reset();
		try {
			await transact(async (wallet) => {
				await wallet.deauthorize({ auth_token: token });
			});
		} catch (err) {
			// Deauthorize is best-effort. We've already cleared local state.
			console.warn('[mwa] deauthorize failed', err);
		}
	}

	/**
	 * Sign a single Uint8Array message. Mirrors Phantom's
	 *   provider.signMessage(bytes, 'utf8') → { signature: Uint8Array }
	 * shape.
	 *
	 * The web3js transact() hands the callback an AUGMENTED wallet proxy:
	 * signMessages takes Uint8Array payloads and returns Uint8Array[] of
	 * signed payloads directly (message with the 64-byte ed25519 signature
	 * appended) — NOT the raw protocol's { signed_payloads } envelope.
	 */
	async signMessage(messageBytes /* , _displayEncoding */) {
		await this.#ensureConnected();
		if (!(messageBytes instanceof Uint8Array)) {
			throw new TypeError('signMessage expects a Uint8Array');
		}
		const transact = await loadTransact();
		let signed = null;
		try {
			await transact(async (wallet) => {
				await this.#reauthorize(wallet);
				signed = await wallet.signMessages({
					addresses: [this.#authResultAddressBase64()],
					payloads: [messageBytes],
				});
			});
		} catch (err) {
			throw normalizeMwaError(err);
		}
		const combined = Array.isArray(signed) ? signed[0] : null;
		if (!(combined instanceof Uint8Array)) throw new Error('MWA returned no signed payload');
		// web3js signMessages returns the message with the 64-byte ed25519
		// signature appended; take the trailing 64 bytes.
		const signatureBytes = combined.slice(combined.length - 64);
		return { signature: signatureBytes, publicKey: this.#publicKey };
	}

	/**
	 * Sign a single VersionedTransaction or legacy Transaction. Returns the
	 * same transaction object with the signature applied.
	 */
	async signTransaction(transaction) {
		const [signed] = await this.signAllTransactions([transaction]);
		return signed;
	}

	async signAllTransactions(transactions) {
		if (!Array.isArray(transactions) || transactions.length === 0) {
			throw new TypeError('signAllTransactions expects a non-empty array');
		}
		await this.#ensureConnected();
		const transact = await loadTransact();
		// web3js wallet proxy: signTransactions takes { transactions } of real
		// web3.js Transaction / VersionedTransaction objects and returns
		// deserialized signed transaction objects — no manual serialization.
		let signed = [];
		try {
			await transact(async (wallet) => {
				await this.#reauthorize(wallet);
				signed = await wallet.signTransactions({ transactions });
			});
		} catch (err) {
			throw normalizeMwaError(err);
		}
		if (!Array.isArray(signed) || signed.length !== transactions.length) {
			throw new Error('MWA returned mismatched signed transaction count');
		}
		return signed;
	}

	/**
	 * Sign + send + return signature string. Wraps the MWA "send" flow,
	 * which is more efficient than sign+broadcast because the wallet can
	 * use its own RPC.
	 */
	async signAndSendTransaction(transaction, { minContextSlot } = {}) {
		await this.#ensureConnected();
		const transact = await loadTransact();
		// web3js wallet proxy: signAndSendTransactions takes { transactions }
		// and returns base58 signature strings (Phantom-compatible).
		let signatures = null;
		try {
			await transact(async (wallet) => {
				await this.#reauthorize(wallet);
				signatures = await wallet.signAndSendTransactions({
					transactions: [transaction],
					...(minContextSlot ? { minContextSlot } : null),
				});
			});
		} catch (err) {
			throw normalizeMwaError(err);
		}
		const signature = Array.isArray(signatures) ? signatures[0] : null;
		if (typeof signature !== 'string') throw new Error('MWA returned no signature');
		return { signature };
	}

	/**
	 * One-tap Sign-In With Solana (SIWS). On the Seed Vault, authorization and
	 * the sign-in signature happen in a SINGLE wallet interaction via the MWA
	 * `sign_in_payload` — instead of the two prompts (connect, then sign) that
	 * the generic connect()+signMessage() path costs. The wallet builds the
	 * canonical SIWS (CAIP-122) message itself and returns the exact bytes it
	 * signed, so the caller can hand `signedMessageText` + `signature` straight
	 * to /api/auth/siws/verify.
	 *
	 * @param {object} input SIWS fields — domain, statement, uri, version,
	 *   chainId, nonce, issuedAt, expirationTime, resources. `domain` defaults
	 *   to the current host.
	 * @returns {Promise<null | {
	 *   address: string, publicKey: PublicKey,
	 *   signature: Uint8Array, signedMessage: Uint8Array, signedMessageText: string
	 * }>} null when the connected wallet does not support authorize-time
	 *   sign-in (caller should fall back to connect()+signMessage()).
	 */
	async signIn(input = {}) {
		const transact = await loadTransact();
		const payload = {
			domain: input.domain
				|| (typeof location !== 'undefined' ? location.host : undefined),
			...input,
		};
		let out = null;
		try {
			await transact(async (wallet) => {
				const result = await wallet.authorize({
					identity: APP_IDENTITY,
					chain: this.#chain,
					sign_in_payload: payload,
				});
				this.#applyAuthResult(result);
				const signIn = result.sign_in_result;
				if (signIn?.signed_message && signIn?.signature) {
					const messageBytes = base64ToBytes(signIn.signed_message);
					out = {
						address: this.#address,
						publicKey: this.#publicKey,
						signature: base64ToBytes(signIn.signature),
						signedMessage: messageBytes,
						signedMessageText: new TextDecoder().decode(messageBytes),
					};
				}
			});
		} catch (err) {
			throw normalizeMwaError(err);
		}
		return out;
	}

	/** Whether this provider can perform one-tap authorize-time sign-in. */
	get supportsSignIn() { return true; }

	// Every signing session re-presents the stored auth token. When the Seed
	// Vault has revoked it (wallet wiped, app deauthorized from the wallet
	// side), a dead token must not linger: clear it and emit disconnect so the
	// next call authorizes from scratch instead of failing forever.
	async #reauthorize(wallet) {
		let result;
		try {
			result = await wallet.reauthorize({
				auth_token: this.#authToken,
				identity: APP_IDENTITY,
			});
		} catch (err) {
			this.#reset();
			throw err;
		}
		this.#applyAuthResult(result);
	}

	#applyAuthResult(result) {
		if (!result || typeof result !== 'object') throw new Error('MWA returned invalid auth result');
		const account = Array.isArray(result.accounts) ? result.accounts[0] : null;
		if (!account?.address) throw new Error('MWA auth result has no account address');
		const address = decodeAccountAddress(account.address);
		this.#address = address;
		this.#publicKey = new PublicKey(address);
		if (typeof result.auth_token === 'string') {
			this.#authToken = result.auth_token;
		}
		this._lastRawAddress = account.address;
		writeStoredAuth(this.#authToken, address);
		this.#emit('connect', this.#publicKey);
	}

	#authResultAddressBase64() {
		// MWA expects the address back in the same encoding it was returned
		// (base64). We stash the raw value on the instance during authorize.
		if (typeof this._lastRawAddress === 'string') return this._lastRawAddress;
		return bytesToBase64(this.#publicKey.toBytes());
	}

	async #ensureConnected() {
		if (this.isConnected && this.#authToken) return;
		await this.connect({ onlyIfTrusted: Boolean(this.#authToken) });
	}

	#reset() {
		this.#address = null;
		this.#publicKey = null;
		this.#authToken = null;
		clearStoredAuth();
		this.#emit('disconnect', null);
	}
}

function decodeAccountAddress(rawAddress) {
	// MWA returns addresses base64-encoded. Some implementations have started
	// returning base58 directly — accept both.
	if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(rawAddress) && rawAddress.length >= 32 && rawAddress.length <= 44) {
		try {
			const pk = new PublicKey(rawAddress);
			return pk.toBase58();
		} catch {
			/* fall through to base64 path */
		}
	}
	return addressFromBase64(rawAddress);
}

