// Seeker / Saga boot: on Solana Mobile devices the page runs inside our TWA
// and window.solana is NOT injected by Phantom. The import below detects the
// TWA at runtime and, when present, installs an MWA-backed wallet at
// window.solana that signs through the on-device Seed Vault. On every other
// platform the import is a no-op (it checks display-mode + UA + referrer).
import '../solana-mobile/src/index.js';

let connectedWalletAddress = null;
let listenersBound = false;

function getPhantom() {
	const provider = typeof window !== 'undefined' ? window.solana : null;
	if (!provider) return null;
	// Phantom on web, or our MWA wallet on Seeker — both expose .connect /
	// .signMessage with the same shape, so the rest of this file works
	// unchanged.
	if (provider.isPhantom || provider.isThreeWs) return provider;
	return null;
}

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

async function onConnectWallet() {
	const provider = getPhantom();
	if (!provider) {
		// No injected wallet AND not running inside the Seeker TWA — point
		// the user at Phantom, which is the most common web fallback.
		window.open('https://phantom.app/', '_blank', 'noopener');
		return;
	}
	bindPhantomListeners(provider);
	try {
		const res = await provider.connect();
		connectedWalletAddress = res?.publicKey?.toString?.() || null;
		updateWalletState(connectedWalletAddress);
	} catch (err) {
		console.error('Wallet connection failed:', err);
	}
}

export function updateWalletState(address) {
	const btn = document.getElementById('connect-wallet-btn');
	if (btn) {
		btn.textContent = address ? `${address.slice(0, 4)}...${address.slice(-4)}` : 'Connect Wallet';
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
	if (!provider) return;
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
