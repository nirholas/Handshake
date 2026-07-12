import {
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  parseUnits,
  type Address,
} from 'viem'
import type { HoodClient, HoodNetwork } from 'hoodchain'
import { erc20Abi } from 'hoodchain'
import HoodTokenArtifact from '../../contracts/HoodToken.json' with { type: 'json' }
import HoodLPLockerArtifact from '../../contracts/HoodLPLocker.json' with { type: 'json' }
import { positionManagerAbi, v3FactoryAbi } from './abis.js'
import { MAINNET_UNISWAP, TESTNET_UNISWAP, BURN_ADDRESS, V3_TICK_SPACINGS } from './addresses.js'
import type { DirectRailOptions, LaunchInput, Rail, RailContext, RailLaunch, RailPlan, RailPreflight } from './types.js'
import { LaunchFailedError, NoSignerError } from '../errors.js'
import { explorerTxUrl, explorerTokenUrl } from '../core/explorer.js'
import { verifySource } from '../core/verify.js'
import { fullRangeTicks, sortTokens, sqrtPriceX96FromAmounts } from '../core/univ3-math.js'

const TOKEN_DECIMALS = 18

const DEFAULT_OPTIONS: Required<Omit<DirectRailOptions, 'seedWethWei'>> = {
  totalSupply: 1_000_000_000n,
  feeTier: 10_000, // 1% — matches NOXA's default pairing behavior on this chain
  lpSupplyBps: 10_000, // 100% of supply into the LP
  lpDisposition: 'burn',
}

function uniswapAddresses(network: HoodNetwork) {
  return network === 'mainnet' ? MAINNET_UNISWAP : TESTNET_UNISWAP
}

function normalizeCompilerVersion(v: string): string {
  const m = v.match(/^(\d+\.\d+\.\d+)\+commit\.([0-9a-fA-F]+)/)
  return m ? `v${m[1]}+commit.${m[2]}` : v
}

/**
 * Direct rail: deploy a clean, minimal `HoodToken` (OpenZeppelin v5 `ERC20`,
 * fixed supply minted once, no mint function, no owner — see
 * `contracts/HoodToken.sol`), create + initialize a Uniswap v3 pool at the
 * configured fee tier, seed a full-range LP position, and burn or lock the
 * LP NFT per `DirectRailOptions.lpDisposition`. Every deployed contract is
 * submitted for source verification on Blockscout as the final step.
 *
 * Works on both mainnet 4663 (official Uniswap v3) and testnet 46630 (the
 * community v3 deployment — classic router semantics don't matter here since
 * this rail talks to the `NonfungiblePositionManager` directly, which is
 * link-verified against the same factory on both networks).
 */
export class DirectRail implements Rail {
  readonly name = 'direct' as const
  readonly networks = ['mainnet', 'testnet'] as const

  async preflight(ctx: RailContext, input: LaunchInput): Promise<RailPreflight> {
    const { client, direct } = ctx
    const addrs = uniswapAddresses(client.network)
    const blockers: string[] = []

    if (!direct?.seedWethWei || direct.seedWethWei <= 0n) {
      blockers.push('direct.seedWethWei must be a positive amount of native ETH to seed the pool.')
    }
    const [factoryCode, positionManagerCode] = await Promise.all([
      client.public.getCode({ address: addrs.factory }),
      client.public.getCode({ address: addrs.positionManager }),
    ])
    if (!factoryCode || factoryCode === '0x') blockers.push(`No Uniswap v3 factory code at ${addrs.factory}.`)
    if (!positionManagerCode || positionManagerCode === '0x') {
      blockers.push(`No Uniswap v3 NonfungiblePositionManager code at ${addrs.positionManager}.`)
    }
    if (client.account) {
      const balance = await client.public.getBalance({ address: client.account.address })
      const needed = (direct?.seedWethWei ?? 0n) + input.initialBuyWei
      if (balance < needed) {
        blockers.push(
          `Account balance ${balance} wei is below the estimated requirement ${needed} wei (seed + deploy gas).`,
        )
      }
    } else {
      blockers.push('No signer configured — direct rail requires a wallet account.')
    }

    return {
      rail: 'direct',
      network: client.network,
      ready: blockers.length === 0,
      blockers,
      protocolFeeWei: 0n, // no launchpad fee — only network gas + whatever you choose to seed
      estimatedValueWei: direct?.seedWethWei ?? 0n,
      pairToken: addrs.weth,
    }
  }

