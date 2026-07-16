import { describe, expect, it } from 'vitest'
import { discoverWallets, watchWallets, type Eip6963ProviderDetail, LEGACY_RDNS } from '../src/index.js'
import { scriptedProvider } from './harness/mock-provider.js'

/**
 * EIP-6963 discovery against a scripted announcer on an isolated
 * EventTarget (the protocol itself, not a copy of it): the harness answers
 * `eip6963:requestProvider` with `eip6963:announceProvider` CustomEvents
 * exactly like a wallet extension does.
 */

function makeDetail(uuid: string, name: string, rdns: string): Eip6963ProviderDetail {
  return {
    info: { uuid, name, icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns },
    provider: scriptedProvider({ eth_chainId: () => '0x1237' }),
  }
}

/** Scripted wallet extension: announces on request, like real wallets do. */
function announcer(target: EventTarget, details: Eip6963ProviderDetail[]): void {
  const announceAll = () => {
    for (const detail of details) {
      target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
    }
  }
  target.addEventListener('eip6963:requestProvider', announceAll)
}

describe('EIP-6963 discovery', () => {
  it('collects every announced wallet', async () => {
    const target = new EventTarget()
    announcer(target, [
      makeDetail('uuid-1', 'MetaMask', 'io.metamask'),
      makeDetail('uuid-2', 'Rabby', 'io.rabby'),
    ])
    const wallets = await discoverWallets({ target, timeoutMs: 20, includeLegacyFallback: false })
    expect(wallets.map((w) => w.info.name).sort()).toEqual(['MetaMask', 'Rabby'])
  })

  it('deduplicates repeated announcements by uuid', async () => {
    const target = new EventTarget()
    const detail = makeDetail('uuid-1', 'MetaMask', 'io.metamask')
    announcer(target, [detail, detail, detail])
    const wallets = await discoverWallets({ target, timeoutMs: 20, includeLegacyFallback: false })
    expect(wallets).toHaveLength(1)
  })

  it('ignores malformed announcements', async () => {
    const target = new EventTarget()
    target.addEventListener('eip6963:requestProvider', () => {
      target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: null, provider: null } }))
      target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: undefined }))
    })
    const wallets = await discoverWallets({ target, timeoutMs: 20, includeLegacyFallback: false })
    expect(wallets).toHaveLength(0)
  })

  it('watchWallets streams the growing list and unsubscribes cleanly', async () => {
    const target = new EventTarget()
    const seen: number[] = []
    const stop = watchWallets((wallets) => seen.push(wallets.length), { target })

    target.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: makeDetail('uuid-1', 'MetaMask', 'io.metamask') }),
    )
    target.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: makeDetail('uuid-2', 'Rabby', 'io.rabby') }),
    )
    expect(seen).toEqual([1, 2])

    stop()
    target.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: makeDetail('uuid-3', 'Zerion', 'io.zerion') }),
    )
    expect(seen).toEqual([1, 2])
  })

  it('falls back to legacy window.ethereum when nothing announces', async () => {
    const legacy = scriptedProvider({ eth_chainId: () => '0x1237' })
    ;(window as unknown as { ethereum?: unknown }).ethereum = legacy
    try {
      const wallets = await discoverWallets({ target: new EventTarget(), timeoutMs: 20 })
      expect(wallets).toHaveLength(1)
      expect(wallets[0]!.info.rdns).toBe(LEGACY_RDNS)
      expect(wallets[0]!.provider).toBe(legacy)
    } finally {
      delete (window as unknown as { ethereum?: unknown }).ethereum
    }
  })

  it('prefers announced wallets over the legacy fallback', async () => {
    const legacy = scriptedProvider({ eth_chainId: () => '0x1237' })
    ;(window as unknown as { ethereum?: unknown }).ethereum = legacy
    try {
      const target = new EventTarget()
      announcer(target, [makeDetail('uuid-1', 'MetaMask', 'io.metamask')])
      const wallets = await discoverWallets({ target, timeoutMs: 20 })
      expect(wallets).toHaveLength(1)
      expect(wallets[0]!.info.rdns).toBe('io.metamask')
    } finally {
      delete (window as unknown as { ethereum?: unknown }).ethereum
    }
  })
})
