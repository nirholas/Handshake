# Mint an Agent Token on Pump.fun

By the end of this tutorial your agent has a live, tradable token on Solana — bonded to its three.ws identity, indexed by the platform's live mint stream, and discoverable from your agent's profile card. The token is real. The bonding curve is real. The Pump.fun graduation event, if it happens, is real.

This is the canonical path for turning a 3D agent into a community-owned asset. It does not make your agent more capable. It makes your agent **owned** — by its holders, transparently, on a chain anyone can read.

**What you'll build:**

- A Pump.fun token (Solana SPL token with a bonding curve) tied to your agent's identity
- A mint address written into your agent's manifest, surfaced on the agent's public card
- Presence in the live three.ws Pump.fun feed at `https://three.ws/pumpfun`
- A dashboard view at `https://three.ws/pump-dashboard.html?agent=<agentId>` showing trades, curve progress, and holder count
- A path to graduation (Raydium liquidity migration) once the bonding curve fills

**Prerequisites:**

- A three.ws account with at least one saved agent. If you have not built an agent yet, work through [first-agent](/tutorials/first-agent) first.
- A Solana wallet. Phantom, Solflare, or any wallet that supports Solana mainnet works. Email-based embedded wallets created on three.ws are also acceptable for this flow.
- Approximately **0.05 SOL** in that wallet on Solana mainnet. This covers Pump.fun's mint fee, a small initial dev buy, and rent + transaction fees with a healthy margin for retries.
- A square image (PNG or JPG, 512x512 minimum, under 1 MB) to use as the token icon. Pump.fun uploads it to its CDN and bakes it into the mint metadata.
- A clear name and ticker symbol you have already verified is available — Step 2 covers how.
- Familiarity with the fact that **tokens minted on Pump.fun are public, immutable, and economically real**. Read the legal note at the end of this tutorial before launching anything you'd regret.

---

## Step 1 — Understand what Pump.fun actually is

Pump.fun is a Solana token launch protocol. Every token launched on Pump.fun starts on a **fair-launch bonding curve** — no presale, no team allocation, no insider rounds. The first buyer pays the lowest price; every subsequent buyer pays slightly more along a deterministic curve. The curve holds the SOL collected on the buy side and the unsold token supply on the sell side. Selling burns the position and returns SOL.

There are three states a Pump.fun token can be in:

1. **Bonding** — the curve is active, trades route through the Pump.fun program, prices follow the curve formula. This is the first life of every token. Almost all activity happens here.
2. **Graduated** — the curve has accumulated enough SOL (currently around 85 SOL at the time of writing; Pump.fun adjusts this threshold). The protocol burns the remaining curve supply, takes the collected SOL, and seeds a Raydium liquidity pool. From then on the token trades like any other Solana SPL token on the open market.
3. **Stalled** — the curve never fills. The token continues to trade on the curve indefinitely. No timer. No expiry. It will sit there at whatever price the last trade left it.

The vast majority of tokens stall. Graduation is rare. This tutorial assumes the bonding stage is the destination, not a milestone. Building real utility into your agent is what gives the curve a reason to fill — not the launch itself.

**Why bond a token to your agent?**

A few legitimate reasons:

- **Skin in the game for skill authors.** If your agent is monetized via paid skills or x402 endpoints, holders of the token participate in the upside of usage growth. See [paid-x402-endpoint](/tutorials/paid-x402-endpoint).
- **Community ownership.** Anyone can buy. There is no allowlist, no KYC, no permission required. The set of holders becomes a public record on Solana.
- **A canonical pointer.** The mint address becomes the single canonical identifier for "this agent's token" — useful for treasury tools, voting, or distribution.
- **Curiosity-driven distribution.** The three.ws Pump.fun feed surfaces new agent mints in real time, sending eyeballs to your agent page.

None of these justify launching a token if your agent does not yet do anything users want. The launch is the easy part. The token is a wrapper around whatever utility already exists.

---

## Step 2 — Lock down name, ticker, and image

Before the launch dialog opens, decide three things and verify them.

**Name** — readable, related to your agent. If your agent's name is `Atlas Concierge`, a token name like `Atlas Concierge Token` or `Atlas` is fine. Names are not unique on Pump.fun; collisions are common. Don't fight over a generic name.

