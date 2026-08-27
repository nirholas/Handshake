// Privy server-side REST client.
//
// The Privy *access token* (verified in auth.js#verifyPrivyToken) carries identity
// — `sub` is the user's DID — but it does NOT reliably include the user's linked
// accounts (email, embedded wallets). Those live in the Privy user object, which
// is fetched server-side with the app secret. This module is that fetch.
//
// Auth: HTTP Basic with `app_id:app_secret`, plus a `privy-app-id` header, per
// https://docs.privy.io/reference/sdk/server-auth . When the secret is unset the
// helpers return null so callers degrade to whatever the token alone provides.

import { env } from './env.js';

import { fetchUpstream } from './upstream-fetch.js';
const PRIVY_API_BASE = 'https://auth.privy.io/api/v1';

function authHeaders() {
	const appId = env.PRIVY_APP_ID;
	const secret = env.PRIVY_APP_SECRET;
	if (!appId || !secret) return null;
	const basic = Buffer.from(`${appId}:${secret}`).toString('base64');
	return {
		Authorization: `Basic ${basic}`,
		'privy-app-id': appId,
		'Content-Type': 'application/json',
	};
}

/**
 * Fetch the full Privy user object by DID. Returns the parsed user (including
 * `linked_accounts`) or null when Privy is unconfigured or the lookup fails.
 * @param {string} did e.g. "did:privy:clxxx..."
 */
export async function fetchPrivyUser(did) {
	const headers = authHeaders();
	if (!headers || !did) return null;
	const res = await fetchUpstream(`${PRIVY_API_BASE}/users/${encodeURIComponent(did)}`, { headers }, { name: 'privy', timeoutMs: 8_000, attempts: 2, okWhen: () => true });
	if (!res.ok) return null;
	return res.json();
}

// Privy tags every linked account with a `type`. Map the wallet ones to our
// user_wallets.chain_type domain ('evm' | 'solana'); ignore the rest.
function walletChainType(account) {
	// Embedded + external wallets expose `chain_type` ('ethereum' | 'solana').
	const ct = account.chain_type || account.chainType;
	if (ct === 'solana') return 'solana';
	if (ct === 'ethereum') return 'evm';
	// Older payloads omit chain_type; infer from address shape (0x = EVM).
	if (typeof account.address === 'string') {
		return account.address.startsWith('0x') ? 'evm' : 'solana';
	}
	return null;
}

/**
 * Normalize a Privy user's linked accounts into the bits we persist.
 * Accepts either a fetched user object or a token payload carrying
 * `linked_accounts`, so callers can pass whichever they have.
 * @returns {{ email: string|null, wallets: Array<{address:string, chainType:string}> }}
 */
export function extractIdentity(privyUserOrPayload) {
	const accounts = Array.isArray(privyUserOrPayload?.linked_accounts)
		? privyUserOrPayload.linked_accounts
		: [];

	const emailAccount = accounts.find(
		(a) =>
			a.type === 'email' ||
			a.type === 'google_oauth' ||
			a.type === 'twitter_oauth' ||
			a.type === 'github_oauth',
	);
	const email = emailAccount?.address || emailAccount?.email || null;

	const wallets = [];
	for (const a of accounts) {
		if (a.type !== 'wallet' && a.type !== 'smart_wallet') continue;
		if (!a.address) continue;
		const chainType = walletChainType(a);
		if (!chainType) continue;
		// EVM addresses are case-insensitive — lowercase to match the unique index;
		// Solana base58 is case-sensitive, so leave it untouched.
		const address = chainType === 'evm' ? a.address.toLowerCase() : a.address;
		wallets.push({ address, chainType });
	}
	return { email, wallets };
}

/**
 * Resolve a Privy user's linked wallets by DID via the server API. Falls back to
 * whatever the token payload carried when the API is unconfigured/unavailable.
 * @param {string} did
 * @param {object} [tokenPayload] the verified access-token payload (optional)
 */
export async function fetchPrivyWallets(did, tokenPayload) {
	const user = await fetchPrivyUser(did);
	if (user) return extractIdentity(user).wallets;
	return tokenPayload ? extractIdentity(tokenPayload).wallets : [];
}
