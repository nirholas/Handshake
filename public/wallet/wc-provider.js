// CDN-compatible WalletConnect EthereumProvider singleton.
// Uses esm.sh so this file works outside Vite bundling.

let _singleton = null;

/**
 * @param {{ projectId: string, chains?: number[], optionalChains?: number[] }} opts
 */
export async function initWCProvider({ projectId, chains, optionalChains }) {
	if (_singleton) return _singleton;
	const { default: EthereumProvider } = await import(
		/* webpackIgnore: true */ 'https://esm.sh/@walletconnect/ethereum-provider@2.23.9'
	);
	_singleton = await EthereumProvider.init({
		projectId,
		chains: chains?.length ? chains : [1],
		optionalChains: optionalChains?.length ? optionalChains : [8453, 10, 42161, 11155111, 84532],
		showQrModal: true,
	});
	return _singleton;
}

export async function disconnectWC() {
	if (!_singleton) return;
	try {
		await _singleton.disconnect();
	} catch {
		// session may already be gone
	}
	_singleton = null;
}