**Ticker symbol** — 3 to 10 uppercase letters, ideally 3–5. The ticker is what traders type. `$ATLAS` is good; `$ACAGENTTOKEN` is bad.

**Symbol availability check.** Pump.fun does not enforce ticker uniqueness, but the three.ws agent registry warns when a ticker is already used by another listed agent. Hit the platform's symbol-availability endpoint from your terminal:

<!-- runnable: 402 an unpaid call answers with the x402 challenge, which is the expected first response -->
```bash
curl 'https://three.ws/api/x402/symbol-availability?symbol=ATLAS' \
  -H 'accept: application/json'
```

The first call returns a 402 because the endpoint is paid (see [paid-x402-endpoint](/tutorials/paid-x402-endpoint) for the full flow). For a one-off check, the agent dashboard at `https://three.ws/dashboard` runs the same query for free against the cached symbol index — open your agent's settings, the Pump.fun tab includes an inline availability indicator.

**Image** — a square PNG or JPG, at least 512x512 pixels. This becomes the token's permanent icon on every Solana wallet, explorer, and aggregator. Once minted, you cannot change it. Use a stable, high-contrast asset; avoid text that gets crushed at 24px favicon sizes.

The image is uploaded to Pump.fun's storage and pinned. The CID is written into the SPL token's metadata account.

---

## Step 3 — Fund the wallet you'll launch from

Open Phantom (or your wallet of choice). Switch the network to **Solana Mainnet**. Confirm the balance shows at least 0.05 SOL.

If you need to fund the wallet:

- **From a centralized exchange** — Coinbase, Binance, Kraken, and most others let you withdraw SOL to a Solana address. Confirm you're withdrawing to **Solana mainnet** (not Wormhole-wrapped, not BSC, not Polygon). Withdrawals usually confirm in under a minute.
- **From another Solana wallet** — standard SPL transfer to your launch wallet's public key.
- **From a card** — Phantom and Solflare both support on-ramp via MoonPay / Coinbase Pay. Slower and more expensive (3–5% fee) but works in two minutes.

Pump.fun charges a flat **0.02 SOL creation fee** plus a small Solana rent allocation (~0.003 SOL). The dev buy is optional but recommended — see Step 5. Reserve 0.005 SOL on top for transaction signing buffer.

Once funded, **double-check the wallet's public key** matches the wallet you plan to connect to three.ws. The mint will be authored by whichever wallet signs the launch transaction. If that wallet is different from the one that owns your three.ws account, bonding the mint to the agent in Step 7 requires an extra signature linking the two.

---

## Step 4 — Open the Pump.fun launch flow on three.ws

Navigate to:

```
https://three.ws/pumpfun
```

This is the live Pump.fun feed. It shows every Pump.fun mint on Solana mainnet in real time, plus a separate ribbon for agent-bonded mints originating from three.ws agents. Watch the feed for thirty seconds — you will see new tokens scroll past every few seconds. Most are noise. The ribbon at the top is where your token will appear after launch.

In the upper right of that page is a button **Launch your agent's token**. Click it.

You can also reach the same launch dialog from your dashboard at `https://three.ws/dashboard` — pick an agent, open its detail panel, and click **Mint Pump.fun token** on the right-side action rail. Both paths open the same modal.

---

## Step 5 — Fill in the launch form

The launch modal has six fields. Fill them in deliberately — once the mint transaction confirms, none of them can be changed.

**1. Agent.** A dropdown of your saved agents. Pick the one you want to bond the token to. The agent's name, avatar, and on-chain ID (if registered) appear in the preview pane on the right.

**2. Token name.** The full name from Step 2. Visible everywhere.

**3. Ticker.** Uppercase symbol from Step 2. The form rejects lowercase, special characters, and tickers longer than 10 chars.

**4. Token image.** Drag-drop or click to upload. The form previews the cropped square at 64x64 to give you a sense of how it looks in a wallet token list. If it looks unreadable at that size, replace it now.

**5. Description.** A 280-character bio that gets written into Pump.fun's token page. Treat this like a tweet. State what the agent does and link to its three.ws page if it has a public profile.