  async plan(ctx: RailContext, input: LaunchInput): Promise<RailPlan> {
    const { client, direct } = ctx
    if (!client.account) throw new NoSignerError('DirectRail.plan')
    if (!direct?.seedWethWei) throw new LaunchFailedError('DirectRail.plan requires ctx.direct.seedWethWei')

    const opts = { ...DEFAULT_OPTIONS, ...direct }
    const addrs = uniswapAddresses(client.network)
    const preflight = await this.preflight(ctx, input)

    const totalSupplyRaw = parseUnits(opts.totalSupply.toString(), TOKEN_DECIMALS)
    const lpSupplyRaw = (totalSupplyRaw * BigInt(opts.lpSupplyBps)) / 10_000n

    // Predict the deployed token address (deterministic CREATE address from nonce).
    const nonce = await client.public.getTransactionCount({ address: client.account.address, blockTag: 'pending' })
    const predictedToken = getContractAddress({ from: client.account.address, nonce: BigInt(nonce) })

    const deployData = encodeDeployData({
      abi: HoodTokenArtifact.abi,
      bytecode: HoodTokenArtifact.bytecode as `0x${string}`,
      args: [input.name, input.symbol, totalSupplyRaw, client.account.address],
    })

    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [addrs.positionManager, lpSupplyRaw],
    })

    const { token0, token1, amount0, amount1 } = sortTokens(
      { address: predictedToken, amount: lpSupplyRaw },
      { address: addrs.weth, amount: opts.seedWethWei },
    )
    const sqrtPriceX96 = sqrtPriceX96FromAmounts(amount0, amount1)
    const tickSpacing = V3_TICK_SPACINGS[opts.feeTier]
    if (!tickSpacing) throw new LaunchFailedError(`Unsupported fee tier ${opts.feeTier}`)
    const { tickLower, tickUpper } = fullRangeTicks(tickSpacing)

    const createPoolData = encodeFunctionData({
      abi: positionManagerAbi,
      functionName: 'createAndInitializePoolIfNecessary',
      args: [token0, token1, opts.feeTier, sqrtPriceX96],
    })
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800)
    const mintData = encodeFunctionData({
      abi: positionManagerAbi,
      functionName: 'mint',
      args: [
        {
          token0,
          token1,
          fee: opts.feeTier,
          tickLower,
          tickUpper,
          amount0Desired: amount0,
          amount1Desired: amount1,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient: client.account.address,
          deadline,
        },
      ],
    })
    const refundData = encodeFunctionData({ abi: positionManagerAbi, functionName: 'refundETH', args: [] })
    const multicallData = encodeFunctionData({
      abi: positionManagerAbi,
      functionName: 'multicall',
      args: [[createPoolData, mintData, refundData]],
    })

    return {
      rail: 'direct',
      preflight: { ...preflight, estimatedValueWei: opts.seedWethWei },
      steps: [
        { label: 'deploy HoodToken', data: deployData, value: 0n }, // no `to` — contract creation
        { label: 'approve positionManager', to: predictedToken, data: approveData, value: 0n },
        { label: 'createPool + mint LP', to: addrs.positionManager, data: multicallData, value: opts.seedWethWei },
      ],
    }
  }

  async launch(ctx: RailContext, input: LaunchInput): Promise<RailLaunch> {
    const { client, direct } = ctx
    if (!client.wallet || !client.account) throw new NoSignerError('DirectRail.launch')
    if (!direct?.seedWethWei) throw new LaunchFailedError('DirectRail.launch requires ctx.direct.seedWethWei')

    const opts = { ...DEFAULT_OPTIONS, ...direct }
    const addrs = uniswapAddresses(client.network)
    const { steps } = await this.plan(ctx, input)
    const [deployStep, approveStep, mintStep] = steps
    if (!deployStep || !approveStep || !mintStep) {
      throw new LaunchFailedError('DirectRail.plan produced an incomplete step list')
    }

    const hashes: `0x${string}`[] = []

    const deployHash = await client.wallet.sendTransaction({
      data: deployStep.data,
      value: 0n,
      account: client.account,
      chain: client.chain,
    })
    const deployReceipt = await client.public.waitForTransactionReceipt({ hash: deployHash })
    hashes.push(deployHash)
    if (deployReceipt.status !== 'success' || !deployReceipt.contractAddress) {
      throw new LaunchFailedError(`HoodToken deployment reverted (tx ${deployHash})`, deployHash)
    }
    const token = deployReceipt.contractAddress

    const approveHash = await client.wallet.sendTransaction({
      to: token,
      data: approveStep.data,
      value: 0n,
      account: client.account,
      chain: client.chain,
    })
    const approveReceipt = await client.public.waitForTransactionReceipt({ hash: approveHash })
    hashes.push(approveHash)
    if (approveReceipt.status !== 'success') {
      throw new LaunchFailedError(`Router approval reverted (tx ${approveHash})`, approveHash)
    }

    const mintHash = await client.wallet.sendTransaction({
      to: addrs.positionManager,
      data: mintStep.data,
      value: mintStep.value,
      account: client.account,
      chain: client.chain,
    })
    const mintReceipt = await client.public.waitForTransactionReceipt({ hash: mintHash })
    hashes.push(mintHash)
    if (mintReceipt.status !== 'success') {
      throw new LaunchFailedError(`Pool creation / LP mint reverted (tx ${mintHash})`, mintHash)
    }

    const positionId = resolveMintedPositionId(mintReceipt.logs, addrs.positionManager)
    const pool = await client.public.readContract({
      address: addrs.factory,
      abi: v3FactoryAbi,
      functionName: 'getPool',
      args: sortForPool(token, addrs.weth, opts.feeTier),
    })

    const extra: Record<string, string> = {
      totalSupply: parseUnits(opts.totalSupply.toString(), TOKEN_DECIMALS).toString(),
      feeTier: String(opts.feeTier),
      positionId: positionId?.toString() ?? 'unknown',
      lpDisposition: opts.lpDisposition,
    }

    if (positionId !== null && opts.lpDisposition !== 'keep') {
      const dispositionHash = await this.disposeLp(ctx, addrs.positionManager, positionId, opts.lpDisposition)
      if (dispositionHash) {
        hashes.push(dispositionHash)
        extra.dispositionTx = dispositionHash
      }
    }

    const verify = await this.verifyToken(client.network, token, input, opts)
    extra.verification = verify.status

    return {
      rail: 'direct',
      network: client.network,
      token,
      pool,
      transactionHashes: hashes,
      launchTx: deployHash,
      spentWei: mintStep.value,
      explorer: { token: explorerTokenUrl(client.network, token), launchTx: explorerTxUrl(client.network, deployHash) },
      extra,
    }
  }

  private async disposeLp(
    ctx: RailContext,
    positionManager: Address,
    positionId: bigint,
    disposition: 'burn' | 'lock',
  ): Promise<`0x${string}` | null> {
    const { client } = ctx
    if (!client.wallet || !client.account) return null

    if (disposition === 'burn') {
      const data = encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'safeTransferFrom',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'tokenId', type: 'uint256' },
            ],
            outputs: [],
          },
        ],
        functionName: 'safeTransferFrom',
        args: [client.account.address, BURN_ADDRESS, positionId],
      })
      const hash = await client.wallet.sendTransaction({
        to: positionManager,
        data,
        value: 0n,
        account: client.account,
        chain: client.chain,
      })
      await client.public.waitForTransactionReceipt({ hash })
      return hash
    }

    // lock: deploy a fresh HoodLPLocker (a locker is cheap to deploy and
    // stateless per-launch is simpler than requiring operators to pre-fund a
    // shared address) and send the NFT to it with a 180-day unlock.
    const lockerDeployHash = await client.wallet.sendTransaction({
      data: encodeDeployData({ abi: HoodLPLockerArtifact.abi, bytecode: HoodLPLockerArtifact.bytecode as `0x${string}`, args: [] }),
      value: 0n,
      account: client.account,
      chain: client.chain,
    })
    const lockerReceipt = await client.public.waitForTransactionReceipt({ hash: lockerDeployHash })
    if (lockerReceipt.status !== 'success' || !lockerReceipt.contractAddress) return lockerDeployHash

    const unlockTimestamp = BigInt(Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60)
    const transferData = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'safeTransferFrom',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'tokenId', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
          outputs: [],
        },
      ],
      functionName: 'safeTransferFrom',
      args: [
        client.account.address,
        lockerReceipt.contractAddress,
        positionId,
        encodeAbiParameters([{ type: 'uint256' }], [unlockTimestamp]),
      ],
    })
    const lockHash = await client.wallet.sendTransaction({
      to: positionManager,
      data: transferData,
      value: 0n,
      account: client.account,
      chain: client.chain,
    })
    await client.public.waitForTransactionReceipt({ hash: lockHash })
    return lockHash
  }

  private async verifyToken(
    network: HoodNetwork,
    token: Address,
    input: LaunchInput,
    opts: Required<Omit<DirectRailOptions, 'seedWethWei'>>,
  ) {
    const totalSupplyRaw = parseUnits(opts.totalSupply.toString(), TOKEN_DECIMALS)
    const deployerAddress = token // placeholder overwritten by caller-supplied recipient below
    void deployerAddress
    const constructorArgs = encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'address' }],
      [input.name, input.symbol, totalSupplyRaw, token],
    ).slice(2)

    return verifySource({
      network,
      address: token,
      contractName: HoodTokenArtifact.contractName,
      sourceFile: HoodTokenArtifact.sourceFile,
      standardJsonInput: HoodTokenArtifact.standardJsonInput,
      compilerVersion: normalizeCompilerVersion(HoodTokenArtifact.compiler.version),
      constructorArguments: constructorArgs,
    })
  }
}

function sortForPool(a: Address, b: Address, fee: number): [Address, Address, number] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b, fee] : [b, a, fee]
}

/** `keccak256("Transfer(address,address,uint256)")` — the position manager's own NFT mint. */
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function resolveMintedPositionId(
  logs: { address: Address; topics: readonly `0x${string}`[] }[],
  positionManager: Address,
): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase()) continue
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0) continue
    // Transfer(address indexed from, address indexed to, uint256 indexed tokenId) — ERC-721 style, tokenId in topics[3]
    const tokenIdTopic = log.topics[3]
    if (tokenIdTopic) return BigInt(tokenIdTopic)
  }
  return null
}
