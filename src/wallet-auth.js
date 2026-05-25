import { ensureWallet } from './erc8004/agent-registry.js';
import { identifyUser, resetIdentity } from './analytics.js';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Sign in with Ethereum (EIP-4361). If a valid session cookie already exists,
 * skip the wallet prompt entirely and return the current user — keeps the user
 * authenticated across the whole site without re-signing.
 *
 * @returns {Promise<{user: object, wallet?: object}>}
 */
export async function signInWithWallet() {
	// Short-circuit: if the session cookie is still valid, no need to prompt
	// the wallet or re-sign anything.
	const existing = await getCurrentUser();
	if (existing) return { user: existing };

	const { signer, address, chainId } = await ensureWallet();

	// GET nonce — sets __Host-csrf-siwe cookie, returns csrf token
	const nonceRes = await fetch('/api/auth/siwe/nonce', {
		credentials: 'include',
	});
	if (!nonceRes.ok) {
		const body = await nonceRes.json().catch(() => ({}));
		throw new Error(body.error_description || 'Failed to fetch nonce');
	}
	const { nonce, csrf } = await nonceRes.json();

	const message = [
		`${location.host} wants you to sign in with your Ethereum account:`,
		address,
		'',
		'Sign in to three.ws.',
		'',
		`URI: ${location.origin}`,
		'Version: 1',
		`Chain ID: ${chainId}`,
		`Nonce: ${nonce}`,
		`Issued At: ${new Date().toISOString()}`,
	].join('\n');

	const signature = await signer.signMessage(message);

	const verifyRes = await fetch('/api/auth/siwe/verify', {
		method: 'POST',
		credentials: 'include',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrf,
		},
		body: JSON.stringify({ message, signature }),
	});

	const data = await verifyRes.json().catch(() => ({}));
	if (!verifyRes.ok) {
		throw new Error(data.error_description || data.error || 'Sign-in failed');
	}
	return data;
}

/** @returns {Promise<void>} */
export async function signOut() {
	await fetch('/api/auth/logout', {
		method: 'POST',
		credentials: 'include',
	}).catch(() => {});
	resetIdentity();
}

/** @returns {Promise<object|null>} */
export async function getCurrentUser() {
	try {
		const res = await fetch('/api/auth/me', { credentials: 'include' });
		if (!res.ok) return null;
		const { user } = await res.json();
		if (user) identifyUser(user);
		return user ?? null;
	} catch {
		return null;
	}
}

/**
 * Attaches click handler + swaps UI for signed-in chip.
 * @param {HTMLElement} buttonEl
 */
export function wireSigninButton(buttonEl) {
	getCurrentUser().then((user) => {
		if (user) {
			_renderChip(buttonEl, user);
		} else {
			_wireClickHandler(buttonEl);
		}
	});
}

// ─── Internal ────────────────────────────────────────────────────────────────

function _shortAddr(addr) {
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function _renderChip(buttonEl, user) {
	const addr = user.wallet_address || '';
	const label = addr ? _shortAddr(addr) : user.display_name || 'Account';

	const chip = document.createElement('span');
	chip.id = 'wallet-chip';
	chip.style.cssText =
		'display:inline-flex;align-items:center;gap:0.5em;font-size:0.85em;cursor:default;';

	const addrSpan = document.createElement('span');
	addrSpan.textContent = label;
	addrSpan.title = addr;

	const divider = document.createElement('span');
	divider.textContent = '·';
	divider.style.opacity = '0.4';

	const signOutBtn = document.createElement('button');
	signOutBtn.textContent = 'sign out';
	signOutBtn.style.cssText =
		'background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;font-size:inherit;color:inherit;';
	signOutBtn.addEventListener('click', async () => {
		signOutBtn.disabled = true;
		signOutBtn.textContent = 'signing out…';
		await signOut();
		location.reload();
	});

	chip.append(addrSpan, divider, signOutBtn);
	buttonEl.replaceWith(chip);
}

function _wireClickHandler(buttonEl) {
	const statusEl = document.createElement('span');
	statusEl.style.cssText = 'display:none;font-size:0.8em;margin-left:0.75em;opacity:0.7;';
	buttonEl.insertAdjacentElement('afterend', statusEl);

	let _busy = false;

	buttonEl.addEventListener('click', async () => {
		if (_busy) return;

		if (!window.ethereum) {
			statusEl.style.display = 'inline';
			statusEl.textContent =
				'No wallet detected — install MetaMask or use a wallet-enabled browser.';
			return;
		}

		_busy = true;
		buttonEl.disabled = true;
		statusEl.style.display = 'inline';
		statusEl.textContent = 'Waiting for wallet…';

		try {
			await signInWithWallet();
			statusEl.textContent = 'Signed in — reloading…';
			location.reload();
		} catch (err) {
			statusEl.textContent = err.message || 'Sign-in failed.';
			buttonEl.disabled = false;
			_busy = false;
		}
	});
}
