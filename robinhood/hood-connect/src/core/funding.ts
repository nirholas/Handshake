import { encodeFunctionData, erc20Abi, formatUnits, type Address, type Hex } from 'viem'
import { robinhood } from 'viem/chains'
import { FundingRouteError } from './errors.js'

/**
 * Funding funnel: live bridge routing onto Robinhood Chain (4663).
 *
 * Primary router is the LI.FI aggregation API (`li.quest`), which listed
 * Robinhood Chain (id 4663, key `out`) and returned executable quotes when
 * verified against the live API on 2026-07-15. Fallback is Relay
 * (`api.relay.link`), which lists the chain with `depositEnabled: true` and
 * also quoted live routes. Both APIs are keyless and CORS-open, so this
 * module works in the browser and in Node.
 */

/** Zero address = native token (ETH) on both APIs. */
export const NATIVE_TOKEN: Address = '0x0000000000000000000000000000000000000000'

/** LI.FI REST base URL. */
export const LIFI_API = 'https://li.quest/v1'

/** Relay REST base URL. */
export const RELAY_API = 'https://api.relay.link'

/** A source chain users can bridge from. */
export interface FundingChain {
  id: number
  name: string
  logoUrl?: string
}

/** Request for a bridge quote into Robinhood Chain. */
export interface FundingQuoteRequest {
  /** Chain the funds leave from (e.g. 42161 for Arbitrum One). */
  fromChainId: number
  /** Sender address on the source chain. */
  fromAddress: Address
  /** Amount in the source token's smallest units. */
  amount: bigint
  /** Source token. Default: native ETH. */
  fromToken?: Address
  /** Destination token on Robinhood Chain. Default: native ETH. */
  toToken?: Address
  /** Destination chain. Default: 4663 (Robinhood Chain mainnet). */
  toChainId?: number
  /** Recipient on the destination chain. Default: `fromAddress`. */
  toAddress?: Address
}

/** A transaction the user's wallet must send on the source chain. */
export interface FundingTx {
  chainId: number
  to: Address
  data: Hex
  value: bigint
  gasLimit?: bigint
}

/** ERC-20 approval required before the bridge transaction (LI.FI flow). */
export interface FundingApproval {
  token: Address
  spender: Address
  amount: bigint
  /** Ready-to-send `approve(spender, amount)` transaction. */
  tx: FundingTx
}

/** A live, executable bridge quote. */
export interface FundingQuote {
  provider: 'lifi' | 'relay'
  /** Routing tool reported by the aggregator (e.g. `relaydepository`). */
  tool: string
  fromChainId: number
  toChainId: number
  fromAmount: bigint
  /** Estimated amount received on Robinhood Chain (destination token units). */
  toAmount: bigint
  /** `toAmount` formatted with the destination token's decimals. */
  toAmountFormatted: string
  /** Destination token symbol. */
  toSymbol: string
  /** USD value of the received amount, when the API reports it. */
  toAmountUsd?: string
  /** Estimated bridge duration in seconds, when reported. */
  etaSeconds?: number
  /** Approval needed before `tx` (ERC-20 sources only). */
  approval?: FundingApproval
  /** The bridge transaction to send from the user's wallet. */
  tx: FundingTx
  /** Provider-specific handle used by {@link getFundingStatus}. */
  statusRef: string
  /** Raw API response for advanced consumers. */
  raw: unknown
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string' && value.length > 0) return BigInt(value)
  return 0n
}

interface LifiQuoteResponse {
  tool: string
  action: {
    fromChainId: number
    toChainId: number
    fromToken: { address: Address; decimals: number; symbol: string }
    toToken: { address: Address; decimals: number; symbol: string }
  }
  estimate: {
    approvalAddress?: Address
    fromAmount: string
    toAmount: string
    toAmountUSD?: string
    executionDuration?: number
  }
  transactionRequest: {
    chainId: number
    to: Address
    data: Hex
    value?: string
    gasLimit?: string
  }
}

