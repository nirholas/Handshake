import type { Eip1193Provider, Eip1193RequestArguments } from '../../src/core/provider.js'

/**
 * TEST-ONLY EIP-1193 provider harness. Scripts wallet behavior per RPC
 * method so every ensure-chain path (rejections, 4902 variants, auto-switch
 * after add) is exercised deterministically. This file lives under `tests/`
 * and is never shipped: the npm package publishes `dist/` only.
 */

type Handler = (args: Eip1193RequestArguments) => unknown | Promise<unknown>

/** An EIP-1193 error carrying a wallet-style `code` (and optional `data`). */
export function rpcError(code: number, message: string, data?: unknown): Error & { code: number; data?: unknown } {
  const error = new Error(message) as Error & { code: number; data?: unknown }
  error.code = code
  if (data !== undefined) error.data = data
  return error
}

export interface ScriptedProvider extends Eip1193Provider {
  /** Every request made, in order. */
  calls: Eip1193RequestArguments[]
  /** Replace the handler for a method mid-test (e.g. chain added -> chainId changes). */
  set(method: string, handler: Handler): void
  /** Emit a provider event to registered listeners. */
  emit(event: string, ...args: unknown[]): void
}

/**
 * Build a scripted provider. `script` maps RPC method to either a static
 * value, an Error to throw, or a handler function. Unscripted methods throw,
 * so tests fail loudly on unexpected wallet traffic.
 */
export function scriptedProvider(script: Record<string, unknown | Error | Handler>): ScriptedProvider {
  const handlers = new Map<string, Handler>()
  for (const [method, behavior] of Object.entries(script)) {
    handlers.set(method, normalize(behavior))
  }

  const listeners = new Map<string, Set<(...args: never[]) => void>>()
  const calls: Eip1193RequestArguments[] = []

  return {
    calls,
    async request(args: Eip1193RequestArguments) {
      calls.push(args)
      const handler = handlers.get(args.method)
      if (!handler) throw rpcError(-32601, `Unscripted method: ${args.method}`)
      return handler(args)
    },
    set(method, handler) {
      handlers.set(method, handler)
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as (...a: unknown[]) => void)(...args)
      }
    },
  }
}

function normalize(behavior: unknown | Error | Handler): Handler {
  if (typeof behavior === 'function') return behavior as Handler
  if (behavior instanceof Error) {
    return () => {
      throw behavior
    }
  }
  return () => behavior
}

/**
 * A stateful wallet simulation: tracks its current chain and known chains,
 * approving connect/add/switch like a cooperative wallet would.
 */
export function cooperativeWallet(options: {
  address: string
  chainId: number
  knownChains?: number[]
  /** Wallets that auto-switch to a chain right after adding it (MetaMask behavior). */
  autoSwitchOnAdd?: boolean
}): ScriptedProvider {
  const known = new Set(options.knownChains ?? [options.chainId])
  let current = options.chainId

  const provider = scriptedProvider({
    eth_requestAccounts: () => [options.address],
    eth_accounts: () => [options.address],
    eth_chainId: () => `0x${current.toString(16)}`,
    wallet_switchEthereumChain: (args: Eip1193RequestArguments) => {
      const target = Number.parseInt((args.params as [{ chainId: string }])[0].chainId, 16)
      if (!known.has(target)) throw rpcError(4902, 'Unrecognized chain ID. Try adding the chain first.')
      current = target
      return null
    },
    wallet_addEthereumChain: (args: Eip1193RequestArguments) => {
      const target = Number.parseInt((args.params as [{ chainId: string }])[0].chainId, 16)
      known.add(target)
      if (options.autoSwitchOnAdd ?? true) current = target
      return null
    },
  })
  return provider
}
