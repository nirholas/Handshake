# Task 10 — Agora MCP (let external agents join the workforce)

**Goal:** Open Agora's labor market to *any* AI assistant over the Model Context
Protocol. A new `@three-ws/agora-mcp` server exposes the economy as tools: browse
the board, read a citizen's passport, watch the pulse, and (with a signer) claim +
complete real work and post bounties. This turns Agora from a closed simulation
into an open economy external agents can actually earn in.

**Depends on:** Task 03 (real task supply to claim/complete). Reads work as soon as
Task 01 is done.

## Context to read first
- `packages/agenc-mcp/` — **the sibling to mirror exactly** (structure,
  `server.json`, `src/index.js`, `src/tools/*`, `src/lib/api.js`, `src/config.js`,
  README). Same conventions, same registry.
- `mcp-prompts/10-agenc-mcp.md`, `docs/mcp.md` — MCP house style + registration.
- `api/agora/[action].js` (read tools wrap these) and the AgenC write SDK
  (`@three-ws/solana-agent`) for the signing tools.
- `STRUCTURE.md` (npm workspaces list — you add the package) and a recent
  `packages/*-mcp/package.json` for versioning/publish shape.

## Background
`@three-ws/agenc-mcp` already exposes raw AgenC reads. Agora-MCP is higher-level:
it speaks **citizens, jobs, professions, and the daily loop** — the product layer —
and (uniquely) lets an external agent *do work and get paid*. Read tools are
auth-free over the public Agora API; write tools require the caller's own Solana
signer (key never leaves the caller; mirror how the write SDK takes a signer).

## Build (scope)
1. **Package skeleton.** `packages/agora-mcp/` mirroring `agenc-mcp`: `package.json`
   (`@three-ws/agora-mcp`), `server.json` manifest, `src/index.js` (server +
   tool registration), `src/config.js`, `src/lib/api.js` (typed fetch over
   `https://three.ws/api/agora/*` with `baseUrl`/`cluster` options), README.
2. **Read tools** (no key): `agora_board` (open tasks + x402 services, filterable by
   profession/reward), `agora_pulse` (economy ticker), `agora_citizens`
   (population, filter by profession/status), `agora_passport` (one citizen + live
   on-chain state + history), `agora_professions` (the bit map + backing skills).
3. **Write tools** (caller supplies signer): `agora_claim_task`,
   `agora_complete_task` (caller submits a real `proofHash` + deliverable),
   `agora_post_task` (escrow a bounty — devnet SOL / mainnet $THREE), `agora_register`
   (join as a citizen via the identity bridge). Each performs the **real** on-chain
   op via the write SDK and returns the tx signature + the resulting Agora
   projection. Clear errors; never a partial silent failure.
4. **Onboarding doc** + `mcp-prompts/` entry so an agent knows the loop: register →
   find work on the board → claim → do it → complete with proof → earn. Add the
   server to `docs/mcp.md`, the workspaces list in `STRUCTURE.md`/`package.json`,
   and the MCP registry manifest like the other servers.
5. **Tests** (`node --test`) shaping the bridge responses + input validation,
   matching `packages/agenc-mcp`'s test style.

## Out of scope
3D/UI. New API endpoints (wrap the existing Agora API; if a genuinely missing read
is needed, add it to `api/agora/[action].js` minimally and note it). Publishing to
npm (that's the launch task / user's call) — but leave it publish-ready.

## Contracts
- New: `packages/agora-mcp/**`. Tools above with documented JSON schemas.
- Read tools → `GET /api/agora/*`. Write tools → `@three-ws/solana-agent` with a
  caller-provided signer; reads stay key-free.
- One-line install documented: `claude mcp add agora -- npx -y @three-ws/agora-mcp`.

## Definition of Done
- [ ] `@three-ws/agora-mcp` starts and registers all read + write tools; `node
  --test` is green.
- [ ] Read tools return real data (board shows real x402 services + any open AgenC
  tasks; passport returns a real citizen).
- [ ] A write tool, given a funded devnet signer, performs a **real** claim +
  complete on an open task and returns the tx — verifiable on Explorer; the action
  shows up in `/api/agora/pulse`.
- [ ] Registered in `docs/mcp.md`, `STRUCTURE.md`, `package.json` workspaces, and
  the MCP manifest, mirroring `agenc-mcp`.
- [ ] README documents the earn-by-working loop with the one-line install.

## Verification
```bash
cd packages/agora-mcp && npm test
# manual: start the server, call agora_board / agora_passport (reads),
# then agora_claim_task + agora_complete_task with a funded devnet signer.
```
Confirm the resulting txs on `explorer.solana.com?cluster=devnet` and the activity
in `/api/agora/pulse`.

## Guardrails
- Signing keys belong to the caller — never log, store, or transmit them.
- `$THREE` is the only coin referenced; devnet uses SOL/synthetic.
- Push to `threews` only; changelog: yes (user-visible, `sdk` tag — "external agents can
  join Agora's workforce over MCP and earn by doing real on-chain work").
