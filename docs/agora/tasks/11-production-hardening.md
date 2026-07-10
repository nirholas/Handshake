# Task 11 — Production hardening + launch

**Goal:** Take Agora from "works on my machine" to **100% production-ready** and
launch it: tests across every new surface, all UI states audited, accessibility +
performance verified, security/spend review, real deploy verification, the
changelog + docs, and the push to `threews`. This is the gate — nothing ships
until every box here is true.

**Depends on:** all prior tasks (run last, or run incrementally as slices land).

## Context to read first
- `CLAUDE.md` (§ Definition of done, § Self-review protocol) and `docs/agora.md`
  (§ Invariants).
- `00-INDEX.md` (global guardrails).
- Everything Agora shipped: `api/agora/*`, `workers/agora-citizens/*`,
  `src/agora/*`, `pages/agora.html`, `packages/agora-mcp/*`, the migration.
- `tests/` (house test style), `data/changelog.json` + `npm run build:pages`,
  `data/pages.json`.
- The `completionist` agent and `/code-review` — use them.

## Build (scope)
1. **Tests.** `node --test` coverage for: the economy API shapes + empty/error
   paths (mock the DB/bazaar at the boundary only — never ship mocks in app code);
   the engine's loop transitions, idempotency (no double-projection), and failure
   isolation; each profession module's proof derivation; `agora-mcp` tools;
   migration sanity. Add to the existing suite so `npm test` covers Agora.
2. **Every state, audited.** Walk each surface for loading / empty / error /
   populated / overflow (0, 1, 1000 citizens; very long names; mid-op network
   failure; expired session; insufficient funds; slashed stake). Fix any blank
   void, dead button, or unreachable state. Confirm the empty economy renders
   honestly end-to-end (no fabricated anything).
3. **Accessibility.** Semantic HTML, ARIA on interactive elements, keyboard nav +
   focus traps in panels, visible focus rings, color contrast, `prefers-reduced-
   motion` honored in all 3D FX. Run an a11y pass (axe/Lighthouse).
4. **Performance.** Lazy-load heavy modules + GLBs; paginate `citizens`; debounce
   polls; pause render on hidden tab; **dispose** Three.js resources (no leak over
   30 min); code-split the Agora bundle. Lighthouse perf budget met; 60fps with a
   busy board + a fleet.
5. **Security + spend review.** `/api/agora/act` (and any mutating path):
   authenticated, input-validated at the boundary, idempotent, rate-limited,
   spend-capped; secrets never logged; mainnet $THREE behind explicit env +
   confirmation. Run `/security-review` on the branch. Confirm the bundler trap
   didn't bloat `api/*.js` (`head -1` check).
6. **Deploy verification.** Build clean (`npm run build`, `npm run build:pages`);
   confirm the worker image builds (`workers/agora-citizens` Docker/cloudbuild);
   smoke the deployed `/api/agora/*` + `/agora` against real data; the life engine
   runs on devnet in the deployed environment.
7. **Docs + changelog + index.** Update `docs/agora.md` roadmap checkboxes to
   reflect reality; mark task status in `00-INDEX.md`; ensure `data/pages.json`
   has `/agora`; add the launch `data/changelog.json` entry (feature) and run
   `npm run build:pages` (it validates the entry). After deploy,
   `npm run changelog:push` (if creds present).
8. **Final self-review.** Run the `completionist` agent on the changed files and
   `/code-review` on the diff; resolve findings. Then the CLAUDE.md pride check.

## Out of scope
New features. This task only hardens, verifies, documents, and launches what
exists. If you find a missing feature, file it as a new task file, don't scope-creep.

## Definition of Done (the launch gate — all must be true)
- [ ] `npm test` green, including new Agora tests; meaningful coverage of API,
  engine, professions, MCP.
- [ ] Every surface's loading/empty/error/populated/overflow states designed and
  reachable; no blank voids, no dead paths.
- [ ] Accessibility pass clean (keyboard, ARIA, contrast, focus, reduced-motion).
- [ ] Performance: lazy-load + pagination + dispose verified; no leak over 30 min;
  60fps busy; Lighthouse budget met.
- [ ] Security: mutating endpoints authed/validated/idempotent/rate-limited/spend-
  capped; `/security-review` findings resolved; no secret logging; mainnet gated.
- [ ] Deployed `/api/agora/*`, `/agora`, the worker, and `agora-mcp` all verified
  against real data (paste evidence: URLs, tx signatures, screenshots).
- [ ] `docs/agora.md` + `00-INDEX.md` statuses current; `data/changelog.json`
  entry added + `build:pages` passes; `/agora` in `data/pages.json`.
- [ ] `git diff` reviewed line-by-line; `completionist` + `/code-review` clean.
- [ ] Pushed to `threews` (the canonical remote).
- [ ] You would proudly demo Agora to a room of senior engineers.

## Verification
```bash
npm test
npm run build && npm run build:pages
head -1 api/agora/*.js api/agenc/*.js        # ensure no esbuild bundle bloat
# a11y + perf: Lighthouse on /agora
# deploy smoke: curl the live /api/agora/* ; load /agora ; run the engine on devnet
```
Then `completionist` on changed files + `/code-review` on the diff.

## Guardrails
- Do not relax any DoD box to "good enough." If something can't be verified, say so
  explicitly and don't claim done.
- `$THREE` only; no other coin anywhere (code, tests, fixtures, copy, changelog).
- Stage explicit paths; re-check `git status`/`--staged` (concurrent agents share
  the worktree). Push to `threews` only; **never** pull/fetch from the retired `threeD` mirror.
