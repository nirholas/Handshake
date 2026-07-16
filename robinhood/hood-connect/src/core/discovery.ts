import type { Eip1193Provider } from './provider.js'

/**
 * EIP-6963 multi-wallet discovery. Modern wallets announce themselves via
 * `eip6963:announceProvider` events instead of fighting over
 * `window.ethereum`; this module collects every announced wallet and falls
 * back to the legacy `window.ethereum` injection when no wallet speaks
 * EIP-6963.
 */

/** EIP-6963 wallet identity. */
export interface Eip6963ProviderInfo {
  uuid: string
  name: string
  /** Data URI icon, per the EIP. */
  icon: string
  /** Reverse-DNS wallet identifier, e.g. `io.metamask`. */
  rdns: string
}

/** An announced wallet: identity + its EIP-1193 provider. */
export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo
  provider: Eip1193Provider
}

/** Options for {@link watchWallets} / {@link discoverWallets}. */
export interface DiscoveryOptions {
  /**
   * Event target to listen on. Defaults to `window`. Injectable so the
   * discovery protocol is testable with a plain `EventTarget`.
   */
  target?: EventTarget
}

const ANNOUNCE_EVENT = 'eip6963:announceProvider'
const REQUEST_EVENT = 'eip6963:requestProvider'

/** rdns used for the synthesized legacy `window.ethereum` wallet entry. */
export const LEGACY_RDNS = 'injected.window.ethereum'

const LEGACY_ICON =
  'data:image/svg+xml;base64,' +
  (typeof btoa === 'function'
    ? btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">' +
          '<rect width="24" height="24" rx="6" fill="#1f2328"/>' +
          '<path d="M6 9.5a2.5 2.5 0 0 1 2.5-2.5h7A2.5 2.5 0 0 1 18 9.5v5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 14.5v-5Z" stroke="#00c805" stroke-width="1.5"/>' +
          '<circle cx="14.5" cy="12" r="1.25" fill="#00c805"/></svg>',
      )
    : '')

function defaultTarget(): EventTarget | undefined {
  return typeof window === 'undefined' ? undefined : window
}

/** The legacy `window.ethereum` provider, when one is injected. */
export function legacyProvider(): Eip1193Provider | undefined {
  if (typeof window === 'undefined') return undefined
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum
  return injected && typeof injected.request === 'function' ? injected : undefined
}

/** Wrap `window.ethereum` in an EIP-6963-shaped detail for uniform handling. */
export function legacyProviderDetail(): Eip6963ProviderDetail | undefined {
  const provider = legacyProvider()
  if (!provider) return undefined
  return {
    info: { uuid: LEGACY_RDNS, name: 'Injected wallet', icon: LEGACY_ICON, rdns: LEGACY_RDNS },
    provider,
  }
}

/**
 * Subscribe to EIP-6963 announcements. Fires `onWallets` with the full
 * deduplicated list every time a new wallet announces itself, and
 * immediately dispatches `eip6963:requestProvider` so already-loaded wallets
 * re-announce. Returns an unsubscribe function.
 */
export function watchWallets(
  onWallets: (wallets: Eip6963ProviderDetail[]) => void,
  options: DiscoveryOptions = {},
): () => void {
  const target = options.target ?? defaultTarget()
  if (!target) return () => {}

  const found = new Map<string, Eip6963ProviderDetail>()
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail
    if (!detail?.info?.uuid || !detail.provider || typeof detail.provider.request !== 'function') return
    if (found.has(detail.info.uuid)) return
    found.set(detail.info.uuid, Object.freeze({ info: { ...detail.info }, provider: detail.provider }))
    onWallets([...found.values()])
  }

  target.addEventListener(ANNOUNCE_EVENT, listener)
  target.dispatchEvent(new Event(REQUEST_EVENT))
  return () => target.removeEventListener(ANNOUNCE_EVENT, listener)
}

/** Options for {@link discoverWallets}. */
export interface DiscoverWalletsOptions extends DiscoveryOptions {
  /**
   * How long to collect announcements before resolving. EIP-6963 wallets
   * answer synchronously in practice; 300ms is a generous window.
   * @defaultValue 300
   */
  timeoutMs?: number
  /**
   * Include a synthesized entry for legacy `window.ethereum` when no wallet
   * announced via EIP-6963.
   * @defaultValue true
   */
  includeLegacyFallback?: boolean
}

/**
 * One-shot discovery: request announcements, collect for `timeoutMs`, and
 * resolve with every wallet found. When no EIP-6963 wallet answers but a
 * legacy `window.ethereum` exists, that provider is returned as a
 * synthesized entry (rdns {@link LEGACY_RDNS}) so single-wallet browsers
 * still connect.
 */
export async function discoverWallets(options: DiscoverWalletsOptions = {}): Promise<Eip6963ProviderDetail[]> {
  const timeoutMs = options.timeoutMs ?? 300
  const includeLegacy = options.includeLegacyFallback ?? true

  let latest: Eip6963ProviderDetail[] = []
  const stop = watchWallets((wallets) => {
    latest = wallets
  }, options)

  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  stop()

  if (latest.length === 0 && includeLegacy) {
    const legacy = legacyProviderDetail()
    if (legacy) return [legacy]
  }
  return latest
}
