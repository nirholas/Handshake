import { encodeAbiParameters, keccak256, toHex, type Address, type Hash } from 'viem'
import type { HoodClient } from 'hoodchain'
import { ODYSSEY, ODYSSEY_BONDING_CONSTANTS, ODYSSEY_SELECTORS } from './addresses.js'
import type { LaunchInput, Rail, RailContext, RailLaunch, RailPlan, RailPreflight } from './types.js'
import { LaunchFailedError, NoSignerError, RailUnavailableError } from '../errors.js'
import { explorerTxUrl, explorerTokenUrl } from '../core/explorer.js'

/**
 * The Odyssey (theodyssey.fun) — mainnet 4663 only, two independent
 * factories with different launch shapes. Neither publishes a verified ABI
 * on Blockscout; every selector and argument layout below was recovered from
 * decoding real historical transactions and is proven byte-for-byte in
 * `tests/unit/odyssey-calldata.test.ts`:
 *
 * - **Instant factory** (`0xD760…f800`) — one payable call,
 *   `f(string name, string symbol, uint256 buyAmount)`, selector
 *   `0x548eb31b`. The invariant `msg.value === buyAmount` held across every
 *   sampled create tx: the initial buy is folded directly into creation.
 *   Emits its own creation events (NOT the `TokenCreated` topic documented
 *   for the bonding factory) and lists to a Uniswap v3 pool immediately.
 * - **Bonding-curve factory** (`0xEb3F…5a80`) — a native-ETH virtual-reserve
 *   curve. Creation, `f(string name, string symbol, uint256, uint256)`
 *   selector `0x56f698a3`, is a separate *zero-value* call from the initial
 *   buy; every sampled create replayed the same two trailing uint256
 *   constants (`0.5e18`, `0`) whose exact semantics aren't source-verified,
 *   so this rail replays them rather than guessing new values. Buying is
 *   `buy(address token, uint256 minTokensOut)` payable, selector
 *   `0xcce7ec13`, and emits the SDK-documented `TokenCreated`/`Traded`
 *   topics on the curve.
 *
 * A full survey of every historical `TokenCreated` emission on the bonding
 * factory (47 logs, `eth_getLogs` from block 0) found FOUR distinct create
 * selectors, not one: `0x8680ce63` (22 uses, an unexplained extra numeric
 * parameter with no consistent relationship to `msg.value`), `0x59a35641`
 * (20 uses, requires a 65-byte trailing ECDSA signature — an off-chain
 * backend co-signs each launch, which this rail has no way to produce),
 * `0xc56f3820` (3 uses, undecoded), and `0x56f698a3` (2 uses — the one this
 * rail ships). `0x56f698a3` is a minority path, but it is the ONLY variant
 * proven simple, unsigned, and byte-for-byte reproducible from real txs
 * without guessing a signature or an unverified parameter — see
 * `tests/unit/odyssey-calldata.test.ts`. It is still live and callable on
 * mainnet today (both sampled uses succeeded).
 *
 * `reflectionFactory` and `legacyFactory` were not sampled for creates during
 * this build and are intentionally NOT exposed by this rail — see the README
 * "Rails shipped vs excluded" section.
 */
export class OdysseyRail implements Rail {
  readonly name = 'odyssey' as const
  readonly networks = ['mainnet'] as const

  /** Which Odyssey factory a launch targets. Defaults to `'instant'` (single tx, simplest). */
  constructor(private readonly variant: 'instant' | 'bonding' = 'instant') {}

  async preflight(ctx: RailContext, _input: LaunchInput): Promise<RailPreflight> {
    const { client } = ctx
    if (client.network !== 'mainnet') {
      return {
        rail: 'odyssey',
        network: client.network,
        ready: false,
        blockers: ['The Odyssey only operates on mainnet 4663 — no testnet deployment exists.'],
        protocolFeeWei: 0n,
        estimatedValueWei: 0n,
      }
    }
    const factory = this.variant === 'instant' ? ODYSSEY.instantFactory : ODYSSEY.bondingCurveFactory
    const code = await client.public.getCode({ address: factory })
    const blockers: string[] = []
    if (!code || code === '0x') blockers.push(`Odyssey ${this.variant} factory has no code at ${factory}.`)

    return {
      rail: 'odyssey',
      network: 'mainnet',
      ready: blockers.length === 0,
      blockers,
      protocolFeeWei: 0n, // Odyssey charges no separate protocol fee at create; the buy amount IS the spend.
      estimatedValueWei: 0n,
    }
  }

  async plan(ctx: RailContext, input: LaunchInput): Promise<RailPlan> {
    const { client } = ctx
    if (client.network !== 'mainnet') {
      throw new RailUnavailableError('odyssey', client.network, 'no testnet deployment exists')
    }
    const preflight = await this.preflight(ctx, input)

    if (this.variant === 'instant') {
      const data = (ODYSSEY_SELECTORS.instantCreate +
        encodeAbiParameters(
          [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }],
          [input.name, input.symbol, input.initialBuyWei],
        ).slice(2)) as `0x${string}`

      return {
        rail: 'odyssey',
        preflight: { ...preflight, estimatedValueWei: input.initialBuyWei },
        steps: [
          {
            label: 'instantCreate (buy folded into creation)',
            to: ODYSSEY.instantFactory,
            data,
            value: input.initialBuyWei,
          },
        ],
      }
    }

