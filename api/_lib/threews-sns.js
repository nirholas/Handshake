// threews.sol subdomain helpers.
//
// The platform owns `threews.sol` on Solana Name Service. This module wraps
// the @bonfida/spl-name-service v3 SDK to mint `<label>.threews.sol`
// subdomains, set a URL record on them (so Brave's built-in SNS resolution
// routes the subdomain to the user's three.ws showcase page), and transfer
// ownership to the user's wallet — all in a single transaction signed by
// the platform parent-domain keypair.
//
// Env (required for any write op):
//   THREEWS_SOL_OWNER_SECRET_BASE58  base58-encoded 64-byte ed25519 secret
//     for the wallet that owns `threews.sol`.
//   THREEWS_PARENT_DOMAIN (optional, default 'threews')
//     the parent label whose subdomains we mint. Override only if the
//     platform owns a different root.

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { solanaConnection } from './agent-pumpfun.js';

export const PARENT_LABEL = (process.env.THREEWS_PARENT_DOMAIN || 'threews').toLowerCase();

const SUBDOMAIN_RE = /^[a-z0-9-]{1,63}$/;
// Reserve labels that look like internal app paths, common impersonations,
// or short reserved words. Matches the spirit of agents/check-name's denylist.
const DENYLIST = new Set([
	'admin', 'root', 'system', 'api', 'app', 'www', 'mail', 'help', 'support',
	'about', 'login', 'signup', 'logout', 'signin', 'auth', 'oauth', 'pay',
	'three', 'threews', 'three-ws', 'anthropic', 'claude', 'openai', 'sol',
	'wallet', 'staff', 'team', 'official', 'verified',
]);

export function normalizeLabel(input) {
	if (typeof input !== 'string') return null;
	const trimmed = input
		.trim()
		.toLowerCase()
		.replace(new RegExp(`\\.${PARENT_LABEL}(\\.sol)?$`), '')
		.replace(/\.sol$/, '');
	if (!SUBDOMAIN_RE.test(trimmed)) return null;
	if (DENYLIST.has(trimmed)) return null;
	return trimmed;
}

export function fullDomain(label) {
	return `${label}.${PARENT_LABEL}.sol`;
}

/**
 * Decode the platform parent-domain keypair from env. Throws when missing —
 * callers must guard with `hasOwnerKey()` and return a friendly 503 otherwise.
 */
export function loadParentOwnerKeypair() {
	const raw = process.env.THREEWS_SOL_OWNER_SECRET_BASE58;
	if (!raw) throw new Error('THREEWS_SOL_OWNER_SECRET_BASE58 not configured');
	const secret = bs58.decode(raw.trim());
	if (secret.length !== 64) throw new Error('THREEWS_SOL_OWNER_SECRET_BASE58 must decode to 64 bytes');
	return Keypair.fromSecretKey(secret);
}

export function hasOwnerKey() {
	return !!process.env.THREEWS_SOL_OWNER_SECRET_BASE58;
}

/**
 * Returns the on-chain owner of `<label>.<parent>.sol`, or null if the
 * subdomain has not been registered yet.
 */
export async function getSubdomainOwner(label) {
	const sns = await import('@bonfida/spl-name-service');
	const conn = solanaConnection('mainnet');
	try {
		const { pubkey } = sns.getDomainKeySync(`${label}.${PARENT_LABEL}`);
		const { registry } = await sns.NameRegistryState.retrieve(conn, pubkey);
		return registry.owner.toBase58();
	} catch {
		return null;
	}
}

/**
 * Mint `<label>.threews.sol` as a single transaction signed by the platform:
 *   1. create the subdomain (parent owner pays rent, becomes interim owner)
 *   2. set its URL record to `urlRecordValue` (parent owner signs)
 *   3. transfer ownership of the subdomain to `recipientWallet`
 *
 * Returns the tx signature on success.
 */
export async function mintSubdomain({ label, recipientWallet, urlRecordValue }) {
	const sns = await import('@bonfida/spl-name-service');
	const conn = solanaConnection('mainnet');
	const parentKp = loadParentOwnerKeypair();
	const recipient = new PublicKey(recipientWallet);

	const createIxs = await sns.createSubdomain(
		conn,
		`${label}.${PARENT_LABEL}`,
		parentKp.publicKey,
		2000,
		parentKp.publicKey,
	);

	const recordIx = sns.createRecordV2Instruction(
		`${label}.${PARENT_LABEL}`,
		sns.Record.Url,
		urlRecordValue,
		parentKp.publicKey,
		parentKp.publicKey,
	);

	const transferIx = await sns.transferSubdomain(
		conn,
		`${label}.${PARENT_LABEL}`,
		recipient,
		true,
		parentKp.publicKey,
	);

	const tx = new Transaction().add(...createIxs, recordIx, transferIx);
	tx.feePayer = parentKp.publicKey;
	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
	tx.recentBlockhash = blockhash;
	tx.sign(parentKp);

	const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
	await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
	return sig;
}
