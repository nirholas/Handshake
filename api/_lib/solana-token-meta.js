// Read-only Solana token metadata fetcher.
//
// On-chain: Metaplex Token Metadata v1 (PDA = ["metadata", program, mint]).
// Off-chain: the JSON document referenced by the on-chain `uri` field —
// typically Pinata/Arweave/pump.fun-cdn — providing `image` (and friends).
//
// Used by /api/x402/mint-to-mesh to derive a 3D representation of any fungible
// token. Distinct from api/pump-fun-mcp.js's inline reader, which only exposes
// the on-chain decode (no off-chain JSON or image bytes resolution).

import { PublicKey } from '@solana/web3.js';
import {
	TOKEN_2022_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	getTokenMetadata,
} from '@solana/spl-token';
import { getConnection, solanaPubkey } from './pump.js';

const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const NAME_MAX = 32;
const SYMBOL_MAX = 10;
const URI_MAX = 200;

const METADATA_FETCH_TIMEOUT_MS = 8_000;
const IMAGE_FETCH_TIMEOUT_MS = 8_000;
const MAX_OFFCHAIN_JSON_BYTES = 256 * 1024; // 256 KB
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Decode the Metaplex Token Metadata account for `mint`.
 * Returns null when the metadata PDA does not exist on-chain.
 */
async function fetchOnchainMetadata(connection, mintPk) {
	const [metadataPda] = PublicKey.findProgramAddressSync(
		[Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()],
		METADATA_PROGRAM,
	);
	const info = await connection.getAccountInfo(metadataPda);
	if (!info) return null;

	// Layout: 1 key + 32 updateAuthority + 32 mint + name + symbol + uri.
	// Each string is length-prefixed (u32 LE) but space-padded to a fixed max.
	const buf = info.data;
	let cursor = 1 + 32 + 32;
	const readPaddedStr = (max) => {
		if (cursor + 4 > buf.length) return '';
		const len = buf.readUInt32LE(cursor);
		cursor += 4;
		const slice = buf.slice(cursor, cursor + len);
		cursor += max;
		return slice.toString('utf8').replace(/\u0000+$/g, '').trim();
	};
	return {
		name: readPaddedStr(NAME_MAX),
		symbol: readPaddedStr(SYMBOL_MAX),
		uri: readPaddedStr(URI_MAX),
	};
}

/**
 * Read the metadata a Token-2022 mint carries inside its own account, in the
 * `TokenMetadata` extension, instead of in a separate Metaplex PDA. Every
 * pump.fun launch since the Token-2022 cutover stores it this way (the platform
 * coin $THREE included), and those mints have NO Metaplex account at all, so a
 * PDA-only reader reports them as nameless and image-less.
 *
 * Returns the same { name, symbol, uri } shape as the Metaplex path, or null
 * when the mint is classic SPL or carries no metadata extension.
 */
async function fetchToken2022Metadata(connection, mintPk, ownerProgram) {
	if (ownerProgram !== TOKEN_2022_PROGRAM_ID.toBase58()) return null;
	const md = await getTokenMetadata(connection, mintPk, undefined, TOKEN_2022_PROGRAM_ID);
	if (!md) return null;
	return {
		name: (md.name || '').trim(),
		symbol: (md.symbol || '').trim(),
		uri: (md.uri || '').trim(),
	};
}

// Resolve common gateway-less URIs to a fetchable HTTPS URL. Pinata/IPFS hashes
// (`ipfs://...`) get rewritten to a public gateway; everything else is returned
// as-is (must already be http(s):).
function resolveOffchainUrl(uri) {
	if (!uri) return null;
	const trimmed = uri.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith('ipfs://')) {
		const cid = trimmed.slice('ipfs://'.length).replace(/^ipfs\//, '');
		return `https://ipfs.io/ipfs/${cid}`;
	}
	if (trimmed.startsWith('ar://')) {
		return `https://arweave.net/${trimmed.slice('ar://'.length)}`;
	}
	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
	return null;
}

