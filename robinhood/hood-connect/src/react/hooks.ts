import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { chainForNetwork, type HoodNetwork } from '../core/chains.js'
import type { Eip6963ProviderDetail } from '../core/discovery.js'
import { ensureChain, type EnsureChainState } from '../core/ensure-chain.js'
import { checkBootstrap, type BootstrapStatus } from '../core/bootstrap.js'
import type { Eip1193Provider } from '../core/provider.js'
import {
  connect as storeConnect,
  disconnect as storeDisconnect,
  getSnapshot,
  isWrongChain,
  subscribe,
  switchToTarget,
  type ConnectionSnapshot,
} from './store.js'

/** Wallets discovered via EIP-6963 (with legacy fallback) and readiness flag. */
export function useWallets(): { wallets: Eip6963ProviderDetail[]; ready: boolean } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { wallets: snap.wallets, ready: snap.discoveryReady }
}

/** Everything `useHoodAccount` returns. */
export interface HoodAccount extends ConnectionSnapshot {
  /** True when connected but on the wrong chain (user switched away). */
  wrongChain: boolean
  /** Live ETH/USDG balances + funding options; undefined until loaded. */
  bootstrap?: BootstrapStatus
  /** Reload balances. */
  refreshBalances: () => Promise<void>
  connect: (wallet: Eip6963ProviderDetail) => Promise<void>
  /** Re-run add/switch on the connected wallet. */
  switchChain: () => Promise<void>
  disconnect: () => void
}

/**
 * The shared Robinhood Chain account: connection status, address, chain,
 * live ETH/USDG balances, and connect/disconnect actions. Every instance of
 * this hook in the app observes the same connection.
 */
export function useHoodAccount(options: { network?: HoodNetwork } = {}): HoodAccount {
  const network = options.network ?? 'mainnet'
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | undefined>(undefined)
  const requestSeq = useRef(0)

  const address = snap.status === 'connected' ? snap.address : undefined

  const refreshBalances = useCallback(async () => {
    if (!address) {
      setBootstrap(undefined)
      return
    }
    const seq = ++requestSeq.current
    try {
      const status = await checkBootstrap(address, { network })
      if (seq === requestSeq.current) setBootstrap(status)
    } catch {
      // RPC hiccup: keep the previous reading rather than flashing empty.
    }
  }, [address, network])

  useEffect(() => {
    void refreshBalances()
  }, [refreshBalances])

  const connect = useCallback((wallet: Eip6963ProviderDetail) => storeConnect(wallet, network), [network])

  return {
    ...snap,
    network,
    wrongChain: isWrongChain({ ...snap, network }),
    bootstrap,
    refreshBalances,
    connect,
    switchChain: switchToTarget,
    disconnect: storeDisconnect,
  }
}

/** State exposed by {@link useEnsureChain} before the flow starts. */
export type UseEnsureChainState = EnsureChainState | { status: 'idle' }

/**
 * Headless access to the connect + add + switch flow for fully custom UIs:
 * returns the current phase and a `run(provider)` trigger.
 */
export function useEnsureChain(options: { network?: HoodNetwork } = {}): {
  state: UseEnsureChainState
  run: (provider: Eip1193Provider) => Promise<void>
  targetChainId: number
} {
  const network = options.network ?? 'mainnet'
  const [state, setState] = useState<UseEnsureChainState>({ status: 'idle' })

  const run = useCallback(
    async (provider: Eip1193Provider) => {
      try {
        await ensureChain(provider, { network, onState: setState })
      } catch {
        // Terminal state already captured via onState('error').
      }
    },
    [network],
  )

  return { state, run, targetChainId: chainForNetwork(network).id }
}
