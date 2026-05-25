/**
 * Create a subdomain under a .sol parent owned by the platform, write a
 * Brave-resolvable URL record pointing at the user's storefront page, and
 * transfer ownership to the user — all atomically in one VersionedTransaction.
 *
 * The platform holds the keypair for the parent domain (e.g. `threews.sol`).
 * Order matters:
 *   1. createSubdomain — parent owner becomes owner of the new registry.
 *   2. createRecordV2Instruction(URL → https://three.ws/u/<label>) — written
 *      while the platform still owns the subdomain. Once Brave's SNS resolver
 *      sees this record, typing `<label>.threews.sol` redirects to the
 *      storefront.
 *   3. transferSubdomain — hands the subdomain (and any records attached to
 *      it; record accounts persist past ownership transfer) to the user.
 *
 * The parent owner is the only signer and fee payer — gas is well under 0.01
 * SOL per subdomain and absorbing it removes wallet-signing friction from the
 * user.
 */

import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const DEFAULT_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// SNS on-chain constants — do not change without verifying against bonfida's source.
const SNS_PROGRAM_ID = new PublicKey('namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX');
const ROOT_DOMAIN_ACCOUNT = new PublicKey('58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx');
const HASH_PREFIX = 'SPL Name Service';

function _getHashedName(name) {
	return createHash('sha256').update(`${HASH_PREFIX}${name}`).digest();
}

function _getNameAccountKey(hashedName, nameClass, nameParent) {
	const seeds = [
		hashedName,
		nameClass ? nameClass.toBuffer() : Buffer.alloc(32),
		nameParent ? nameParent.toBuffer() : Buffer.alloc(32),
	];
	const [pubkey] = PublicKey.findProgramAddressSync(seeds, SNS_PROGRAM_ID);
	return pubkey;
}

// Returns the on-chain PDA for `label.parentDomain` (e.g. "test.threews").
function _computeSubdomainKey(label, parentDomain) {
	const parentKey = _getNameAccountKey(
		_getHashedName(parentDomain),
		null,
		ROOT_DOMAIN_ACCOUNT,
	);
	const subKey = _getNameAccountKey(
		_getHashedName(`\x00${label}`),
		null,
		parentKey,
	);
	return subKey;
}

/**
 * Load the platform keypair that owns the parent .sol from
 * THREEWS_SOL_PARENT_SECRET_BASE58 (a base58-encoded 64-byte ed25519 secret).
 */
export function loadParentOwnerKeypair() {
	const b58 = process.env.THREEWS_SOL_PARENT_SECRET_BASE58;
	if (!b58) {
		const e = new Error('THREEWS_SOL_PARENT_SECRET_BASE58 is not set — subdomain minting is disabled');
		e.status = 503;
		e.code = 'parent_owner_unconfigured';
		throw e;
	}
	let raw;
	try {
		raw = bs58.decode(b58);
	} catch (err) {
		const e = new Error(`THREEWS_SOL_PARENT_SECRET_BASE58 is not valid base58: ${err?.message}`);
		e.status = 503;
		e.code = 'parent_owner_misconfigured';
		throw e;
	}
	if (raw.length !== 64) {
		const e = new Error(`THREEWS_SOL_PARENT_SECRET_BASE58 decoded to ${raw.length} bytes; expected 64`);
		e.status = 503;
		e.code = 'parent_owner_misconfigured';
		throw e;
	}
	return Keypair.fromSecretKey(raw);
}

export function getParentDomain() {
	return (process.env.THREEWS_SOL_PARENT_DOMAIN || 'threews.sol').toLowerCase();
}

// Public origin three.ws is reachable on. Used to build the URL record so a
// Brave user typing `<label>.threews.sol` lands on the matching storefront.
export function getStorefrontOrigin() {
	const raw = process.env.STOREFRONT_ORIGIN || 'https://three.ws';
	return raw.replace(/\/$/, '');
}

