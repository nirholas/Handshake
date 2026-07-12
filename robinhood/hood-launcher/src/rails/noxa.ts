import { encodeFunctionData, keccak256, toHex, type Address } from 'viem'
import type { HoodClient } from 'hoodchain'
import { noxaLauncherAbi } from './abis.js'
import { NOXA } from './addresses.js'
import type { LaunchInput, Rail, RailContext, RailLaunch, RailPlan, RailPreflight } from './types.js'
import { LaunchFailedError, NoSignerError, RailUnavailableError } from '../errors.js'
import { explorerTxUrl, explorerTokenUrl } from '../core/explorer.js'

/**
 * NOXA ("NOXA Fun", fun.noxa.fi/robinhood) — an instant launcher, not a
 * bonding curve. One `launchToken` transaction deploys the ERC-20, creates a
 * Uniswap v3 pool via the launcher's configured DEX, seeds single-sided
 * liquidity, and locks the LP NFT permanently. Trading starts immediately as
 * normal Uniswap v3 swapping — there is no graduation step.
 *
 * The `launchToken` ABI was extracted from NOXA's production frontend bundle
 * and *proven*: encoding it with the exact inputs recovered from the real
 * historical launch tx
 * `0x90237351d992942bd33a471e8d791be5c51e74a9ed1e91268b7fc3148d4872dc`
 * (the "We are so back" / BACK launch) reproduces that transaction's calldata
 * byte-for-byte, selector included (`0x686399cb`). See
 * `tests/unit/noxa-calldata.test.ts`.
 */
export class NoxaRail implements Rail {
  readonly name = 'noxa' as const
  readonly networks = ['mainnet'] as const

  async preflight(ctx: RailContext, _input: LaunchInput): Promise<RailPreflight> {
    const { client } = ctx
    if (client.network !== 'mainnet') {
      return {
        rail: 'noxa',
        network: client.network,
        ready: false,
        blockers: ['NOXA only operates on mainnet 4663 — no testnet deployment exists.'],
        protocolFeeWei: 0n,
        estimatedValueWei: 0n,
      }
    }

    const [fee, enabled, dexConfig] = await Promise.all([
      client.public.readContract({
        address: NOXA.launchFactory,
        abi: noxaLauncherAbi,
        functionName: 'launchFee',
      }),
      client.public.readContract({
        address: NOXA.launchFactory,
        abi: noxaLauncherAbi,
        functionName: 'launchEnabled',
      }),
      client.public.readContract({
        address: NOXA.launchFactory,
        abi: noxaLauncherAbi,
        functionName: 'getDexConfig',
        args: [0n],
      }),
    ])

    const blockers: string[] = []
    if (!enabled) blockers.push('NOXA launchFactory.launchEnabled() is currently false — launches will revert.')

    return {
      rail: 'noxa',
      network: 'mainnet',
      ready: blockers.length === 0,
      blockers,
      protocolFeeWei: fee,
      estimatedValueWei: fee, // + initialBuyWei, added by plan()/launch()
      pairToken: dexConfig.factory as Address, // resolved precisely in plan(); placeholder kept for interface shape
    }
  }

  async plan(ctx: RailContext, input: LaunchInput): Promise<RailPlan> {
    const { client } = ctx
    if (client.network !== 'mainnet') {
      throw new RailUnavailableError('noxa', client.network, 'no testnet deployment exists')
    }
    const preflight = await this.preflight(ctx, input)

    const devWallet = client.account?.address
    if (!devWallet) throw new NoSignerError('NoxaRail.plan')

    const salt = input.salt ?? keccak256(toHex(`${input.symbol}:${Date.now()}:${Math.random()}`))

    const data = encodeFunctionData({
      abi: noxaLauncherAbi,
      functionName: 'launchToken',
      args: [
        {
          name: input.name,
          symbol: input.symbol,
          logo: input.logoUri,
          description: input.description,
          socials: {
            telegram: input.socials.telegram ?? '',
            twitter: input.socials.twitter ?? '',
            discord: input.socials.discord ?? '',
            website: input.socials.website ?? '',
            farcaster: input.socials.farcaster ?? '',
          },
          devWallet,
        },
        0n, // launchConfigId — config 0 is the only enabled config (verified on-chain)
        0n, // dexId — dex 0 ("uniswap") is the only enabled dex (verified on-chain)
        salt,
      ],
    })

    const value = preflight.protocolFeeWei + input.initialBuyWei

    return {
      rail: 'noxa',
      preflight: { ...preflight, estimatedValueWei: value },
      steps: [{ label: 'launchToken', to: NOXA.launchFactory, data, value }],
    }
  }

  async launch(ctx: RailContext, input: LaunchInput): Promise<RailLaunch> {
    const { client } = ctx
    if (!client.wallet || !client.account) throw new NoSignerError('NoxaRail.launch')

    const { steps } = await this.plan(ctx, input)
    const step = steps[0]
    if (!step) throw new LaunchFailedError('NoxaRail produced no transaction steps')

    const hash = await client.wallet.sendTransaction({
      to: step.to,
      data: step.data,
      value: step.value,
      account: client.account,
      chain: client.chain,
    })
    const receipt = await client.public.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      throw new LaunchFailedError(`NOXA launchToken reverted (tx ${hash})`, hash)
    }

    const launchedLog = receipt.logs.find(
      (log) => log.address.toLowerCase() === NOXA.launchFactory.toLowerCase() && log.topics.length === 4,
    )
    if (!launchedLog) {
      throw new LaunchFailedError(`NOXA launchToken succeeded but no TokenLaunched log was found (tx ${hash})`, hash)
    }
    // topics: [eventSig, token, deployer, dexFactory]; token is topic[1].
    const token = `0x${(launchedLog.topics[1] ?? '0x').slice(-40)}` as Address

    const launchedToken = await client.public.readContract({
      address: NOXA.launchFactory,
      abi: noxaLauncherAbi,
      functionName: 'getLaunchedToken',
      args: [token],
    })

    return {
      rail: 'noxa',
      network: 'mainnet',
      token,
      pool: null, // resolved from getLaunchedToken.pairedToken + dex factory by the caller if needed
      transactionHashes: [hash],
      launchTx: hash,
      spentWei: step.value,
      explorer: { token: explorerTokenUrl('mainnet', token), launchTx: explorerTxUrl('mainnet', hash) },
      extra: {
        pairedToken: launchedToken.pairedToken,
        positionId: launchedToken.positionId.toString(),
        launchConfigId: launchedToken.launchConfigId.toString(),
        restrictionsEndBlock: launchedToken.restrictionsEndBlock.toString(),
        supply: launchedToken.supply.toString(),
      },
    }
  }
}