**6. Initial dev buy (optional).** A small SOL amount the form will use to immediately buy your own token after the mint succeeds. Setting this to **0.01–0.05 SOL** is conventional. Two reasons it helps:

- It sets a non-zero floor on the curve. A token with a zero-buy initial state looks abandoned in the feed and is easier to ignore.
- It registers you as a holder. Some downstream tools (treasury dashboards, holder leaderboards) treat zero-balance creators differently from non-zero-balance creators.

Leaving this at zero is fine if you want a purely fair launch and plan to never buy your own token. Many creators do not do a dev buy as a matter of principle.

When everything looks right, click **Continue**.

---

## Step 6 — Sign the mint transaction

Phantom (or your connected wallet) pops a transaction prompt. It will be a complex transaction with multiple instructions — at minimum:

1. Create the SPL mint account
2. Initialize the Metaplex metadata account
3. Create the Pump.fun bonding curve account
4. Initialize the curve with the protocol's defaults
5. If you set a dev buy: a buy instruction against the just-created curve

Phantom shows estimated SOL changes (negative — leaving your wallet) and the program IDs being invoked. The two you should expect to see are:

- The Pump.fun program (a Solana mainnet program well-known to wallets; Phantom usually labels it)
- The Metaplex Token Metadata program

Confirm. The transaction signs and broadcasts. Pump.fun's program rents the mint account, initializes the curve, and returns the new mint address.

Confirmation on Solana mainnet typically lands in 5–10 seconds at the current slot time. The launch modal flips to a success state and displays:

- The **mint address** (a base58 public key, 43–44 chars)
- A link to **pump.fun** for the new token page
- A link to **Solscan** for the mint account
- A button **Bond this mint to your agent on three.ws**

Copy the mint address. You'll want it.

---

## Step 7 — Bond the mint into the agent manifest

This is the step that makes the token *your agent's* token rather than a free-floating SPL mint that happens to share a name. Bonding writes the mint address into your agent's manifest under a `tokens.pumpfun` entry.

Click **Bond this mint to your agent**.

If the wallet that signed the mint matches the wallet on your three.ws account, the modal writes the manifest server-side immediately. The agent's manifest is re-pinned and (if the agent is registered on-chain via ERC-8004) you'll be prompted to also update its on-chain `tokenURI` — see [register-onchain](/tutorials/register-onchain) for the registration mechanics.

If the launching wallet is **different** from your three.ws account wallet (common when you launch from a hot wallet but the agent was created under your hardware wallet, for example), the modal asks for a **link signature**: a short SIWS (Sign-In With Solana) signature from the launching wallet proving you control the mint authority. Approve the signature in Phantom. The link costs no gas.

After bonding, the agent's public card at `https://three.ws/a/sol/<mint>` and `https://three.ws/a/<chain>/<agentId>` both display:

- The Pump.fun token panel: current price, market cap, curve progress, last trade
- A Buy/Sell widget that routes through Pump.fun's program directly
- A link to the agent's dashboard

The manifest entry that gets written looks like this:

```json
{
  "tokens": {
    "pumpfun": {
      "chain": "solana",
      "mint": "<base58 mint address>",
      "ticker": "ATLAS",
      "name": "Atlas Concierge Token",
      "launchedAt": "2026-05-14T12:34:56Z",
      "launchTx": "<solana transaction signature>",
      "graduated": false
    }
  }
}
```

The `graduated` field is updated automatically by a cron job that polls the bonding curve account for each bonded mint every few minutes.

---

## Step 8 — Verify the listing in the feed

Open `https://three.ws/pumpfun` again. Your token should appear in the **Agent-bonded** ribbon within thirty seconds — the feed is driven by a Helius webhook on the Pump.fun program plus a server-side filter that joins against bonded mints.

Click your token. The detail panel shows:

- Live price (updated from a websocket subscription to the bonding curve account)
- Holders count
- Total trades
- Curve fill percentage (how close to graduation)
- A trade list with each buy/sell, the wallet, and the amount

The ribbon is rendered from a public endpoint, so you can check the same list without opening the page. Press Run and this tutorial calls it against the live site:

```live
{ "step": "pump-launches" }
```

