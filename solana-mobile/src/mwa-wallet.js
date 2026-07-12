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

function readStoredAuth() {
	try {
		const token = sessionStorage.getItem(SESSION_KEY);
		const address = sessionStorage.getItem(ADDRESS_KEY);
		if (token && address) return { authToken: token, address };
	} catch {
		/* sessionStorage may be unavailable */
	}
	return null;
}

function writeStoredAuth(authToken, address) {
	try {
		sessionStorage.setItem(SESSION_KEY, authToken);
		sessionStorage.setItem(ADDRESS_KEY, address);
	} catch {
		/* non-fatal */
	}
}

function clearStoredAuth() {
	try {
		sessionStorage.removeItem(SESSION_KEY);
		sessionStorage.removeItem(ADDRESS_KEY);
	} catch {
		/* non-fatal */
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
					// reauthorize() failed because the wallet revoked the token
					// — clear it and let the caller decide whether to prompt.
					clearStoredAuth();
					this.#authToken = null;
				}
				throw err;
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
		let signatureBytes = null;
		await transact(async (wallet) => {
			const reauth = await wallet.reauthorize({
				auth_token: this.#authToken,
				identity: APP_IDENTITY,
			});
			this.#applyAuthResult(reauth);
			const signed = await wallet.signMessages({
				addresses: [this.#authResultAddressBase64()],
				payloads: [messageBytes],
			});
			const combined = Array.isArray(signed) ? signed[0] : null;
			if (!(combined instanceof Uint8Array)) throw new Error('MWA returned no signed payload');
			signatureBytes = combined.slice(combined.length - 64);
		});
		if (!signatureBytes) throw new Error('MWA signMessage produced no signature');
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
		await transact(async (wallet) => {
			const reauth = await wallet.reauthorize({
				auth_token: this.#authToken,
				identity: APP_IDENTITY,
			});
			this.#applyAuthResult(reauth);
			signed = await wallet.signTransactions({ transactions });
		});
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
		let signature = null;
		await transact(async (wallet) => {
			const reauth = await wallet.reauthorize({
				auth_token: this.#authToken,
				identity: APP_IDENTITY,
			});
			this.#applyAuthResult(reauth);
			const signatures = await wallet.signAndSendTransactions({
				transactions: [transaction],
				...(minContextSlot ? { minContextSlot } : null),
			});
			const first = Array.isArray(signatures) ? signatures[0] : null;
			if (typeof first !== 'string') throw new Error('MWA returned no signature');
			signature = first;
		});
		return { signature };
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

