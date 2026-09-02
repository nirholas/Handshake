# materialize: forge output becomes a physical object in the buyer's hands

This campaign builds **Materialize**, the lane that takes any three.ws forge
creation from GLB to a high-precision physical print delivered to a door.
The complete loop: prompt or photo, generated 3D model, printability analysis
and automatic repair, true-scale AR preview, itemized quote, Solana USDC
checkout (human or paying AI agent over x402), fulfillment through a
provider adapter, an on-chain birth certificate linking the physical object
back to its generation record, and a tracked delivery.

Nobody has shipped this loop end to end. Pieces exist elsewhere (print
bureaus have upload forms, AI 3D vendors have download buttons), but no
platform closes prompt-to-object in one surface, and no platform lets an AI
agent pay for a physical object of a model it just generated. That second
one is the headline: the x402 print endpoint makes three.ws the first place
where an autonomous agent can order manufacturing.

## Files

| File | Work order | Depends on |
|---|---|---|
| [00-CONTEXT.md](materialize-00-CONTEXT.md) | Shared facts: architecture, schema, naming, OSS decisions, launch scope. Read first, always. | none |
| [01-printability-engine.md](materialize-01-printability-engine.md) | Mesh analysis, repair, and print-format export (STL, 3MF, color) | none |
| [02-quote-order-payments.md](materialize-02-quote-order-payments.md) | Material catalog, quote engine, order state machine, Solana + x402 checkout | 01 |
| [03-materialize-surface.md](materialize-03-materialize-surface.md) | The /materialize page, entry points across the platform, true-scale AR | 01, 02 |
| [04-fulfillment-ops.md](materialize-04-fulfillment-ops.md) | Provider adapter layer, operator fulfillment console, partner onboarding | 02 |
| [05-provenance-phygital.md](materialize-05-provenance-phygital.md) | On-chain print certificates, editions, QR link from object to record | 02 |
| [06-safety-docs-launch.md](materialize-06-safety-docs-launch.md) | Fabrication content gate, docs, spec, changelog, launch checklist | all |
| [PROGRESS.md](materialize-PROGRESS.md) | Cross-chat handoff log. Append on finish. | none |

Run order: 01 first (everything consumes its analysis and export layer),
then 02, then 03/04/05 in any order or in parallel, then 06 to close.
Every order re-derives current state in its step 0, so re-running a
half-finished order is always safe.

## Relation to other packs

The swarm-100 orders in prompts/finish/ audit what exists; this pack builds a
new surface, like the roadmap orders. Where a swarm-100 sweep later touches `api/print/*` or
`/materialize`, both re-derive state first, so order does not matter.

## Retirement

A finished work order is deleted in the same commit as its last deliverable
(git rm, explicit path), per the prompts/README.md retirement policy. The
campaign retires when all six are gone and PROGRESS.md records the evidence.
