// Privy headless auth for login and register pages.
// Handles email-OTP and EVM wallet (SIWE via Privy).
// Solana wallet uses our own SIWS backend (/api/auth/siws/*) directly.

import Privy, { LocalStorage } from '@privy-io/js-sdk-core';
// Seeker / Saga: installs the Seed Vault wallet at window.threeWsWallet inside
// the three.ws app (a no-op everywhere else). getSolanaProvider() below already
// looked for it, but nothing on this page loaded it, so the Solana button
// answered "No Solana wallet detected" inside the app.
import '../solana-mobile/src/index.js';

const next =
	window.__loginNext ||
	new URLSearchParams(location.search).get('next') ||
	sessionStorage.getItem('login_redirect') ||
	'/dashboard';
sessionStorage.removeItem('login_redirect');

// ── Bootstrap ────────────────────────────────────────────────────────────────

// "This deployment has no Privy app" and "we could not find out" are different
// answers and used to collapse into the same null: the whole passwordless and
// wallet block vanished with no explanation, and the visitor had no way to tell
// a deliberate configuration from a failed probe.
const CONFIG_UNAVAILABLE = Symbol('config_unavailable');

async function getAppId() {
	try {
		// This module's top-level await blocks on it, so an unbounded fetch keeps
		// the entire sign-in block unrendered for as long as the network hangs.
		const r = await fetch('/api/config', { signal: AbortSignal.timeout(6000) });
		if (!r.ok) return CONFIG_UNAVAILABLE;
		const cfg = await r.json();
		return cfg.privyAppId || null;
	} catch {
		return CONFIG_UNAVAILABLE;
	}
}

const appId = await getAppId();

const section = document.getElementById('privy-section');
const divider = document.getElementById('privy-or-divider');

if (appId === CONFIG_UNAVAILABLE) {
	// Keep the section, drop the controls that cannot work, and say why. The
	// password form below the divider still signs the visitor in.
	for (const id of ['privy-step-email', 'privy-step-code', 'privy-wallet-wrap']) {
		const node = document.getElementById(id);
		if (node) node.hidden = true;
	}
	const err = document.getElementById('privy-inline-err');
	if (err) {
		err.textContent =
			'Email and wallet sign-in could not load. Check your connection and reload, or sign in with your password below.';
		err.hidden = false;
	}
} else if (!appId) {
	if (section) section.style.display = 'none';
	if (divider) divider.style.display = 'none';
} else {
	const privy = new Privy({ appId, storage: new LocalStorage() });
	mountPrivyUI(privy, makeCaptchaResolver(appId));
}

// ── CAPTCHA (Cloudflare Turnstile) ───────────────────────────────────────────
// Privy rejects passwordless/init AND siwe/init with 401 invalid_credentials
// when the app has CAPTCHA enabled and no token is sent, so this must resolve
// before sendCode and before the EVM wallet flow.

// Three outcomes, and collapsing the last two is what produced the opaque
// error. `null` means the app genuinely has no CAPTCHA, so proceed without a
// token. CAPTCHA_UNAVAILABLE means we could not ask: proceeding blind is
// exactly what Privy answers with 401 invalid_credentials, a message that tells
// the visitor their credentials were wrong when nothing of the sort happened.
const CAPTCHA_UNAVAILABLE = Symbol('captcha_unavailable');

async function fetchCaptchaConfig(id) {
	try {
		// This gates the login form, so an unbounded call stalls sign-in on a slow
		// network instead of degrading.
		const r = await fetch(`https://auth.privy.io/api/v1/apps/${id}`, {
			headers: { 'privy-app-id': id },
			signal: AbortSignal.timeout(6000),
		});
		if (!r.ok) return CAPTCHA_UNAVAILABLE;
		const cfg = await r.json();
		if (!cfg?.captcha_enabled || !cfg.captcha_site_key) return null;
		if (cfg.enabled_captcha_provider && cfg.enabled_captcha_provider !== 'turnstile') return null;
		return {
			// Privy prefixes Turnstile site keys with "t:".
			siteKey: cfg.captcha_site_key.replace(/^t:/, ''),
			// Apps with a custom auth domain serve every auth endpoint from it.
			apiUrl: cfg.custom_api_url || 'https://auth.privy.io',
		};
	} catch {
		return CAPTCHA_UNAVAILABLE;
	}
}

/**
 * Resolve the CAPTCHA config, retrying once at the moment of use.
 *
 * The page-load probe can lose a race with a flaky network, and without a retry
 * that one failure would break sign-in for the whole page view. A button press
 * is a fresh chance, so take it before giving up.
 *
 * @param {string} id  Privy app id.
 * @returns {() => Promise<object|null|symbol>}
 */
