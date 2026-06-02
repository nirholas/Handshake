// Solana primitives for the $THREE token MCP: connection, key handling, and
// balance reads. Self-contained so the published npm package has no internal
// cross-package imports.

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

import { SOLANA_RPC_URL, SOLANA_DEFAULT_SECRET } from '../config.js';

const bs58encode = bs58.default ? bs58.default.encode : bs58.encode;
const bs58decode = bs58.default ? bs58.default.decode : bs58.decode;

export { bs58encode, bs58decode, LAMPORTS_PER_SOL, PublicKey };

let _conn = null;
export function getConnection() {
	if (!_conn) _conn = new Connection(SOLANA_RPC_URL, 'confirmed');
	return _conn;
}

export function isValidPubkey(s) {
	try {
		// eslint-disable-next-line no-new
		new PublicKey(s);
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse a base58 secret key (64-byte Solana keypair) into a Keypair. Accepts
 * either a base58 string or a JSON array of bytes.
 */
export function keypairFromSecret(secret) {
	const trimmed = (secret || '').trim();
	if (!trimmed) {
		throw Object.assign(new Error('No Solana secret key provided. Set SOLANA_SECRET_KEY or pass `secret`.'), {
			code: 'no_signer',
		});
	}
	let bytes;
	if (trimmed.startsWith('[')) {
		bytes = Uint8Array.from(JSON.parse(trimmed));
	} else {
		bytes = bs58decode(trimmed);
	}
	if (bytes.length !== 64) {
		throw Object.assign(new Error(`Invalid secret key length ${bytes.length} (expected 64 bytes).`), {
			code: 'bad_secret',
		});
	}
	return Keypair.fromSecretKey(bytes);
}

/** Resolve a signer from an explicit per-call secret or the configured default. */
export function loadSigner(secret) {
	return keypairFromSecret(secret || SOLANA_DEFAULT_SECRET);
}

export async function getSolBalance(pubkeyStr) {
	const conn = getConnection();
	const lamports = await conn.getBalance(new PublicKey(pubkeyStr), 'confirmed');
	return { lamports, sol: lamports / LAMPORTS_PER_SOL };
}

/**
 * Read an SPL token balance for a single mint owned by `pubkeyStr`. Returns the
 * raw atomic amount (string) and the UI amount, or zero if no token account
 * exists yet.
 */
export async function getSplBalance(pubkeyStr, mint) {
	const conn = getConnection();
	const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(pubkeyStr), {
		mint: new PublicKey(mint),
	});
	let atomics = 0n;
	let decimals = 0;
	for (const { account } of res.value) {
		const info = account.data?.parsed?.info?.tokenAmount;
		if (!info) continue;
		atomics += BigInt(info.amount);
		decimals = info.decimals;
	}
	return {
		mint,
		atomics: atomics.toString(),
		decimals,
		uiAmount: decimals ? Number(atomics) / 10 ** decimals : Number(atomics),
	};
}
