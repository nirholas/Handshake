// Town auth — the browser half of posting as yourself in a coin world.
//
// Posting flow, all real, no shortcuts:
//   1. Sign in to CoinCommunities with X (OAuth popup → same-origin callback
//      sets an httpOnly session cookie; we just await the postMessage).
//   2. Ensure a Solana wallet is linked: connect Phantom, sign the challenge
//      message, link it via the proxy.
//   3. Post — the proxy forwards the session cookie as the user bearer.
//
// Session/token handling lives entirely server-side (cookies); this module only
// orchestrates the user-facing steps and never sees the JWT.

const BASE = '/api/community';

async function json(path, init) {
	const res = await fetch(`${BASE}${path}`, { credentials: 'include', ...init });
	let body = null;
	try {
		body = await res.json();
	} catch {
		/* fall through */
	}
	if (!res.ok || body?.error) {
		const err = new Error(body?.error_description || body?.error || `HTTP ${res.status}`);
		err.status = res.status;
		err.code = body?.error;
		throw err;
	}
	return body?.data ?? null;
}

/** Current CoinCommunities session, or { user: null } when signed out. */
export function getSession() {
	return json('/me');
}

/**
 * Open the X OAuth popup and resolve once the same-origin callback reports
 * success. Rejects on user-close or failure.
 */
export async function signInWithX() {
	const { authUrl } = await json('/auth/url');
	const w = 520;
	const h = 680;
	const left = window.screenX + (window.outerWidth - w) / 2;
	const top = window.screenY + (window.outerHeight - h) / 2;
	const popup = window.open(
		authUrl,
		'cc-x-oauth',
		`width=${w},height=${h},left=${left},top=${top}`,
	);
	if (!popup) throw new Error('Popup blocked — allow popups to sign in.');

	return new Promise((resolve, reject) => {
		let settled = false;
		const onMessage = (e) => {
			if (e.origin !== location.origin) return;
			if (e.data?.type !== 'cc-auth') return;
			cleanup();
			if (e.data.ok) resolve(e.data.user || null);
			else reject(new Error(e.data.message || 'Sign-in failed'));
		};
		const poll = setInterval(() => {
			if (popup.closed && !settled) {
				cleanup();
				reject(new Error('Sign-in cancelled'));
			}
		}, 500);
		const cleanup = () => {
			settled = true;
			clearInterval(poll);
			window.removeEventListener('message', onMessage);
			try {
				popup.close();
			} catch {
				/* already closed */
			}
		};
		window.addEventListener('message', onMessage);
	});
}

/** Connect Phantom (or any window.solana provider) and return its address. When
 *  `forceReconnect` is set, drop any existing connection first — injected wallets
 *  silently re-hand back the already-trusted account, so without this the user
 *  can never pick a different wallet to link. */
async function connectSolana({ forceReconnect = false } = {}) {
	const provider = window.phantom?.solana || window.solana;
	if (!provider?.connect) {
		throw new Error('No Solana wallet found — install Phantom to post.');
	}
	if (forceReconnect) {
		try { await provider.disconnect?.(); } catch { /* nothing connected — fine */ }
	}
	const resp = await provider.connect();
	const address = (resp?.publicKey || provider.publicKey)?.toString();
	if (!address) throw new Error('Could not read wallet address.');
	return { provider, address };
}

/**
 * Ensure the signed-in user has a linked Solana wallet, linking one via a
 * signed challenge if needed. Returns the wallet address to post from.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceReconnect]  link a freshly-chosen wallet even if one
 *   is already linked — used when switching wallets (see relinkSolanaWallet).
 */
export async function ensureSolanaWallet(session, { forceReconnect = false } = {}) {
	if (!forceReconnect && session?.solWallet) return session.solWallet;

	const { provider, address } = await connectSolana({ forceReconnect });
	const { message } = await json('/wallet/challenge', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ address }),
	});

	const encoded = new TextEncoder().encode(message);
	const signed = await provider.signMessage(encoded, 'utf8');
	const sigBytes = signed?.signature ?? signed;
	const bs58 = (await import('bs58')).default;
	const signature = bs58.encode(sigBytes);

	const linked = await json('/wallet/link', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ address, signature }),
	});
	return linked?.address || address;
}

/** Unlink the Solana wallet currently bound to the session. Idempotent — safe to
 *  call when none is linked. */
export function unlinkSolanaWallet() {
	return json('/wallet/unlink', { method: 'POST' });
}

/**
 * Switch the linked Solana wallet: unlink the current one, then connect and link
 * a freshly-chosen wallet. Lets a holder enter from the wallet that actually
 * holds the coin when the first one they linked falls short. Returns the new
 * linked address.
 */
export async function relinkSolanaWallet() {
	await unlinkSolanaWallet();
	return ensureSolanaWallet(null, { forceReconnect: true });
}

/**
 * Ask the server whether the signed-in user holds enough of `mint` to enter its
 * Holders world, and if so mint a holder pass for the game server.
 *
 * Resolves to { eligible, usd, amount, minUsd, wallet, holderPass? } — the pass
 * is present only when eligible. Rejects with a coded error when the user can't
 * be checked yet: `auth_required` (not signed in) or `wallet_required` (no
 * linked Solana wallet) — the gate UI routes on err.code to recover.
 */
export function requestHolderPass(mint) {
	return json(`/holder-pass?token=${encodeURIComponent(mint)}`, { method: 'POST' });
}

/** Post content to a coin world as the signed-in user from their linked wallet. */
export function postAsUser(token, content, walletAddress) {
	return json(`/messages?token=${encodeURIComponent(token)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ content, walletAddress, chainId: 'solana' }),
	});
}

export function logout() {
	return json('/logout', { method: 'POST' }).catch(() => {});
}
