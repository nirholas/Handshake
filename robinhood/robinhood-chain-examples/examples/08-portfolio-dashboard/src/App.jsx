import { useState } from 'react'
import { useHoodPortfolio } from './useHoodPortfolio.js'

const DEFAULT_HOLDER = '0xA953CA88ff430e9487c60cA34d757414f4efdA07'
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export default function App() {
  const [input, setInput] = useState(DEFAULT_HOLDER)
  const [owner, setOwner] = useState(DEFAULT_HOLDER)
  const { status, portfolio, error } = useHoodPortfolio(owner)

  const submit = (e) => {
    e.preventDefault()
    if (ADDRESS_RE.test(input)) setOwner(input)
  }

  return (
    <div className="wrap">
      <header>
        <h1>Portfolio Dashboard</h1>
        <p className="sub">Multiplier-correct Stock Token holdings, polled every 20s — hoodchain reads only.</p>
      </header>

      <form onSubmit={submit} className="lookup">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x… holder address"
          aria-label="Wallet address"
          spellCheck={false}
        />
        <button type="submit" disabled={!ADDRESS_RE.test(input)}>
          Look up
        </button>
      </form>
      {!ADDRESS_RE.test(input) && input.length > 0 && <p className="hint">Not a valid address.</p>}

      {status === 'loading' && (
        <div className="grid">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="card skeleton" key={i}>
              <div className="line w60" />
              <div className="line w40" />
            </div>
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className="panel error">
          <strong>Couldn't load this portfolio.</strong>
          <div className="mono">{error?.message}</div>
        </div>
      )}

      {status === 'success' && portfolio.positions.length === 0 && (
        <div className="panel empty">
          <strong>No Stock Tokens held.</strong>
          <div>This address doesn't hold any of the 95 registry tokens. Try the default holder, or your own address after a swap.</div>
        </div>
      )}

      {status === 'success' && portfolio.positions.length > 0 && (
        <>
          <div className="total">
            <span className="label">Total priced value</span>
            <span className="value">${portfolio.totalUsd.toFixed(2)}</span>
          </div>
          <div className="grid">
            {portfolio.positions.map((p) => (
              <div className="card" key={p.symbol}>
                <div className="sym">{p.symbol}</div>
                <div className="value">{p.valueUsd === null ? 'unpriced' : `$${p.valueUsd.toFixed(2)}`}</div>
                <div className="meta">
                  {p.balanceTokens.toFixed(6)} tokens · {p.shareEquivalent.toFixed(6)} share-equiv
                </div>
              </div>
            ))}
          </div>
          {portfolio.unpricedSymbols.length > 0 && (
            <p className="hint">Unpriced (no feed): {portfolio.unpricedSymbols.join(', ')}</p>
          )}
        </>
      )}

      <footer>
        Built by <a href="https://x.com/nichxbt">nirholas</a> · <a href="https://three.ws">three.ws</a>
      </footer>
    </div>
  )
}
