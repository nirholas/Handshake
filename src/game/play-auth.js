// Play auth — the browser half of wallet-first sign-in for /play.
//
// The wallet address IS the account: no email, no password, no seed phrase ever
// asked for. The flow is, all real:
//   1. Fetch the gate config + a fresh server nonce (GET /api/play/nonce).
//   2. Connect a Solana wallet (Phantom/Backpack/Solflare, or the Seeker TWA's
//      on-device wallet) and read its public key.
//   3. Sign a human-readable message embedding the nonce — proves key ownership,
//      moves nothing on-chain.
//   4. POST { address, signature, nonce } to /api/play/verify, which checks the
//      signature server-side, reads the wallet's game-token balance from real
//      RPC, and (if it clears the floor) returns a short-lived play pass.
//
// The pass + verified wallet are cached in sessionStorage so a reload inside the
// pass's lifetime doesn't re-prompt the wallet. All on-chain truth is computed
// server-side; this module only orchestrates the wallet interaction.

// Side-effect import: on a Solana Mobile (Seeker/Saga) device running inside our
// TWA, this installs an MWA-backed wallet at window.solana that signs through the
// Seed Vault. A no-op on every other platform.
import '../../solana-mobile/src/index.js';

const NONCE_URL = '/api/play/nonce';
const VERIFY_URL = '/api/play/verify';
const STORE_KEY = 'cc-play-pass';
// Refresh a little before the server's 10-min pass TTL so a reconnect never
// races expiry; the game server sweeps expired passes every minute.
const REFRESH_SKEW_MS = 90_000;

/** A coded error the gate UI can route on (err.code) without string matching. */
export class PlayAuthError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = 'PlayAuthError';
	}
}

/** Detect an injected Solana wallet, preferring Phantom, then Backpack/Solflare,
 *  and the Seeker TWA wallet (window.solana.isThreeWs). */
export function detectProvider() {
	if (typeof window === 'undefined') return null;
	const w = window;
	if (w.phantom?.solana?.isPhantom) return w.phantom.solana;
	if (w.solana?.isPhantom || w.solana?.isThreeWs) return w.solana;
	if (w.backpack?.solana) return w.backpack.solana;
	if (w.solflare?.isSolflare) return w.solflare;
	if (w.solana) return w.solana; // generic injected provider
	return null;
}

/** True when any Solana wallet is installed/injected. */
export function hasWallet() {
	return !!detectProvider();
}

/**
 * Fetch the gate configuration and a fresh nonce.
 * @returns {Promise<{ nonce: string, expiresAt: string, required: boolean, mint: string, minBalance: number }>}
 */
export async function fetchPlayConfig() {
	const res = await fetch(NONCE_URL, { credentials: 'include', headers: { accept: 'application/json' } });
	const body = await res.json().catch(() => null);
	if (!res.ok || !body?.data?.nonce) {
		throw new PlayAuthError('nonce_unavailable', body?.error_description || 'Could not start sign-in. Try again.');
	}
	return body.data;
}

// The message the wallet signs. MUST stay byte-identical to buildPlayMessage in
// api/play/verify.js — the server reconstructs and verifies the signature over
// these exact bytes, so any drift breaks every login.
function buildPlayMessage(address, nonce) {
	return [
		'three.ws wants you to sign in with your Solana account:',
		address,
		'',
		'Sign in to play three.ws. This proves you own this wallet and will not move any funds or tokens.',
		'',
		`Nonce: ${nonce}`,
	].join('\n');
}

/**
 * Run the full connect → sign → verify flow against a server-issued nonce.
 *
 * @param {object} opts
 * @param {string} opts.nonce        nonce from fetchPlayConfig()
 * @param {boolean} [opts.forceReconnect]  drop the current wallet link before
 *   connecting, so the wallet re-prompts and a different account can be chosen.
 * @param {(stage: string) => void} [opts.onStage]  'connecting' | 'signing' | 'verifying'
 * @returns {Promise<object>} the /verify result — { ok: true, wallet, balance,
 *   playPass, … } when the wallet clears the floor, or { ok: false,
 *   reason: 'balance_too_low', wallet, balance, minBalance, acquireUrl, … }.
 * @throws {PlayAuthError} no_wallet | rejected | nonce_invalid | bad_signature |
 *   balance_unavailable | verify_failed
 */
