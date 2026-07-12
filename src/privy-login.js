// Privy headless auth for login and register pages.
// Handles email-OTP and EVM wallet (SIWE via Privy).
// Solana wallet uses our own SIWS backend (/api/auth/siws/*) directly.

import Privy, { LocalStorage } from '@privy-io/js-sdk-core';

const next =
	window.__loginNext ||
	new URLSearchParams(location.search).get('next') ||
	sessionStorage.getItem('login_redirect') ||
	'/dashboard';
sessionStorage.removeItem('login_redirect');

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function getAppId() {
	try {
		const r = await fetch('/api/config');
		const cfg = await r.json();
		return cfg.privyAppId || null;
	} catch {
		return null;
	}
}

const appId = await getAppId();

const section = document.getElementById('privy-section');
const divider = document.getElementById('privy-or-divider');

if (!appId) {
	if (section) section.style.display = 'none';
	if (divider) divider.style.display = 'none';
} else {
	const privy = new Privy({ appId, storage: new LocalStorage() });
	mountPrivyUI(privy, fetchCaptchaConfig(appId));
}

// ── CAPTCHA (Cloudflare Turnstile) ───────────────────────────────────────────
// Privy rejects passwordless/init with 401 invalid_credentials when the app has
// CAPTCHA enabled and no token is sent, so this must resolve before sendCode.

async function fetchCaptchaConfig(id) {
	try {
		const r = await fetch(`https://auth.privy.io/api/v1/apps/${id}`, {
			headers: { 'privy-app-id': id },
		});
		if (!r.ok) return null;
		const cfg = await r.json();
		if (!cfg?.captcha_enabled || !cfg.captcha_site_key) return null;
		if (cfg.enabled_captcha_provider && cfg.enabled_captcha_provider !== 'turnstile') return null;
		// Privy prefixes Turnstile site keys with "t:".
		return { siteKey: cfg.captcha_site_key.replace(/^t:/, '') };
	} catch {
		return null;
	}
}

let turnstilePromise = null;

function loadTurnstile() {
	if (turnstilePromise) return turnstilePromise;
	turnstilePromise = new Promise((resolve, reject) => {
		if (window.turnstile) { resolve(window.turnstile); return; }
		window.__privyTurnstileOnload = () => resolve(window.turnstile);
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/api.js?onload=__privyTurnstileOnload&render=explicit';
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

// ── Shared backend verify ─────────────────────────────────────────────────────

async function verifyWithBackend(identity_token) {
	const res = await fetch('/api/auth/privy/verify', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ token: identity_token }),
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

function mountPrivyUI(privy, captchaConfigPromise) {
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
			let captchaToken;
			const captcha = await captchaConfigPromise;
			if (captcha) {
				sendBtn.textContent = 'Verifying…';
				captchaToken = await requestCaptchaToken(captcha.siteKey);
				sendBtn.textContent = 'Sending…';
			}
			await privy.auth.email.sendCode(email, captchaToken);
			pendingEmail = email;
			showStep('code');
			codeInput?.focus();
		} catch (e) {
			showErr(e?.message || 'Failed to send code. Try again.');
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
			showErr(e?.message || 'Verification failed. Check the code and try again.');
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

			setWalletStatus('Generating sign-in message…');
			const { message } = await withTimeout(
				privy.auth.siwe.init({ address, chainId }, location.hostname, location.origin),
				15_000,
				'Could not reach the sign-in service. Try again.',
			);

			setWalletStatus('Sign the message in your wallet…');
			const signature = await withTimeout(
				window.ethereum.request({ method: 'personal_sign', params: [message, address] }),
				60_000,
				'Signature timed out. Check your wallet extension and try again.',
			);

			setWalletStatus('Signing in…');
			const { identity_token } = await withTimeout(
				privy.auth.siwe.loginWithSiwe(signature),
				15_000,
				'Could not reach the sign-in service. Try again.',
			);
			if (!identity_token) throw new Error('No identity token returned.');

			await verifyWithBackend(identity_token);
		} catch (e) {
			const raw = e?.message || '';
			showErr(/reject|denied|cancel|refused/i.test(raw) ? 'Signature cancelled.' : raw || 'Wallet sign-in failed.');
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
			const nonceRes = await fetch('/api/auth/siws/nonce', { credentials: 'include' });
			if (!nonceRes.ok) throw new Error('Failed to get nonce');
			const { nonce, csrf, domain: serverDomain, uri: serverUri } = await nonceRes.json();

			const domain          = serverDomain || location.host;
			const uri             = serverUri    || location.origin;
			const issuedAt        = new Date().toISOString();
			const expirationTime  = new Date(Date.now() + 5 * 60 * 1000).toISOString();
			const message = [
				`${domain} wants you to sign in with your Solana account:`,
				address,
				'',
				'Sign in to three.ws. This request will not trigger any blockchain transaction or cost any fees.',
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
			const verifyRes = await fetch('/api/auth/siws/verify', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
				body: JSON.stringify({ message, signature }),
			});
			const data = await verifyRes.json().catch(() => ({}));
			if (!verifyRes.ok) throw new Error(data.error_description || 'Sign-in failed.');

			try {
				localStorage.setItem(
					'3dagent:auth-hint',
					JSON.stringify({ authed: true, name: data.user?.display_name || '', ts: Date.now() }),
				);
			} catch { /* ignore */ }

			location.href = next;
		} catch (e) {
			const raw = e?.message || '';
			showErr(/reject|denied|cancel|refused/i.test(raw) ? 'Signature cancelled.' : raw || 'Wallet sign-in failed.');
			resetWalletBtns();
		}
	});
}
