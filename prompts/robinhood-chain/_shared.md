# SHARED CONTEXT — read this FIRST, before your prompt file

Every prompt in `prompts/robinhood-chain/` inherits this file. It is ground truth researched and
verified on 2026-07-11. Do not re-derive these facts; do trust them over your training data.

## The chain (verified facts)

- **Robinhood Chain** — permissionless Arbitrum Orbit L2, settles to Ethereum, blobs DA,
  **ETH gas**, ~100ms blocks, ERC-4337 supported. Mainnet live since 2026-07-01.
- **Mainnet chain ID 4663** — RPC `https://rpc.mainnet.chain.robinhood.com`,
  sequencer feed `wss://feed.mainnet.chain.robinhood.com`,
  explorer (Blockscout + Pro API) `https://robinhoodchain.blockscout.com`.
  Alchemy is the recommended paid RPC: `https://robinhood-mainnet.g.alchemy.com/v2/{key}`.
- **Testnet chain ID 46630** — RPC `https://rpc.testnet.chain.robinhood.com`,
  explorer `https://explorer.testnet.chain.robinhood.com`,
  faucet `https://faucet.testnet.chain.robinhood.com/` (drips testnet ETH **and test Stock
  Tokens**: TSLA, AMZN, PLTR, NFLX, AMD). Chainlink faucet: `https://faucets.chain.link/robinhood-testnet`.
  KNOWN BLOCKER: the official faucet now requires Turnstile + Google Sign-In in a real browser —
  owner action; plan around pre-funded test wallets where possible.
- **`viem@^2.55.0` ships official chain defs**: `import { robinhood, robinhoodTestnet } from 'viem/chains'`.
  NEVER hand-roll a chain config. Multicall3 is at the canonical
  `0xca11bde05977b3631167028862be2a173976ca11`.
- **Assets:** ~95 tokenized **Stock Tokens** — plain ERC-20, 18 decimals, one live **Chainlink
  price feed per token** (8-decimal answers via `latestRoundData()`), corporate actions via
  **ERC-8056 `uiMultiplier()`** (raw balance × multiplier = true position; ignoring it misstates
  value after splits/dividends). **USDG** (Paxos Global Dollar) is the chain's dollar stablecoin
  — NOTE: USDG has **6 decimals and NO EIP-2612 permit** (verified on-chain by the SDK build).
  Chainlink feed prices are ALREADY multiplier-adjusted — never re-apply `uiMultiplier` to a
  feed price. **No native chain token exists** — anyone claiming otherwise is speculating.
- **Live DEXes/DeFi:** Uniswap v2/v3/v4 + UniswapX (primary public liquidity), 1inch, Arcus
  (zero-fee stock-token DEX), Lighter (perps), Morpho (lending). Memecoin launchpads: **NOXA**
  ("NOXA Fun") and **The Odyssey** — pump.fun-style, graduating to Uniswap v3.
