import type { Address } from 'viem'

/**
 * Launchpad + DEX addresses used by the rails.
 *
 * Every mainnet address here was verified during this build:
 * - NOXA `launchFactory` was cross-checked by reading its live on-chain
 *   config (`getDexConfig(0)` returns the exact Uniswap v3 factory / position
 *   manager / router below, `launchFee()` = 0.0005 ETH, `getLaunchConfig(0)`
 *   pairs against WETH at the 1% tier). The Uniswap addresses match
 *   `hoodchain`'s `MAINNET_ADDRESSES`.
 * - The Odyssey factories were confirmed as the real token deployers via
 *   Blockscout `getcontractcreation` on tokens they produced.
 */

/** NOXA "NOXA Fun" launcher (mainnet 4663). Instant Uniswap-v3 listing. */
export const NOXA = {
  launchFactory: '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB' as Address,
  locker: '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85' as Address,
  feeRouter: '0x9eFdC1A8e6E94f16A228e44f3025E1f346EE0417' as Address,
  /** First block with factory activity — lower bound for historical scans. */
  deployBlock: 61688n,
} as const

/** The Odyssey launchpad factories (mainnet 4663). */
export const ODYSSEY = {
  /** Native-ETH bonding-curve factory. `createToken`-shaped, initial buy is a separate call. */
  bondingCurveFactory: '0xEb3FeeD2716cF0eEAda05B22e67424794e1f5a80' as Address,
  /** Instant-list factory — one tx deploys + seeds a pool; initial buy folds into `msg.value`. */
  instantFactory: '0xD7601cEe401306fdea5833c6898181D9c770F800' as Address,
  /** Variant that pays reflections in a reward token (create shape unverified — not enabled). */
  reflectionFactory: '0x6Ce85c4b7cE12903E5867652C265bCcce57f935F' as Address,
  robinLock: '0x5B41D59Fa0ce65750bc64e06D85bC999084493CD' as Address,
  legacyFactory: '0xAf9f3ce1d34909F59E88c23027f89d5807B0F915' as Address,
} as const

/**
 * Proven 4-byte selectors for The Odyssey. No verified ABI exists on-chain for
 * any Odyssey factory, so the rails pin *selectors* (structure recovered from
 * real txs) rather than function names. Each is proven against a cited
 * historical transaction in `tests/unit/odyssey-calldata.test.ts`.
 */
export const ODYSSEY_SELECTORS = {
  /** instant `f(string name, string symbol, uint256 buyAmount)` payable, msg.value == buyAmount. */
  instantCreate: '0x548eb31b' as const,
  /** bonding `f(string name, string symbol, uint256 threshold, uint256 reserved)` value 0. */
  bondingCreate: '0x56f698a3' as const,
  /** bonding `f(address token, uint256 minTokensOut)` payable — the initial buy. */
  bondingBuy: '0xcce7ec13' as const,
} as const

/**
 * Constant tail params observed in EVERY sampled Odyssey bonding `createToken`
 * call (`0.5e18`, `0`). Semantics are not source-verified; the rail replays the
 * observed constants rather than guessing new values.
 */
export const ODYSSEY_BONDING_CONSTANTS = {
  threshold: 500_000_000_000_000_000n, // 0.5e18
  reserved: 0n,
} as const

/** Uniswap v3 periphery on mainnet 4663 (used by the direct rail). */
export const MAINNET_UNISWAP = {
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address,
  positionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3' as Address,
  swapRouter02: '0xCaf681a66D020601342297493863E78C959E5cb2' as Address,
} as const

/** Uniswap v3 periphery on the community testnet 46630 deployment. */
export const TESTNET_UNISWAP = {
  weth: '0x7943e237c7F95DA44E0301572D358911207852Fa' as Address,
  usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F' as Address,
  factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as Address,
  positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' as Address,
  swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14' as Address,
} as const

/** Uniswap v3 fee tiers as basis points → tickSpacing. */
export const V3_TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
}

/** The dead address LP NFTs / tokens are burned to. */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as Address
