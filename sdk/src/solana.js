/**
 * Solana utilities for three.ws SDK.
 *
 * Covers:
 *  - SIWS (Sign-In with Solana) auth flow
 *  - Solana agent identity registration (Metaplex Core NFT)
 *  - Solana Pay checkout + confirm
 *
 * All functions are browser-compatible; they rely on window.phantom / window.solana
 * being injected by the user's wallet extension.
 */

// ─── Provider detection ───────────────────────────────────────────────────────

export function detectSolanaProvider(preferred = null) {
	if (preferred === 'phantom')  return window.phantom?.solana  || window.solana  || null;
	if (preferred === 'backpack') return window.backpack?.solana || null;
	if (preferred === 'solflare') return window.solflare          || null;
	if (window.phantom?.solana?.isPhantom)  return window.phantom.solana;
	if (window.solana?.isPhantom)           return window.solana;
	if (window.backpack?.solana)            return window.backpack.solana;
	if (window.solflare?.isSolflare)        return window.solflare;
	return null;
}

// ─── SIWS sign-in ─────────────────────────────────────────────────────────────

/**
 * Full SIWS sign-in flow using the detected Solana wallet.
 *
 * @param {object} opts
 * @param {string} [opts.preferred]   'phantom' | 'backpack' | 'solflare' | null (auto)
 * @param {string} [opts.nonceUrl]    Defaults to '/api/auth/siws/nonce'
 * @param {string} [opts.verifyUrl]   Defaults to '/api/auth/siws/verify'
 * @param {string} [opts.chainId]     'mainnet' | 'devnet' (default 'mainnet')
 * @returns {Promise<{user: object, wallet: object}>}
 */
export async function signInWithSolana({
	preferred  = null,
	nonceUrl   = '/api/auth/siws/nonce',
	verifyUrl  = '/api/auth/siws/verify',
	chainId    = 'mainnet',
} = {}) {
	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected. Install Phantom or Backpack.');

	const { publicKey } = await provider.connect();
	const address = publicKey.toString();

	const nonceRes = await fetch(nonceUrl, { credentials: 'include' });
	if (!nonceRes.ok) throw new Error('Failed to fetch SIWS nonce');
	const { nonce, csrf } = await nonceRes.json();

	const domain       = location.host;
	const uri          = location.origin;
	const issuedAt     = new Date().toISOString();
	const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();

	const message = [
		`${domain} wants you to sign in with your Solana account:`,
		address, '',
		'Sign in to three.ws. This request will not trigger any transaction. By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and Privacy Policy (https://three.ws/legal/privacy).',
		'',
		`URI: ${uri}`, 'Version: 1', `Chain ID: ${chainId}`,
		`Nonce: ${nonce}`, `Issued At: ${issuedAt}`, `Expiration Time: ${expirationTime}`,
	].join('\n');

	const msgBytes            = new TextEncoder().encode(message);
	const { signature }       = await provider.signMessage(msgBytes, 'utf8');
	const sigBase64           = btoa(String.fromCharCode(...signature));

	const verifyRes = await fetch(verifyUrl, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
		// tosAccepted: the signed statement carries the agreement; the flag
		// tells the server to stamp acceptance on the user record.
		body: JSON.stringify({ message, signature: sigBase64, tosAccepted: true }),
	});
	const data = await verifyRes.json().catch(() => ({}));
	if (!verifyRes.ok) throw new Error(data.error_description || 'SIWS verification failed');
	return data;
}

// ─── Solana agent identity registration ──────────────────────────────────────

/**
 * Register a Solana agent identity (Metaplex Core NFT).
 *
 * 1. Calls /api/agents/solana-register-prep to get an unsigned transaction.
 * 2. Has the user's wallet sign + submit it.
 * 3. Calls /api/agents/solana-register-confirm with the tx signature.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} [opts.description]
 * @param {string} [opts.avatarId]
 * @param {string} [opts.network]      'mainnet' | 'devnet'
 * @param {string} [opts.preferred]    wallet preference
 * @param {Function} [opts.onStatus]  (msg: string) => void
 * @returns {Promise<{agent: object, sol_mint_address: string, tx_signature: string}>}
 */
export async function registerSolanaAgent({
	name, description = '', avatarId, network = 'mainnet',
	preferred = null, onStatus = () => {},
} = {}) {
	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected');

	let publicKey;
	try {
		({ publicKey } = await provider.connect());
	} catch {
		throw new Error('Wallet connection rejected');
	}
	const walletAddress = publicKey.toString();

	onStatus('Preparing registration transaction…');
	const prepRes = await fetch('/api/agents/solana-register-prep', {
		method: 'POST', credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name, description, avatar_id: avatarId, wallet_address: walletAddress, network }),
	});
	const prep = await prepRes.json();
	if (!prepRes.ok) throw new Error(prep.error_description || 'Prep failed');

	onStatus('Sign the transaction in your wallet…');
	// Deserialize and sign the transaction.
	const txBytes = Uint8Array.from(atob(prep.tx_base64), (c) => c.charCodeAt(0));
	let txSignature;
	try {
		// sendAndConfirm is the cleanest — Phantom handles submission.
		const result = await provider.signAndSendTransaction({ serialize: () => txBytes });
		txSignature  = result.signature || result;
	} catch (e) {
		if (e?.code === 4001 || String(e).includes('rejected')) throw new Error('Transaction cancelled');
		throw e;
	}

	onStatus('Confirming on-chain…');
	const confirmRes = await fetch('/api/agents/solana-register-confirm', {
		method: 'POST', credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			tx_signature: txSignature,
			asset_pubkey: prep.asset_pubkey,
			wallet_address: walletAddress,
			network, name, description,
			...(avatarId ? { avatar_id: avatarId } : {}),
		}),
	});
	const result = await confirmRes.json();
	if (!confirmRes.ok) throw new Error(result.error_description || 'Confirm failed');
	onStatus('Agent registered on Solana!');
	return result;
}

// ─── Solana Pay subscription ──────────────────────────────────────────────────

/**
 * Start a Solana Pay USDC subscription checkout.
 *
 * @param {object} opts
 * @param {'pro'|'team'|'enterprise'} opts.plan
 * @param {'mainnet'|'devnet'} [opts.network]
 * @returns {Promise<{solana_pay_url: string, intent_id: string, amount_usdc: number, nonce: string}>}
 */
export async function startSolanaCheckout({ plan, network = 'mainnet' } = {}) {
	const res = await fetch('/api/payments/solana/checkout', {
		method: 'POST', credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ plan, network }),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error_description || 'Checkout failed');
	return data;
}

/**
 * Confirm a completed Solana Pay transaction.
 *
 * @param {object} opts
 * @param {string} opts.intentId
 * @param {string} opts.txSignature
 * @param {'mainnet'|'devnet'} [opts.network]
 * @returns {Promise<{ok: boolean, plan: string, active_until: string}>}
 */
export async function confirmSolanaPayment({ intentId, txSignature, network = 'mainnet' } = {}) {
	const res = await fetch('/api/payments/solana/confirm', {
		method: 'POST', credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ intent_id: intentId, tx_signature: txSignature, network }),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error_description || 'Confirmation failed');
	return data;
}
