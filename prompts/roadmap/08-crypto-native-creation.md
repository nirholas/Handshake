# Prompt 08 — Crypto-native creation: mint, provenance, gating, royalties (new)

> Paste into a fresh Claude Code chat. Follow CLAUDE.md + `prompts/roadmap/00-README.md`. Run `npm run gate` before and after.

## Context
Crypto rails already exist: `contracts/` (ERC-8004 identity, skill-license SPL NFTs, agent-invocation), `packages/provenance-mcp/` (append-only signed on-chain-verifiable action log), the launches feed (`/api/pump/launches`, `pump_agent_mints`), and x402 (USDC + $THREE) settlement. Connect these to 3D creation so assets become ownable, provable, and monetizable.

## Objective
Let creators turn a generated 3D asset into an **owned, provenance-backed, optionally-monetized** on-chain asset — using $THREE + USDC only.

## Tasks (new, additive; reuse existing contracts/rails)
1. **Signed provenance for every asset.** On generation, write a signed provenance record (creator, prompt, parent lineage, model hash, timestamp) via `provenance-mcp`. Verifiable, append-only. This underpins authenticity for everything below.
2. **Mint generated 3D on-chain.** A creator opt-in to mint an asset as an SPL NFT (reuse the skill-license SPL NFT pattern as the reference implementation) referencing the GLB + provenance. Real mint on the existing chain config; clear cost disclosure; never auto-mint.
3. **Token-gated / premium generation.** Add optional gating where premium tiers, higher quality, or exclusive styles require $THREE holdings or an x402 payment. Generic, runtime-supplied gating — $THREE is the only coin referenced; USDC for settlement. The free TRELLIS lane stays free and ungated.
4. **Royalties on remix.** When someone mints/derives from another creator's published asset, route a royalty split to the original via x402 (align with prompt 06/09 lineage). Real settlement, real split math, hard caps.
5. **Launches integration.** Surface minted/created 3D assets in the existing launches/agent-profile records pattern (the product-feature directories CLAUDE.md explicitly allows). Do not hardcode or promote any non-$THREE mint.

## Non-negotiables
- **$THREE is the only coin** referenced anywhere in code, copy, or metadata. USDC is settlement only. No other token, ever. `grep` to prove it.
- Minting/payments are opt-in with disclosure; no surprise on-chain writes. Spend/mint caps enforced.
- Reuse existing contracts/programs; do not deploy a parallel system without justification.

## Verification
- Generate → write provenance → (opt-in) mint an SPL NFT on the configured chain; paste the on-chain reference. Verify provenance is queryable.
- A gated premium generation requires $THREE/x402 and the free lane stays free.
- A remix mint routes a real royalty split (paste settlement ref); caps enforced.
- `grep -ri` for any non-$THREE token across changed files → zero. `npm run gate` green. Changelog + `npm run build:pages`.

## Definition of done
- Provenance on every asset; opt-in on-chain minting; opt-in $THREE/x402 gating with a free lane preserved; remix royalties with caps — all real, all $THREE-only.

## Hand-off
Report the provenance format, mint flow + on-chain refs, gating model, and royalty logic. Commit/push only if asked; `git push threews main` is the only push target.
