# Task 01 — Verify the Agora foundation

**Goal:** Get the Phase-1 foundation (data model + economy read API) actually
running and proven green against the real DB and the real x402 bazaar, and
unblock the local SDK build so the AgenC stack is importable. After this task,
`/api/agora/*` returns correct, real data and the next tasks have solid ground.

**Depends on:** nothing. This is the first task.

## Context to read first
- `docs/agora.md` — the spec.
- `docs/agora/tasks/00-INDEX.md` — shared context + guardrails.
- `api/_lib/migrations/20260629020000_agora_world.sql` — the tables.
- `api/agora/[action].js` — the endpoint you're verifying.
- `api/_lib/db.js`, `package.json` (`db:migrate`, `db:status`, `db:bootstrap`).
- `solana-agent-sdk/package.json` (build = `tsup`).

## Background
Phase 1 already wrote three artifacts (spec, migration, economy API). They have
**not** been applied/smoke-tested. The `board` and `pulse` lanes should be live
immediately (they read the real x402 bazaar); `citizens`/`passport` should return
honest empty states until the life engine (Task 02) seeds them. The Solana write
SDK may be unbuilt locally (`tsup` bus-errors in constrained sandboxes).

## Build (scope)
1. **Apply the migration.** `npm run db:status` to see pending, then
   `npm run db:migrate` to apply `20260629020000_agora_world.sql`. Confirm both
   `agora_citizens` and `agora_activity` exist with their indexes. If
   `DATABASE_URL` points at the canonical Neon DB, apply there; otherwise use the
   configured dev DB. Do **not** drop/recreate anything else.
2. **Unblock the SDK build.** Build `@three-ws/solana-agent` so `dist/` exists
   (`cd solana-agent-sdk && npm run build`). If `tsup` bus-errors, diagnose:
   try raising Node memory, a single-threaded esbuild, or emit via `tsc` as a
   fallback **without** changing the committed build tooling for everyone (a
   local emit is fine; if a tooling change is genuinely needed, make it minimal
   and justify it). The success bar: `node -e "import('@three-ws/solana-agent')"`
   resolves. If the sandbox genuinely cannot build native esbuild, document the
   exact failure and confirm the package builds in CI instead — then proceed.
3. **Smoke-test all four actions** against a running API (`npm run dev`, or invoke
   the handler directly). Capture real output:
   - `GET /api/agora/board` → real x402 services in `services[]`; `tasks[]` empty
     (no postings yet); `empty:false`.
   - `GET /api/agora/pulse` → honest zeros, `coin.symbol === "$THREE"`,
     `empty:true`.
   - `GET /api/agora/citizens` → `{ count:0, citizens:[], empty:true }`.
   - `GET /api/agora/passport?id=<random-uuid>` → `404 not_found`.
4. **Fix anything the smoke test surfaces.** Shapes must match the contracts in
   the endpoint. No console errors.

## Out of scope
Seeding citizens, posting tasks, any UI. Those are later tasks. Do not write fake
rows to make `citizens`/`pulse` look populated — empty is correct here.

## Definition of Done
- [ ] `agora_citizens` + `agora_activity` exist in the target DB with all indexes
  from the migration; `npm run db:status` shows the migration applied.
- [ ] `@three-ws/solana-agent` imports successfully in Node (or a written,
  reproduced explanation of the sandbox-only build failure + CI confirmation).
- [ ] All four `/api/agora/*` actions return the documented shapes against real
  data, captured in the task report (paste the JSON).
- [ ] `board.services` contains real bazaar entries; `pulse.empty === true`;
  `citizens.empty === true`; unknown `passport` 404s.
- [ ] No console errors/warnings from Agora code.

## Verification
```bash
npm run db:status
npm run db:migrate
cd solana-agent-sdk && npm run build && node -e "import('@three-ws/solana-agent').then(()=>console.log('SDK ok'))"; cd ..
npm run dev   # then, in another shell:
curl -s localhost:3000/api/agora/board  | head -c 1200
curl -s localhost:3000/api/agora/pulse
curl -s localhost:3000/api/agora/citizens
curl -s "localhost:3000/api/agora/passport?id=00000000-0000-0000-0000-000000000000" -i | head -1
```

## Guardrails
- Migrations are forward-only; don't edit an already-applied migration file —
  add a new one if a change is needed.
- `$THREE` is the only coin; the placeholder mint in any test is synthetic.
- Stage explicit paths. If committing, push to `threews` only; this is internal
  plumbing so **no** changelog entry.
