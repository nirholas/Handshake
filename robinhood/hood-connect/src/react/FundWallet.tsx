import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { numberToHex, parseEther, type Hex } from 'viem'
import { chainForNetwork, type HoodNetwork } from '../core/chains.js'
import { providerErrorMessage } from '../core/errors.js'
import {
  getFundingQuote,
  getFundingStatus,
  listFundingChains,
  type FundingChain,
  type FundingQuote,
} from '../core/funding.js'
import { useHoodAccount } from './hooks.js'
import { injectStyles } from './styles.js'

/** Props for {@link FundWallet}. */
export interface FundWalletProps {
  /** Target network. Bridging is mainnet-only; testnet renders faucet guidance. */
  network?: HoodNetwork
  /** Skip the default skin injection. */
  unstyled?: boolean
  /** Called when a bridge deposit is confirmed on the destination. */
  onFunded?: () => void
  className?: string
}

/** Source chains pinned to the top of the selector, in this order. */
const FEATURED_CHAIN_IDS = [42161, 1, 8453, 10, 137]

type Phase =
  | { step: 'input' }
  | { step: 'switching' }
  | { step: 'approving' }
  | { step: 'sending' }
  | { step: 'bridging'; txHash: Hex }
  | { step: 'done'; txHash: Hex }
  | { step: 'failed'; txHash?: Hex; message: string }

