// Boot module for the Seeker / Solana Mobile build of three.ws.
//
// Importing this file is a no-op on desktop and on Android browsers that
// aren't running inside the three.ws TWA. Inside the TWA, it constructs an
// MwaWallet, attaches it to window.threeWsWallet (and proxies the Phantom-
// shaped API on window.solana when the user has authorized us), and emits
// a `threews:mwa-ready` CustomEvent so the rest of the app knows it can
// call standard signing methods.
//
// Usage from app entry points (e.g. src/app.js):
//
//   import './solana-mobile/src/index.js';
//
// Or, for explicit control:
//
//   import { initSolanaMobile } from './solana-mobile/src/index.js';
//   const wallet = await initSolanaMobile();
//   if (wallet) { ... } else { ... use Phantom path ... }

import { MwaWallet } from './mwa-wallet.js';
import { isSolanaMobileTwa, isSolanaMobileDevice, isMwaSupported } from './seeker-detect.js';
import { normalizeMwaError, isUserRejection, MwaError } from './mwa-errors.js';

let bootPromise = null;

export async function initSolanaMobile({ chain = 'mainnet-beta', autoConnect = true } = {}) {
	if (typeof window === 'undefined') return null;
	if (!isSolanaMobileTwa()) return null;
	if (bootPromise) return bootPromise;

	bootPromise = (async () => {
		const wallet = new MwaWallet({ chain });
		window.threeWsWallet = wallet;
		// Mirror onto window.solana so legacy code paths that read
		// window.solana.publicKey continue to work. We do NOT set
		// isPhantom — code that gates on isPhantom will skip us, which is
		// the safer default.
		try {
			Object.defineProperty(window, 'solana', {
				value: wallet,
				configurable: true,
				writable: true,
			});
		} catch {
			window.solana = wallet;
		}
		if (autoConnect) {
			try {
				await wallet.connect({ onlyIfTrusted: true });
			} catch {
				/* User has not pre-authorized us — that's fine, they'll be
				   prompted on first sign. */
			}
		}
		window.dispatchEvent(new CustomEvent('threews:mwa-ready', { detail: { wallet } }));
		return wallet;
	})();

	return bootPromise;
}

// Self-execute on import — covers the common case where the integrator
// just adds `import './solana-mobile/src/index.js'` to the app entry.
// Wrapped in a microtask so the import chain finishes before we touch
// window.solana.
queueMicrotask(() => {
	initSolanaMobile().catch((err) => {
		console.error('[threews/mwa] init failed', err);
	});
});

export {
	MwaWallet,
	isSolanaMobileTwa,
	isSolanaMobileDevice,
	isMwaSupported,
	normalizeMwaError,
	isUserRejection,
	MwaError,
};
