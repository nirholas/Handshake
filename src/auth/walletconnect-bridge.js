// WalletConnect v2 → SIWE bridge.
// Lazy-loads @walletconnect/ethereum-provider from CDN so it never ships in
// the main bundle unless the user explicitly triggers WC sign-in.

const WC_CDN = 'https://esm.sh/@walletconnect/ethereum-provider@2.17.0';

let _provider = null;

async function _loadEthereumProvider() {
	const { EthereumProvider } = await import(/* @vite-ignore */ WC_CDN);
	return EthereumProvider;
}

async function _resolveProjectId(override) {
	if (override) return override;

	// Vite injects VITE_* vars at build time.
	if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID) {
		return import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
	}

	// /api/config fallback for deployments that set walletConnectProjectId there.
	try {
		const res = await fetch('/api/config');
		if (res.ok) {
			const cfg = await res.json();
			if (cfg.walletConnectProjectId) return cfg.walletConnectProjectId;
		}
	} catch {
		/* network failure — fall through */
	}

	return null;
}

function _wcError(stage, message) {
	const err = new Error(message);
	err.code = `wc/${stage}`;
	return err;
}

/**
 * Full WalletConnect → SIWE sign-in.
 * @param {{ projectId?: string, chains?: number[] }} [opts]
 * @returns {Promise<{ user: object, address: string }>}
 */
export async function signInWithWalletConnect({ projectId, chains } = {}) {
	const pid = await _resolveProjectId(projectId);
	if (!pid) {
		throw _wcError(
			'no_project_id',
			'WalletConnect projectId is required. Set VITE_WALLETCONNECT_PROJECT_ID.',
		);
	}

	// 1. Load provider.
	let EthereumProvider;
	try {
		EthereumProvider = await _loadEthereumProvider();
	} catch (e) {
		throw _wcError('load_failed', `Failed to load WalletConnect provider: ${e.message}`);
	}

	// 2. Init + open modal.
	try {
		_provider = await EthereumProvider.init({
			projectId: pid,
			chains: chains || [1],
			showQrModal: true,
			methods: ['eth_requestAccounts', 'personal_sign'],
			events: ['chainChanged', 'accountsChanged'],
		});
	} catch (e) {
		throw _wcError('init_failed', `Provider init failed: ${e.message}`);
	}

	try {
		await _provider.enable();
	} catch (e) {
		throw _wcError('connect_rejected', `Connection rejected or failed: ${e.message}`);
	}

	const accounts = _provider.accounts;
	if (!accounts?.length) throw _wcError('no_accounts', 'No accounts returned after connect.');
	const address = accounts[0];

	// 3. Fetch nonce.
	let nonce;
	try {
		const nr = await fetch('/api/auth/siwe/nonce', { credentials: 'include' });
		if (!nr.ok) throw new Error(`HTTP ${nr.status}`);
		({ nonce } = await nr.json());
	} catch (e) {
		throw _wcError('nonce_failed', `Nonce request failed: ${e.message}`);
	}

	// 4. Build EIP-4361 message matching the format expected by /api/auth/siwe/verify.
	const chainId = _provider.chainId || (chains?.[0] ?? 1);
	const domain = location.host;
	const uri = location.origin;
	const issuedAt = new Date().toISOString();

	const message = [
		`${domain} wants you to sign in with your Ethereum account:`,
		address,
		'',
		'Sign in to three.ws. By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and Privacy Policy (https://three.ws/legal/privacy).',
		'',
		`URI: ${uri}`,
		'Version: 1',
		`Chain ID: ${chainId}`,
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt}`,
	].join('\n');

	// 5. Sign.
	let signature;
	try {
		signature = await _provider.request({
			method: 'personal_sign',
			params: [message, address],
		});
	} catch (e) {
		throw _wcError('sign_rejected', `User rejected signing: ${e.message}`);
	}

	// 6. Verify on server — server sets session cookie on success.
	let result;
	try {
		const vr = await fetch('/api/auth/siwe/verify', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			// tosAccepted: the signed statement carries the agreement; the flag
			// tells the server to stamp acceptance on the user record.
			body: JSON.stringify({ message, signature, tosAccepted: true }),
		});
		result = await vr.json();
		if (!vr.ok) throw new Error(result.error_description || `HTTP ${vr.status}`);
	} catch (e) {
		throw _wcError('verify_failed', `SIWE verify failed: ${e.message}`);
	}

	// 7. Refresh auth hint via getMe (writes localStorage hint internally).
	try {
		const { getMe } = await import('../account.js');
		await getMe();
	} catch {
		/* non-fatal: hint just won't be refreshed */
	}

	return {
		user: result.user,
		address: result.wallet?.address ?? address,
	};
}

/**
 * Returns the active EIP-1193 provider, or null if not connected.
 * @returns {object|null}
 */
export function getWalletConnectProvider() {
	return _provider;
}

/**
 * Disconnects the active WalletConnect session and clears the provider.
 */
export async function disconnectWalletConnect() {
	if (!_provider) return;
	try {
		await _provider.disconnect();
	} finally {
		_provider = null;
	}
}
