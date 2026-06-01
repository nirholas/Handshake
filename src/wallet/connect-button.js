/**
 * Unified wallet connect controller + button factory.
 *
 * Usage (Vite-bundled apps):
 *   import { createConnectWalletButton } from './wallet/connect-button.js';
 *   const ctrl = createConnectWalletButton(mountEl, { onSuccess: (data) => ... });
 */

import { BrowserProvider } from 'ethers';
import { STATES, initialState, reduce } from './state.js';
import { eagerConnectWallet, getWalletState } from '../erc8004/agent-registry.js';

/** Chain IDs that match known ERC-8004 registry deployments. */
const DEFAULT_CHAIN_IDS = [1, 8453, 10, 42161, 11155111, 84532];

const CHAIN_NAMES = {
	1: 'Mainnet',
	8453: 'Base',
	10: 'Optimism',
	42161: 'Arbitrum One',
	11155111: 'Sepolia',
	84532: 'Base Sepolia',
};

const ASYNC_STATES = new Set([
	STATES.DETECTING,
	STATES.REQUESTING_ACCOUNTS,
	STATES.SIGNING,
	STATES.VERIFYING,
]);

/**
 * Build the EIP-4361 SIWE message string.
 * Format must match the parser in api/auth/siwe/verify.js exactly.
 *
 * @param {string} address  checksummed Ethereum address
 * @param {number} chainId
 * @param {string} nonce
 * @param {{ domain: string, uri: string, issuedAt: string, expirationTime: string }} ctx
 * @returns {string}
 */
