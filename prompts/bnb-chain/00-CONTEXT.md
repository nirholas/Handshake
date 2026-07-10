# BNB Chain Campaign — Shared Context (READ FIRST; every prompt in this folder requires it)

You are building three.ws's BNB Chain expansion: three product tracks that exploit
capabilities verified live on BNB Chain on 2026-07-07 that Ethereum L1, Base, and (mostly)
Solana cannot match. This file is static reference — reading it is NOT a dependency on
another agent's work. Read `/workspaces/three.ws/CLAUDE.md` after this file.

---

## Owner approval (commit gate — resolved for this campaign)

CLAUDE.md gates commits referencing crypto projects other than `$THREE`. **The owner
approved this campaign on 2026-07-07** ("yeah lets do those all"). Within this campaign's
scope — BNB Chain / BSC / opBNB / Greenfield / MegaFuel / MPP infrastructure code, docs,
tests, prompts — committing BNB Chain references is **pre-approved**. Do not stop to re-ask.
Boundaries that still hold:
- `$THREE` (CA `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`) remains the ONLY promoted
  coin. BNB Chain is infrastructure we build ON; never promote BNB or any other token.
  No "buy BNB" copy, ever.
- No real third-party token mints in tests/fixtures — use `$THREE` or synthetic placeholders.
- Anything referencing a crypto project OUTSIDE this campaign's scope still needs the gate.

## Verified facts (3-vote adversarially verified 2026-07-07 — build on these)

1. **Gasless plain-EOA transactions.** BEP-414 paymaster API (`pm_isSponsorable` +
   `eth_sendRawTransaction`) + BEP-322 atomic builder bundles: a user signs a normal tx
   with `gasPrice = 0`; a sponsor tx pairs with it atomically. Works with unmodified
   private-key EOAs — mechanically impossible on Ethereum L1/Base (EIP-1559 rejects
   zero-fee; 4337 needs smart accounts, 7702 needs delegation). Production implementation:
   **MegaFuel** (NodeReal) on BSC + opBNB — docs.nodereal.io/docs/megafuel, open SDKs
   `node-real/megafuel-js-sdk` / `megafuel-go-sdk`. Caveats: operated by one company
   (NodeReal), sponsor policies are whitelisted, BEP-414 status is Draft. **Always ship a
   self-pay fallback** (the official SDK pattern: MegaFuel decides per-tx; outage → self-pay).