/** Parse a LI.FI `/quote` response into a {@link FundingQuote}. */
export function parseLifiQuote(json: LifiQuoteResponse): FundingQuote {
  const { action, estimate, transactionRequest: txr } = json
  if (!txr?.to || !txr.data) throw new FundingRouteError('LI.FI quote had no transactionRequest.')

  const tx: FundingTx = {
    chainId: txr.chainId,
    to: txr.to,
    data: txr.data,
    value: toBigInt(txr.value),
    ...(txr.gasLimit ? { gasLimit: toBigInt(txr.gasLimit) } : {}),
  }

  const quote: FundingQuote = {
    provider: 'lifi',
    tool: json.tool,
    fromChainId: action.fromChainId,
    toChainId: action.toChainId,
    fromAmount: toBigInt(estimate.fromAmount),
    toAmount: toBigInt(estimate.toAmount),
    toAmountFormatted: formatUnits(toBigInt(estimate.toAmount), action.toToken.decimals),
    toSymbol: action.toToken.symbol,
    tx,
    statusRef: 'lifi',
    raw: json,
  }
  if (estimate.toAmountUSD) quote.toAmountUsd = estimate.toAmountUSD
  if (typeof estimate.executionDuration === 'number') quote.etaSeconds = estimate.executionDuration

  const fromToken = action.fromToken.address.toLowerCase()
  if (fromToken !== NATIVE_TOKEN && estimate.approvalAddress) {
    const amount = toBigInt(estimate.fromAmount)
    quote.approval = {
      token: action.fromToken.address,
      spender: estimate.approvalAddress,
      amount,
      tx: {
        chainId: action.fromChainId,
        to: action.fromToken.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [estimate.approvalAddress, amount],
        }),
        value: 0n,
      },
    }
  }
  return quote
}

interface RelayQuoteResponse {
  steps: Array<{
    id: string
    kind: string
    requestId?: string
    items: Array<{
      status: string
      data: { from: Address; to: Address; data: Hex; value?: string; chainId: number; gas?: string }
      check?: { endpoint: string; method: string }
    }>
  }>
  details: {
    currencyOut: {
      currency: { decimals: number; symbol: string }
      amount: string
      amountUsd?: string
    }
    currencyIn: { amount: string }
    timeEstimate?: number
  }
}

/** Parse a Relay `/quote` response into a {@link FundingQuote}. */
export function parseRelayQuote(json: RelayQuoteResponse): FundingQuote {
  const steps = json.steps ?? []
  const txSteps = steps.filter((s) => s.kind === 'transaction' && s.items?.[0]?.data)
  if (txSteps.length === 0) throw new FundingRouteError('Relay quote had no transaction step.')

  // Relay puts an ERC-20 approval in its own step before the deposit.
  const approveStep = txSteps.find((s) => /approv/i.test(s.id))
  const depositStep = txSteps.find((s) => !/approv/i.test(s.id)) ?? txSteps[txSteps.length - 1]!
  const depositItem = depositStep.items[0]!
  const out = json.details.currencyOut

  const quote: FundingQuote = {
    provider: 'relay',
    tool: 'relay',
    fromChainId: depositItem.data.chainId,
    toChainId: out.currency && 'chainId' in (out.currency as object) ? (out.currency as { chainId?: number }).chainId ?? robinhood.id : robinhood.id,
    fromAmount: toBigInt(json.details.currencyIn?.amount),
    toAmount: toBigInt(out.amount),
    toAmountFormatted: formatUnits(toBigInt(out.amount), out.currency.decimals),
    toSymbol: out.currency.symbol,
    tx: {
      chainId: depositItem.data.chainId,
      to: depositItem.data.to,
      data: depositItem.data.data,
      value: toBigInt(depositItem.data.value),
      ...(depositItem.data.gas ? { gasLimit: toBigInt(depositItem.data.gas) } : {}),
    },
    statusRef: depositItem.check?.endpoint ?? (depositStep.requestId ? `/intents/status?requestId=${depositStep.requestId}` : ''),
    raw: json,
  }
  if (out.amountUsd) quote.toAmountUsd = out.amountUsd
  if (typeof json.details.timeEstimate === 'number') quote.etaSeconds = json.details.timeEstimate

  if (approveStep?.items?.[0]?.data) {
    const a = approveStep.items[0].data
    quote.approval = {
      token: a.to,
      spender: quote.tx.to,
      amount: quote.fromAmount,
      tx: { chainId: a.chainId, to: a.to, data: a.data, value: toBigInt(a.value) },
    }
  }
  return quote
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init)
  const body = await res.text()
  if (!res.ok) {
    throw new FundingRouteError(`${new URL(url).host} responded ${res.status}: ${body.slice(0, 300)}`)
  }
  return JSON.parse(body)
}

