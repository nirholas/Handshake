# 01 · Balance

> Your agent's real Solana balance, live from the chain — with a USD estimate and a receipt trail for every transaction.

## What it does

The Balance tab is the agent wallet's home screen. It shows the agent's live SOL balance in big type with a dollar estimate underneath, the wallet address with one-click copy and a block-explorer link, and a Recent Activity feed of the last ten on-chain transactions — each with a green or red SOL amount, a plain-language summary, a timestamp, and a direct link to the transaction on the explorer. It refreshes itself every 30 seconds while you're looking at it, and anyone visiting an agent's page can see its balance — only the owner sees the activity feed.

## How it works

Every number is read live from the Solana blockchain — there are no stored or sample balances. The backend queries the agent's wallet over a primary RPC provider with automatic retry and a public-RPC failover, and caches results for 60 seconds in shared Redis so thousands of viewers never overload the chain. The activity feed pulls the wallet's recent transaction signatures, then parses each transaction to compute exactly how much SOL entered or left the wallet and what kind of operation it was; if that enrichment is rate-limited, the feed still shows the transactions rather than failing. The dollar estimate comes from a live SOL/USD price feed (Jupiter, with CoinGecko as backup), cached for a minute. A mainnet/devnet switch in the wallet header re-points every read at the chosen network instantly.

## Every feature

- Live SOL balance in large display type, read from the chain on every load
- USD estimate under the balance from a live SOL/USD price feed (Jupiter primary, CoinGecko fallback, 60s cache) with extra decimals for sub-$1 amounts
- Auto-refresh: balance re-polls every 30 seconds while the tab is visible, pauses when hidden
- Manual Refresh button with spinning icon and disabled 'Refreshing…' state while in flight
- Shortened wallet address with full-address tooltip on hover
- One-click Copy address with toast confirmation (works even on older browsers via a fallback path)
- Explorer link for the wallet — Solscan on mainnet, Solana Explorer on devnet
- Recent Activity feed: the last 10 on-chain transactions for the wallet
- Per-transaction explorer deep link on each signature
- Signed SOL delta per transaction, green for money in, red for money out
- Plain-language transaction summary per row (e.g. 'transfer'), derived from the parsed on-chain instruction
- Relative timestamps ('3m ago', '2h ago') on every activity row
- 'Failed' pill badge on any transaction that failed on-chain, with an explanatory tooltip
- Mainnet/Devnet network switcher support — switching resets the tab and refetches everything for the chosen network
- Skeleton loading screens (animated shimmer bars, no spinners) for both the balance card and the activity list
- Honest 'Balance unavailable' state in amber when the Solana network can't be reached — with a note that it retries automatically and funds are safe, never a misleading zero
- Distinct handling for rate-limited vs. unreachable RPC, surfaced as the same safe 'unavailable' state
- Activity error state with a one-click Retry button
- Empty activity state that tells you what will appear ('Deposits and trades appear here')
- Empty wallet state explaining the agent's wallet is being prepared automatically
- Public visibility: any visitor can view an agent's balance; the activity feed and all write operations stay owner-only
- Screen-reader support: live-announced balance updates, labeled buttons, busy indicators, and reduced-motion compliance
- Server-side RPC resilience: primary provider, timed backoff retry, then public-RPC failover on every balance and activity read
- Fleet-wide 60-second balance cache (shared Redis) so heavy traffic collapses to at most one chain query per wallet per minute
- Graceful degradation on activity enrichment: if transaction parsing is rate-limited everywhere, the feed still lists transactions without amounts instead of erroring
- USD estimate silently hides if the price feed is down — the SOL amount is never blocked by it
- Number safety: malformed amounts render as '—', never 'NaN'; trailing zeros are trimmed so 1.2000 reads 1.2

## Guardrails & safety

Strictly read-only — this tab can never move funds. The activity feed is owner-gated server-side (visitors and other users get the public balance only). Wallet reads are rate-limited per user, and a shared 60-second server cache plus visibility-aware polling (balance-only, cheap call) prevent RPC abuse. RPC failures show an honest 'Balance unavailable — retrying automatically, your funds are safe' state instead of a false zero. All rendered chain data is HTML-escaped, and explorer links open in sandboxed new tabs.

## Screenshot-worthy (shot list)

- The hero shot: a big live SOL balance with its dollar value underneath, quietly updating itself every 30 seconds — real chain data, zero mocks
- The activity feed: green +SOL and red −SOL deltas, plain-English summaries, 'Failed' badges, and every row deep-linked to the block explorer
- The failure state most wallets get wrong: when Solana is unreachable it says 'Balance unavailable — retrying automatically, your funds are safe' in amber instead of showing a terrifying $0

## API surface

- `GET /api/agents/:id/solana?network=mainnet|devnet (live balance, address, vanity/SNS metadata; public read for visitors)`
- `GET /api/agents/:id/solana/activity?network=&limit=10 (owner-only parsed transaction feed)`
- `https://lite-api.jup.ag/price/v3 (SOL/USD price, primary)`
- `https://api.coingecko.com/api/v3/simple/price (SOL/USD price, fallback)`
