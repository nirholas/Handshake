/**
 * ABIs for the launch rails.
 *
 * The NOXA `launchToken` ABI below is not guesswork: it was extracted from
 * NOXA's own production frontend bundle (`fun.noxa.fi/assets/index-*.js`,
 * struct `LauncherTypes.LaunchParams`) and then *proven* — encoding
 * `launchToken(...)` with the exact inputs recovered from the real historical
 * launch tx `0x90237351d992942bd33a471e8d791be5c51e74a9ed1e91268b7fc3148d4872dc`
 * (the "We are so back" / BACK launch on `NOXA_LAUNCH_FACTORY`) reproduces
 * that transaction's calldata **byte-for-byte, selector included**
 * (`0x686399cb`). See `tests/unit/noxa-calldata.test.ts`, which re-runs that
 * proof on every `npm test`.
 */

/** NOXA `LauncherFactory` — the launch surface + on-chain config views. */
export const noxaLauncherAbi = [
  {
    type: 'function',
    name: 'launchToken',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        internalType: 'struct LauncherTypes.LaunchParams',
        components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'logo', type: 'string' },
          { name: 'description', type: 'string' },
          {
            name: 'socials',
            type: 'tuple',
            internalType: 'struct LauncherTypes.Socials',
            components: [
              { name: 'telegram', type: 'string' },
              { name: 'twitter', type: 'string' },
              { name: 'discord', type: 'string' },
              { name: 'website', type: 'string' },
              { name: 'farcaster', type: 'string' },
            ],
          },
          { name: 'devWallet', type: 'address' },
        ],
      },
      { name: 'launchConfigId', type: 'uint256' },
      { name: 'dexId', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'positionId', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'launchFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'launchEnabled',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'launchConfigCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'dexConfigCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getLaunchConfig',
    stateMutability: 'view',
    inputs: [{ name: 'configId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        internalType: 'struct LauncherTypes.LaunchConfig',
        components: [
          { name: 'pairToken', type: 'address' },
          { name: 'dexId', type: 'uint256' },
          { name: 'initialTick', type: 'int24' },
          { name: 'supply', type: 'uint256' },
          { name: 'maxWalletBps', type: 'uint16' },
          { name: 'maxTxBps', type: 'uint16' },
          { name: 'restrictionBlocks', type: 'uint32' },
          { name: 'buyPairHopFee', type: 'uint24' },
          { name: 'enabled', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getDexConfig',
    stateMutability: 'view',
    inputs: [{ name: 'dexId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        internalType: 'struct LauncherFactory.DexConfig',
        components: [
          { name: 'name', type: 'string' },
          { name: 'factory', type: 'address' },
          { name: 'positionManager', type: 'address' },
          { name: 'router', type: 'address' },
          { name: 'poolFee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'enabled', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getLaunchedToken',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        internalType: 'struct LauncherTypes.LaunchedToken',
        components: [
          { name: 'token', type: 'address' },
          { name: 'deployer', type: 'address' },
          { name: 'pairedToken', type: 'address' },
          { name: 'positionManager', type: 'address' },
          { name: 'positionId', type: 'uint256' },
          { name: 'dexId', type: 'uint256' },
          { name: 'launchConfigId', type: 'uint256' },
          { name: 'restrictionsEndBlock', type: 'uint256' },
          { name: 'supply', type: 'uint256' },
        ],
      },
    ],
  },
  {
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
  },
] as const

/** Uniswap v3 `NonfungiblePositionManager` surface used by the direct rail. */
export const positionManagerAbi = [
  {
    type: 'function',
    name: 'createAndInitializePoolIfNecessary',
    stateMutability: 'payable',
    inputs: [
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'sqrtPriceX96', type: 'uint160' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'token0', type: 'address' },
          { name: 'token1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickLower', type: 'int24' },
          { name: 'tickUpper', type: 'int24' },
          { name: 'amount0Desired', type: 'uint256' },
          { name: 'amount1Desired', type: 'uint256' },
          { name: 'amount0Min', type: 'uint256' },
          { name: 'amount1Min', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
  {
    type: 'function',
    name: 'refundETH',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'owner', type: 'address' }],
  },
  {
    type: 'function',
    name: 'factory',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

/** Uniswap v3 factory — used to resolve the pool address after creation. */
export const v3FactoryAbi = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

/** WETH9 deposit/withdraw (direct rail wraps ETH to seed a WETH-paired pool). */
export const weth9Abi = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const
