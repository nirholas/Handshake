// Minimal ABIs for Robinhood Chain reads. Each was read from a verified
// contract on Blockscout during the Wave-1 SDK build; this is the subset the
// market-data handlers actually call (reads only — the write/swap ABIs the
// purchase flow needs live client-side in src/robinhood/wallet.js).

export const erc20Abi = [
	{ type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
	{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
	{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
	{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
	{
		type: 'function',
		name: 'balanceOf',
		stateMutability: 'view',
		inputs: [{ name: 'account', type: 'address' }],
		outputs: [{ type: 'uint256' }],
	},
];

// Stock Token = ERC-20 + ERC-8056 corporate-action surface (the two reads
// trackers get wrong: uiMultiplier for share-equivalents, and the pause flags).
export const stockTokenAbi = [
	...erc20Abi,
	{ type: 'function', name: 'uiMultiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'newUIMultiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'effectiveAt', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'tokenPaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
	{ type: 'function', name: 'oraclePaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
];

export const aggregatorV3Abi = [
	{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
	{ type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
	{
		type: 'function',
		name: 'latestRoundData',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'roundId', type: 'uint80' },
			{ name: 'answer', type: 'int256' },
			{ name: 'startedAt', type: 'uint256' },
			{ name: 'updatedAt', type: 'uint256' },
			{ name: 'answeredInRound', type: 'uint80' },
		],
	},
];

export const uniswapV3FactoryAbi = [
	{
		type: 'function',
		name: 'getPool',
		stateMutability: 'view',
		inputs: [
			{ name: 'tokenA', type: 'address' },
			{ name: 'tokenB', type: 'address' },
			{ name: 'fee', type: 'uint24' },
		],
		outputs: [{ type: 'address' }],
	},
];

export const uniswapV3PoolAbi = [
	{ type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
	{
		type: 'function',
		name: 'slot0',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'sqrtPriceX96', type: 'uint160' },
			{ name: 'tick', type: 'int24' },
			{ name: 'observationIndex', type: 'uint16' },
			{ name: 'observationCardinality', type: 'uint16' },
			{ name: 'observationCardinalityNext', type: 'uint16' },
			{ name: 'feeProtocol', type: 'uint8' },
			{ name: 'unlocked', type: 'bool' },
		],
	},
];

// Odyssey bonding-curve launch/trade events (mainnet). NOXA lists instantly so
// its launch event carries the pool directly.
export const noxaTokenLaunchedEvent = {
	type: 'event',
	name: 'TokenLaunched',
	inputs: [
		{ name: 'token', type: 'address', indexed: true },
		{ name: 'deployer', type: 'address', indexed: true },
		{ name: 'dexFactory', type: 'address', indexed: true },
		{ name: 'pairToken', type: 'address', indexed: false },
		{ name: 'pool', type: 'address', indexed: false },
		{ name: 'dexId', type: 'uint256', indexed: false },
		{ name: 'launchConfigId', type: 'uint256', indexed: false },
		{ name: 'positionId', type: 'uint256', indexed: false },
		{ name: 'restrictionsEndBlock', type: 'uint256', indexed: false },
		{ name: 'initialBuyAmount', type: 'uint256', indexed: false },
	],
};
export const odysseyTokenCreatedEvent = {
	type: 'event',
	name: 'TokenCreated',
	inputs: [
		{ name: 'token', type: 'address', indexed: true },
		{ name: 'creator', type: 'address', indexed: true },
		{ name: 'backingWallet', type: 'address', indexed: false },
		{ name: 'isMarginBacked', type: 'bool', indexed: false },
		{ name: 'threshold', type: 'uint256', indexed: false },
	],
};
export const odysseyPoolMigratedEvent = {
	type: 'event',
	name: 'PoolMigrated',
	inputs: [
		{ name: 'token', type: 'address', indexed: true },
		{ name: 'pool', type: 'address', indexed: false },
		{ name: 'tokenId', type: 'uint256', indexed: false },
		{ name: 'liquidity', type: 'uint128', indexed: false },
		{ name: 'tokenUsed', type: 'uint256', indexed: false },
		{ name: 'usdcUsed', type: 'uint256', indexed: false },
	],
};