Copy the mint out of that response and paste it into a Solana explorer to confirm it on-chain. If your token is missing here but visible on Pump.fun, the bonding step (Step 7) did not complete.

This is the same data surfaced on the per-agent dashboard at:

```
https://three.ws/pump-dashboard.html?agent=<your-agent-id>
```

Open that page too. The pump-dashboard is the operator view — it shows aggregate trade volume, holder distribution (top holders, concentration warnings), and a chart of price + curve fill over time. Bookmark it.

---

## Step 9 — Tell people the token exists

A token that nobody knows about does nothing. The launch is not the announcement.

A reasonable sequence on launch day:

1. **Update the agent's public card.** The three.ws agent page already shows the Pump.fun panel after bonding, but check it in an incognito tab to confirm.
2. **Post the agent URL** (not the bare Pump.fun URL — the agent URL frames it correctly). Example: "Just bonded a token to my agent. mint and chart on the page → `https://three.ws/a/<chain>/<agentId>`".
3. **Cross-post the Pump.fun link.** Some communities prefer the raw pump.fun page. Both are valid.
4. **Pin the post.** Make it findable.

The three.ws feed handles in-platform discovery automatically — there's nothing extra to do to appear in the agent-bonded ribbon. External discovery (Twitter, Telegram, Farcaster) is on you.

What not to do: brigade groupchats begging for buys. Tokens that ride this pattern reliably stall and burn the creator's reputation.

---

## Step 10 — What graduation actually means

A Pump.fun token graduates when the bonding curve accumulates the protocol's graduation threshold of collected SOL. At that moment, atomically:

1. The Pump.fun program burns the remaining unsold curve supply (the tokens still locked in the curve account)
2. The collected SOL is sent to a Raydium pool initialization instruction
3. A Raydium AMM pool is opened for `<your token> / SOL` with the migrated liquidity
4. From the next slot onward, the token trades on Raydium with standard AMM mechanics, not the bonding curve

The Pump.fun page for the token flips to a **Graduated** state and points to the Raydium pool. The token's `graduated` flag in your three.ws manifest is updated within a few minutes by the cron poller, and the buy/sell widget on your agent card switches from a Pump.fun-program call to a Jupiter aggregator call.

**Probability:** small. Pump.fun publishes its own statistics; community trackers like dune dashboards estimate single-digit percent graduation rates for unboosted tokens. Plan as if your token will stay on the bonding curve. If it graduates, treat it as a bonus, not a target.

---

## Step 11 — Operate the token, don't promote it

The most useful thing you can do with a bonded agent token is make the agent more valuable. Concretely:

- Ship more skills. Each new skill is a reason for an existing holder to keep holding and a new user to discover the agent. See [custom-skill](/tutorials/custom-skill) and [skill-with-database-auth](/tutorials/skill-with-database-auth).
- Add a paid x402 endpoint that your agent calls and that you charge for. Revenue accrues to the operator wallet. See [paid-x402-endpoint](/tutorials/paid-x402-endpoint).
- Register the agent on-chain via ERC-8004 so the token's holders have a verifiable identity to anchor reputation to. See [register-onchain](/tutorials/register-onchain).
- Surface the agent in more places. Embed it on your own site at a real domain — see [deploy-to-vercel-custom-domain](/tutorials/deploy-to-vercel-custom-domain).

The token will follow the utility, not the other way around. A creator who keeps the agent improving keeps the holders interested.

---

## Step 12 — Reading the bonding curve programmatically

If you want to build something on top of your token — a trading bot, a holder-gated chat, an automated buyback funded by skill revenue — you'll need to read the curve state directly.

The three.ws API exposes a normalized view of any bonded curve at:

```
GET https://three.ws/api/pump/curve?mint=<mint-address>
```

The response includes the curve account's raw fields plus computed helpers:

```json
{
  "mint": "<mint>",
  "curveAccount": "<pubkey>",
  "virtualSolReserves": "30000000000",
  "virtualTokenReserves": "1073000000000000",
  "realSolReserves": "8200000000",
  "realTokenReserves": "812000000000000",
  "tokenTotalSupply": "1000000000000000",
  "complete": false,
  "graduationProgress": 0.0973,
  "priceLamportsPerToken": 28,
  "priceUsd": 0.000019,
  "marketCapUsd": 19431.22,
  "lastTradeAt": "2026-05-14T13:01:47.012Z"
}
```

