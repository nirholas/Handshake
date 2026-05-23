// API-side facade over the canonical SNS-subdomain primitive in
// src/solana/sns-subdomain.js.
//
// The on-chain logic — keypair loading, availability check, atomic
// create + URL-record + transfer — lives in src/solana/sns-subdomain.js
// and is shared with the agent-level mint endpoint at /api/sns-subdomain.
//
// This module adds API-layer concerns that belong outside the on-chain
// primitive: a stricter reserved-label denylist, a fully-qualified
// `<label>.<parent>.sol` formatter for HTTP responses, and a thin
// `mintSubdomain()` wrapper that callers can use without re-spelling the
// records argument.

import {
	checkSubdomainAvailability,
	createNamedSubdomain,
	getParentDomain,
	getStorefrontOrigin,
	loadParentOwnerKeypair,
	normalizeLabel as normalizeLabelRaw,
	storefrontUrlForLabel,
} from '../../src/solana/sns-subdomain.js';
import { Connection } from '@solana/web3.js';

const DEFAULT_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// The platform label is the bare parent domain (e.g. 'threews' for
// 'threews.sol'). Derived from THREEWS_SOL_PARENT_DOMAIN via getParentDomain().
export const PARENT_LABEL = getParentDomain().replace(/\.sol$/, '');

// Labels we never let users claim. Either reserved app paths, impersonation
// risks, or short reserved words. Mirrors api/agents/check-name's denylist
// plus the additional surface a public-facing `<label>.threews.sol` exposes.
const DENYLIST = new Set([
	'admin', 'root', 'system', 'api', 'app', 'www', 'mail', 'help', 'support',
	'about', 'login', 'signup', 'logout', 'signin', 'auth', 'oauth', 'pay',
	'three', 'threews', 'three-ws', 'anthropic', 'claude', 'openai', 'sol',
	'wallet', 'staff', 'team', 'official', 'verified',
]);

export function normalizeLabel(input) {
	if (typeof input !== 'string') return null;
	// Users routinely paste the whole `<label>.threews.sol` or `<label>.sol`.
	// Strip those suffixes before delegating to the canonical label normalizer
	// (which insists on a single bare label).
	const stripped = input
		.trim()
		.toLowerCase()
		.replace(new RegExp(`\\.${PARENT_LABEL}(\\.sol)?$`), '')
		.replace(/\.sol$/, '');
	const cleaned = normalizeLabelRaw(stripped);
	if (!cleaned) return null;
	if (DENYLIST.has(cleaned)) return null;
	return cleaned;
}

export function fullDomain(label) {
	return `${label}.${PARENT_LABEL}.sol`;
}

export function hasOwnerKey() {
	return !!process.env.THREEWS_SOL_PARENT_SECRET_BASE58;
}

/**
 * Returns the on-chain owner of `<label>.<parent>.sol`, or null if the
 * subdomain has not been registered yet.
 */
export async function getSubdomainOwner(label) {
	const conn = new Connection(DEFAULT_RPC_URL, 'confirmed');
	const { exists, owner } = await checkSubdomainAvailability({
		connection: conn,
		parentDomain: PARENT_LABEL,
		label,
	});
	return exists ? owner : null;
}

/**
 * Mint `<label>.<parent>.sol`, write its URL record so Brave routes to the
 * three.ws storefront, and transfer ownership to `recipientWallet`. Returns
 * { signature, fullName, owner, parent, url_record }.
 */
export async function mintSubdomain({ label, recipientWallet }) {
	return createNamedSubdomain({ label, newOwner: recipientWallet });
}

// Re-exports so callers don't need a second import from src/solana.
export { loadParentOwnerKeypair, getStorefrontOrigin, storefrontUrlForLabel };