export function storefrontUrlForLabel(label) {
	return `${getStorefrontOrigin()}/u/${encodeURIComponent(label)}`;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate a single subdomain label. Mirrors DNS-ish rules: 1–63 chars, no
 * leading/trailing hyphen, lowercase letters/digits/hyphens only.
 */
export function normalizeLabel(input) {
	const s = String(input || '').trim().toLowerCase();
	if (!s) return null;
	if (s.length > 63) return null;
	if (!LABEL_RE.test(s)) return null;
	return s;
}

/**
 * Check whether `label.<parent>` already exists on-chain.
 * Returns { exists: boolean, owner: string|null }.
 *
 * Implemented without @bonfida/spl-name-service to avoid ESM/borsh
 * version conflicts in Vercel's serverless bundler. Derivation is
 * verified to match bonfida's getDomainKeySync output.
 */
export async function checkSubdomainAvailability({ connection, parentDomain, label }) {
	const cleanParent = parentDomain.replace(/\.sol$/, '');
	const pubkey = _computeSubdomainKey(label, cleanParent);
	try {
		const info = await connection.getAccountInfo(pubkey);
		if (!info) return { exists: false, owner: null };
		// NameRegistryState header layout: [parentName(32), owner(32), class(32)]
		const owner = new PublicKey(info.data.slice(32, 64));
		return { exists: true, owner: owner.toBase58() };
	} catch {
		return { exists: false, owner: null };
	}
}

/**
 * Build + send a transaction that:
 *   1. createSubdomain(label.parentDomain) — parent owner signs, becomes owner
 *      of the freshly-minted registry.
 *   2. transferSubdomain(label.parentDomain → newOwner) — parent owner signs
 *      again to hand the subdomain to the requested final owner.
 *
 * Returns { signature, fullName, owner }.
 */
export async function createNamedSubdomain({
	label,
	newOwner,
	space = 2000,
	rpcUrl = DEFAULT_RPC_URL,
	urlOverride,
}) {
	const cleanLabel = normalizeLabel(label);
	if (!cleanLabel) {
		const e = new Error('invalid subdomain label');
		e.status = 400;
		e.code = 'validation_error';
		throw e;
	}
	const parentDomain = getParentDomain().replace(/\.sol$/, '');
	const fullName = `${cleanLabel}.${parentDomain}`;
	const newOwnerKey = new PublicKey(newOwner);

	const parentKp = loadParentOwnerKeypair();
	const connection = new Connection(rpcUrl, 'confirmed');

	const availability = await checkSubdomainAvailability({
		connection,
		parentDomain,
		label: cleanLabel,
	});
	if (availability.exists) {
		const e = new Error(`${fullName}.sol already exists`);
		e.status = 409;
		e.code = 'conflict';
		throw e;
	}

	const sns = await import('@bonfida/spl-name-service');
	const createIxs = await sns.createSubdomain(connection, fullName, parentKp.publicKey, space);

	// Write the URL record while the platform still owns the subdomain.
	// This makes `<label>.threews.sol` resolve in Brave (and any other SNS-
	// aware client) to the right page on three.ws — the user's `/u/<label>`
	// storefront by default, or a caller-supplied override (e.g. an agent
	// page when the subdomain is being attached to an agent).
	const url = urlOverride || storefrontUrlForLabel(cleanLabel);
	const urlRecordIx = sns.createRecordV2Instruction(
		fullName,
		sns.Record.Url,
		url,
		parentKp.publicKey,
		parentKp.publicKey,
	);

	const transferIxs = await sns.transferSubdomain(connection, fullName, newOwnerKey, true);

	const ixs = [...createIxs, urlRecordIx, ...transferIxs];
	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	const message = new TransactionMessage({
		payerKey: parentKp.publicKey,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const tx = new VersionedTransaction(message);
	tx.sign([parentKp]);

	const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
	await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

	return {
		signature,
		fullName: `${fullName}.sol`,
		owner: newOwnerKey.toBase58(),
		parent: `${parentDomain}.sol`,
		url_record: url,
	};
}
