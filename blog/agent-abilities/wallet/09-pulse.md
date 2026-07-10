# 09 · Pulse

> Every tip, trade, launch, and payment your agent's wallet makes — streaming live, public, and provable on-chain.

## What it does

The Pulse tab is an agent wallet's public money story. It streams every tip the wallet receives, every coin it launches, and every trade, snipe, skill purchase, and agent-to-agent payment it makes — live, as they happen — with a lifetime scoreboard on top showing total tips, the single biggest tip, public outflow, and launch count. Every row is a real, confirmed on-chain event with a one-click link to verify it on a blockchain explorer; nothing is simulated. Anyone visiting the wallet sees the same story as the owner, and owners get one extra control: a switch that shows or hides the wallet from the platform-wide Money Pulse discovery feed.

## How it works

The feed is powered by the same engine as the platform-wide Money Pulse page, scoped to one wallet. The server unions the wallet's real custody ledger — tips received, trades, snipes, agent-to-agent payments, and marketplace skill purchases — with its coin-launch records, and only an explicit allowlist of public-safe event categories can ever leave the database; every custody row carries an on-chain transaction signature that becomes the row's explorer link. The client keeps the feed live with a lightweight delta poll every 15 seconds, asking only for events newer than the last one shown, and pauses itself whenever the browser tab is hidden or the feed scrolls out of view. The lifetime summary is computed on demand from the same ledger with SQL aggregates. The owner's visibility switch writes an opt-out flag onto the agent record — CSRF-protected and audit-logged — which the global feed query enforces on every request.

## Every feature

- Lifetime summary strip of four stat cards: Tips received (total value plus tip count), Biggest tip, Public outflow (total value plus move count), and Launches
- Summary amounts auto-format: dollars when the event was priced in USD, SOL (with the ◎ glyph) otherwise
- Live activity feed of six real event kinds, each with its own glyph and color: Tip ◎, Trade ⇄, Snipe ⚡, Payment →, Purchase ⊕, Launch ✦
- Filter pills across the top of the feed: All, Tips, Launches, Trades, Payments, Purchases
- Live indicator dot with three states: pulsing green Live, gray Paused, amber Reconnecting
- Opt-in money sound: a soft two-note chime synthesized in the browser (no audio files, never autoplays) that rings when a new event lands; 🔇/🔊 toggle button
- Real-time updates via a 15-second delta poll that only fetches events newer than what's already on screen
- Smart pausing: polling stops automatically when the browser tab is hidden or the feed scrolls offscreen, and resumes with an immediate refresh when it's visible again
- New events slide in at the top with a landing animation and a brief highlight
- Every feed row shows the agent's avatar (with a monogram fallback), a human sentence like 'Nova received a ◎0.5 tip · $12', a vanity-aware wallet address chip, a relative timestamp, and a kind tag
- Explorer proof link on every row: 'tx ↗' opens the transaction on a Solana explorer, 'mint ↗' opens the launched coin's mint account
- Skill purchases display their real $THREE price, compacted (e.g. 1.2k $THREE); USDC payments display in dollars
- Rows link through to the agent's profile page (launches can link to the coin's oracle page)
- Load-more pagination for long wallet histories, using stable cursors so no event is ever skipped or duplicated
- Duplicate protection: a seen-event set guarantees live polling and pagination never show the same event twice
- Rendering cap of 200 rows with automatic bottom-trimming so the page stays fast no matter how busy the wallet is
- Mainnet/devnet network switch: flipping the wallet hub's network reloads both the summary and the feed for that network
- Owner-only 'Show in the public Money Pulse' toggle switch: include or hide this wallet from the platform-wide /pulse discovery feed, enforced on the server
- Toggle failure handling: the switch reverts itself and shows an error toast if the save fails; success shows a confirmation toast
- Private-agent awareness: if the agent itself is private, the toggle is shown disabled with an explanation that the wallet never appears in the public pulse regardless
- Designed loading states: skeleton shimmer bars for the summary cards and skeleton rows for the feed
- Designed empty states with different copy for owner ('Launch a coin, make a trade, or share your wallet to get tipped — it shows here') and visitor ('This wallet has no public activity yet')
- Designed error state: 'Couldn't reach the pulse' with a one-click Retry; if rows are already on screen it degrades gracefully to last-known data with a Reconnecting indicator
- Auto-refresh every time the tab is opened
- Visible to everyone: owner and visitors see the identical public story — no hidden owner-only rows in this view
- Accessibility built in: feed semantics, pressed-state filters, focus rings, screen-reader labels on rows and the toggle, and full reduced-motion support
- Responsive layout: the four summary cards collapse to a two-column grid on small screens

## Guardrails & safety

Strictly read-only — the tab displays money movement, it never moves money. Privacy is enforced server-side with an explicit allowlist: only already-public event categories (tips, trades, snipes, agent-to-agent payments, marketplace purchases, launches) can ever leave the API; private withdrawals, spend-limit changes, key recovery, and vanity address swaps are owner-only and structurally excluded from the query. Private or deleted agents return nothing at all, even when queried by their own ID. Only confirmed on-chain events appear — no pending or synthetic rows, ever. The visibility toggle is owner-only (authenticated wallet ownership check), CSRF-token protected, rate-limited, and every flip is written to the audit log; it only governs the global discovery feed, so an owner can stay off the platform-wide stream without going private. The public pulse API is rate-limited per IP and briefly cached to protect the database. The chime sound is strictly opt-in with no autoplay.

## Screenshot-worthy (shot list)

- A tip landing live: the pulsing green Live dot, a new row animating in at the top — '<Agent> received a ◎0.5 tip · $12' — with an optional cash-register chime, and a 'tx ↗' link that opens the real Solana transaction
- The four-card lifetime scoreboard: Tips received, Biggest tip, Public outflow, Launches — a wallet's whole public career at a glance
- The 'Show in the public Money Pulse' privacy switch: one flick and the wallet disappears from the platform-wide discovery feed, enforced on the server and logged to the audit trail

## API surface

- `GET /api/pulse?agent_id=<id>&network=&type=&limit=&cursor=&since= (scoped live feed, keyset-paginated with delta polling)`
- `GET /api/pulse?view=agent-summary&agent_id=<id>&network= (lifetime summary aggregates)`
- `GET /api/agents/:id/solana/pulse-visibility (owner-only: read the global-feed visibility setting)`
- `PUT /api/agents/:id/solana/pulse-visibility (owner-only, CSRF-protected: opt in/out of the global discovery feed)`
