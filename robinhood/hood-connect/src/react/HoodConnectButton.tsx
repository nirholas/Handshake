import { useCallback, useEffect, useRef, useState } from 'react'
import { chainForNetwork, type HoodNetwork } from '../core/chains.js'
import type { Eip6963ProviderDetail } from '../core/discovery.js'
import { useHoodAccount } from './hooks.js'
import { injectStyles } from './styles.js'

/** Props for {@link HoodConnectButton}. */
export interface HoodConnectButtonProps {
  /** Target network. Default `'mainnet'` (4663). */
  network?: HoodNetwork
  /** Show live ETH/USDG balances in the connected pill. Default true. */
  showBalances?: boolean
  /** Skip the default skin injection (bring your own CSS for `.hc-*`). */
  unstyled?: boolean
  /** Called once per successful connection. */
  onConnected?: (account: { address: string; chainId: number }) => void
  /** Called when the user clicks "Fund wallet" on an empty connected wallet. */
  onFund?: () => void
  /** Extra class for the root element. */
  className?: string
}

const INSTALL_LINKS: Array<{ name: string; url: string }> = [
  { name: 'MetaMask', url: 'https://metamask.io/download/' },
  { name: 'Rabby', url: 'https://rabby.io/' },
  { name: 'Coinbase Wallet', url: 'https://www.coinbase.com/wallet/downloads' },
]

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function trimAmount(value: string, digits = 4): string {
  const [whole = '0', frac = ''] = value.split('.')
  const trimmedFrac = frac.slice(0, digits).replace(/0+$/, '')
  return trimmedFrac ? `${whole}.${trimmedFrac}` : whole
}

/**
 * The whole Robinhood Chain onboarding flow in one component: discover
 * wallets (EIP-6963), connect, add/switch to chain 4663, then show the
 * address with live ETH/USDG balances. Every state is designed:
 * no-wallet-installed, disconnected, wallet picker, connecting, adding,
 * switching, wrong-chain, connected, empty-wallet, and error.
 */
