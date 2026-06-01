/**
 * Lazy singleton for @walletconnect/ethereum-provider.
 * Import and call initWCProvider() once per session; subsequent calls
 * return the same instance without re-initializing.
 */

let _singleton = null;

/**
 * @param {{
 *   projectId: string,
 *   chains?: number[],
 *   optionalChains?: number[],
 * }} opts
 * @returns {Promise<import('@walletconnect/ethereum-provider').default>}
 */
export async function initWCProvider({ projectId, chains, optionalChains }) {
	if (_singleton) return _singleton;
	const { default: EthereumProvider } = await import('@walletconnect/ethereum-provider');
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