async function fetchOffchainJson(uri) {
	const url = resolveOffchainUrl(uri);
	if (!url) return null;
	let res;
	try {
		res = await fetch(url, {
			redirect: 'follow',
			signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
			headers: { accept: 'application/json' },
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const len = Number(res.headers.get('content-length') || 0);
	if (len && len > MAX_OFFCHAIN_JSON_BYTES) return null;
	let text;
	try {
		text = await res.text();
	} catch {
		return null;
	}
	if (text.length > MAX_OFFCHAIN_JSON_BYTES) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Fetch the binary bytes of an off-chain image, validating size and MIME type.
 * Returns { bytes, mimeType } on success or null on any failure (timeout,
 * 4xx/5xx, oversize, unsupported MIME).
 */
export async function fetchTokenImage(imageUrl) {
	const url = resolveOffchainUrl(imageUrl);
	if (!url) return null;
	let res;
	try {
		res = await fetch(url, {
			redirect: 'follow',
			signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
			headers: { accept: 'image/png, image/jpeg, image/webp, image/*' },
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;

	const headerMime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	const len = Number(res.headers.get('content-length') || 0);
	if (len && len > MAX_IMAGE_BYTES) return null;

	const ab = await res.arrayBuffer();
	if (ab.byteLength > MAX_IMAGE_BYTES) return null;
	const bytes = new Uint8Array(ab);

	// Sniff the first bytes — many CDNs return content-type: application/octet-stream
	// for legitimate PNG/JPEG, and the embedding-into-glTF requires we declare a
	// real MIME. PNG: 89 50 4E 47. JPEG: FF D8 FF. WebP: "RIFF" + "WEBP".
	let sniffed = null;
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		sniffed = 'image/png';
	} else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		sniffed = 'image/jpeg';
	} else if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	) {
		sniffed = 'image/webp';
	}

	const mimeType = sniffed || (ALLOWED_IMAGE_MIME.has(headerMime) ? headerMime : null);
	if (!mimeType) return null;
	// glTF 2.0 only mandates PNG/JPEG support; WebP requires KHR_texture_webp.
	// Skip WebP for now — keeps the GLB compatible with every viewer.
	if (mimeType === 'image/webp') return null;
	return { bytes, mimeType };
}

/**
 * Read a Solana fungible token's full metadata profile.
 *
 * @param {string} mint        Base58 SPL mint address.
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @param {boolean} [opts.includeImage=true] Fetch and return image bytes/mime.
 *
 * @returns {Promise<{
 *   mint: string,
 *   name: string|null,
 *   symbol: string|null,
 *   uri: string|null,
 *   description: string|null,
 *   imageUrl: string|null,
 *   image: { bytes: Uint8Array, mimeType: string } | null,
 *   externalUrl: string|null,
 *   raw: object|null,
 * }>}
 *
 * `raw` is the parsed off-chain JSON document verbatim (null when the token has
 * no `uri` or it could not be read). The named fields above cover what a token
 * profile needs; a caller after anything else in the document (`animation_url`,
 * `properties.files`, attributes) would otherwise have to fetch and parse the
 * same document a second time.
 */
export async function fetchTokenMeta(mint, { network = 'mainnet', includeImage = true } = {}) {
	const pk = solanaPubkey(mint);
	if (!pk) {
		const err = new Error('invalid mint address');
		err.code = 'invalid_mint';
		err.status = 400;
		throw err;
	}

	const connection = getConnection({ network });

	const accountInfo = await connection.getAccountInfo(pk);
	if (!accountInfo) {
		const err = new Error(`mint account not found on ${network}`);
		err.code = 'mint_not_found';
		err.status = 404;
		throw err;
	}
	// An address can exist on-chain without being a token mint at all (a program,
	// a PDA, a wallet). Reading metadata off one of those yields an untitled
	// husk, so reject it here rather than charging a caller for a nameless
	// result: only the two SPL token programs own real mints.
	const owner = accountInfo.owner?.toBase58?.() || '';
	if (owner !== TOKEN_PROGRAM_ID.toBase58() && owner !== TOKEN_2022_PROGRAM_ID.toBase58()) {
		const err = new Error(`address is not an SPL token mint on ${network}`);
		err.code = 'mint_not_found';
		err.status = 404;
		throw err;
	}

	const onchain = (await fetchToken2022Metadata(connection, pk, owner))
		|| (await fetchOnchainMetadata(connection, pk));
	const off = onchain?.uri ? await fetchOffchainJson(onchain.uri) : null;

	const name = (off?.name || onchain?.name || '').toString().trim() || null;
	const symbol = (off?.symbol || onchain?.symbol || '').toString().trim() || null;
	const description = (off?.description || '').toString().trim() || null;
	const imageUrl = (off?.image || '').toString().trim() || null;
	const externalUrl =
		(off?.external_url || off?.website || '').toString().trim() || null;

	const image = imageUrl && includeImage ? await fetchTokenImage(imageUrl) : null;

	return {
		mint,
		name,
		symbol,
		uri: onchain?.uri || null,
		description,
		imageUrl,
		image,
		externalUrl,
		raw: off || null,
	};
}
