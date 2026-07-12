import type { Address, Hash, Hex } from 'viem'
import type { HoodClient, HoodNetwork } from 'hoodchain'

/** The launch rails hood-launcher ships. */
export type RailName = 'noxa' | 'odyssey' | 'direct'

/** Social links attached to a launch (all optional). */
export interface Socials {
  telegram?: string
  twitter?: string
  discord?: string
  website?: string
  farcaster?: string
}

/**
 * The rail-agnostic description of a coin to launch. The concept engine and
 * config both resolve down to this shape before any rail runs.
 */
export interface LaunchInput {
  /** Token name, e.g. "We are so back". */
  name: string
  /** Ticker, e.g. "BACK". Uppercased, no `$`. */
  symbol: string
  /** One-line description / lore. May be empty. */
  description: string
  /**
   * The coin's logo, as a URI. hood-launcher's differentiator is a 3D GLB
   * logo generated on the three.ws free forge lane; any image/GLB/IPFS URI the
   * operator supplies works too.
   */
  logoUri: string
  socials: Socials
  /**
   * Native ETH to spend on the creator's initial buy, in wei. `0n` = launch
   * with no initial buy. On rails where the initial buy is a separate step
   * (Odyssey bonding), this seeds that step.
   */
  initialBuyWei: bigint
  /** Optional 32-byte salt for deterministic addresses (NOXA). Random if omitted. */
  salt?: Hex
}

/** Options that tune the direct rail's ERC-20 + pool. */
export interface DirectRailOptions {
  /** Total fixed supply, in whole tokens (18 decimals applied). @defaultValue `1_000_000_000` */
  totalSupply?: bigint
  /** Uniswap v3 fee tier in bps for the seeded pool. @defaultValue `10000` (1%) */
  feeTier?: number
  /** Native ETH (wei) to seed as the pool's paired liquidity. */
  seedWethWei: bigint
  /** Fraction (bps) of total supply to deposit as the token side of the LP. @defaultValue `10000` (100%) */
  lpSupplyBps?: number
  /** What to do with the LP position NFT after seeding. @defaultValue `'burn'` */
  lpDisposition?: 'burn' | 'lock' | 'keep'
}

/** Everything a rail needs at call time. */
export interface RailContext {
  client: HoodClient
  /** Direct-rail knobs; ignored by launchpad rails. */
  direct?: DirectRailOptions
}

/** Result of a read-only rail preflight. */
export interface RailPreflight {
  rail: RailName
  network: HoodNetwork
  /** True when a launch can proceed right now. */
  ready: boolean
  /** Human-readable blockers when `ready` is false. */
  blockers: string[]
  /** Protocol fee charged by the rail, in wei (launch fee; excludes the initial buy). */
  protocolFeeWei: bigint
  /** Total native ETH the launch tx will require = protocol fee + initial buy + seed. */
  estimatedValueWei: bigint
  /** The token the new coin will be paired against (WETH / USDG / native). */
  pairToken?: Address
}

/** A built, not-yet-sent launch, suitable for simulation and inspection. */
export interface RailPlan {
  rail: RailName
  /** One or more ordered transactions the launch requires. */
  steps: RailStep[]
  preflight: RailPreflight
}

/** A single unsigned transaction in a launch plan. */
export interface RailStep {
  label: string
  to: Address
  data: Hex
  value: bigint
}

/** The outcome of a completed launch. */
export interface RailLaunch {
  rail: RailName
  network: HoodNetwork
  /** The new token's contract address. */
  token: Address
  /** The Uniswap v3 pool, when one exists immediately (null for pure bonding curves pre-graduation). */
  pool: Address | null
  /** Every transaction hash the launch sent, in order. */
  transactionHashes: Hash[]
  /** The primary launch tx hash (token creation). */
  launchTx: Hash
  /** Native ETH spent in total (fees + buy + seed), in wei. */
  spentWei: bigint
  /** Explorer links for the token + launch tx. */
  explorer: { token: string; launchTx: string }
  /** Rail-specific extras (positionId, pairToken, restrictionsEndBlock, …). */
  extra: Record<string, string>
}

/** The interface every rail implements. */
export interface Rail {
  readonly name: RailName
  /** Networks this rail can run on. */
  readonly networks: readonly HoodNetwork[]
  /** Read-only: is the rail launchable now, and what will it cost? */
  preflight(ctx: RailContext, input: LaunchInput): Promise<RailPreflight>
  /** Build the ordered, unsigned transactions (for simulation / dry-run). */
  plan(ctx: RailContext, input: LaunchInput): Promise<RailPlan>
  /** Sign, send, confirm, and resolve the launched token + pool. */
  launch(ctx: RailContext, input: LaunchInput): Promise<RailLaunch>
}
