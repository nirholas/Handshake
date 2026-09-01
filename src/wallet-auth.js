import {
	identifyUser,
	resetIdentity,
	trackFunnelStep,
	shortWallet,
	ANALYTICS_EVENTS,
} from './analytics.js';
import { resolveError } from './shared/error-messages.js';

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

	// Activation funnel: a real connect prompt is about to fire (the session
	// short-circuit above means this only counts genuine connect attempts).
	trackFunnelStep('activation', ANALYTICS_EVENTS.WALLET_CONNECT_STARTED, { provider: 'eip4361' });

	let chainId;
	let address;
	try {
		// agent-registry carries ethers (140 KB gzipped). Only a real sign-in
		// click needs it, so it loads here rather than with the page: /create
		// imports this module for its sign-in button and was shipping the whole
		// EVM stack to every visitor who never pressed it.
		const { ensureWallet } = await import('./erc8004/agent-registry.js');
		const wallet = await ensureWallet();
		address = wallet.address;
		chainId = wallet.chainId;
		const { signer } = wallet;

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
			'Sign in to three.ws. By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and Privacy Policy (https://three.ws/legal/privacy).',
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
			// tosAccepted: the signed statement above carries the agreement, so the
			// signature itself is the acceptance evidence; the flag tells the server
			// to stamp it on the user record.
			body: JSON.stringify({ message, signature, tosAccepted: true }),
		});

		const data = await verifyRes.json().catch(() => ({}));
		if (!verifyRes.ok) {
			throw new Error(data.error_description || data.error || 'Sign-in failed');
		}
		trackFunnelStep('activation', ANALYTICS_EVENTS.WALLET_CONNECT_SUCCEEDED, {
			provider: 'eip4361',
			wallet_short: shortWallet(address),
			chain: chainId,
		});
		return data;
	} catch (err) {
		trackFunnelStep('activation', ANALYTICS_EVENTS.WALLET_CONNECT_FAILED, {
			provider: 'eip4361',
			reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
			...(chainId != null ? { chain: chainId } : {}),
		});
		throw err;
	}
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
			// No wallet extension — route to the email sign-in path instead of dead-ending.
			try { sessionStorage.setItem('login_redirect', location.href); } catch { /* ignore */ }
			location.href = '/login?from=no-wallet';
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
			const entry = resolveError(err, 'wallet-auth sign-in');
			_renderInlineError(statusEl, entry, {
				retry: () => {
					buttonEl.disabled = false;
					_busy = false;
					statusEl.style.display = 'none';
					buttonEl.click();
				},
			});
			buttonEl.disabled = false;
			_busy = false;
		}
	});
}

/**
 * Render a compact inline error with action links/buttons into a status span.
 *
 * @param {HTMLElement} el
 * @param {{ title: string, body: string, actions: Array }} entry
 * @param {Record<string, () => void>} handlers
 */
function _renderInlineError(el, entry, handlers = {}) {
	el.innerHTML = '';
	el.setAttribute('role', 'alert');

	const text = document.createTextNode(`${entry.title} — ${entry.body} `);
	el.appendChild(text);

	for (const action of (entry.actions || [])) {
		if (action.href) {
			const a = document.createElement('a');
			a.href = action.href;
			if (action.href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
			a.textContent = action.label;
			a.style.cssText = 'margin-left:.4em;text-decoration:underline;cursor:pointer;';
			el.appendChild(a);
		} else if (action.onClick) {
			const handler = handlers[action.onClick];
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = action.label;
			btn.style.cssText = 'margin-left:.4em;background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;font-size:inherit;color:inherit;';
			if (handler) btn.addEventListener('click', handler);
			el.appendChild(btn);
		}
	}
}
