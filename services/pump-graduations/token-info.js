/**
 * Graduation enrichment: the PumpSwap pool a graduated mint migrates into, and
 * the mint's on-chain name/symbol.
 *
 * Both are derived or read from chain state rather than guessed out of the
 * graduation transaction. The `complete` event fires when the bonding curve
 * fills; the PumpSwap pool is created in a LATER migration transaction, so the
 * graduation tx's account list never contains the pool and cannot be mined for
 * it. The pool address is fully deterministic instead.
 */

import { PublicKey } from '@solana/web3.js';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WRAPPED_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Every pump.fun migration creates the pool at index 0 for its mint.
const CANONICAL_POOL_INDEX = 0;

function u16le(n) {
	const b = Buffer.alloc(2);
	b.writeUInt16LE(n);
	return b;
}

/**
 * The canonical PumpSwap pool for a graduated mint.
 *
 * Mirrors `canonicalPumpPoolPda` from `@pump-fun/pump-swap-sdk` (verified to
 * produce identical addresses) without pulling that SDK and its Anchor tree
 * into this service's image.
 *
 * @param {string|PublicKey} mint
 * @returns {string} base58 pool address
 */
export function canonicalPumpPoolAddress(mint) {
	const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
	const [poolAuthority] = PublicKey.findProgramAddressSync(
		[Buffer.from('pool-authority'), mintPk.toBuffer()],
		PUMP_PROGRAM_ID,
	);
	const [pool] = PublicKey.findProgramAddressSync(
		[
			Buffer.from('pool'),
			u16le(CANONICAL_POOL_INDEX),
			poolAuthority.toBuffer(),
			mintPk.toBuffer(),
			WRAPPED_SOL_MINT.toBuffer(),
		],
		PUMP_AMM_PROGRAM_ID,
	);
	return pool.toBase58();
}

/** Metaplex metadata account for a mint (pre-Token-2022 pump launches). */
export function metaplexMetadataAddress(mint) {
	const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
	const [pda] = PublicKey.findProgramAddressSync(
		[
			Buffer.from('metadata'),
			METAPLEX_METADATA_PROGRAM_ID.toBuffer(),
			mintPk.toBuffer(),
		],
		METAPLEX_METADATA_PROGRAM_ID,
	);
	return pda;
}

function readBorshString(data, offset) {
	if (offset + 4 > data.length) return null;
	const len = data.readUInt32LE(offset);
	const end = offset + 4 + len;
	if (len > data.length || end > data.length) return null;
	// Metaplex pads its strings to a fixed capacity with NULs; trim them off.
	const value = data.subarray(offset + 4, end).toString('utf8').replace(/\0+$/, '');
	return { value, next: end };
}

// SPL Token-2022 mint layout: 82-byte base, padded to 165, one account-type
// byte, then type-length-value extension entries.
const TLV_START = 166;
const TOKEN_METADATA_EXTENSION = 19;

/**
 * Decode name/symbol from a Token-2022 mint carrying the TokenMetadata
 * extension. Every pump.fun mint since the Token-2022 switch stores its
 * metadata inline this way rather than in a Metaplex account.
 *
 * @param {Buffer} data raw mint account data
 * @returns {{name: string, symbol: string}|null}
 */
export function decodeToken2022Metadata(data) {
	if (!data || data.length <= TLV_START) return null;
	let off = TLV_START;
	while (off + 4 <= data.length) {
		const type = data.readUInt16LE(off);
		const len = data.readUInt16LE(off + 2);
		const valueStart = off + 4;
		if (valueStart + len > data.length) return null;
		if (type === TOKEN_METADATA_EXTENSION) {
			// updateAuthority(32) mint(32) then borsh name, symbol, uri.
			const name = readBorshString(data, valueStart + 64);
			if (!name) return null;
			const symbol = readBorshString(data, name.next);
			if (!symbol) return null;
			return { name: name.value, symbol: symbol.value };
		}
		off = valueStart + len;
	}
	return null;
}

/**
 * Decode name/symbol from a Metaplex token-metadata account.
 * Layout: key(1) updateAuthority(32) mint(32) name symbol uri.
 *
 * @param {Buffer} data raw metadata account data
 * @returns {{name: string, symbol: string}|null}
 */
export function decodeMetaplexMetadata(data) {
	if (!data || data.length < 1 + 32 + 32 + 4) return null;
	const name = readBorshString(data, 1 + 32 + 32);
	if (!name) return null;
	const symbol = readBorshString(data, name.next);
	if (!symbol) return null;
	return { name: name.value, symbol: symbol.value };
}

/**
 * Read a mint's name and symbol from chain, trying the Token-2022 inline
 * extension first and falling back to the Metaplex metadata account for older
 * launches. Returns nulls rather than throwing: a graduation is still worth
 * publishing when its metadata read fails.
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string} mint
 * @returns {Promise<{name: string|null, symbol: string|null}>}
 */
export async function fetchTokenMetadata(connection, mint) {
	const mintPk = new PublicKey(mint);
	try {
		const info = await connection.getAccountInfo(mintPk);
		const inline = info && decodeToken2022Metadata(info.data);
		if (inline?.symbol) return { name: inline.name || null, symbol: inline.symbol };
	} catch (err) {
		console.error('[pump-graduations] mint read failed for %s:', mint, err?.message || err);
	}
	try {
		const info = await connection.getAccountInfo(metaplexMetadataAddress(mintPk));
		const legacy = info && decodeMetaplexMetadata(info.data);
		if (legacy?.symbol) return { name: legacy.name || null, symbol: legacy.symbol };
	} catch (err) {
		console.error('[pump-graduations] metadata read failed for %s:', mint, err?.message || err);
	}
	return { name: null, symbol: null };
}
