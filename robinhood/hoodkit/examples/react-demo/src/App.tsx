import { useMemo, useState } from 'react'
import { createHoodClient } from 'hoodchain'
import { HoodProvider, useQuote, useLaunches } from 'hoodkit/react'

const SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'GOOGL', 'AMZN', 'COIN'] as const

function QuoteTile({ symbol }: { symbol: string }) {
  const { data, isLoading, error } = useQuote(symbol)
  return (
    <div className="tile">
      <div className="tile-symbol">{symbol}</div>
      {error ? (
        <div className="tile-state tile-error">feed error</div>
      ) : data ? (
        <>
          <div className="tile-price">${data.priceUsd.toFixed(2)}</div>
          <div className="tile-meta">round #{data.roundId.toString()} · {data.ageSeconds}s ago</div>
        </>
      ) : (
        <div className="tile-state">
          <span className="skeleton" style={{ width: '70%' }} />
        </div>
      )}
      {isLoading && !data && <div className="tile-meta">connecting…</div>}
    </div>
  )
}

function LaunchFeed() {
  const { launches, isLoading, error } = useLaunches({ limit: 12 })
  if (error) return <div className="panel-empty tile-error">launch feed error: {error.message}</div>
  if (isLoading) return <div className="panel-empty">watching NOXA + The Odyssey for new launches…</div>
  if (launches.length === 0) return <div className="panel-empty">no launches yet — this updates live, leave it open</div>
  return (
    <ul className="launch-list">
      {launches.map((l) => (
        <li key={l.transactionHash} className="launch-row">
          <span className={`badge badge-${l.launchpad}`}>{l.launchpad}</span>
          <span className="mono">{l.token.slice(0, 6)}…{l.token.slice(-4)}</span>
          <span className="launch-block">block {l.blockNumber.toString()}</span>
        </li>
      ))}
    </ul>
  )
}

export function App() {
  const [network, setNetwork] = useState<'mainnet' | 'testnet'>('mainnet')
  const client = useMemo(() => createHoodClient({ chain: network }), [network])

  return (
    <HoodProvider client={client}>
      <div className="page">
        <header className="header">
          <div>
            <h1>hoodkit</h1>
            <p className="subtitle">live dashboard — real Chainlink feeds + real launch events, streamed client-side</p>
          </div>
          <div className="network-toggle" role="group" aria-label="Network">
            <button className={network === 'mainnet' ? 'active' : ''} onClick={() => setNetwork('mainnet')}>
              mainnet
            </button>
            <button className={network === 'testnet' ? 'active' : ''} onClick={() => setNetwork('testnet')}>
              testnet
            </button>
          </div>
        </header>

        <section>
          <h2>Stock Token prices</h2>
          <div className="tile-grid">
            {SYMBOLS.map((s) => (
              <QuoteTile key={`${network}-${s}`} symbol={s} />
            ))}
          </div>
        </section>

        <section>
          <h2>Live launches — NOXA + The Odyssey</h2>
          <div className="panel">
            <LaunchFeed key={network} />
          </div>
        </section>

        <footer className="footer">
          Built with <code>hoodkit/react</code> · streaming directly from the public Robinhood Chain RPC, no backend.
        </footer>
      </div>
    </HoodProvider>
  )
}