function makeCaptchaResolver(id) {
	let pending = fetchCaptchaConfig(id);
	return async () => {
		const first = await pending;
		if (first !== CAPTCHA_UNAVAILABLE) return first;
		pending = fetchCaptchaConfig(id);
		return pending;
	};
}

/**
 * The CAPTCHA token for a sign-in attempt, or undefined when the app has none.
 * Throws a sentence a person can act on when the requirement is unknowable,
 * rather than letting Privy reply "invalid_credentials".
 *
 * @param {object|null|symbol} config
 * @param {(msg: string) => void} [setStatus]
 */
async function captchaTokenFor(config, setStatus) {
	if (config === CAPTCHA_UNAVAILABLE) {
		throw new Error(
			'We could not reach the sign-in service to check whether this step needs a CAPTCHA. Check your connection and try again.',
		);
	}
	if (!config) return undefined;
	setStatus?.();
	return requestCaptchaToken(config.siteKey);
}

let turnstilePromise = null;

function loadTurnstile() {
	if (turnstilePromise) return turnstilePromise;
	turnstilePromise = new Promise((resolve, reject) => {
		if (window.turnstile) { resolve(window.turnstile); return; }
		window.__privyTurnstileOnload = () => resolve(window.turnstile);
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__privyTurnstileOnload&render=explicit';
		script.async = true;
		script.onerror = () => {
			turnstilePromise = null;
			reject(new Error('Could not load the CAPTCHA verifier. Check your connection and try again.'));
		};
		document.head.appendChild(script);
	});
	return turnstilePromise;
}

let captchaWidgetId = null;
let pendingCaptcha = null;

async function requestCaptchaToken(siteKey) {
	const turnstile = await loadTurnstile();
	const slot = document.getElementById('privy-captcha-slot');
	if (!slot) throw new Error('CAPTCHA container missing from page.');
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingCaptcha = null;
			reject(new Error('CAPTCHA timed out. Try again.'));
		}, 90_000);
		pendingCaptcha = {
			resolve(token) { clearTimeout(timer); pendingCaptcha = null; resolve(token); },
			reject(err) { clearTimeout(timer); pendingCaptcha = null; reject(err); },
		};
		if (captchaWidgetId === null) {
			captchaWidgetId = turnstile.render(slot, {
				sitekey: siteKey,
				appearance: 'interaction-only',
				execution: 'execute',
				callback: (token) => pendingCaptcha?.resolve(token),
				'error-callback': () => pendingCaptcha?.reject(new Error('CAPTCHA verification failed. Try again.')),
				'timeout-callback': () => pendingCaptcha?.reject(new Error('CAPTCHA timed out. Try again.')),
			});
		} else {
			turnstile.reset(captchaWidgetId);
		}
		turnstile.execute(slot);
	});
}

// ── SIWE init with CAPTCHA ───────────────────────────────────────────────────
// js-sdk-core's siwe.init() POSTs only {address}, with no way to attach a
// CAPTCHA token, so a CAPTCHA-enabled app 401s every EVM login through the
// SDK. The endpoint itself accepts a token field (same as passwordless/init),
// so call it directly and hand the message to loginWithSiwe(signature,
// wallet, message), which keeps the rest of the SDK flow intact.

async function siweInitWithCaptcha(apiUrl, address, chainId, captchaToken) {
	const r = await fetch(`${apiUrl}/api/v1/siwe/init`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', 'privy-app-id': appId },
		body: JSON.stringify({ address, token: captchaToken }),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) {
		throw new Error(
			data.code === 'invalid_captcha'
				? 'CAPTCHA verification failed. Try again.'
				: 'Could not reach the sign-in service. Try again.',
		);
	}
	// Same EIP-4361 message the SDK's siwe.init() builds; the server verifies
	// the domain and nonce on authenticate.
	return [
		`${location.hostname} wants you to sign in with your Ethereum account:`,
		address,
		'',
		'By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.',
		'',
		`URI: ${location.origin}`,
		'Version: 1',
		`Chain ID: ${chainId}`,
		`Nonce: ${data.nonce}`,
		`Issued At: ${new Date().toISOString()}`,
		'Resources:',
		'- https://privy.io',
	].join('\n');
}

// ── Shared backend verify ─────────────────────────────────────────────────────