2. **Greenfield storage programmable from BSC contracts.** Live BSC-mainnet (56) hubs,
   bytecode-verified 2026-07-07:
   - CrossChain `0x77e719b714be09F70D484AB81F70D02B0E182f7d`
   - TokenHub `0xeA97dF87E6c7F68C9f95A69dA79E19B834823F25`
   - BucketHub `0xE909754263572F71bc6aFAc837646A93f5818573`
   - ObjectHub `0x634eB9c438b8378bbdd8D0e10970Ec88db0b4d0f`
   - GroupHub `0xDd9af4573D64324125fCa5Ce13407be79331B7F7`
   - MultiMessage `0x26204702935e2D617EE75B795152B9623a7d9809` (atomic batch of storage ops)
   A BSC contract can create/delete buckets & groups, delete objects, and grant/revoke
   per-object permissions (PermissionHub `createPolicy`/`deletePolicy`) cross-chain.
   Hard limits (design around them, don't fight them): object CREATION from BSC is
   "pending"/unshipped; file bytes always upload via off-chain Storage Providers; cross-chain
   ops settle ASYNCHRONOUSLY on Greenfield after relay (poll for effect, never assume
   same-block). Testnet hub addresses: read from `bnb-chain/greenfield-contracts` README —
   never invent addresses. Ecosystem caveat: contracts repo last released May 2024 and
   Greenfield is absent from the 2026 roadmap — live but deprioritized. Keep vault
   architecture portable (encrypt-at-rest + permission-gated key release) so storage backend
   could be swapped.
3. **0.45s blocks, ~1.125s finality, live.** Fermi hardfork (BEP-619/590) activated
   2026-01-14; measured live at ~0.45–0.47s via public RPC on 2026-07-07. Fastest EVM L1
   (Base 2s, Ethereum 12s; Solana slots ~400ms). BEP-670 targets 250ms (NOT live — don't
   claim it).

**Refuted / unverified — NEVER claim these in docs, UI copy, or marketing:** "20,000 TPS"
and the chain-level "AI agent framework" are roadmap promises, not shipped. Greenfield
mirror-NFTs are control handles, NOT freely composable ERC-721s. No unique precompiles /
native LST hooks substantiated. **BABT is SETTLED, not refuted:** prompt 20 confirmed it
real, live on BSC mainnet (`0x2B09d47D550061f995A3b5C6F0Fd58005215D7c8`, 1.16M+ holders)
AND testnet, and freely third-party-queryable via `balanceOf`/`tokenIdOf` — see
`docs/bnb-babt-findings.md` and `api/_lib/bnb/babt.js`. Do claim it as a real KYC-backed
signal; do NOT claim it's a permanent identity anchor (Binance can revoke/re-mint).
Honest-docs rule: any "only on BNB Chain" claim you write must trace to the verified list.

## Networks & endpoints

| Thing | Value |
|---|---|
| BSC mainnet | chainId 56, RPC `https://bsc-dataseed.bnbchain.org` (reads OK on mainnet) |
| BSC testnet | chainId 97, RPC `https://data-seed-prebsc-1-s1.bnbchain.org:8545` — **all deploys + writes default here** |
| opBNB | out of scope this campaign (note gaps in PROGRESS if relevant) |
| Greenfield mainnet / testnet | chain `greenfield_1017-1` / `greenfield_5600-1`; SP + RPC endpoints per `@bnb-chain/greenfield-js-sdk` docs |
| MegaFuel | mainnet `https://bsc-megafuel.nodereal.io`, testnet `https://bsc-megafuel-testnet.nodereal.io` (confirm exact paths in docs.nodereal.io/docs/megafuel) |
| tBNB faucet | `https://www.bnbchain.org/en/testnet-faucet` (alternatives: QuickNode/Chainlink faucets) |

## The codebase map (so you never have to hunt)

- **EVM libs already installed:** `viem ^2.52`, `ethers ^6.16` (package.json). Prefer viem
  for new code. Open-source-first: use `@bnb-chain/greenfield-js-sdk`, `@bnb-chain/mpp`,
  `megafuel-js-sdk` where they fit — don't hand-roll what they cover.
- **New BNB server libs live in `api/_lib/bnb/`** (new namespace, one file per concern).
- **Contracts:** Foundry workspace at `contracts/` (`foundry.toml`, `lib/forge-std`,
  `lib/openzeppelin-contracts`, deploy scripts in `contracts/script/*.s.sol`). Follow
  `contracts/README.md` deploy conventions; record every deploy in `contracts/DEPLOYMENTS.md`
  (bytecode-verified style, see that file's Provenance section).
- **ERC-8004 is ALREADY live on BSC(56)** at our CREATE2 registry addresses — see
  `contracts/DEPLOYMENTS.md` + `api/_lib/erc8004-chains.js` + `src/erc8004/abi.js`. Don't
  redeploy; extend.
- **x402 stack:** paid endpoints `api/x402/<slug>.js` via `api/_lib/x402-paid-endpoint.js`;
  BSC payTo already supported (`env.X402_PAY_TO_BSC`, `networks: ['bsc']`); discovery doc
  mirrored in `api/wk.js`, validated by `node scripts/verify-x402-discovery.mjs`.
- **Free endpoints:** plain-handler pattern (`cors`/`wrap`/`error` from `api/_lib/http.js`,
  rate-limit via `api/_lib/rate-limit.js`). Model on `api/solana-rpc.js`.
- **3D viewer + explore/platformer:** `src/` Vite app; platformer mode shipped 2026-07-07
  (see `git log --oneline -5`). Multiplayer rooms: `multiplayer/` (Colyseus), Agora
  player-mode `src/agora/player-mode.js`.
- **Docs:** `docs/` per-capability files; `specs/` for wire formats; `data/pages.json` for
  routes; `STRUCTURE.md` for surfaces; `data/changelog.json` for holder-visible changes.

## Prompt independence & prerequisites

Prompts are scoped small on purpose. Track-internal ordering exists (README table). Rule:
**each prompt starts by checking its "Prereq artifacts" list.** If an artifact is missing,
OPEN THE NAMED PREREQ PROMPT IN THIS FOLDER AND EXECUTE IT FIRST, then continue yours.
Never stub around a missing prereq; never report done with a prereq unmet. Prompts with no
prereqs say "Prereqs: none".

## You are NEVER blocked — decision defaults

| Situation | Do this — do NOT ask |
|---|---|
| Need a funded testnet key | Env `BNB_TESTNET_DEPLOYER_KEY` (add to `.env.example` with comment, never commit a real key). If absent, generate a throwaway key, fund via faucet, and print the address + faucet URL in your report. If every faucet fails: finish ALL code + tests against a local `anvil --chain-id 97` fork, and record the single funding blocker in PROGRESS. |
| MegaFuel sponsor policy needs a NodeReal account we don't have | Code against the public API spec; probe `pm_isSponsorable` on the public testnet endpoint; ship the self-pay fallback as the default path; record the exact signup/policy-creation step needed in PROGRESS. The feature must work end-to-end in self-pay mode regardless. |
| Greenfield cross-chain op hasn't settled | It's async by design. Poll (bounded, with backoff) for the mirrored effect; surface `pending` state honestly in API/UI. |
| A BNB SDK is broken/unmaintained for our use | Wrap the minimal REST/RPC calls yourself in `api/_lib/bnb/`, document why in the commit message. Never mock. |
| Mainnet money needed to prove something | Don't spend mainnet funds. Prove on testnet + assert mainnet-readiness via config/bytecode checks. Note the mainnet flip steps in PROGRESS. |
| Unsure of a price for a paid surface | Default $0.10 (`"100000"` atomic USDC) via `priceFor`, env-overridable. Move on. |
| Shared-file conflict with a concurrent agent | Stage YOUR explicit paths only, re-check `git status` before commit, re-apply only your hunk. |
| Something adjacent is broken/mediocre | Fix it if <30 min and in your blast radius; otherwise note it in PROGRESS. Don't half-do two prompts. |

If a genuine blocker remains (rare): implement everything else 100%, then state the ONE
blocker with exactly what's needed.

## Definition-of-done template (every prompt inherits)

- [ ] Built, wired, reachable; zero mocks/stubs/TODOs/commented-out code (CLAUDE.md).
- [ ] Every state handled: success, empty, error, bad input, rate-limited, upstream-down,
      and (BNB-specific) `pending` for async cross-chain effects.
- [ ] Real proof captured: live testnet tx hashes / real JSON responses / real block numbers
      pasted into your PROGRESS entry. "Returns 200" is not done.
- [ ] `npm test` green; new tests follow `tests/` conventions. Contracts: `forge test` green.
- [ ] Docs per CLAUDE.md (docs/ file or section, pages.json for routes, STRUCTURE.md for
      surfaces, specs/ for wire formats) — written for a zero-context reader, every claim
      consistent with the Verified facts above.
- [ ] `data/changelog.json` entry for anything user-visible (holder-readable, no jargon).
- [ ] `git diff` self-reviewed; commit EXPLICIT paths (never `-A`); push with
      `git push threews main` — the only push target. Never push/pull/fetch/merge `threeD`
      (retired `nirholas/3D-Agent` mirror, diverged history).
- [ ] `npx vercel build` trap: if run, check `head -1` of changed `api/*.js` for `__defProp`;
      recover with `git restore -- api/ public/`.
- [ ] Append a dated entry to `prompts/bnb-chain/PROGRESS.md`: what shipped, proof, gaps.

## Dev commands

```
npm run dev                              # Vite, port 3000
npm test                                 # JS test suite
cd contracts && forge build && forge test -vv
node scripts/verify-x402-discovery.mjs   # if you touched paid-route discovery
npm run build:pages                      # regenerate + validate changelog/pages
```