`graduationProgress` is a float between 0 and 1; multiply by 100 for a percentage. `complete` flips to `true` after graduation and stays there. For a holder count, hit `https://three.ws/api/pump/dashboard?agent=<agentId>`.

If you need raw on-chain reads, point any Solana RPC client (Helius, Triton, or the public mainnet RPC for low-volume use) at the Pump.fun program ID and decode the bonding curve account with the program's published IDL. The three.ws endpoint is just a normalized, rate-limit-friendly convenience layer over that same on-chain data — every field is derivable yourself if you don't want to depend on the platform.

---

## Step 13 — Sell pressure, doxx pressure, and other things to be ready for

A few realities of operating a public token, in roughly the order you'll encounter them:

**The first hour is loud.** Pump.fun has bots that auto-buy any new mint with certain heuristics (creator wallet age, image classifier, ticker patterns). Some of those bots will dump on you in the same hour. Don't panic when you see the curve dip after a spike.

**Concentration.** If a single wallet holds more than ~5% of the supply, watch it. The pump-dashboard surfaces top holders. If the concentration moves into worrying territory, decide whether to do anything about it (typically: nothing).

**Impersonation.** Other creators may mint tokens with your agent's name or ticker. Pump.fun does not enforce uniqueness. Your agent's three.ws card is the canonical link — point people there.

**Telegram/Discord requests for "calls."** Trading communities will ask you to coordinate buys. Don't. It is securities-promotion-adjacent in many jurisdictions, and it produces short-lived spikes followed by long drawdowns.

**Tax.** Every buy and sell on the curve is, in most jurisdictions, a taxable event for whoever transacted. Your dev buy in Step 5 is a taxable acquisition. Track it.

---

## Legal note (read this)

Pump.fun tokens trade on a permissionless protocol. Once launched, the token exists, anyone can buy or sell it, and nobody — including you, Pump.fun, or three.ws — can pause it, reverse trades, or recall supply. The platform is a launchpad, not a gatekeeper.

Some practical implications:

- **You are responsible for what you launch.** Three.ws does not vet token names, descriptions, or claims attached to a bonded mint. If you launch a token impersonating someone, promising returns, or otherwise breaking the law of your jurisdiction, that is on you.
- **Tokens are not securities offerings by us.** Three.ws is software that integrates with the Pump.fun protocol. We do not custody, broker, or guarantee anything about any token launched through that integration. The same is true of the Pump.fun protocol itself.
- **Some jurisdictions restrict promotion.** Even talking about "buying $TICKER" online, in some jurisdictions, can be regulated. Especially if you are paid to do so. Read the rules where you live.
- **Reversibility is zero.** A typo in the ticker is permanent. A wrong image is permanent. The mint authority is, by default, retained by the creator wallet and can be renounced — many creators renounce immediately to signal they cannot mint more supply. Renouncing is irreversible.

If you have a lawyer, talk to them before launching. If you don't, default to the conservative interpretation: launch a token only if your agent is providing genuine, ongoing utility, and only if you're comfortable with all of the above being permanent and public.

---

## What you learned

- The economics of a Pump.fun token: bonding curve, graduation, and the realistic odds of either outcome
- How to launch from three.ws so the mint is bonded to your agent's identity from minute one
- How the bonded mint surfaces in the live feed, the agent's public card, and the dashboard
- How to read curve state programmatically via `https://three.ws/api/pump/curve`
- The operational realities of owning a public, irreversible, permissionless token
- The legal posture you should adopt — not legal advice, but a reasonable default

## Next steps

- Register the agent on-chain so the token has a verified identity anchor — [register-onchain](/tutorials/register-onchain).
- Add a paid x402 endpoint and route revenue to the token's operator wallet — [paid-x402-endpoint](/tutorials/paid-x402-endpoint).
- Build a database-backed skill that uses the token as an access gate — [skill-with-database-auth](/tutorials/skill-with-database-auth).
- Coordinate the agent with a second one for richer interactions — [multi-agent-coordination](/tutorials/multi-agent-coordination).