async function verifyWithBackend(identity_token) {
	// The last step of sign-in. Unbounded, a stalled edge left the Verify button
	// reading "Signing in…" forever with no error and no way back.
	const res = await fetch('/api/auth/privy/verify', {
		method: 'POST',
		credentials: 'include',
		signal: AbortSignal.timeout(20_000),
		headers: { 'content-type': 'application/json' },
		// tosAccepted: the login/register pages show the agreement notice next
		// to the Privy controls, so completing the flow affirms the Terms.
		body: JSON.stringify({ token: identity_token, tosAccepted: true }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error_description || 'Sign-in failed.');

	try {
		localStorage.setItem(
			'3dagent:auth-hint',
			JSON.stringify({ authed: true, name: data.user?.display_name || '', ts: Date.now() }),
		);
	} catch { /* ignore */ }

	location.href = next;
}

// ── Timeout helper ─────────────────────────────────────────────────────────
// window.ethereum.request()/Solana provider calls have no network-layer
// timeout — a dead or reconnecting extension background port can leave the
// promise permanently unsettled, stranding the button in "Connecting…" with
// the catch block that resets it never firing.
/**
 * Turn an SDK or network failure into something a person can act on.
 *
 * Privy answers a missing or rejected CAPTCHA token with `invalid_credentials`,
 * which reads as "your email or wallet is wrong" and sent people to reset a
 * password that was never the problem. An abort reads as nothing at all.
 *
 * @param {unknown} err
 * @param {string} fallback
 * @returns {string}
 */
function signInMessage(err, fallback) {
	const raw = err?.message || '';
	if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
		return 'The sign-in service did not respond in time. Check your connection and try again.';
	}
	if (/invalid_credentials/i.test(raw)) {
		return 'The sign-in service rejected this attempt. This usually means its human-verification check did not go through, so try again.';
	}
	return raw || fallback;
}

function withTimeout(promise, ms, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Solana wallet detection ───────────────────────────────────────────────────

function getSolanaProvider() {
	// Seeker/Saga TWA: solana-mobile/src/index.js injects a Phantom-shaped
	// wallet backed by Seed Vault with isPhantom=false (it isn't Phantom) —
	// check its own isThreeWs flag first, same order as
	// src/onchain/adapters/solana.js.
	if (window.threeWsWallet?.isThreeWs)    return window.threeWsWallet;
	if (window.solana?.isThreeWs)           return window.solana;
	if (window.phantom?.solana?.isPhantom)  return window.phantom.solana;
	if (window.solana?.isPhantom)           return window.solana;
	if (window.backpack?.solana)            return window.backpack.solana;
	if (window.solflare?.isSolflare)        return window.solflare;
	return null;
}

// ── UI ───────────────────────────────────────────────────────────────────────

function mountPrivyUI(privy, resolveCaptchaConfig) {
	// Email OTP elements
	const stepEmail    = document.getElementById('privy-step-email');
	const stepCode     = document.getElementById('privy-step-code');
	const emailInput   = document.getElementById('privy-email-input');
	const codeInput    = document.getElementById('privy-code-input');
	const sendBtn      = document.getElementById('privy-send-btn');
	const verifyBtn    = document.getElementById('privy-verify-btn');
	const backBtn      = document.getElementById('privy-back-btn');
	const errEl        = document.getElementById('privy-inline-err');

	// Wallet elements
	const walletWrap   = document.getElementById('privy-wallet-wrap');
	const evmBtn       = document.getElementById('privy-evm-btn');
	const solanaBtn    = document.getElementById('privy-solana-btn');
	const walletStatus = document.getElementById('privy-wallet-status');

	if (!stepEmail) return;

	let pendingEmail = '';

	function showErr(msg) {
		if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
	}
	function clearErr() {
		if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
	}

	function showStep(step) {
		clearErr();
		stepEmail.hidden = step !== 'email';
		stepCode.hidden  = step !== 'code';
		if (walletWrap) walletWrap.hidden = step !== 'email';
	}

	function reset() {
		showStep('email');
		if (emailInput) emailInput.value = '';
		if (codeInput) codeInput.value = '';
		resetWalletBtns();
		emailInput?.focus();
	}

	const evmBtnHTML    = evmBtn?.innerHTML    ?? '';
	const solanaBtnHTML = solanaBtn?.innerHTML ?? '';

	function resetWalletBtns() {
		if (evmBtn)    { evmBtn.disabled = false;    evmBtn.innerHTML = evmBtnHTML; }
		if (solanaBtn) { solanaBtn.disabled = false;  solanaBtn.innerHTML = solanaBtnHTML; }
		if (walletStatus) { walletStatus.textContent = ''; walletStatus.hidden = true; }
	}

	function setWalletStatus(msg) {
		if (walletStatus) { walletStatus.textContent = msg; walletStatus.hidden = false; }
	}

	// Initialize — show email step
	showStep('email');

	backBtn?.addEventListener('click', reset);

	// ── Email OTP ──────────────────────────────────────────────────────────────

	sendBtn?.addEventListener('click', async () => {
		const email = emailInput?.value.trim();
		if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			showErr('Enter a valid email address.'); return;
		}
		sendBtn.disabled = true;
		sendBtn.textContent = 'Sending…';
		clearErr();
		try {
			const captcha = await resolveCaptchaConfig();
			const captchaToken = await captchaTokenFor(captcha, () => {
				sendBtn.textContent = 'Verifying…';
			});
			sendBtn.textContent = 'Sending…';
			await privy.auth.email.sendCode(email, captchaToken);
			pendingEmail = email;
			showStep('code');
			codeInput?.focus();
		} catch (e) {
			showErr(signInMessage(e, 'Failed to send code. Try again.'));
			sendBtn.disabled = false;
			sendBtn.textContent = 'Send code';
		}
	});

	emailInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); sendBtn?.click(); }
	});

	verifyBtn?.addEventListener('click', async () => {
		const code = codeInput?.value.trim();
		if (!code || code.length < 4) {
			showErr('Enter the code from your email.'); return;
		}
		verifyBtn.disabled = true;
		verifyBtn.textContent = 'Verifying…';
		clearErr();
		try {
			const { identity_token } = await privy.auth.email.loginWithCode(pendingEmail, code);
			if (!identity_token) throw new Error('No identity token returned.');
			verifyBtn.textContent = 'Signing in…';
			await verifyWithBackend(identity_token);
		} catch (e) {
			showErr(signInMessage(e, 'Verification failed. Check the code and try again.'));
			verifyBtn.disabled = false;
			verifyBtn.textContent = 'Verify';
		}
	});

	codeInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); verifyBtn?.click(); }
	});

	codeInput?.addEventListener('input', () => {
		codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
	});

	// ── EVM Wallet (SIWE via Privy) ────────────────────────────────────────────

	evmBtn?.addEventListener('click', async () => {
		if (!window.ethereum) {
			showErr('No EVM wallet detected. Install MetaMask or another browser wallet.');
			return;
		}
		evmBtn.disabled = true;
		evmBtn.innerHTML = 'Connecting…';
		if (solanaBtn) solanaBtn.disabled = true;
		setWalletStatus('Requesting accounts…');
		clearErr();

		try {
			const accounts = await withTimeout(
				window.ethereum.request({ method: 'eth_requestAccounts' }),
				60_000,
				'Wallet connection timed out. Check your wallet extension and try again.',
			);
			const address  = accounts[0];
			if (!address) throw new Error('No account returned from wallet.');

			const chainIdHex = await withTimeout(
				window.ethereum.request({ method: 'eth_chainId' }),
				10_000,
				'Wallet did not respond. Try again.',
			);
			const chainId    = parseInt(chainIdHex, 16);

			let message;
			const captcha = await resolveCaptchaConfig();
			const captchaToken = await captchaTokenFor(captcha, () => {
				setWalletStatus('Checking you are human…');
			});
			if (captchaToken) {
				setWalletStatus('Generating sign-in message…');
				message = await withTimeout(
					siweInitWithCaptcha(captcha.apiUrl, address, chainId, captchaToken),
					15_000,
					'Could not reach the sign-in service. Try again.',
				);
			} else {
				setWalletStatus('Generating sign-in message…');
				({ message } = await withTimeout(
					privy.auth.siwe.init({ address, chainId }, location.hostname, location.origin),
					15_000,
					'Could not reach the sign-in service. Try again.',
				));
			}

			setWalletStatus('Sign the message in your wallet…');
			const signature = await withTimeout(
				window.ethereum.request({ method: 'personal_sign', params: [message, address] }),
				60_000,
				'Signature timed out. Check your wallet extension and try again.',
			);

			setWalletStatus('Signing in…');
			const { identity_token } = await withTimeout(
				privy.auth.siwe.loginWithSiwe(signature, { address, chainId }, message),
				15_000,
				'Could not reach the sign-in service. Try again.',
			);
			if (!identity_token) throw new Error('No identity token returned.');

			await verifyWithBackend(identity_token);
		} catch (e) {
			const raw = e?.message || '';
			showErr(/reject|denied|cancel|refused/i.test(raw) ? 'Signature cancelled.' : signInMessage(e, 'Wallet sign-in failed.'));
			resetWalletBtns();
		}
	});

	// ── Solana Wallet (SIWS via Privy) ─────────────────────────────────────────

	solanaBtn?.addEventListener('click', async () => {
		const provider = getSolanaProvider();
		if (!provider) {
			showErr('No Solana wallet detected. Install Phantom, Backpack, or Solflare.');
			return;
		}
		solanaBtn.disabled = true;
		solanaBtn.innerHTML = 'Connecting…';
		if (evmBtn) evmBtn.disabled = true;
		setWalletStatus('Connecting wallet…');
		clearErr();

		try {
			const resp    = await withTimeout(
				provider.connect(),
				60_000,
				'Wallet connection timed out. Check your wallet extension and try again.',
			);
			const address = resp.publicKey.toString();

			setWalletStatus('Generating sign-in message…');
			const fetchNonce = async () => {
				const r = await fetch('/api/auth/siws/nonce', {
					credentials: 'include',
					signal: AbortSignal.timeout(10_000),
				});
				if (!r.ok) throw new Error('Could not reach the sign-in service. Try again.');
				return r.json();
			};
			let { nonce, csrf, domain: serverDomain, uri: serverUri } = await fetchNonce();

			const domain          = serverDomain || location.host;
			const uri             = serverUri    || location.origin;
			const statement       = 'Sign in to three.ws. This request will not trigger any blockchain transaction or cost any fees. By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and Privacy Policy (https://three.ws/legal/privacy).';
			const issuedAt        = new Date().toISOString();
			const expirationTime  = new Date(Date.now() + 5 * 60 * 1000).toISOString();

			const postVerify = (message, signature, csrfToken) => fetch('/api/auth/siws/verify', {
				method: 'POST',
				credentials: 'include',
				signal: AbortSignal.timeout(20_000),
				headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
				// tosAccepted: the signed statement carries the agreement; the flag
				// tells the server to stamp acceptance on the user record.
				body: JSON.stringify({ message, signature, tosAccepted: true }),
			});

			let data = null;
			let verified = false;

			// One-tap SIWS (Seeker / Seed Vault): authorization and the sign-in
			// signature happen in a SINGLE wallet interaction. The wallet builds
			// the canonical SIWS message and we forward the exact bytes it signed.
			// Any wallet without supportsSignIn (Phantom/Backpack/Solflare) — or a
			// one-tap failure that isn't a user cancel — falls through to the
			// two-step path below with a fresh nonce.
			if (provider.supportsSignIn && typeof provider.signIn === 'function') {
				setWalletStatus('Approve sign-in in your wallet…');
				try {
					const siws = await withTimeout(
						provider.signIn({ domain, statement, uri, version: '1', chainId: 'mainnet', nonce, issuedAt, expirationTime }),
						60_000,
						'Sign-in timed out. Try again.',
					);
					if (siws?.signedMessageText && siws.signature) {
						const signature = btoa(String.fromCharCode(...siws.signature));
						const res = await postVerify(siws.signedMessageText, signature, csrf);
						data = await res.json().catch(() => ({}));
						if (res.ok) verified = true;
						else ({ nonce, csrf } = await fetchNonce()); // burned — refresh for fallback
					}
				} catch (e) {
					if (/reject|denied|cancel|refused/i.test(e?.message || '') || e?.code === 4001) throw e;
					// Non-cancel failure: refresh the nonce and fall through.
					({ nonce, csrf } = await fetchNonce());
				}
			}

			if (!verified) {
				const message = [
					`${domain} wants you to sign in with your Solana account:`,
					address,
					'',
					statement,
					'',
					`URI: ${uri}`,
					'Version: 1',
					'Chain ID: mainnet',
					`Nonce: ${nonce}`,
					`Issued At: ${issuedAt}`,
					`Expiration Time: ${expirationTime}`,
				].join('\n');

				setWalletStatus('Sign the message in your wallet…');
				const { signature: sigBytes } = await withTimeout(
					provider.signMessage(new TextEncoder().encode(message), 'utf8'),
					60_000,
					'Signature timed out. Check your wallet extension and try again.',
				);
				const signature = btoa(String.fromCharCode(...sigBytes));

				setWalletStatus('Signing in…');
				const verifyRes = await postVerify(message, signature, csrf);
				data = await verifyRes.json().catch(() => ({}));
				if (!verifyRes.ok) throw new Error(data.error_description || 'Sign-in failed.');
			}

			try {
				localStorage.setItem(
					'3dagent:auth-hint',
					JSON.stringify({ authed: true, name: data.user?.display_name || '', ts: Date.now() }),
				);
			} catch { /* ignore */ }

			location.href = next;
		} catch (e) {
			const raw = e?.message || '';
			showErr(/reject|denied|cancel|refused/i.test(raw) ? 'Signature cancelled.' : signInMessage(e, 'Wallet sign-in failed.'));
			resetWalletBtns();
		}
	});
}
