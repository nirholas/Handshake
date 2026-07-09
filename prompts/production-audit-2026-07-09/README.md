# Production Audit 2026-07-09 — Prompt Pack

Source: full production sweep (static code audits + live check of all 303 catalog routes +
real-Chromium crawl of every page) run 2026-07-09, post-Vercel→Cloud Run migration. 305 pages
crawled, 74 console/network errors, 935 warnings, 34 commits sitting undeployed.

Run each prompt in a **fresh Claude Code chat**. Each is self-contained and ends with
verification + commit (push per the repo's normal git rules — `threews` only, see root
`CLAUDE.md`). Do not skip verification — a prompt is only done when its acceptance criteria
pass against the **live** site, not just locally.

## Run order & dependencies

| # | File | Depends on | Can run in parallel with |
|---|------|-----------|---------------------------|
| 1 | `01-deploy-production.md` | — | — **run this first, alone** |
| 2 | `02-homepage-thumbnail-orb.md` | — | 03, 04, 05, 06 |
| 3 | `03-oracle-ipfs-image-proxy.md` | — | 02, 04, 05, 06 |
| 4 | `04-meshopt-decoder-crash.md` | — | 02, 03, 05, 06 |
| 5 | `05-cors-proxy-jupiter-ufo.md` | — | 02, 03, 04, 06 |
| 6 | `06-js-module-bugs.md` | — | 02, 03, 04, 05 |
| 7 | `07-world-admin-hardening.md` | 01 (deploy ships nothing here; independent, but owner must run the secret-minting step) | any |
| 8 | `08-x402-sponsor-cosign.md` | — (owner-supplied secret) | any |
| 9 | `09-polish-sweep.md` | 01–06 ideally deployed first so the crawl re-check is clean | last |

Prompts 2–6 all touch client-side code with no shared files — genuinely parallel. Run 01 first
by itself since it ships 34 commits including the `/app` and `/chat` routing fix that is
otherwise silently sitting undeployed; every other prompt's "verify against production" step is
more trustworthy once 01 has shipped.

## Ground rules baked into every prompt

- **No mocks, no placeholders, no half-wiring** (root `CLAUDE.md` rules apply in full).
- **Verify against the live behavior**, not just a green test suite — this audit was itself
  found by a real-Chromium crawl; re-run the equivalent check (`npm run audit:pages` /
  `scripts/page-audit.mjs` against the affected path, or a manual browser check) before
  claiming a prompt done.
- **Deploy is `npm run deploy:gcp`** (builds frontend + submits to Cloud Run via
  `server/cloudbuild.yaml`). Run `npm run build` first if you changed frontend-only files and
  need to sanity-check `dist/` locally.
- Every fix here is a **bug fix**, not a redesign — match existing patterns in the surrounding
  code (see each prompt's "Context" section for the exact file/pattern to follow).
- Append a `data/changelog.json` entry for anything user-visible per the root `CLAUDE.md`
  changelog rules — tag `fix`.

## Source

Audit artifact: `scripts/page-audit.mjs` (Chromium, desktop, concurrency 8) ·
`scripts/verify-routes.mjs --base=https://three.ws --all` ·
`npm run audit:mcp` / `audit:handlers` / `audit:hidden-guard` / `audit:x402-catalog` /
`audit:tokens` · `scripts/audit-links.mjs` · `/api/healthz` · `git log`.
