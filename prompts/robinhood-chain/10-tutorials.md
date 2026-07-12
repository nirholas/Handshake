# 10 — Tutorial site: `learn-robinhood-chain`

Read `prompts/robinhood-chain/_shared.md` first. Wave 4 — run LAST: it teaches the finished
stack. Verify which sibling repos exist in `robinhood/` and teach what's real.

## Mission
Build `robinhood/learn-robinhood-chain/` — the definitive learning site for building on
Robinhood Chain, from zero to shipping an autonomous agent. Written tutorials, each verified by
actually performing it. This is a content product: the writing quality bar is "official docs of
a top-tier devtools company" (Stripe/Vite-level), and it funnels readers to our SDK, API, and
MCP at every natural step without being an ad.

## Curriculum (each tutorial = one page, sequential but independently completable)

**Foundations**
1. What Robinhood Chain actually is — architecture, chain IDs, what's real vs hype (no-token
   fact, US Stock Token restriction, permissionless deployment). Sourced, linked.
2. Connect and read the chain in 5 minutes — wallet setup, faucet, first viem read.
3. Stock Tokens explained for developers — ERC-20 + Chainlink feed + `uiMultiplier()`; the
   split/dividend trap, with a worked real example showing wrong-vs-right valuation.

**Building**
4. Your first app: live price ticker (from example 07, expanded with explanation).
5. Portfolio tracker done right (SDK `getPortfolio`, why naive trackers are wrong).
6. Swapping on-chain: quotes, slippage, execution on testnet (memecoin path; eligibility
   sidebar for Stock Tokens).
7. Streaming the chain: launchpad watcher + sequencer firehose.

**Monetizing & agents**
8. Sell your API for USDG: x402 + hood402 from zero to first paid request.
9. Give your AI agent chain access: hood-mcp with Claude Code/Desktop/Cursor — real transcript.
10. Build an autonomous trading agent: paper-mode hood-traders strategy, risk-first framing.
11. Launch a coin programmatically (testnet): hood-launcher direct rail, responsibly framed.

**Capstone**
12. Ship it: deploying your app/API (Pages for static, Cloud Run for servers), going mainnet
    checklist (funding, keys, caps, monitoring).

## Requirements
- EVERY tutorial performed by you during the build, on a clean environment; all outputs and tx
  hashes in the text are real captures. A tutorial you didn't complete doesn't ship.
- Site: static generator you build or a minimal SSG (plain build script rendering markdown →
  styled HTML is fine; no heavy framework) outputting to `docs/` per `_shared.md`. Features:
  sidebar navigation, prev/next, reading time, copy buttons on code blocks, dark/light,
  search (client-side index — lunr-style or hand-rolled), mobile-perfect.
- Each page: prerequisites box, "what you'll build" with a real screenshot/output, estimated
  time, troubleshooting section from errors YOU actually hit.
- Landing page: curriculum map with progress affordance, one-line pitch, live chain stats strip
  (client-side RPC — block height, gas, a ticking price).
- Root README: how to add a tutorial (contributor guide), local preview command.

## Done checklist
- [ ] 12 tutorials, all performed, all real outputs. Build script produces the site into docs/.
- [ ] Search works offline; site is beautiful at 320/768/1440; Lighthouse-clean structure
      (semantic headings, alt text, contrast).
- [ ] Report: per-tutorial verification note + list of upstream bugs/rough edges found while
      performing them (feeds fixes to the other repos).
