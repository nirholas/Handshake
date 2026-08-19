// Two ways to hold the key that signs a mint, both self-custodial.
//
// 1. An injected browser wallet (Phantom, Solflare, Backpack, Seeker). The key
//    never leaves the extension; we hand it transactions and it hands back
//    signatures.
// 2. A wallet created right here, for people who have never installed one. The
//    keypair is generated in the browser with WebCrypto randomness, encrypted
//    under a passphrase (PBKDF2-SHA256, 310k iterations, AES-GCM) and written
//    to localStorage. The plaintext secret exists only in memory while
//    unlocked, and never crosses the network: this site has no server.
//
// The honest limits of option 2 are stated in the UI, not buried here: a
// browser-stored wallet is as durable as the browser profile, so the backup
// step is part of creating one, not an afterthought.

import { generateSigner, createSignerFromKeypair } from '@metaplex-foundation/umi';
import bs58 from 'bs58';

const STORAGE_KEY = 'map.wallet.v1';
const PBKDF2_ITERATIONS = 310_000;

/* ── Injected wallets ─────────────────────────────────────────────────── */

const INJECTED = [
	{ id: 'phantom', label: 'Phantom', find: () => window.phantom?.solana?.isPhantom && window.phantom.solana },
	{ id: 'solflare', label: 'Solflare', find: () => window.solflare?.isSolflare && window.solflare },
	{ id: 'backpack', label: 'Backpack', find: () => window.backpack?.solana },
	{ id: 'seeker', label: 'Seeker', find: () => window.threeWsWallet?.isThreeWs && window.threeWsWallet },
	{ id: 'solana', label: 'Browser wallet', find: () => window.solana },
];

/** Every injected provider present right now, deduped by provider object. */
export function detectInjected() {
	const seen = new Set();
	const found = [];
	for (const entry of INJECTED) {
		let provider = null;
		try {
			provider = entry.find();
		} catch {
			provider = null;
		}
		if (!provider || seen.has(provider)) continue;
		seen.add(provider);
		found.push({ id: entry.id, label: entry.label, provider });
	}
	return found;
}

/* ── Encryption primitives ────────────────────────────────────────────── */

const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
	const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

async function encryptSecret(secretKey, passphrase) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveKey(passphrase, salt);
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secretKey);
	return { v: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt), iv: toB64(iv), data: toB64(ciphertext) };
}

async function decryptSecret(record, passphrase) {
	const key = await deriveKey(passphrase, fromB64(record.salt));
	const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(record.iv) }, key, fromB64(record.data));
	return new Uint8Array(plain);
}

/* ── The hosted wallet ────────────────────────────────────────────────── */

function readRecord() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

/** True when a wallet was created in this browser (locked or not). */
export function hostedWalletExists() {
	return Boolean(readRecord());
}

/** The stored wallet's public address, readable without the passphrase. */
export function hostedWalletAddress() {
	return readRecord()?.address || null;
}

export function forgetHostedWallet() {
	localStorage.removeItem(STORAGE_KEY);
}

/**
 * A wallet held by this page: created, unlocked, and signing entirely
 * in-memory. `umi` is needed because the keypair lives in umi's eddsa
 * interface, the same one the mint builders sign with.
 */
export class HostedWallet {
	#keypair;

	constructor(keypair) {
		this.#keypair = keypair;
	}

	get address() {
		return this.#keypair.publicKey.toString();
	}

	/** The umi signer the mint path uses when this wallet pays. */
	signer(umi) {
		return createSignerFromKeypair(umi, this.#keypair);
	}

	/** Base58 secret key, for backing the wallet up or importing it elsewhere. */
	exportSecretKey() {
		return bs58.encode(this.#keypair.secretKey);
	}

	/** Create a new wallet, encrypt it under `passphrase`, and persist it. */
	static async create(umi, passphrase) {
		const keypair = umi.eddsa.generateKeypair();
		await HostedWallet.#persist(keypair, passphrase);
		return new HostedWallet(keypair);
	}

	/** Restore a wallet from a base58 secret key (or a JSON byte array). */
	static async importSecret(umi, secret, passphrase) {
		const raw = String(secret).trim();
		let bytes;
		if (raw.startsWith('[')) {
			bytes = Uint8Array.from(JSON.parse(raw));
		} else {
			bytes = bs58.decode(raw);
		}
		if (bytes.length !== 64) throw new Error(`A Solana secret key is 64 bytes; that one is ${bytes.length}.`);
		const keypair = umi.eddsa.createKeypairFromSecretKey(bytes);
		await HostedWallet.#persist(keypair, passphrase);
		return new HostedWallet(keypair);
	}

	/** Decrypt the stored wallet. Throws `bad_passphrase` when the passphrase is wrong. */
	static async unlock(umi, passphrase) {
		const record = readRecord();
		if (!record) throw new Error('No wallet has been created in this browser yet.');
		let secretKey;
		try {
			secretKey = await decryptSecret(record.secret, passphrase);
		} catch {
			throw Object.assign(new Error('That passphrase does not unlock this wallet.'), { code: 'bad_passphrase' });
		}
		const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
		return new HostedWallet(keypair);
	}

	static async #persist(keypair, passphrase) {
		const secret = await encryptSecret(keypair.secretKey, passphrase);
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ address: keypair.publicKey.toString(), createdAt: new Date().toISOString(), secret }),
		);
	}
}

/**
 * A backup file the visitor can actually use later: the secret key plus enough
 * context that a person finding it in six months knows what it opens.
 */
export function backupBlob(address, secretKeyBase58) {
	const doc = {
		type: 'solana-keypair-backup',
		createdBy: 'Metaplex Agent Deployer (three.ws)',
		address,
		secretKey: secretKeyBase58,
		note: 'Anyone with this secret key controls this wallet and everything it holds. Keep it offline. Import it into Phantom, Solflare, or the Solana CLI with this base58 string.',
		exportedAt: new Date().toISOString(),
	};
	return new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
}

/** A fresh throwaway signer, used to price a mint before a wallet exists. */
export function ephemeralSigner(umi) {
	return generateSigner(umi);
}
