// Seeker / Saga boot: on Solana Mobile devices the page runs inside our TWA
// and window.solana is NOT injected by Phantom. The import below detects the
// TWA at runtime and, when present, installs an MWA-backed wallet at
// window.solana that signs through the on-device Seed Vault. On every other
// platform the import is a no-op (it checks display-mode + UA + referrer).
import '../solana-mobile/src/index.js';
import { isSolanaMobileTwa, isSolanaMobileDevice } from '../solana-mobile/src/seeker-detect.js';
import { isUserRejection } from '../solana-mobile/src/mwa-errors.js';
import { log } from './shared/log.js';
import { showToast } from './ui-helpers.js';
import { resolveError } from './shared/error-messages.js';

let connectedWalletAddress = null;
let listenersBound = false;
let connecting = false;

function getPhantom() {
	const provider = typeof window !== 'undefined' ? window.solana : null;
	if (!provider) return null;
	// Phantom on web, or our MWA wallet on Seeker — both expose .connect /
	// .signMessage with the same shape, so the rest of this file works
	// unchanged.
	if (provider.isPhantom || provider.isThreeWs) return provider;
	return null;
}

// On a Seeker, the wallet IS the on-device Seed Vault — name it that so the
// affordance reads native instead of a generic "Connect Wallet". Detection is
// wrapped because it touches navigator/matchMedia which can be absent in odd
// embeddings.
function onSeeker() {
	try { return isSolanaMobileTwa() || isSolanaMobileDevice(); } catch { return false; }
}
function defaultLabel() { return onSeeker() ? 'Sign in with Seed Vault' : 'Connect Wallet'; }
function defaultHint() { return onSeeker() ? 'Sign in with your Seed Vault' : 'Connect your Solana wallet'; }

function bindPhantomListeners(provider) {
	if (listenersBound || !provider) return;
	listenersBound = true;
	provider.on('connect', (publicKey) => {
		connectedWalletAddress = publicKey?.toString?.() || null;
		updateWalletState(connectedWalletAddress);
	});
	provider.on('disconnect', () => {
		connectedWalletAddress = null;
		updateWalletState(null);
	});
}

// Visually mark the button busy during an async connect: a disabled button
// reading "Connecting…" is unambiguous feedback and blocks double-clicks. On
// settle we hand the label back to updateWalletState so it reflects the real
// outcome (short address on success, default prompt on failure).
function setConnecting(btn, on) {
	if (!btn) return;
	btn.classList.toggle('is-connecting', on);
	if (on) {
		btn.setAttribute('aria-busy', 'true');
		btn.disabled = true;
		const label = btn.querySelector('[data-wallet-label]') || btn;
		label.textContent = 'Connecting…';
	} else {
		btn.removeAttribute('aria-busy');
		btn.disabled = false;
		// Reconcile only the label — the connect/disconnect side of state (class,
		// dataset, a11y, and the wallet:changed broadcast) is owned by
		// updateWalletState and already fired on the actual outcome. Re-running it
		// here would double-broadcast on success.
		const label = btn.querySelector('[data-wallet-label]') || btn;
		label.textContent = connectedWalletAddress
			? `${connectedWalletAddress.slice(0, 4)}...${connectedWalletAddress.slice(-4)}`
			: defaultLabel();
	}
}

async function onConnectWallet() {
	if (connecting) return;
	const btn = document.getElementById('connect-wallet-btn');
	const provider = getPhantom();

	if (!provider) {
		// No injected wallet AND not on Seeker. Don't hijack the tab with a
		// surprise popup — offer Phantom as an explicit, dismissible choice.
		showToast('No Solana wallet detected. Get Phantom to connect and start building.', {
			type: 'info',
			duration: 8000,
			action: {
				label: 'Get Phantom',
				onClick: (dismiss) => {
					window.open('https://phantom.app/', '_blank', 'noopener');
					dismiss();
				},
			},
		});
		return;
	}

	bindPhantomListeners(provider);
	connecting = true;
	setConnecting(btn, true);
	try {
		const res = await provider.connect();
		connectedWalletAddress = res?.publicKey?.toString?.() || null;
		updateWalletState(connectedWalletAddress);
		if (connectedWalletAddress) {
			showToast(onSeeker() ? 'Seed Vault connected' : 'Wallet connected', { type: 'success' });
		}
	} catch (err) {
		// A user cancel is a choice, not an error — don't nag. Everything else
		// gets a clear message with a one-tap retry.
		if (!isUserRejection(err)) {
			const message = err?.userMessage || resolveError(err, 'wallet-connect').body;
			showToast(message, {
				type: 'error',
				action: { label: 'Try again', onClick: (dismiss) => { dismiss(); onConnectWallet(); } },
			});
		}
		log.error('Wallet connection failed:', err);
	} finally {
		connecting = false;
		setConnecting(btn, false);
	}
}

export function updateWalletState(address) {
	const btn = document.getElementById('connect-wallet-btn');
	if (btn) {
		const short = address ? `${address.slice(0, 4)}...${address.slice(-4)}` : defaultLabel();
		// Buttons that wrap their text in a [data-wallet-label] span keep their
		// icon/markup intact across state changes; plain-text buttons (e.g. the
		// pump dashboard) fall back to replacing textContent.
		const label = btn.querySelector('[data-wallet-label]');
		if (label) label.textContent = short;
		else btn.textContent = short;
		btn.classList.toggle('is-connected', Boolean(address));
		if (address) {
			btn.title = `Connected: ${address}`;
			btn.setAttribute('aria-label', `Solana wallet connected: ${address}`);
			btn.dataset.address = address;
		} else {
			btn.title = defaultHint();
			btn.setAttribute('aria-label', defaultHint());
			delete btn.dataset.address;
		}
	}
	// Broadcast so consumers (dashboards, balance panels) can react to connect /
	// disconnect without reaching into window.solana directly. Fires for both the
	// click-connect and auto-connect-if-trusted paths.
	if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
		window.dispatchEvent(new CustomEvent('wallet:changed', { detail: { address: address || null } }));
	}
}

export function initWalletButton() {
	const btn = document.getElementById('connect-wallet-btn');
	if (btn) btn.addEventListener('click', onConnectWallet);

	const provider = getPhantom();
	if (!provider) {
		// Paint the Seeker-native label even before any wallet event fires, so a
		// Seeker user sees "Sign in with Seed Vault" from first render.
		if (btn && onSeeker()) updateWalletState(null);
		return;
	}
	bindPhantomListeners(provider);
	provider.connect({ onlyIfTrusted: true })
		.then((res) => {
			connectedWalletAddress = res?.publicKey?.toString?.() || null;
			updateWalletState(connectedWalletAddress);
		})
		.catch(() => {});
}

export function getConnectedWallet() {
	const provider = getPhantom();
	return provider && provider.isConnected ? provider : null;
}

export function getConnectedWalletAddress() {
	return connectedWalletAddress;
}

export function connectWallet() {
	return onConnectWallet();
}