- **Verified deployment addresses (from the Wave-1 SDK build — trust these):** Stock Tokens
  resolve via shared beacon `0xe10b6f6B275de231345c20D14Ab812db62151b00`; Uniswap mainnet:
  SwapRouter02 `0xCaf681a66D…5cb2`, QuoterV2 `0x33e885eD…9E7`, factory `0x1f7d7550…2EfA`
  (full addresses in `robinhood/robinhood-chain-sdk/src/addresses.ts` — import, don't retype);
  NOXA factory `0xD9eC2db5…FCcB` (instant v3 pools, no bonding curve), Odyssey curve factory
  `0xEb3FeeD2…5a80` (events: TokenCreated/Traded/PoolMigrated). Testnet has NO official
  Uniswap — a community deployment (classic SwapRouter with struct deadline); the only liquid
  testnet pool is NFLX/WETH 0.05%.
- **Canonical contract addresses:** Robinhood's registry at `https://docs.robinhood.com/chain/contracts`
  is the source of truth for Stock Token + USDG addresses. Cross-check via the
  `BankrBot/skills` GitHub repo (hoodmarkets pack, `known-contracts.json`) and verify each
  address resolves on Blockscout before shipping it. NEVER invent or placeholder an address.
- **Data providers already covering the chain:** DefiLlama (`/chain/robinhood-chain`), CoinGecko
  API (chain data + categories "Robinhood Chain Meme", "Robinhood Chain Stocks Ecosystem"),
  GeckoTerminal (DEX pools), Dune, Goldsky (subgraphs), Blockscout Pro API.
- **Docs:** `https://docs.robinhood.com/chain/` (connecting, stock-tokens, deploy, contracts).

## Legal line (bake into every user-facing surface that touches Stock Tokens)

Stock Tokens are tokenized debt securities (issuer: Robinhood Assets (Jersey) Ltd) and **may not
be offered, sold, or delivered to US persons** (extra limits: Canada, UK, Switzerland). This is
enforced legally and at front-ends, NOT at the contract level. Consequences for you:
- Displaying Stock Token data: unrestricted. Do it freely.
- Any BUY/SWAP flow or agent that acquires Stock Tokens: must carry a clear eligibility
  disclosure and a config-level geo gate (default: Stock Token acquisition disabled until the
  operator affirms non-US eligibility). Memecoins and other non-security tokens: no restriction.

## Deliverable conventions (every prompt)

- **Location:** create your project at `robinhood/<repo-name>/` in this workspace. The folder
  must be a complete, standalone, push-ready repo: own `package.json`, `README.md`, `LICENSE`,
  `.gitignore`, docs site. Do NOT run `git init` inside it and do NOT `git commit` anything in
  this workspace — the owner extracts and pushes these folders himself (three.ws commit gate
  applies to all Robinhood-referencing content).
- **Authorship & license:** MIT. `LICENSE` says `Copyright (c) 2026 nirholas`. Every README ends
  with: `Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)`. package.json
  `"author": "nirholas (https://x.com/nichxbt)"`, `"license": "MIT"`.
- **Docs site = static `docs/` folder, GitHub Pages deploy-from-branch.** NO GitHub Actions —
  do not create `.github/workflows/`. Hand-crafted vanilla HTML/CSS/JS in `docs/` that works by
  opening `docs/index.html` locally. The README documents the one-time Pages setup (Settings →
  Pages → main branch → /docs).
- **Landing page with LIVE demo where feasible:** read-only chain calls work client-side against
  the public RPC — so docs landing pages CAN show live data (prices ticking, latest launches,
  block height) directly on GitHub Pages. Do this; it is the screenshot moment. If the product
  needs a server (API, facilitator, long-running agent), ship a `Dockerfile` +
  `deploy` docs for Google Cloud Run (preferred) and Vercel; attempt a real deploy only if
  credentials are present in the environment, otherwise document the exact commands.
- **Design bar:** dark theme first, one accent gradient, real typography (system stack or a
  self-hosted variable font — no CDN fonts on Pages is fine, system stack preferred), designed
  empty/loading/error states, responsive at 320/768/1440, keyboard accessible, focus rings.
  The aesthetic reference is Linear/Vercel/Stripe docs — restrained, dense, fast. No emoji soup,
  no lorem ipsum, no stock illustrations.
- **npm:** make packages publish-ready (`files`, `exports`, `types`, `sideEffects` set; `npm pack`
  runs clean) but DO NOT publish — owner holds the token. Document `npm publish --access public`.
  Before finalizing any npm name, check availability with `npm view <name>` (a 404 = free) and
  use the fallback names your prompt lists. KNOWN TAKEN: `robinhood-chain-sdk`.
- **Dependencies between our repos:** depend on the sibling via its npm name in `package.json`
  plus a `file:../<repo>` install for local development, documented in the README ("until the
  package is on npm, run `npm i ../robinhood-chain-sdk`"). Never copy-paste sibling source.

## Quality bar (CLAUDE.md hard rules apply in full — the ones agents break most)

1. NO mocks, NO fake data, NO placeholder addresses, NO stub functions, NO TODO comments.
2. Every address, RPC URL, and ABI you ship must be verified against Blockscout/official docs
   during the build (curl it, read the contract, prove it).
3. Real E2E verification before claiming done: unit tests green (`npm test`), plus at least one
   REAL on-chain read on mainnet 4663 and — for anything that writes — a REAL transaction on
   testnet 46630 using faucet funds. Paste the commands and outputs in your final report.
4. Wallet keys: env vars only (`ROBINHOOD_CHAIN_PRIVATE_KEY`), never in code or docs examples
   with real values, `.gitignore` covers `.env*`. Agents that spend must have hard spend caps
   and a kill switch (env `MAX_SPEND_*`, SIGINT-safe shutdown).
5. Documentation is part of the feature: README (what/why/install/quickstart/API), `docs/` site,
   runnable `examples/` where the prompt asks. Every code sample must actually run.
6. Self-review before reporting: run the Definition of Done checklist from CLAUDE.md. If a step
   could not be verified, say so explicitly — never claim it.
7. **Do NOT delete or move other prompts, other agents' folders, or anything you did not
   create.** This directory was wiped once by an overzealous cleanup; work-order prompts stay
   until the OWNER removes them, even after the work ships.

## Report format (end of your run)

State: what shipped (file tree summary), names chosen (repo/npm), E2E evidence (commands +
outputs), what is deploy-ready vs deployed, and any owner actions needed (npm publish, Pages
toggle, funding, creds). Keep it under a page.