function sortChains(chains: FundingChain[]): FundingChain[] {
  const featured = FEATURED_CHAIN_IDS.map((id) => chains.find((c) => c.id === id)).filter(
    (c): c is FundingChain => Boolean(c),
  )
  const rest = chains
    .filter((c) => !FEATURED_CHAIN_IDS.includes(c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...featured, ...rest]
}

/**
 * The funding funnel: bridge ETH from any supported chain onto Robinhood
 * Chain without leaving the dApp. Live quotes and route execution via LI.FI
 * (Relay fallback), plus a documented "from the Robinhood app" path. On
 * testnet it points at the faucets instead (there is nothing to bridge).
 */
export function FundWallet(props: FundWalletProps): React.JSX.Element {
  const { network = 'mainnet', unstyled = false, onFunded, className } = props
  const account = useHoodAccount({ network })
  const [tab, setTab] = useState<'bridge' | 'app'>('bridge')
  const [chains, setChains] = useState<FundingChain[] | undefined>(undefined)
  const [chainsError, setChainsError] = useState<string | undefined>(undefined)
  const [fromChainId, setFromChainId] = useState(42161)
  const [amount, setAmount] = useState('0.01')
  const [quote, setQuote] = useState<FundingQuote | undefined>(undefined)
  const [quoteError, setQuoteError] = useState<string | undefined>(undefined)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [phase, setPhase] = useState<Phase>({ step: 'input' })
  const quoteSeq = useRef(0)

  useEffect(() => {
    if (!unstyled) injectStyles()
  }, [unstyled])

  useEffect(() => {
    if (network !== 'mainnet') return
    let cancelled = false
    listFundingChains()
      .then((list) => {
        if (!cancelled) setChains(sortChains(list))
      })
      .catch((error: unknown) => {
        if (!cancelled) setChainsError(providerErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [network])

  const parsedAmount = useMemo(() => {
    try {
      const wei = parseEther(amount)
      return wei > 0n ? wei : undefined
    } catch {
      return undefined
    }
  }, [amount])

  // Debounced live quote.
  useEffect(() => {
    setQuote(undefined)
    setQuoteError(undefined)
    if (network !== 'mainnet' || !account.address || !parsedAmount) return
    const seq = ++quoteSeq.current
    setQuoteLoading(true)
    const timer = setTimeout(() => {
      getFundingQuote({ fromChainId, fromAddress: account.address!, amount: parsedAmount })
        .then((next) => {
          if (seq === quoteSeq.current) {
            setQuote(next)
            setQuoteLoading(false)
          }
        })
        .catch((error: unknown) => {
          if (seq === quoteSeq.current) {
            setQuoteError(providerErrorMessage(error))
            setQuoteLoading(false)
          }
        })
    }, 500)
    return () => clearTimeout(timer)
  }, [network, account.address, parsedAmount, fromChainId])

  const execute = useCallback(async () => {
    const provider = account.wallet?.provider
    if (!provider || !quote || !account.address) return
    try {
      setPhase({ step: 'switching' })
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: numberToHex(quote.tx.chainId) }],
      })

      if (quote.approval) {
        setPhase({ step: 'approving' })
        await provider.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: account.address,
              to: quote.approval.tx.to,
              data: quote.approval.tx.data,
              value: numberToHex(quote.approval.tx.value),
            },
          ],
        })
      }

      setPhase({ step: 'sending' })
      const txHash = (await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: account.address,
            to: quote.tx.to,
            data: quote.tx.data,
            value: numberToHex(quote.tx.value),
          },
        ],
      })) as Hex

      setPhase({ step: 'bridging', txHash })
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const status = await getFundingStatus(quote, txHash)
        if (status === 'done') {
          setPhase({ step: 'done', txHash })
          await account.refreshBalances()
          onFunded?.()
          return
        }
        if (status === 'failed') {
          setPhase({ step: 'failed', txHash, message: 'The bridge reported a failure. Funds were not delivered; check the source transaction.' })
          return
        }
      }
      // Still pending after the polling window: not a failure, just slow.
      setPhase({ step: 'done', txHash })
      await account.refreshBalances()
    } catch (error) {
      setPhase({ step: 'failed', message: providerErrorMessage(error) })
    }
  }, [account, quote, onFunded])

  const rootClass = ['hc-scope', 'hc-fund', className].filter(Boolean).join(' ')
  const targetChain = chainForNetwork(network)

  if (network === 'testnet') {
    return (
      <div className={rootClass}>
        <p className="hc-hint" style={{ marginTop: 0 }}>
          Testnet funds come from the faucets, not a bridge:
        </p>
        <ol className="hc-steps">
          <li>
            <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noreferrer noopener">
              Official faucet
            </a>{' '}
            drips testnet ETH and test Stock Tokens (requires Google sign-in).
          </li>
          <li>
            <a href="https://faucets.chain.link/robinhood-testnet" target="_blank" rel="noreferrer noopener">
              Chainlink faucet
            </a>{' '}
            drips testnet ETH.
          </li>
        </ol>
      </div>
    )
  }

  if (account.status !== 'connected' || !account.address) {
    return (
      <div className={rootClass}>
        <p className="hc-hint" style={{ margin: 0 }}>
          Connect a wallet first; the funding funnel bridges to your connected address on {targetChain.name}.
        </p>
      </div>
    )
  }

  return (
    <div className={rootClass}>
      <div className="hc-fund-tabs" role="tablist" aria-label="Funding method">
        <button role="tab" aria-selected={tab === 'bridge'} className="hc-fund-tab" onClick={() => setTab('bridge')}>
          Bridge from any chain
        </button>
        <button role="tab" aria-selected={tab === 'app'} className="hc-fund-tab" onClick={() => setTab('app')}>
          From the Robinhood app
        </button>
      </div>

      {tab === 'app' && (
        <ol className="hc-steps">
          <li>Open the Robinhood app or Robinhood Wallet and go to your <strong>ETH</strong> holding.</li>
          <li>Choose <strong>Send</strong> and pick the <strong>Robinhood Chain</strong> network (not Ethereum mainnet).</li>
          <li>
            Paste your connected address: <strong style={{ wordBreak: 'break-all' }}>{account.address}</strong>
          </li>
          <li>Confirm. Funds arrive on chain {targetChain.id} in about a minute; balances above refresh automatically.</li>
        </ol>
      )}

      {tab === 'bridge' && (
        <>
          {chainsError && !chains && (
            <div className="hc-error" role="alert">
              Could not load source chains: {chainsError}
            </div>
          )}
          {!chains && !chainsError && (
            <div className="hc-field" aria-busy="true">
              <label>From chain</label>
              <div className="hc-skeleton" style={{ height: 38 }} />
            </div>
          )}
          {chains && (
            <div className="hc-field">
              <label htmlFor="hc-from-chain">From chain</label>
              <select
                id="hc-from-chain"
                value={fromChainId}
                onChange={(event) => setFromChainId(Number(event.target.value))}
              >
                {chains.map((chain) => (
                  <option key={chain.id} value={chain.id}>
                    {chain.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="hc-field">
            <label htmlFor="hc-amount">Amount (ETH)</label>
            <input
              id="hc-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.01"
            />
          </div>

          {quoteLoading && (
            <div className="hc-quote" aria-busy="true" aria-label="Fetching live quote">
              <div className="hc-skeleton" />
              <div className="hc-skeleton" style={{ width: '70%' }} />
              <div className="hc-skeleton" style={{ width: '50%' }} />
            </div>
          )}
          {!quoteLoading && quoteError && parsedAmount && (
            <div className="hc-error" role="alert">
              No route right now: {quoteError}
            </div>
          )}
          {!quoteLoading && !parsedAmount && amount.trim() !== '' && (
            <p className="hc-hint">Enter a positive ETH amount, e.g. 0.01.</p>
          )}
          {!quoteLoading && quote && (
            <div className="hc-quote">
              <div className="hc-quote-row">
                <span>You receive on {targetChain.name}</span>
                <strong>
                  {Number(quote.toAmountFormatted).toFixed(6)} {quote.toSymbol}
                  {quote.toAmountUsd ? ` (~$${Number(quote.toAmountUsd).toFixed(2)})` : ''}
                </strong>
              </div>
              <div className="hc-quote-row">
                <span>Route</span>
                <strong>
                  {quote.provider === 'lifi' ? 'LI.FI' : 'Relay'} via {quote.tool}
                </strong>
              </div>
              {typeof quote.etaSeconds === 'number' && (
                <div className="hc-quote-row">
                  <span>Estimated time</span>
                  <strong>{quote.etaSeconds < 60 ? `${quote.etaSeconds}s` : `${Math.round(quote.etaSeconds / 60)}m`}</strong>
                </div>
              )}
            </div>
          )}

          {phase.step === 'input' && (
            <button className="hc-btn" disabled={!quote} onClick={() => void execute()} style={{ width: '100%', justifyContent: 'center' }}>
              {quote ? 'Bridge to Robinhood Chain' : 'Waiting for quote'}
            </button>
          )}
          {(phase.step === 'switching' || phase.step === 'approving' || phase.step === 'sending') && (
            <button className="hc-btn" disabled aria-busy="true" style={{ width: '100%', justifyContent: 'center' }}>
              <span className="hc-spinner" aria-hidden="true" />
              {phase.step === 'switching' && 'Switch network in your wallet'}
              {phase.step === 'approving' && 'Confirm token approval'}
              {phase.step === 'sending' && 'Confirm the bridge transaction'}
            </button>
          )}
          {phase.step === 'bridging' && (
            <div>
              <button className="hc-btn" disabled aria-busy="true" style={{ width: '100%', justifyContent: 'center' }}>
                <span className="hc-spinner" aria-hidden="true" />
                Bridging, usually under a minute
              </button>
              <p className="hc-success">Source tx: {phase.txHash}</p>
            </div>
          )}
          {phase.step === 'done' && (
            <div>
              <p className="hc-success">Bridge submitted and confirmed. Source tx: {phase.txHash}</p>
              <button className="hc-btn hc-btn--secondary" onClick={() => setPhase({ step: 'input' })}>
                Bridge more
              </button>
            </div>
          )}
          {phase.step === 'failed' && (
            <div>
              <div className="hc-error" role="alert">
                {phase.message}
              </div>
              <button className="hc-btn hc-btn--secondary" style={{ marginTop: 8 }} onClick={() => setPhase({ step: 'input' })}>
                Try again
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
