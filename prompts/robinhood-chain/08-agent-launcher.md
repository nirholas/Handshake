# 08 — Autonomous coin launcher: `hood-launcher`

Read `prompts/robinhood-chain/_shared.md` first. Wave 3: requires core SDK (`launchpads` module).

## Mission
Build `robinhood/hood-launcher/` — an autonomous agent (and a human-driven CLI/API around the
same core) that launches coins on Robinhood Chain end-to-end: concept → name/ticker/description
→ artwork → deploy on a launchpad (NOXA primary) or direct ERC-20 + Uniswap v3 pool → announce.
The pump.fun-launcher playbook, ported to chain 4663 — nothing like it exists there yet.

## Deliverables

1. **Launch rails** (`src/rails/`) — research first, then implement what is REAL:
   - `noxa` rail: reverse-engineer NOXA's verified factory/bonding-curve contracts on Blockscout
     (creation tx of a recent launch → factory → `create` calldata shape). Implement create +
     initial-buy. If NOXA has an official API/SDK, prefer it and cite it.
   - `direct` rail: deploy a clean, audited-pattern ERC-20 (OpenZeppelin v5, fixed supply,
     no owner mint, renounced) + create/initialize a Uniswap v3 pool + seed LP + burn or lock
     LP per config. Every contract verified on Blockscout via API as part of the pipeline.
   - Pick ONE more live launchpad (The Odyssey) only if its contracts are discoverable and
     verified; otherwise document why it's excluded. Never guess calldata.
2. **Concept engine** (`src/concept/`) — name/ticker/description/lore generation via the LLM the
   operator configures (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` — support both, no proxy of ours),
   uniqueness check against existing on-chain tickers (registry + Blockscout search), artwork
   via the three.ws forge free lane (`https://three.ws` public forge/3D endpoints are usable —
   generate a 3D-render logo; this is our differentiator: every hood-launcher coin ships with a
   3D logo GLB + rendered PNG) with a documented plain-image fallback (any image the operator
   supplies). Config-first: fully deterministic launches (operator supplies everything) must
   work with zero LLM calls.
3. **Autonomous mode** (`src/auto/`) — scheduler that watches launch-meta conditions (e.g.
   trending narratives from the free three.ws crypto-news digest API), proposes a launch,
   and requires either `AUTO_APPROVE=1` or an operator approve step (HTTP endpoint / CLI
   confirm). Hard caps: `MAX_LAUNCHES_PER_DAY`, `MAX_SEED_USDG`. Kill switch per prompt 07's bar.
4. **CLI + API** — `hood-launch` CLI (`hood-launch create --config coin.json --rail noxa`) and a
   small HTTP API for programmatic use, sharing one core.
5. **Testnet-first pipeline** — full E2E on 46630: deploy, pool, buy, verify — real tx hashes.
   Mainnet execution gated behind `LIVE=1` + funding; do not launch anything real on mainnet
   during the build (a mainnet token launch is an outward-facing, irreversible act — that call
   is the owner's).

## Requirements
- Ethics/abuse posture in README: this tool creates real tradeable assets; document operator
  responsibility, no-impersonation policy (concept engine refuses trademarked/person-named
  coins — enforce with a checkable denylist + LLM screen), and the caps.
- Vitest: calldata builders against captured real factory transactions; cap enforcement; ticker
  uniqueness. E2E on testnet with pasted hashes + Blockscout verification links.
- `docs/` static site per `_shared.md`: landing shows a real testnet launch walkthrough
  (concept → 3D logo → live coin on the testnet explorer), rail docs, autonomous-mode guide,
  safety page.

## Done checklist
- [ ] NOXA calldata proven against a real historical launch tx (cite it) AND a real testnet
      execution of whichever rails testnet supports (direct rail at minimum).
- [ ] A complete testnet coin exists: token + pool + initial buy + verified contract + 3D logo.
- [ ] Caps/kill/approval tests green. No mainnet launches performed.
- [ ] Report: rails shipped vs excluded (with evidence), owner actions for mainnet go-live.
