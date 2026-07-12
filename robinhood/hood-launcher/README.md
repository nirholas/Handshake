# hood-launcher

**An autonomous coin launcher for [Robinhood Chain](https://docs.robinhood.com/chain/) (chain ID 4663).**
Concept → 3D logo → deploy on a real launchpad or a clean-room Uniswap v3 rail → announce.
The pump.fun-launcher playbook, ported to chain 4663 — nothing like it existed there before this.

> **This tool creates real, tradeable, irreversible on-chain assets.** Read [Safety](#safety) before
> running it against mainnet with `LIVE=1`. Every launch spends real funds and creates a coin that
> real people can buy.

## What it does

1. **Concept engine** — either fully deterministic (you supply name/symbol/description/logo) or
   LLM-generated from a theme/trending narrative (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, your
   choice, no proxy of ours). Every concept passes a two-layer safety screen (a deterministic
   trademark/impersonation denylist, plus an LLM judgment call when a key is configured) and an
   on-chain ticker uniqueness check before anything is spent.
2. **3D logo** — every hood-launcher coin ships with a real 3D-rendered GLB logo, generated for
   free on the [three.ws](https://three.ws) public forge lane (no key, no account). Supply your
   own image/IPFS URI instead if you'd rather skip generation entirely.
3. **Launch rails** — three independent ways to get a token on-chain (see [Rails](#rails)).
4. **Autonomous mode** — a scheduler that watches trending crypto narratives, proposes a launch,
   and only executes past hard caps and an approval gate (see [Autonomous mode](#autonomous-mode)).
5. **CLI + HTTP API** — one core, three ways to drive it: `hood-launch` (one-shot), `hood-auto`
   (the scheduler), and a small HTTP API for programmatic use.

Docs: **https://nirholas.github.io/robinhood-chain-launcher/**

## Install

```bash
npm install hood-launcher
```

Node ≥ 20. Until the package is on npm, install from a checkout: `npm i ../hood-launcher`.

## Quickstart

```bash
cp .env.example .env
# fill in ROBINHOOD_CHAIN_NETWORK=testnet and (optionally) an OPENAI_API_KEY/ANTHROPIC_API_KEY

npm install
npm run build

# Dry run — full pipeline (concept → screen → uniqueness → artwork → preflight), no transaction sent
node dist/cli.js preflight --config examples/coin.deterministic.json --rail noxa

# Real launch (requires a funded ROBINHOOD_CHAIN_PRIVATE_KEY, LIVE=1, ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1)
node dist/cli.js create --config examples/coin.deterministic.json --rail noxa
```

A minimal deterministic config (`examples/coin.deterministic.json`):

```json
{
  "name": "Sleepy Capybara",
  "symbol": "NAP",
  "description": "a very tired rodent, unbothered by the market",
  "socials": { "twitter": "https://x.com/example" },
  "initialBuyEth": 0,
  "rail": "noxa"
}
```

Omit `name`/`symbol`/`description` and pass `--theme "..."` (or drive it through
[autonomous mode](#autonomous-mode)) to have the concept engine generate them instead — this
requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

## Rails

Every rail's calldata is proven against a **real historical mainnet transaction** — never
guessed. See `tests/unit/*-calldata.test.ts`, which re-run each proof on every `npm test`.

| Rail | Network | What it does | Proof |
| --- | --- | --- | --- |
| `noxa` | mainnet only | One `launchToken` call: deploys the ERC-20, creates a Uniswap v3 pool at the launcher's configured fee tier, seeds single-sided liquidity, permanently locks the LP. Trading starts immediately. | `launchToken(...)` reproduces the real, successful [`ROBINDOG` launch tx](https://robinhoodchain.blockscout.com/tx/0x63da3b0a80cbc836806ed055ed797667e7ec59391cf7aeb5a3dcfeb9152756d0) byte-for-byte, selector `0x686399cb` included. ABI recovered from NOXA's own production frontend bundle. |
| `odyssey` (`instant`) | mainnet only | One payable call to The Odyssey's instant factory: `msg.value` folds directly into the initial buy, lists to a Uniswap v3 pool immediately. | Reproduces two real create txs byte-for-byte (`0x8a21d7f3...`, `0x4da9887c...`), selector `0x548eb31b`. |
| `odyssey` (`bonding`) | mainnet only | Create on the native-ETH bonding-curve factory (zero value), optional separate `buy` call to seed the curve. | Reproduces two real create txs byte-for-byte (`0xd1404ae2...`, `0xd024b90b...`), selector `0x56f698a3`; buy shape matches a real buy tx (`0xf3bd87ab...`), selector `0xcce7ec13`. |
| `direct` | mainnet + testnet | Deploys `contracts/HoodToken.sol` (OpenZeppelin v5 `ERC20`, fixed supply, no mint function, no owner — nothing to renounce because there's nothing privileged to begin with), creates + initializes a Uniswap v3 pool, seeds a full-range LP position, then burns or time-locks the LP NFT per config. Every deployed contract is submitted for Blockscout source verification as the final step. | No ABI reverse-engineering needed — this is code hood-launcher wrote and compiled itself. Verified live on both mainnet and testnet Blockscout (`?module=contract&action=verifysourcecode`). |

### Rails shipped vs excluded

**NOXA** and **The Odyssey's instant + bonding factories** are shipped. **The Odyssey's
`reflectionFactory` and `legacyFactory`** are intentionally excluded: a full survey of every
historical `TokenCreated` emission on the bonding factory (47 logs, `eth_getLogs` from block 0)
found **four distinct create selectors**, not one — `0x8680ce63` (22 uses, an unexplained extra
numeric parameter with no consistent relationship to `msg.value`), `0x59a35641` (20 uses,
requires a 65-byte trailing ECDSA signature from an off-chain backend signer this rail has no way
to produce), `0xc56f3820` (3 uses, undecoded), and `0x56f698a3` (2 uses — simple, unsigned, and
the only one this rail could prove byte-for-byte without guessing). Shipping the two majority
selectors would mean guessing a signature scheme or an unverified parameter — the CLAUDE.md rule
this whole build follows is "never guess calldata," so they're out. **The Odyssey team publishing
a verified ABI or an official SDK** is the only thing that would change this — see their
[frontend bundle](https://theodyssey.fun) if you want to pick up where this left off.

**"The Odyssey" as a third live launchpad** (beyond NOXA + direct) was the prompt's ask for "one
more launchpad if its contracts are discoverable and verified" — its contracts are discoverable
(decoded from real txs) but not source-verified, so it ships under the same evidentiary bar as
NOXA (byte-for-byte tx reproduction) rather than a Blockscout ABI match.

## Concept engine

```ts
import { buildConcept, loadOperatorConfig, launchConfigSchema } from 'hood-launcher'

const config = loadOperatorConfig() // reads ROBINHOOD_CHAIN_NETWORK, etc.
// launchConfigSchema.parse fills in every default (odysseyVariant, description, socials, …) —
// the same pattern the autonomous scheduler uses (src/auto/scheduler.ts) — so the object below
// only needs to supply the fields that actually vary per launch.
const launchConfig = launchConfigSchema.parse({
  name: 'placeholder', symbol: 'PLC', rail: 'noxa',
})
const result = await buildConcept(config.network, launchConfig, {
  theme: 'the strait of hormuz closure and crypto market resilience',
})

console.log(result.input.name, result.input.symbol, result.input.logoUri)
```

- **Fully deterministic mode**: supply `name`/`symbol` directly in the config and omit `theme` —
  zero LLM calls happen. The denylist still runs (it's free and instant); the LLM safety screen
  degrades to "denylist-only, no LLM configured" and is reported as such, never silently skipped.
- **Generative mode**: pass `theme` — the configured LLM invents name/ticker/description/lore,
  then the same two-layer screen and uniqueness check apply before anything is spent.
- **No-impersonation policy**: a coin cannot be named after a real private individual, and cannot
  present itself as a specific trademarked brand/product. Public-figure/internet-culture
  commentary (the normal texture of memecoin culture) is allowed — see `src/concept/screen.ts`'s
  system prompt for the exact line the LLM screen draws, and `src/concept/denylist.ts` for the
  deterministic layer, which is intentionally short and word-boundary-matched (not fuzzy/substring
  matching — that class of matching reliably false-positives on unrelated real words).
- **Artwork**: `logoUri` supplied → used verbatim, zero cost. Omitted → a 3D logo GLB is generated
  on the three.ws free forge lane (`POST https://three.ws/api/forge`, no key).

## Autonomous mode

```bash
node dist/cli-auto.js tick      # one poll-propose cycle against trending narratives
node dist/cli-auto.js list      # see pending proposals
node dist/cli-auto.js approve <id>
node dist/cli-auto.js loop --interval-minutes 60   # run forever
```

The scheduler polls the free three.ws crypto-news digest (`GET /api/news/digest`, real clustered
narratives — headline, summary, market stance, tickers, no key required), builds a concept from
the strongest un-proposed narrative, and runs the full pipeline through preflight. **Execution
requires either `AUTO_APPROVE=1` (proposals still pass through every cap below) or an explicit
operator approval** — `hood-auto approve <id>` or `POST /auto/approve/:id`. Either way, nothing
broadcasts a real transaction unless `LIVE=1` is also set — approval and liveness are independent
gates.

### Hard caps

| Cap | Env | Enforcement |
| --- | --- | --- |
| Launches per day | `MAX_LAUNCHES_PER_DAY` (default 3) | Rolling 24h window over the launch ledger (`.hood-launcher/launches.jsonl`) |
| Seed value | `MAX_SEED_USDG` (default 50) | Live Uniswap v3 WETH→USDG quote on mainnet converts the seed/buy amount to a USD estimate before every launch; on testnet's thin liquidity where no route exists, the check is skipped rather than fabricating a price |
| Kill switch | — | SIGINT, SIGTERM, a `KILL` sentinel file in the data dir, or `POST /kill` — any one stops all further launches for the life of the process |
| Responsibility | `ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1` | Required before ANY `LIVE=1` launch, autonomous or manual |

## HTTP API

```bash
npm run api   # PORT=8787 by default
```

`GET /health` · `GET /rails` · `POST /launch` · `GET /auto/pending` · `POST /auto/tick` ·
`POST /auto/approve/:id` · `POST /auto/reject/:id` · `POST /kill`

## Safety

**This tool creates real, tradeable, irreversible on-chain assets that other people can buy.**

- **Operator responsibility.** You are responsible for every coin you launch with this tool,
  autonomously or manually. hood-launcher enforces a no-impersonation policy and hard spend caps,
  but it cannot make the underlying decision to launch a good-faith responsible for you.
- **No-impersonation policy**, enforced two ways: a deterministic denylist (`src/concept/
  denylist.ts`, always on, zero cost) and an LLM safety screen (`src/concept/screen.ts`, runs when
  an LLM key is configured). Neither is a substitute for operator judgment — read what gets
  proposed before approving it.
- **Caps are hard, not advisory** — `MAX_LAUNCHES_PER_DAY` and `MAX_SEED_USDG` throw a typed
  `CapExceededError` rather than warning and proceeding. There is no override flag.
- **Kill switch** — SIGINT/SIGTERM, a `KILL` file, or `POST /kill`. Once engaged, the process must
  be restarted to resume; there's no in-process "un-kill."
- **`LIVE=1` + `ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1`** are both required before any real fund
  movement. Without them, every entry point (`create`, `approve`, autonomous `tick`) runs the full
  pipeline through preflight and stops — a genuine simulation against live market data, not a
  fabricated one.
- **Direct-rail contracts have zero privileged surface.** `HoodToken` has no owner, no mint
  function post-deploy, and nothing to renounce. `HoodLPLocker` never touches a locked position
  before its unlock timestamp — no admin override exists.

## Testnet-first

Every rail is built to run on testnet 46630 first. **The direct rail runs on testnet today.**
NOXA and The Odyssey are mainnet-only (no testnet deployment exists — confirmed on-chain during
this build: `eth_getCode` returns `0x` for both factories on 46630).

Real testnet execution requires a funded `ROBINHOOD_CHAIN_PRIVATE_KEY`. The official faucet
(`https://faucet.testnet.chain.robinhood.com/`) requires a live browser session with Cloudflare
Turnstile + Google Sign-In and cannot be automated headlessly — this is an owner action, not
something this build can complete unattended (the same blocker affects every other repo in this
campaign; see `robinhood/robinhood-chain-sdk`'s live test suite for the identical gate). Fund a
key there, export it, then:

```bash
ROBINHOOD_CHAIN_PRIVATE_KEY=0x.. LIVE=1 ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1 npm run test:live
```

**Mainnet execution is gated behind `LIVE=1` + funding and was never performed during this
build** — a mainnet token launch is an outward-facing, irreversible act; that call belongs to the
platform owner, not an autonomous build agent.

## Development

```bash
npm install
npm run compile:contract   # solc-compiles contracts/*.sol, embeds a self-contained
                            # standard-json-input in contracts/*.json for Blockscout verification
npm test                   # unit tests — calldata proofs, caps, denylist, kill switch, math
npm run test:live          # live tests — real mainnet/testnet reads, real Blockscout/news-digest calls
npm run typecheck
npm run build
```

## Architecture

```
src/
  rails/       noxa.ts, odyssey.ts, direct.ts — one Rail interface, three implementations
  concept/     denylist, LLM screen, generation, artwork (3D logo), ticker uniqueness
  core/        config, launcher orchestrator, caps, kill switch, ledger, Uniswap v3 math, verify
  auto/        narrative source, proposal store, scheduler
  api/         HTTP server (shares core with the CLI)
bin/           hood-launch.ts (CLI), hood-auto.ts (scheduler CLI)
contracts/     HoodToken.sol, HoodLPLocker.sol + compiled artifacts (ABI + bytecode + verification input)
tests/         unit/ (network-free, calldata proofs) + live/ (real chain/API calls)
```

## License

[Apache License 2.0](./LICENSE) © 2026 nirholas.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
