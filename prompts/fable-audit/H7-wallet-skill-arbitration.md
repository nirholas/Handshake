# H7 — High: Two colliding wallet/payment skill stacks with no arbitration

**Severity:** High · **Area:** Model-facing skill files · **Commit-gate:** ⚠ partial

## The defect
Two parallel wallet/payment stacks fire on overlapping triggers and neither defers
to the other, so the model nondeterministically picks a signing path:

| Intent | Stack A (`awal` / three-ws-core) | Stack B (OKX `onchainos`) |
|---|---|---|
| "send USDC" | `send-usdc` | `okx-agentic-wallet` |
| "swap USDC for ETH" | `trade` | `okx-dex-swap` |
| "pay for an API / x402 / 402" | `pay-for-service` + `x402` | `okx-agent-payments-protocol` |

Verified: neither stack's `SKILL.md` references or defers to the other. A user's
funds could move through either signing path depending on which skill the model
happens to select.

## The fix
Add an explicit arbitration rule to each colliding skill's description/body. Choose
one deterministic axis and apply it consistently — recommended: **by chain / venue**:
- Solana + three.ws-native wallet operations → `awal` stack.
- OKX-routed / EVM-DApp / named-venue operations → `onchainos` stack.

Concretely, in each skill's frontmatter description add a one-line disambiguation,
e.g. in `send-usdc`: *"For OKX-managed accounts or EVM chains, defer to
`okx-agentic-wallet`."* and the mirror clause in `okx-agentic-wallet`. Do the same
for the swap pair and the x402/pay pair.

## Commit-gate note
The `awal` core skills (`send-usdc`, `trade`, `pay-for-service`, `x402`) are freely
committable. The OKX skills reference OKX (another project) — edits that touch them
fall under the CLAUDE.md commit gate → **get owner approval before staging the OKX
side.** You can land the `awal`-side arbitration clauses first without the gate.

## Verification
Walk each colliding intent mentally: exactly one skill should now be the clear match
for a given chain/venue; the other explicitly steps aside.

## Done checklist
- [ ] One deterministic arbitration axis chosen and documented.
- [ ] `awal`-side disambiguation clauses added (no gate).
- [ ] OKX-side clauses staged only after owner approval (commit-gate).
- [ ] Overlaps re-walked; each intent resolves to one skill.