function defaultMessageBuilder(address, chainId, nonce, { domain, uri, issuedAt, expirationTime }) {
	return [
		`${domain} wants you to sign in with your Ethereum account:`,
		address,
		'',
		'Sign in to three.ws. This does not cost anything and proves wallet ownership.',
		'',
		`URI: ${uri}`,
		'Version: 1',
		`Chain ID: ${chainId}`,
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt}`,
		`Expiration Time: ${expirationTime}`,
	].join('\n');
}

/**
 * Headless state machine for wallet connect / SIWE.
 * Emits `change` CustomEvents on state transitions.
 *
 * @fires ConnectWalletController#change
 */
export class ConnectWalletController extends EventTarget {
	/** @type {import('./state.js').ConnectState} */
	#s;
	#opts;
	#onAccountsChanged;
	#onChainChanged;

	/**
	 * @param {{
	 *   allowedChainIds?: number[],
	 *   nonceUrl?: string,
	 *   verifyUrl?: string,
	 *   messageBuilder?: Function,
	 *   onSuccess?: Function,
	 *   autoDetect?: boolean,
	 *   labels?: Record<string, string>,
	 * }} [opts]
	 */
	constructor(opts = {}) {
		super();
		this.#opts = {
			allowedChainIds: DEFAULT_CHAIN_IDS,
			nonceUrl: '/api/auth/siwe/nonce',
			verifyUrl: '/api/auth/siwe/verify',
			messageBuilder: defaultMessageBuilder,
			onSuccess: null,
			autoDetect: false,
			labels: {},
			...opts,
		};
		this.#s = initialState();

		this.#onAccountsChanged = (accounts) =>
			this.#dispatch({ type: 'ACCOUNTS_CHANGED', accounts });
		this.#onChainChanged = (chainIdHex) => {
			const chainId = parseInt(chainIdHex, 16);
			this.#dispatch({ type: 'CHAIN_CHANGED', chainId });
			if (!this.#opts.allowedChainIds.includes(chainId)) {
				this.#dispatch({ type: 'WRONG_CHAIN' });
			} else if (this.#s.status === STATES.WRONG_CHAIN) {
				this.#dispatch({ type: 'CHAIN_OK' });
			}
		};

		if (window.ethereum) {
			window.ethereum.on('accountsChanged', this.#onAccountsChanged);
			window.ethereum.on('chainChanged', this.#onChainChanged);
		}

		// Hydrate from any already-resolved silent reconnect (fired during app
		// boot). If the shared registry has a connected address, jump straight
		// to CONNECTED so the button renders the address instead of "Connect
		// wallet" on first paint. If not yet resolved, attempt the silent path
		// here too (idempotent — no popup).
		this.#tryEagerHydrate();
	}

	async #tryEagerHydrate() {
		const existing = getWalletState();
		if (existing.address && existing.chainId) {
			this.#dispatch({
				type: 'ACCOUNTS_RESOLVED',
				address: existing.address,
				chainId: existing.chainId,
			});
			if (!this.#opts.allowedChainIds.includes(existing.chainId)) {
				this.#dispatch({ type: 'WRONG_CHAIN' });
			}
			return;
		}
		const eager = await eagerConnectWallet();
		if (!eager) return;
		this.#dispatch({
			type: 'ACCOUNTS_RESOLVED',
			address: eager.address,
			chainId: eager.chainId,
		});
		if (!this.#opts.allowedChainIds.includes(eager.chainId)) {
			this.#dispatch({ type: 'WRONG_CHAIN' });
		}
	}

	get state() {
		return this.#s.status;
	}
	get address() {
		return this.#s.address;
	}
	get chainId() {
		return this.#s.chainId;
	}
	get error() {
		return this.#s.error;
	}

	/** @param {{ type: string, [k: string]: any }} action */
	#dispatch(action) {
		const next = reduce(this.#s, action);
		if (next === this.#s) return;
		this.#s = next;
		this.dispatchEvent(new CustomEvent('change', { detail: { ...next } }));
	}

	/** Initiate the connect flow from `idle`. Idempotent if already past idle. */
	async connect() {
		if (this.#s.status !== STATES.IDLE) return;
		this.#dispatch({ type: 'CONNECT' });

		if (!window.ethereum) {
			this.#dispatch({ type: 'NO_PROVIDER' });
			return;
		}
		this.#dispatch({ type: 'HAS_PROVIDER' });

		try {
			const provider = new BrowserProvider(window.ethereum);
			await provider.send('eth_requestAccounts', []);
			const signer = await provider.getSigner();
			const address = await signer.getAddress();
			const network = await provider.getNetwork();
			const chainId = Number(network.chainId);
			this.#dispatch({ type: 'ACCOUNTS_RESOLVED', address, chainId });

			if (!this.#opts.allowedChainIds.includes(chainId)) {
				this.#dispatch({ type: 'WRONG_CHAIN' });
				await this.#trySwitchChain(provider);
			}
		} catch (e) {
			this.#dispatch({ type: 'ERROR', error: e instanceof Error ? e : new Error(String(e)) });
		}
	}

	/** Attempt to switch to the first allowed chain via wallet_switchEthereumChain. */
	async #trySwitchChain(provider) {
		const target = this.#opts.allowedChainIds[0];
		const hex = '0x' + target.toString(16);
		try {
			await provider.send('wallet_switchEthereumChain', [{ chainId: hex }]);
			// chainChanged event fires and handles the CHAIN_OK dispatch.
		} catch (e) {
			if (e?.code === 4902) {
				this.#dispatch({
					type: 'ERROR',
					error: new Error(
						`Chain ${CHAIN_NAMES[target] || target} is not in your wallet. Add it manually.`,
					),
				});
			} else if (e?.code !== 4001) {
				// 4001 = user rejected — surface as error; other codes are bugs
				this.#dispatch({
					type: 'ERROR',
					error: e instanceof Error ? e : new Error(String(e)),
				});
			}
		}
	}

	/** Sign a SIWE message and verify with the backend. Call from `connected` state. */
	async signAndVerify() {
		if (this.#s.status !== STATES.CONNECTED && this.#s.status !== STATES.WRONG_CHAIN) return;
		this.#dispatch({ type: 'SIGN' });

		try {
			const provider = new BrowserProvider(window.ethereum);
			const signer = await provider.getSigner();
			const address = await signer.getAddress();

			const nonceRes = await fetch(this.#opts.nonceUrl, { credentials: 'include' });
			if (!nonceRes.ok) throw new Error('Failed to get nonce');
			const { nonce, csrf, domain: serverDomain, uri: serverUri } = await nonceRes.json();

			// Prefer server-issued domain/uri so dev frontends proxying /api/*
			// to a different origin still produce messages that match the
			// upstream's domain check.
			const domain = serverDomain || location.host;
			const uri = serverUri || location.origin;
			const issuedAt = new Date().toISOString();
			const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();

			const message = this.#opts.messageBuilder(address, this.#s.chainId, nonce, {
				domain,
				uri,
				issuedAt,
				expirationTime,
			});

			const signature = await signer.signMessage(message);
			this.#dispatch({ type: 'SIGNATURE_OBTAINED' });

			const verifyRes = await fetch(this.#opts.verifyUrl, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
				body: JSON.stringify({ message, signature }),
			});
			const data = await verifyRes.json();
			if (!verifyRes.ok) throw new Error(data.error_description || 'Verification failed');

			this.#dispatch({ type: 'SUCCESS' });
			if (this.#opts.onSuccess) this.#opts.onSuccess(data);
		} catch (e) {
			this.#dispatch({ type: 'ERROR', error: e instanceof Error ? e : new Error(String(e)) });
		}
	}

	/** Return to `idle` state, clearing any error. */
	reset() {
		this.#dispatch({ type: 'RESET' });
	}

	/** Remove all event listeners. Call when unmounting in SPA contexts. */
	dispose() {
		if (window.ethereum) {
			window.ethereum.removeListener('accountsChanged', this.#onAccountsChanged);
			window.ethereum.removeListener('chainChanged', this.#onChainChanged);
		}
	}
}

const LABEL_DEFAULTS = {
	idle: 'Connect wallet',
	detecting: 'Detecting…',
	no_provider: 'Install MetaMask',
	requesting_accounts: 'Check your wallet…',
	signing: 'Sign in your wallet…',
	verifying: 'Verifying…',
	success: 'Signed in',
	error: 'Retry',
};

/**
 * Mount a wallet connect button into `mountEl`.
 * The element's contents are replaced with a single `<button class="cwb-btn">`.
 *
 * @param {HTMLElement} mountEl
 * @param {{
 *   allowedChainIds?: number[],
 *   nonceUrl?: string,
 *   verifyUrl?: string,
 *   messageBuilder?: Function,
 *   onSuccess?: Function,
 *   labels?: Record<string, string>,
 * }} [opts]
 * @returns {ConnectWalletController}
 */
export function createConnectWalletButton(mountEl, opts = {}) {
	// Dispose any previous controller on this mount point (handles HMR remounts).
	mountEl._cwbCtrl?.dispose();

	const labels = { ...LABEL_DEFAULTS, ...(opts.labels || {}) };
	const allowedChainIds = opts.allowedChainIds || DEFAULT_CHAIN_IDS;
	const ctrl = new ConnectWalletController({ ...opts, allowedChainIds });
	mountEl._cwbCtrl = ctrl;

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'cwb-btn';

	function render(detail) {
		const s = detail.status;
		btn.setAttribute('data-state', s);
		btn.disabled = ASYNC_STATES.has(s) || s === STATES.SUCCESS;
		btn.setAttribute('aria-busy', ASYNC_STATES.has(s) ? 'true' : 'false');

		if (s === STATES.CONNECTED || s === STATES.WRONG_CHAIN) {
			const addr = detail.address || '';
			const short = addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
			const chainName = CHAIN_NAMES[detail.chainId] || `Chain ${detail.chainId}`;
			btn.textContent =
				s === STATES.WRONG_CHAIN
					? `Switch to ${CHAIN_NAMES[allowedChainIds[0]] || 'Mainnet'}`
					: `${short} · ${chainName}`;
		} else if (s === STATES.ERROR) {
			btn.textContent = labels.error;
		} else {
			btn.textContent = labels[s] || s;
		}
	}

	function updateClickHandler(status) {
		btn.onclick = null;
		if (status === STATES.NO_PROVIDER) {
			btn.onclick = () => window.open('https://metamask.io', '_blank', 'noopener');
		} else if (status === STATES.CONNECTED) {
			btn.onclick = () => ctrl.signAndVerify();
		} else if (status === STATES.WRONG_CHAIN) {
			btn.onclick = () => ctrl.connect();
		} else if (status === STATES.ERROR) {
			btn.onclick = () => {
				ctrl.reset();
				ctrl.connect();
			};
		} else if (status === STATES.IDLE) {
			btn.onclick = () => ctrl.connect();
		}
	}

	ctrl.addEventListener('change', (e) => {
		render(e.detail);
		updateClickHandler(e.detail.status);
	});

	// Initial render from current state.
	render({ status: ctrl.state, address: ctrl.address, chainId: ctrl.chainId, error: ctrl.error });
	updateClickHandler(ctrl.state);

	mountEl.innerHTML = '';
	mountEl.appendChild(btn);

	return ctrl;
}
