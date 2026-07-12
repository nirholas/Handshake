import type { Address } from 'viem'

/**
 * Canonical contract addresses on Robinhood Chain mainnet (chain ID 4663).
 *
 * Every address was verified during SDK development:
 * - `usdg` / `weth` from https://docs.robinhood.com/chain/contracts, verified
 *   as deployed + source-verified contracts on Blockscout.
 * - The Uniswap v3 stack was resolved on-chain: `SwapRouter02.factory()` and
 *   `QuoterV2.factory()` both return `uniswapV3Factory`, and both routers
 *   report `WETH9() == weth`. All five contracts were deployed by the same
 *   deployer (`0x9701fb0aDe1E269c8f64Ec0C7b3cfADB31A13A52`) in the chain's
 *   genesis-era Uniswap deployment and are the addresses the public
 *   ecosystem (hood.markets and others) routes through.
 * - `multicall3` is the canonical cross-chain Multicall3, present in viem's
 *   official `robinhood` chain definition.
 */
export const MAINNET_ADDRESSES = {
  /** USDG — Paxos Global Dollar, the chain's dollar stablecoin. 6 decimals. */
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  /** Canonical WETH9. */
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
  /** Uniswap v3 factory. */
  uniswapV3Factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address,
  /** Uniswap QuoterV2. */
  quoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7' as Address,
  /** Uniswap SwapRouter02. */
  swapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2' as Address,
  /** Uniswap UniversalRouter. */
  universalRouter: '0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77' as Address,
  /** Uniswap NonfungiblePositionManager. */
  nonfungiblePositionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3' as Address,
  /** Multicall3 (canonical deterministic deployment). */
  multicall3: '0xca11bde05977b3631167028862be2a173976ca11' as Address,
} as const

/**
 * Contract addresses on Robinhood Chain testnet (chain ID 46630).
 *
 * There is NO official Uniswap deployment on the testnet: none of the mainnet
 * addresses have code there (`eth_getCode` returns `0x` for all six) and the
 * mainnet Uniswap deployer has zero testnet transactions. The addresses below
 * are the one community v3 deployment that actually has a liquid Stock Token
 * pool, and its internal linkage was verified on-chain during SDK
 * development: `router.factory()`, `quoterV2.factory()`,
 * `positionManager.factory()` and the live pool's `factory()` all return
 * `uniswapV3Factory`, and `router.WETH9()` matches the chain's canonical
 * WETH (which is also the L2 WETH listed at
 * https://docs.robinhood.com/chain/protocol-contracts).
 *
 * NOTE the router flavor difference: testnet uses the classic v3
 * `SwapRouter` whose `exactInputSingle` struct carries a `deadline` field;
 * mainnet uses `SwapRouter02` (deadline via `multicall`). The swap module
 * handles both.
 *
 * Testnet Stock Tokens (faucet-dripped) and USDG were resolved from the
 * testnet Blockscout (https://explorer.testnet.chain.robinhood.com) —
 * canonical testnet tokens use plain company names, not the mainnet
 * "<Name> • Robinhood Token" pattern.
 */
export const TESTNET_ADDRESSES = {
  /** Testnet USDG ("Global Dollar", 6 decimals). */
  usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F' as Address,
  /** Canonical testnet WETH9 (matches the official protocol-contracts L2 WETH). */
  weth: '0x7943e237c7F95DA44E0301572D358911207852Fa' as Address,
  /** Community Uniswap v3 factory (the one with liquid Stock Token pools). */
  uniswapV3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as Address,
  /** QuoterV2 linked to the factory above. */
  quoterV2: '0xcf05Fc31A6B693DD0bEB76e958ae4BCD490dc985' as Address,
  /** Classic v3 SwapRouter (struct-level deadline) linked to the factory above. */
  swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14' as Address,
  /** NonfungiblePositionManager linked to the factory above. */
  nonfungiblePositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' as Address,
  /** Multicall3 (canonical deterministic deployment, in viem's chain def). */
  multicall3: '0xca11bde05977b3631167028862be2a173976ca11' as Address,
} as const

/**
 * Faucet-dripped Stock Tokens on testnet 46630 (18 decimals each). These are
 * plain test ERC-20s — the testnet does not mirror the mainnet registry.
 */
export const TESTNET_STOCK_TOKENS = {
  TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E' as Address,
  AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02' as Address,
  PLTR: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0' as Address,
  NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93' as Address,
  AMD: '0x71178BAc73cBeb415514eB542a8995b82669778d' as Address,
} as const

/** Sequencer firehose WebSocket endpoint (mainnet). */
export const MAINNET_FEED_URL = 'wss://feed.mainnet.chain.robinhood.com'

/** Blockscout explorer base URL (mainnet). */
export const MAINNET_EXPLORER_URL = 'https://robinhoodchain.blockscout.com'

/** USDG has 6 decimals (verified on-chain — unlike most L2-native stables' 18). */
export const USDG_DECIMALS = 6

/** Every canonical Stock Token uses 18 decimals. */
export const STOCK_TOKEN_DECIMALS = 18

/** Chainlink stock/crypto feeds on Robinhood Chain answer with 8 decimals. */
export const FEED_DECIMALS = 8

/** Fee tiers probed when discovering Uniswap v3 routes. */
export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const