export function HoodConnectButton(props: HoodConnectButtonProps): React.JSX.Element {
  const { network = 'mainnet', showBalances = true, unstyled = false, onConnected, onFund, className } = props
  const account = useHoodAccount({ network })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const chain = chainForNetwork(network)

  useEffect(() => {
    if (!unstyled) injectStyles()
  }, [unstyled])

  const notifiedFor = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (account.status === 'connected' && account.address && notifiedFor.current !== account.address) {
      notifiedFor.current = account.address
      onConnected?.({ address: account.address, chainId: account.chainId ?? chain.id })
    }
    if (account.status !== 'connected') notifiedFor.current = undefined
  }, [account.status, account.address, account.chainId, chain.id, onConnected])

  useEffect(() => {
    if (!pickerOpen && !menuOpen) return
    const onOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPickerOpen(false)
        setMenuOpen(false)
      }
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false)
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onEscape)
    }
  }, [pickerOpen, menuOpen])

  const connectWith = useCallback(
    async (wallet: Eip6963ProviderDetail) => {
      setPickerOpen(false)
      try {
        await account.connect(wallet)
      } catch {
        // Error state is rendered from the store snapshot.
      }
    },
    [account],
  )

  const onConnectClick = useCallback(() => {
    if (account.wallets.length === 1) {
      void connectWith(account.wallets[0]!)
    } else {
      setPickerOpen((open) => !open)
    }
  }, [account.wallets, connectWith])

  const copyAddress = useCallback(async () => {
    if (!account.address) return
    await navigator.clipboard.writeText(account.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [account.address])

  const rootClass = ['hc-scope', className].filter(Boolean).join(' ')

  // Discovery still running.
  if (!account.discoveryReady) {
    return (
      <div className={rootClass} ref={rootRef}>
        <button className="hc-btn hc-btn--secondary" disabled aria-busy="true">
          <span className="hc-spinner" aria-hidden="true" />
          Looking for wallets
        </button>
      </div>
    )
  }

  // No wallet installed.
  if (account.wallets.length === 0) {
    return (
      <div className={rootClass} ref={rootRef}>
        <div className="hc-install">
          <span className="hc-hint">No wallet extension found. Install one, then reload this page:</span>
          <div className="hc-install-links">
            {INSTALL_LINKS.map((link) => (
              <a key={link.name} href={link.url} target="_blank" rel="noreferrer noopener">
                {link.name}
              </a>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Busy phases.
  if (account.status === 'connecting' || account.status === 'switching' || account.status === 'adding') {
    const label =
      account.status === 'connecting'
        ? 'Confirm in wallet'
        : account.status === 'adding'
          ? `Adding ${chain.name}`
          : `Switching to ${chain.name}`
    return (
      <div className={rootClass} ref={rootRef}>
        <button className="hc-btn" disabled aria-busy="true">
          <span className="hc-spinner" aria-hidden="true" />
          {label}
        </button>
      </div>
    )
  }

  // Connected but the user moved to another chain.
  if (account.status === 'connected' && account.wrongChain) {
    return (
      <div className={rootClass} ref={rootRef}>
        <button className="hc-btn" onClick={() => void account.switchChain()}>
          <span className="hc-dot hc-dot--warn" aria-hidden="true" />
          Switch to {chain.name}
        </button>
        <p className="hc-hint">
          {account.address ? shortAddress(account.address) : 'Your wallet'} is on chain {account.chainId}. This app
          runs on {chain.name} (chain {chain.id}).
        </p>
      </div>
    )
  }

  // Connected.
  if (account.status === 'connected' && account.address) {
    const explorer = chain.blockExplorers?.default?.url
    const empty = account.bootstrap ? !account.bootstrap.funded : false
    return (
      <div className={rootClass} ref={rootRef}>
        <div className="hc-menu-wrap">
          <button
            className="hc-pill"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="hc-dot" aria-hidden="true" />
            {shortAddress(account.address)}
            {showBalances && account.bootstrap && (
              <span className="hc-balances">
                <span>
                  <strong>{trimAmount(account.bootstrap.ethFormatted, 5)}</strong> ETH
                </span>
                <span>
                  <strong>{trimAmount(account.bootstrap.usdgFormatted, 2)}</strong> USDG
                </span>
              </span>
            )}
          </button>
          {menuOpen && (
            <div className="hc-menu" role="menu">
              <button className="hc-menu-item" role="menuitem" onClick={() => void copyAddress()}>
                {copied ? 'Copied' : 'Copy address'}
              </button>
              {explorer && (
                <a
                  className="hc-menu-item"
                  role="menuitem"
                  href={`${explorer}/address/${account.address}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  View on explorer
                </a>
              )}
              <button className="hc-menu-item" role="menuitem" onClick={() => void account.refreshBalances()}>
                Refresh balances
              </button>
              <button
                className="hc-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  account.disconnect()
                }}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
        {empty && (
          <p className="hc-hint">
            This wallet is empty on {chain.name}.{' '}
            {onFund ? (
              <a
                href="#fund"
                onClick={(event) => {
                  event.preventDefault()
                  onFund()
                }}
              >
                Fund it now
              </a>
            ) : (
              'Bridge ETH in with the FundWallet component.'
            )}
          </p>
        )}
      </div>
    )
  }

  // Disconnected (default) and error states share the connect entry point.
  return (
    <div className={rootClass} ref={rootRef}>
      <div className="hc-menu-wrap">
        <button className="hc-btn" onClick={onConnectClick} aria-haspopup={account.wallets.length > 1 ? 'menu' : undefined}>
          Connect wallet
        </button>
        {pickerOpen && (
          <div className="hc-menu" role="menu" aria-label="Choose a wallet">
            <div className="hc-menu-label">Choose a wallet</div>
            {account.wallets.map((wallet) => (
              <button
                key={wallet.info.uuid}
                className="hc-menu-item"
                role="menuitem"
                onClick={() => void connectWith(wallet)}
              >
                {wallet.info.icon && <img src={wallet.info.icon} alt="" aria-hidden="true" />}
                {wallet.info.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {account.status === 'error' && account.error && (
        <div className="hc-error" role="alert">
          {account.error.message} <span style={{ opacity: 0.8 }}>Click connect to try again.</span>
        </div>
      )}
    </div>
  )
}
