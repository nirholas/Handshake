// Market-data identifiers per EVM chain.
//
// Three different upstreams address the same chain by three different names,
// and every one of them is a silent miss when it is wrong: CoinGecko keys its
// contract lookups by an asset-platform slug (`/coins/base/contract/0x…`),
// DefiLlama keys its price oracle by a chain prefix (`base:0x…`), and the
// chain's native gas token is its own CoinGecko coin id. Callers used to
// hardcode `ethereum` for all three, which priced a Base or Arbitrum token
// against a contract address that does not exist on Ethereum: both upstreams
// answered "unknown", and the caller reported the holding as unpriceable.
//
// Only chains with real market data are listed. A testnet, or a chain no
// upstream indexes, resolves to null so a caller skips the lookup entirely
// rather than asking the wrong chain and trusting the answer.

export const EVM_CHAIN_MARKET = {
	1: { coingeckoPlatform: 'ethereum', llamaChain: 'ethereum', nativeCoingeckoId: 'ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum' },
	10: { coingeckoPlatform: 'optimistic-ethereum', llamaChain: 'optimism', nativeCoingeckoId: 'ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum' },
	56: { coingeckoPlatform: 'binance-smart-chain', llamaChain: 'bsc', nativeCoingeckoId: 'binancecoin', nativeSymbol: 'BNB', nativeName: 'BNB' },
	100: { coingeckoPlatform: 'xdai', llamaChain: 'xdai', nativeCoingeckoId: 'xdai', nativeSymbol: 'XDAI', nativeName: 'xDAI' },
	// POL, not MATIC: the `matic-network` coin id stopped resolving after the
	// token migration, so anything still asking for it prices Polygon at null.
	137: { coingeckoPlatform: 'polygon-pos', llamaChain: 'polygon', nativeCoingeckoId: 'polygon-ecosystem-token', nativeSymbol: 'POL', nativeName: 'Polygon Ecosystem Token' },
	250: { coingeckoPlatform: 'fantom', llamaChain: 'fantom', nativeCoingeckoId: 'fantom', nativeSymbol: 'FTM', nativeName: 'Fantom' },
	324: { coingeckoPlatform: 'zksync', llamaChain: 'era', nativeCoingeckoId: 'ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum' },
	1284: { coingeckoPlatform: 'moonbeam', llamaChain: 'moonbeam', nativeCoingeckoId: 'moonbeam', nativeSymbol: 'GLMR', nativeName: 'Moonbeam' },
	5000: { coingeckoPlatform: 'mantle', llamaChain: 'mantle', nativeCoingeckoId: 'mantle', nativeSymbol: 'MNT', nativeName: 'Mantle' },
	8453: { coingeckoPlatform: 'base', llamaChain: 'base', nativeCoingeckoId: 'ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum' },
	42161: { coingeckoPlatform: 'arbitrum-one', llamaChain: 'arbitrum', nativeCoingeckoId: 'ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum' },
	42220: { coingeckoPlatform: 'celo', llamaChain: 'celo', nativeCoingeckoId: 'celo', nativeSymbol: 'CELO', nativeName: 'Celo' },
	43114: { coingeckoPlatform: 'avalanche', llamaChain: 'avax', nativeCoingeckoId: 'avalanche-2', nativeSymbol: 'AVAX', nativeName: 'Avalanche' },
	59144: { coingeckoPlatform: 'linea', llamaChain: 'linea', nativeCoingeckoId: 'ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum' },
	534352: { coingeckoPlatform: 'scroll', llamaChain: 'scroll', nativeCoingeckoId: 'ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum' },
};

// The chain every agent wallet lands on when `agent_identities.chain_id` is
// null, which is the majority of the fleet.
export const DEFAULT_EVM_CHAIN_ID = 8453;

export function evmChainMarket(chainId) {
	return EVM_CHAIN_MARKET[Number(chainId)] || null;
}

// CoinGecko coin id for a chain's native gas token, or null on a chain no
// upstream prices (testnets included).
export function evmNativeCoingeckoId(chainId) {
	return evmChainMarket(chainId)?.nativeCoingeckoId || null;
}
