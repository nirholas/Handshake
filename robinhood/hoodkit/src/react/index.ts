import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Address } from 'viem'
import {
  getPortfolio,
  quoteSwap,
  executeSwap,
  type HoodClient,
  type Launch,
  type Portfolio,
  type SwapQuote,
} from 'hoodchain'
import { streamPrices, streamLaunches, type PriceTick } from '../stream/index.js'

/**
 * `hoodkit/react` — SSR-safe React hooks over the streaming + read layers.
 *
 * All subscriptions run inside `useEffect`, so hooks render inert on the server
 * and hydrate on the client. Provide a client via {@link HoodProvider} once, or
 * pass `{ client }` to any hook to override.
 *
 * @packageDocumentation
 */

const HoodContext = createContext<HoodClient | null>(null)

/** Provides a {@link HoodClient} to the hook tree. */
export function HoodProvider(props: { client: HoodClient; children: ReactNode }): ReactNode {
  return createElement(HoodContext.Provider, { value: props.client }, props.children)
}

/** Resolve the active client from an explicit override or the {@link HoodProvider}. */
export function useHoodClient(explicit?: HoodClient): HoodClient {
  const ctx = useContext(HoodContext)
  const client = explicit ?? ctx
  if (!client) {
    throw new Error('hoodkit/react: wrap your app in <HoodProvider client={...}> or pass { client } to the hook')
  }
  return client
}

/** Shared async-state shape returned by the read hooks. */
export interface AsyncState<T> {
  data: T | null
  isLoading: boolean
  error: Error | null
}

/** Options accepted by every hook: an optional client override. */
export interface HookOptions {
  client?: HoodClient
}

/**
 * Live Chainlink price for one Stock Token. Updates whenever the feed's round
 * advances. Returns `{ data, isLoading, error }`.
 *
 * @example
 * ```tsx
 * const { data } = useQuote('AAPL')
 * return <span>{data ? `$${data.priceUsd.toFixed(2)}` : '—'}</span>
 * ```
 */
export function useQuote(symbol: string, options: HookOptions & { pollingIntervalMs?: number } = {}): AsyncState<PriceTick> {
  const client = useHoodClient(options.client)
  const [state, setState] = useState<AsyncState<PriceTick>>({ data: null, isLoading: true, error: null })

  useEffect(() => {
    if (!symbol) return
    let active = true
    const stream = streamPrices(client, [symbol], { pollingIntervalMs: options.pollingIntervalMs })
    const offData = stream.on('data', (tick) => {
      if (active) setState({ data: tick, isLoading: false, error: null })
    })
    const offError = stream.on('error', (error) => {
      if (active) setState((s) => ({ ...s, isLoading: false, error }))
    })
    return () => {
      active = false
      offData()
      offError()
      stream.close()
    }
  }, [client, symbol, options.pollingIntervalMs])

  return state
}

/**
 * A wallet's Stock Token portfolio, multiplier-correct. Auto-refreshes on an
 * interval; returns `{ data, isLoading, error, refetch }`.
 */
export function usePortfolio(
  address: Address | undefined,
  options: HookOptions & { refetchIntervalMs?: number } = {},
): AsyncState<Portfolio> & { refetch: () => void } {
  const client = useHoodClient(options.client)
  const [state, setState] = useState<AsyncState<Portfolio>>({ data: null, isLoading: Boolean(address), error: null })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!address) {
      setState({ data: null, isLoading: false, error: null })
      return
    }
    let active = true
    setState((s) => ({ ...s, isLoading: true }))
    getPortfolio(client, address)
      .then((data) => active && setState({ data, isLoading: false, error: null }))
      .catch((error: Error) => active && setState((s) => ({ ...s, isLoading: false, error })))

    const interval = options.refetchIntervalMs
      ? setInterval(() => {
          getPortfolio(client, address)
            .then((data) => active && setState({ data, isLoading: false, error: null }))
            .catch((error: Error) => active && setState((s) => ({ ...s, error })))
        }, options.refetchIntervalMs)
      : null

    return () => {
      active = false
      if (interval) clearInterval(interval)
    }
  }, [client, address, options.refetchIntervalMs, nonce])

  return { ...state, refetch }
}

/**
 * Live launch feed from NOXA + The Odyssey, newest first, capped at `limit`.
 *
 * @example
 * ```tsx
 * const { launches } = useLaunches({ limit: 20 })
 * ```
 */
export function useLaunches(options: HookOptions & { limit?: number } = {}): { launches: Launch[]; isLoading: boolean; error: Error | null } {
  const client = useHoodClient(options.client)
  const limit = options.limit ?? 50
  const [launches, setLaunches] = useState<Launch[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let active = true
    const stream = streamLaunches(client)
    const offData = stream.on('data', (launch) => {
      if (!active) return
      setIsLoading(false)
      setLaunches((prev) => [launch, ...prev].slice(0, limit))
    })
    const offError = stream.on('error', (e) => {
      if (active) setError(e)
    })
    return () => {
      active = false
      offData()
      offError()
      stream.close()
    }
  }, [client, limit])

  return { launches, isLoading, error }
}

/** State + actions returned by {@link useSwap}. */
export interface UseSwapResult {
  quote: SwapQuote | null
  isQuoting: boolean
  isSwapping: boolean
  error: Error | null
  txHash: `0x${string}` | null
  /** Fetch a quote for the given swap. */
  getQuote: (args: { tokenIn: Address; tokenOut: Address; amountIn: bigint }) => Promise<SwapQuote | null>
  /** Execute the swap (requires a wallet-backed client). */
  swap: (
    args: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
    swapOptions?: { slippageBps?: number },
  ) => Promise<`0x${string}` | null>
  /** Reset quote/error/tx state. */
  reset: () => void
}

/**
 * A swap action hook: `getQuote` to preview and `swap` to execute. Execution
 * requires a wallet-backed client and, for Stock Token *outputs*, that the
 * client was created with `acknowledgeStockTokenEligibility: true`.
 */
export function useSwap(options: HookOptions = {}): UseSwapResult {
  const client = useHoodClient(options.client)
  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  const [isSwapping, setIsSwapping] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const getQuote = useCallback<UseSwapResult['getQuote']>(
    async (args) => {
      setIsQuoting(true)
      setError(null)
      try {
        const q = await quoteSwap(client, args)
        if (mounted.current) setQuote(q)
        return q
      } catch (e) {
        if (mounted.current) setError(e as Error)
        return null
      } finally {
        if (mounted.current) setIsQuoting(false)
      }
    },
    [client],
  )

  const swap = useCallback<UseSwapResult['swap']>(
    async (args, swapOptions) => {
      setIsSwapping(true)
      setError(null)
      try {
        const { hash } = await executeSwap(client, args, swapOptions)
        if (mounted.current) setTxHash(hash)
        return hash
      } catch (e) {
        if (mounted.current) setError(e as Error)
        return null
      } finally {
        if (mounted.current) setIsSwapping(false)
      }
    },
    [client],
  )

  const reset = useCallback(() => {
    setQuote(null)
    setError(null)
    setTxHash(null)
  }, [])

  return { quote, isQuoting, isSwapping, error, txHash, getQuote, swap, reset }
}