    // Bonding: create (value 0), then optional buy (value = initialBuyWei).
    const createData = (ODYSSEY_SELECTORS.bondingCreate +
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
        [input.name, input.symbol, ODYSSEY_BONDING_CONSTANTS.threshold, ODYSSEY_BONDING_CONSTANTS.reserved],
      ).slice(2)) as `0x${string}`

    const steps: RailPlan['steps'] = [
      { label: 'bondingCreate', to: ODYSSEY.bondingCurveFactory, data: createData, value: 0n },
    ]
    // The buy step needs the created token address, which only exists after
    // `create` confirms — it is appended in `launch()`, not here. `plan()`
    // for the bonding variant therefore only ever returns the create step;
    // callers that need the full two-step cost must add `initialBuyWei`
    // themselves (reflected in `estimatedValueWei`).
    return {
      rail: 'odyssey',
      preflight: { ...preflight, estimatedValueWei: input.initialBuyWei },
      steps,
    }
  }

  async launch(ctx: RailContext, input: LaunchInput): Promise<RailLaunch> {
    const { client } = ctx
    if (!client.wallet || !client.account) throw new NoSignerError('OdysseyRail.launch')

    if (this.variant === 'instant') return this.launchInstant(client, input)
    return this.launchBonding(client, input)
  }

  private async launchInstant(client: HoodClient, input: LaunchInput): Promise<RailLaunch> {
    if (!client.wallet || !client.account) throw new NoSignerError('OdysseyRail.launchInstant')
    const { steps } = await this.plan({ client }, input)
    const step = steps[0]
    if (!step) throw new LaunchFailedError('OdysseyRail(instant) produced no transaction steps')

    const hash = await client.wallet.sendTransaction({
      to: step.to,
      data: step.data,
      value: step.value,
      account: client.account,
      chain: client.chain,
    })
    const receipt = await client.public.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      throw new LaunchFailedError(`Odyssey instant create reverted (tx ${hash})`, hash)
    }
    const token = resolveCreatedToken(receipt.logs, ODYSSEY.instantFactory)
    if (!token) throw new LaunchFailedError(`Odyssey instant create succeeded but no token could be resolved (tx ${hash})`, hash)

    return {
      rail: 'odyssey',
      network: 'mainnet',
      token,
      pool: null,
      transactionHashes: [hash],
      launchTx: hash,
      spentWei: step.value,
      explorer: { token: explorerTokenUrl('mainnet', token), launchTx: explorerTxUrl('mainnet', hash) },
      extra: { variant: 'instant' },
    }
  }

  private async launchBonding(client: HoodClient, input: LaunchInput): Promise<RailLaunch> {
    if (!client.wallet || !client.account) throw new NoSignerError('OdysseyRail.launchBonding')
    const { steps } = await this.plan({ client }, input)
    const createStep = steps[0]
    if (!createStep) throw new LaunchFailedError('OdysseyRail(bonding) produced no create step')

    const createHash = await client.wallet.sendTransaction({
      to: createStep.to,
      data: createStep.data,
      value: createStep.value,
      account: client.account,
      chain: client.chain,
    })
    const createReceipt = await client.public.waitForTransactionReceipt({ hash: createHash })
    if (createReceipt.status !== 'success') {
      throw new LaunchFailedError(`Odyssey bonding create reverted (tx ${createHash})`, createHash)
    }
    const token = resolveCreatedToken(createReceipt.logs, ODYSSEY.bondingCurveFactory)
    if (!token) {
      throw new LaunchFailedError(`Odyssey bonding create succeeded but no token could be resolved (tx ${createHash})`, createHash)
    }

    const hashes: Hash[] = [createHash]
    let spent = 0n

    if (input.initialBuyWei > 0n) {
      // minTokensOut = 0 is intentionally conservative-unsafe only for a
      // freshly-created curve the caller controls end-to-end in the same
      // launch; callers wanting slippage protection should call the buy
      // step separately with a quote.
      const buyData = (ODYSSEY_SELECTORS.bondingBuy +
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, 0n]).slice(2)) as `0x${string}`
      const buyHash = await client.wallet.sendTransaction({
        to: ODYSSEY.bondingCurveFactory,
        data: buyData,
        value: input.initialBuyWei,
        account: client.account,
        chain: client.chain,
      })
      const buyReceipt = await client.public.waitForTransactionReceipt({ hash: buyHash })
      if (buyReceipt.status === 'success') {
        hashes.push(buyHash)
        spent += input.initialBuyWei
      }
    }

    return {
      rail: 'odyssey',
      network: 'mainnet',
      token,
      pool: null,
      transactionHashes: hashes,
      launchTx: createHash,
      spentWei: spent,
      explorer: { token: explorerTokenUrl('mainnet', token), launchTx: explorerTxUrl('mainnet', createHash) },
      extra: { variant: 'bonding' },
    }
  }
}

/** `keccak256("Transfer(address,address,uint256)")` — standard ERC-20 mint/transfer topic0. */
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Resolve the created token from a receipt: the new ERC-20's own constructor
 * mint emits `Transfer(0x0, creator, supply)` from the token's own address —
 * the first `Transfer` log NOT emitted by the factory itself is the token.
 */
function resolveCreatedToken(
  logs: { address: Address; topics: readonly `0x${string}`[] }[],
  factory: Address,
): Address | null {
  for (const log of logs) {
    if (log.address.toLowerCase() === factory.toLowerCase()) continue
    if (log.topics[0]?.toLowerCase() === TRANSFER_TOPIC0) return log.address
  }
  return null
}