export async function signInToPlay({ nonce, forceReconnect = false, onStage = () => {} } = {}) {
	const provider = detectProvider();
	if (!provider?.connect) {
		throw new PlayAuthError('no_wallet', 'No Solana wallet found. Install Phantom to play.');
	}

	// Switching wallets: injected providers silently re-hand back the already-
	// trusted account on connect(), so without disconnecting first the player is
	// stuck on whichever wallet they picked the first time. Dropping the link makes
	// the wallet show its account picker again. Best-effort — a no-op when nothing
	// is connected yet.
	if (forceReconnect) {
		try { await provider.disconnect?.(); } catch { /* not connected — fine */ }
	}

	onStage('connecting');
	let address;
	try {
		const resp = await provider.connect();
		address = (resp?.publicKey || provider.publicKey)?.toString();
	} catch (err) {
		if (err?.code === 4001 || /reject|cancel|denied/i.test(String(err?.message))) {
			throw new PlayAuthError('rejected', 'Wallet connection was cancelled.');
		}
		throw new PlayAuthError('rejected', err?.message || 'Could not connect your wallet.');
	}
	if (!address) throw new PlayAuthError('rejected', 'Could not read your wallet address.');

	onStage('signing');
	const message = buildPlayMessage(address, nonce);
	let signature;
	try {
		const encoded = new TextEncoder().encode(message);
		const signed = await provider.signMessage(encoded, 'utf8');
		const sigBytes = signed?.signature ?? signed;
		const bs58 = (await import('bs58')).default;
		signature = bs58.encode(sigBytes);
	} catch (err) {
		if (err?.code === 4001 || /reject|cancel|denied/i.test(String(err?.message))) {
			throw new PlayAuthError('rejected', 'You declined the sign-in signature.');
		}
		throw new PlayAuthError('rejected', err?.message || 'Could not sign the sign-in message.');
	}

	onStage('verifying');
	let res, body;
	try {
		res = await fetch(VERIFY_URL, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ address, signature, nonce }),
		});
		body = await res.json().catch(() => null);
	} catch {
		throw new PlayAuthError('verify_failed', 'Network error during sign-in. Check your connection and retry.');
	}
	if (!res.ok) {
		const code = body?.error || 'verify_failed';
		throw new PlayAuthError(code, body?.error_description || 'Sign-in verification failed.');
	}
	const data = body?.data;
	if (!data) throw new PlayAuthError('verify_failed', 'Sign-in returned an unexpected response.');

	if (data.ok && data.playPass) storePass(data);
	return data;
}

// ── Session cache ────────────────────────────────────────────────────────────

/** Persist a granted pass for this tab so a reload inside its TTL doesn't
 *  re-prompt the wallet. */
export function storePass(data) {
	try {
		sessionStorage.setItem(
			STORE_KEY,
			JSON.stringify({ wallet: data.wallet, playPass: data.playPass, mint: data.mint, balance: data.balance, symbol: data.symbol, expiresAt: data.expiresAt }),
		);
	} catch { /* private mode / quota — sign-in just re-runs */ }
}

/** Return a cached, still-fresh pass, or null. */
export function loadStoredPass() {
	try {
		const raw = sessionStorage.getItem(STORE_KEY);
		if (!raw) return null;
		const p = JSON.parse(raw);
		if (!p?.playPass || !p?.expiresAt) return null;
		if (new Date(p.expiresAt).getTime() - Date.now() <= REFRESH_SKEW_MS) {
			clearStoredPass();
			return null;
		}
		return p;
	} catch {
		return null;
	}
}

export function clearStoredPass() {
	try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}
