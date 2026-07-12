# 05 — x402 on Robinhood Chain: `hood402` (USDG payment rail)

Read `prompts/robinhood-chain/_shared.md` first. Requires Wave 1 core SDK for chain plumbing.

## Mission
Build `robinhood/hood402/` — the x402 payment stack for USDG on Robinhood Chain: server
middleware, client, and facilitator. The only prior art is days old (`project-r0x`, MIT — study
its facilitator design and the canonical `x402` protocol repo/spec; follow the STANDARD x402
scheme exactly rather than inventing a variant, so any x402 client interoperates). npm scope:
`hood402` with subpath exports (fallbacks: `x402-usdg`, `hood-402`).

## Deliverables

1. **Protocol conformance** — implement x402 `exact` scheme for EVM with USDG on chain 4663:
   the SDK build verified USDG has 6 decimals and NO EIP-2612 permit — so verify on Blockscout
   whether it supports EIP-3009 `transferWithAuthorization`; if neither gasless path exists,
   settlement is approve+transferFrom via the facilitator or direct transfer with reference —
   document the mechanism you prove and build on it (this decision is load-bearing).
   Testnet twin on 46630.
2. **`hood402/server`** — Express/Hono/Next middleware: `paywall({ price, payTo, network: 'robinhood' })`
   issuing spec-compliant 402 challenges and verifying/settling via facilitator or self-settle mode.
3. **`hood402/client`** — fetch wrapper: intercept 402 → sign payment (viem wallet) → retry,
   with spend caps per origin and a session cache. Works in Node and browser (injected wallet).
4. **Facilitator service** — `facilitator/` subfolder: verify + settle endpoints per x402 spec,
   Dockerfile, Cloud Run deploy docs, idempotent settlement with a small SQLite ledger, metrics
   endpoint. This is what we run in production; keys via env.
5. **Interop proof** — E2E script: a demo paid endpoint + the client completing a REAL paid
   request with USDG on testnet 46630 (faucet ETH for gas). If testnet USDG doesn't exist, run
   the E2E on mainnet with a $0.001 real payment funded from the owner's wallet if creds are
   present; otherwise prove the full flow up to settlement broadcast in simulation (`eth_call`)
   and mark settlement as pending-owner-funding in the report. Deploy NOTHING fake. State
   plainly which path you took.
6. **three.ws seam** — a short `INTEGRATION.md` describing exactly how three.ws's existing x402
   catalog adds `network: robinhood-chain` as an accepted rail using this package (env vars,
   settlement wallet, facilitator URL). Do not modify three.ws in this prompt.

## Requirements
- Strict TypeScript, ESM+CJS, vitest unit suite for challenge/verify/settle state machine
  (malformed payloads, replay, expiry, wrong-chain, underpayment — each a test).
- `docs/` static site per `_shared.md`: landing explains x402-on-Robinhood-Chain in one screen
  with an animated request/402/pay/200 diagram (CSS, no video), quickstarts for the three
  pieces, spec-conformance notes, r0x comparison (fair, factual).
- README: security model, key handling, spend caps, replay protection.

## Done checklist
- [ ] USDG settlement mechanism verified from the actual contract, cited by address + Blockscout link.
- [ ] State-machine tests green; interop E2E evidence per deliverable 5 with the honest path taken.
- [ ] Facilitator Docker image builds; `npm pack` clean on both packages.
- [ ] INTEGRATION.md actionable enough that a three.ws agent can wire the rail without research.
