// Canonical Robinhood Chain contract addresses + protocol constants.
//
// Every address here was verified on-chain during the Wave-1 SDK build
// (robinhood/robinhood-chain-sdk/src/addresses.ts) and cross-checked against
// https://docs.robinhood.com/chain/contracts and Blockscout. This module is
// the app-side mirror of that verified set — kept in sync by hand rather than
// importing the sibling TS repo (which the serverless bundle can't resolve).

export const MAINNET = {
	usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
	weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
	uniswapV3Factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
	quoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
	swapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2',
	universalRouter: '0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77',
	nonfungiblePositionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
	multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
};

export const TESTNET = {
	usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
	weth: '0x7943e237c7F95DA44E0301572D358911207852Fa',
	uniswapV3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
	quoterV2: '0xcf05Fc31A6B693DD0bEB76e958ae4BCD490dc985',
	swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
	nonfungiblePositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
	multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
};

// Faucet-dripped test Stock Tokens on testnet 46630 (plain ERC-20s, 18 dec).
export const TESTNET_STOCK_TOKENS = {
	TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',
	AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02',
	PLTR: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0',
	NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',
	AMD: '0x71178BAc73cBeb415514eB542a8995b82669778d',
};

// Memecoin launchpad factories (mainnet 4663) — from the Wave-1 SDK's
// launchpads.ts, extracted from each platform's frontend bundle and confirmed
// against live logs. Neither publishes verified source on Blockscout.
export const NOXA = {
	launchFactory: '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB',
	deployBlock: 61688n,
};
export const ODYSSEY = {
	bondingCurveFactory: '0xEb3FeeD2716cF0eEAda05B22e67424794e1f5a80',
	reflectionFactory: '0x6Ce85c4b7cE12903E5867652C265bCcce57f935F',
	instantFactory: '0xD7601cEe401306fdea5833c6898181D9c770F800',
};
export const ODYSSEY_FACTORIES = [
	ODYSSEY.bondingCurveFactory,
	ODYSSEY.reflectionFactory,
	ODYSSEY.instantFactory,
];

export function addressesFor(network = 'mainnet') {
	return network === 'testnet' ? TESTNET : MAINNET;
}

export const USDG_DECIMALS = 6;
export const STOCK_TOKEN_DECIMALS = 18;
export const FEED_DECIMALS = 8;
export const V3_FEE_TIERS = [100, 500, 3000, 10000];