/** Quote a route via LI.FI. Throws {@link FundingRouteError} when no route exists. */
export async function getLifiQuote(request: FundingQuoteRequest): Promise<FundingQuote> {
  const params = new URLSearchParams({
    fromChain: String(request.fromChainId),
    toChain: String(request.toChainId ?? robinhood.id),
    fromToken: request.fromToken ?? NATIVE_TOKEN,
    toToken: request.toToken ?? NATIVE_TOKEN,
    fromAmount: request.amount.toString(),
    fromAddress: request.fromAddress,
  })
  if (request.toAddress) params.set('toAddress', request.toAddress)
  const json = (await fetchJson(`${LIFI_API}/quote?${params}`)) as LifiQuoteResponse
  return parseLifiQuote(json)
}

/** Quote a route via Relay. Throws {@link FundingRouteError} when no route exists. */
export async function getRelayQuote(request: FundingQuoteRequest): Promise<FundingQuote> {
  const json = (await fetchJson(`${RELAY_API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: request.fromAddress,
      recipient: request.toAddress ?? request.fromAddress,
      originChainId: request.fromChainId,
      destinationChainId: request.toChainId ?? robinhood.id,
      originCurrency: request.fromToken ?? NATIVE_TOKEN,
      destinationCurrency: request.toToken ?? NATIVE_TOKEN,
      amount: request.amount.toString(),
      tradeType: 'EXACT_INPUT',
    }),
  })) as RelayQuoteResponse
  return parseRelayQuote(json)
}

/**
 * Quote the best available route into Robinhood Chain: LI.FI first, Relay
 * as fallback. Throws {@link FundingRouteError} with both failures attached
 * when neither can route.
 */
export async function getFundingQuote(request: FundingQuoteRequest): Promise<FundingQuote> {
  let lifiError: unknown
  try {
    return await getLifiQuote(request)
  } catch (error) {
    lifiError = error
  }
  try {
    return await getRelayQuote(request)
  } catch (relayError) {
    throw new FundingRouteError(
      `No bridge route found. LI.FI: ${lifiError instanceof Error ? lifiError.message : String(lifiError)}. Relay: ${relayError instanceof Error ? relayError.message : String(relayError)}`,
      relayError,
    )
  }
}

/** Bridge progress states reported by {@link getFundingStatus}. */
export type FundingStatus = 'pending' | 'done' | 'failed' | 'unknown'

/**
 * Check the status of a sent bridge transaction. Pass the quote that
 * produced it and the source-chain transaction hash.
 */
export async function getFundingStatus(quote: FundingQuote, txHash: Hex): Promise<FundingStatus> {
  if (quote.provider === 'lifi') {
    const json = (await fetchJson(`${LIFI_API}/status?txHash=${txHash}`)) as { status?: string }
    if (json.status === 'DONE') return 'done'
    if (json.status === 'FAILED') return 'failed'
    if (json.status === 'PENDING' || json.status === 'NOT_FOUND') return 'pending'
    return 'unknown'
  }
  if (!quote.statusRef) return 'unknown'
  const json = (await fetchJson(`${RELAY_API}${quote.statusRef}`)) as { status?: string }
  if (json.status === 'success') return 'done'
  if (json.status === 'failure' || json.status === 'refund') return 'failed'
  if (json.status === 'pending' || json.status === 'waiting' || json.status === 'submitted') return 'pending'
  return 'unknown'
}

/**
 * Chains users can bridge FROM. Sourced live from LI.FI, falling back to
 * Relay; Robinhood Chain itself is filtered out of the list.
 */
export async function listFundingChains(): Promise<FundingChain[]> {
  try {
    const json = (await fetchJson(`${LIFI_API}/chains`)) as {
      chains: Array<{ id: number; name: string; logoURI?: string }>
    }
    return json.chains
      .filter((c) => c.id !== robinhood.id)
      .map((c) => ({ id: c.id, name: c.name, ...(c.logoURI ? { logoUrl: c.logoURI } : {}) }))
  } catch {
    const json = (await fetchJson(`${RELAY_API}/chains`)) as {
      chains: Array<{ id: number; displayName: string; disabled?: boolean }>
    }
    return json.chains
      .filter((c) => c.id !== robinhood.id && !c.disabled)
      .map((c) => ({ id: c.id, name: c.displayName }))
  }
}
