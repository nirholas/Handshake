# GCP $100k Credit Program — Prompt Pack

Run each prompt in a **fresh Claude Code chat**, in order. Each is self-contained and ends with
verification + commit/push. Do not skip verification sections — a prompt is only done when its
acceptance criteria all pass.

## Run order & dependencies

| # | File | Depends on | Can run in parallel with |
|---|------|-----------|---------------------------|
| 1 | `01-gcp-foundation.md` | — | — (run first, alone) |
| 2 | `02-vertex-claude-provider.md` | 01 | 03, 04 |
| 3 | `03-imagen-activation.md` | 01 | 02, 04 |
| 4 | `04-gpu-workers-deploy.md` | 01 | 02, 03 |
| 5 | `05-catalog-animation-seeding.md` | 04 | 06, 07 |
| 6 | `06-vanity-inventory.md` | 01 | 05, 07 |
| 7 | `07-spend-observability.md` | 01 (best after 02–04) | 05, 06 |
| 8 | `08-expiry-revert-runbook.md` | all of the above | — (run last) |

## Ground rules baked into every prompt

- **Everything behind env flags.** Credits expire in ~1 year; every reroute must revert by
  flipping env vars, never by migrating code back.
- **No mocks, no placeholders, no half-wiring** (CLAUDE.md rules apply in full).
- **Fail-safe chains.** Vertex/GCP lanes slot into existing provider chains as preferred lanes
  with automatic fallthrough to the current providers on error — a GCP outage must never take
  down a feature that works today.
- **Never commit secrets.** Service-account JSON goes into Vercel env / local `.env` only.
- Push with `git push threews main` — the only push target. Never push/pull/fetch/merge `threeD` (retired mirror, diverged history).

## Budget targets (for context, not hard caps)

- Claude on Vertex (dev + production chain inversion): $40–60k
- GPU fleet (Cloud Run L4: TRELLIS/Hunyuan3D/UniRig/TripoSG/text2motion): $15–25k
- Imagen: $3–5k · Vanity/observability/misc: ~$5k · Reserve: remainder
