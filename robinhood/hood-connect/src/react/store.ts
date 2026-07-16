import type { Address } from 'viem'
import { chainForNetwork, type HoodNetwork } from '../core/chains.js'
import { watchWallets, legacyProviderDetail, type Eip6963ProviderDetail } from '../core/discovery.js'
import { ensureChain, type EnsureChainState } from '../core/ensure-chain.js'
import { HoodConnectError, providerErrorMessage } from '../core/errors.js'

/**
 * A tiny module-level store so every hood-connect hook and component in the
 * app shares one connection state (button, funding funnel, custom hooks)
 * without requiring a React context provider. Consumed via
 * `useSyncExternalStore`.
 */

/** Connection lifecycle status. */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'switching'
  | 'adding'
  | 'connected'
  | 'error'

/** Immutable snapshot of the shared connection state. */
export interface ConnectionSnapshot {
  status: ConnectionStatus
  network: HoodNetwork
  /** Wallets discovered via EIP-6963 (plus the legacy fallback). */
  wallets: Eip6963ProviderDetail[]
  /** True once the discovery window has elapsed at least once. */
  discoveryReady: boolean
  wallet?: Eip6963ProviderDetail
  address?: Address
  /** The wallet's current chain ID (tracked via `chainChanged`). */
  chainId?: number
  error?: HoodConnectError
}

const STORAGE_KEY = 'hood-connect:last-wallet'

let snapshot: ConnectionSnapshot = {
  status: 'disconnected',
  network: 'mainnet',
  wallets: [],
  discoveryReady: false,
}

const listeners = new Set<() => void>()
let discoveryStarted = false
let activeProviderCleanup: (() => void) | undefined

function setSnapshot(patch: Partial<ConnectionSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

export function getSnapshot(): ConnectionSnapshot {
  return snapshot
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  startDiscovery()
  return () => listeners.delete(listener)
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function startDiscovery(): void {
  if (discoveryStarted || typeof window === 'undefined') return
  discoveryStarted = true

  watchWallets((wallets) => {
    setSnapshot({ wallets, discoveryReady: true })
    void tryReconnect(wallets)
  })

  // Close the discovery window: after 500ms fall back to legacy
  // window.ethereum when nothing announced, and mark discovery done either
  // way so UIs can leave their loading state.
  setTimeout(() => {
    if (snapshot.wallets.length === 0) {
      const legacy = legacyProviderDetail()
      if (legacy) {
        setSnapshot({ wallets: [legacy], discoveryReady: true })
        void tryReconnect([legacy])
        return
      }
    }
    setSnapshot({ discoveryReady: true })
  }, 500)
}

let reconnectAttempted = false

/** Silent session restore: reconnect the last-used wallet when it is already authorized. */
async function tryReconnect(wallets: Eip6963ProviderDetail[]): Promise<void> {
  if (reconnectAttempted || snapshot.status !== 'disconnected') return
  const lastRdns = storage()?.getItem(STORAGE_KEY)
  if (!lastRdns) return
  const wallet = wallets.find((w) => w.info.rdns === lastRdns)
  if (!wallet) return
  reconnectAttempted = true
  try {
    const accounts = (await wallet.provider.request({ method: 'eth_accounts' })) as Address[]
    if (!accounts?.[0]) return
    const chainIdHex = (await wallet.provider.request({ method: 'eth_chainId' })) as string
    adoptConnection(wallet, accounts[0], Number.parseInt(chainIdHex, 16))
  } catch {
    // Silent restore is best-effort; the user can always connect manually.
  }
}

function adoptConnection(wallet: Eip6963ProviderDetail, address: Address, chainId: number): void {
  activeProviderCleanup?.()

  const onAccountsChanged = (accounts: Address[]) => {
    if (!accounts || accounts.length === 0) {
      disconnect()
    } else {
      setSnapshot({ address: accounts[0] })
    }
  }
  const onChainChanged = (chainIdHex: string) => {
    setSnapshot({ chainId: Number.parseInt(chainIdHex, 16) })
  }

  wallet.provider.on?.('accountsChanged', onAccountsChanged as (...args: never[]) => void)
  wallet.provider.on?.('chainChanged', onChainChanged as (...args: never[]) => void)
  activeProviderCleanup = () => {
    wallet.provider.removeListener?.('accountsChanged', onAccountsChanged as (...args: never[]) => void)
    wallet.provider.removeListener?.('chainChanged', onChainChanged as (...args: never[]) => void)
    activeProviderCleanup = undefined
  }

  storage()?.setItem(STORAGE_KEY, wallet.info.rdns)
  setSnapshot({ status: 'connected', wallet, address, chainId, error: undefined })
}

/**
 * Connect a wallet and ensure it is on the requested network. Updates the
 * shared snapshot through every phase; resolves on success, records the
 * typed error (and rethrows) on failure.
 */
export async function connect(wallet: Eip6963ProviderDetail, network: HoodNetwork = 'mainnet'): Promise<void> {
  setSnapshot({ network, error: undefined })
  const onState = (state: EnsureChainState) => {
    if (state.status === 'connecting' || state.status === 'switching' || state.status === 'adding') {
      setSnapshot({ status: state.status, wallet })
    }
  }
  try {
    const result = await ensureChain(wallet.provider, { network, onState })
    adoptConnection(wallet, result.address, result.chainId)
  } catch (error) {
    const wrapped =
      error instanceof HoodConnectError ? error : new HoodConnectError(providerErrorMessage(error), { cause: error })
    setSnapshot({ status: 'error', error: wrapped })
    throw wrapped
  }
}

/** Re-run the add/switch flow on the already-connected wallet (wrong-chain recovery). */
export async function switchToTarget(): Promise<void> {
  const { wallet, network } = snapshot
  if (!wallet) throw new HoodConnectError('No wallet is connected.')
  await connect(wallet, network)
}

/** Drop the connection (local state; injected wallets have no programmatic logout). */
export function disconnect(): void {
  activeProviderCleanup?.()
  storage()?.removeItem(STORAGE_KEY)
  setSnapshot({
    status: 'disconnected',
    wallet: undefined,
    address: undefined,
    chainId: undefined,
    error: undefined,
  })
}

/** True when connected but on a different chain than the configured network. */
export function isWrongChain(snap: ConnectionSnapshot): boolean {
  return snap.status === 'connected' && snap.chainId !== undefined && snap.chainId !== chainForNetwork(snap.network).id
}
