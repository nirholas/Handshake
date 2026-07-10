# Production Issues — three.ws

Live tracker for known production issues. When an item is fixed, move it to
the archive instead of leaving it here marked ✅ — this file should only
contain work that is still open.

> Archive of the 2026-05 incident batch (20 items, all resolved):
> [docs/internal/ISSUES-ARCHIVE-2026-05.md](docs/internal/ISSUES-ARCHIVE-2026-05.md)
>
> Archive of 2026-06 resolved items:
> [docs/internal/ISSUES-ARCHIVE-2026-06.md](docs/internal/ISSUES-ARCHIVE-2026-06.md)

---

## Open

The 2026-07-04 production log export (10h window, ~14.7k lines) surfaced a batch
of issues. Every code-side defect was fixed in the same day's commit (retention
coverage, cache flapping, embed WASM OOM, auth 500s, agora uuid 500, custody
504, holders 429 storm, forge-smoke crash). What remains below requires
**operator action in deployment environments** — it cannot be fixed from this
repo:

1. **`JWT_SECRET` unset in production** — every `GET /api/auth/siwe/nonce` and
   `/api/auth/siws/nonce` failed (122 hits in the window); wallet sign-in is
   down until it's set. Now surfaces as `503 not_configured` with a deduped ops
   alert instead of anonymous 500s. Action: set `JWT_SECRET` on the Cloud Run
   service (`gcloud run services update three-ws-api --region us-central1
   --update-env-vars JWT_SECRET=$(openssl rand -base64 64)`).
2. **`WALLET_ENCRYPTION_KEY` unset** — custodial agent wallet provisioning is
   deferred at create time (the secret-box refuses the JWT_SECRET fallback in
   production, by design). Action: set it (`openssl rand -base64 48`).
3. **world.three.ws serving UNPROTECTED** — the live Cloud Run revision lost
   `ADMIN_CODE`; every visitor has build rights (41 warnings across the
   window). Action: re-run `deploy/world/apply-hardening.sh`.
4. **`OPENAI_API_KEY` invalid + OpenRouter out of credits** — the brain chain's
   primary fails ("Incorrect API key provided") and the openrouter mirror
   rejects with insufficient credits; traffic survives on the free fallback
   chain (Groq/NIM). Action: rotate the OpenAI key, top up OpenRouter credits.
5. **Reconstruct lane has no paid fallback** — `/api/avatars/reconstruct`
   returned 502 whenever the HuggingFace Spaces chain failed because neither
   `REPLICATE_API_TOKEN` nor `GCP_RECONSTRUCTION_URL` is configured; consider
   also widening `HF_RECONSTRUCT_SPACES` to include `stabilityai/TripoSR`.
6. **Neon branch pinned over the storage cap** — 582MB ≥ 470MB for the full
   window. Retention now prunes four previously-uncovered table families and
   sweeps orphaned satellites, and its pressure alert names the largest tables.
   If size stays above the mark after a few cycles, bump the Neon plan or
   `DB_RETENTION_HIGH_WATER_MB`.
7. **Helius quota exhaustion** — balances + DAS walks hit "max usage reached"
   (32 warnings). Cadence pressure was cut code-side (holders snapshot now has
   one scheduler + a 10-min 429 cooldown); if throttling persists, bump the
   Helius plan.

The `character-studio/` lint debt (the last open item of the prior batch) was
cleared 2026-06-21 — `eslint character-studio/src` now reports **0 problems**.
Details in the [2026-06 archive](docs/internal/ISSUES-ARCHIVE-2026-06.md).
