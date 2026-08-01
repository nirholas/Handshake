# 10. `npm run test:core` does not finish, so nobody runs the full suite

**Severity: P1.** A suite too slow to run is a suite that stops protecting
anything. Read [00-INDEX.md](00-INDEX.md) first.

## Symptom (reproduced 2026-08-01)

```
$ npm run test:core        # vitest run --maxWorkers=1
... killed at 10m00s, no summary line, no Test Files / Tests totals
```

At the ten-minute mark the output was still streaming fixture logs from
`audit-guards` cases (expected `[audit-guards] N problem(s)` chatter from tests
that deliberately feed bad registries), so the run had not hung on a single
spec; it was simply still going.

Relevant config: [vitest.config.js](../../vitest.config.js) sets
`testTimeout: 120_000` and `pool: 'forks'`. `test:core` pins
`--maxWorkers=1`, which serializes everything.

## What to establish first, before optimizing anything

1. **Is it slow, or is it stuck?** Run `npx vitest run --reporter=verbose` and
   let it finish, however long that takes. Capture the per-file durations.
   Without that table every subsequent decision is a guess.
2. **Which files dominate?** Rank by duration. In this repo the usual suspects
   are specs that reach the network or a database, and specs that import a
   hosted MCP catalog. That last one is a known hazard: importing an
   `api/_mcp*/catalog.js` pulls in DB and RPC clients that block without live
   credentials, and the import alone can exceed 60s. `prompts/roadmap/00-README.md`
   documents this and says not to write such tests.

## The job

1. Produce the per-file duration ranking and put the top 20 in your report.
2. For each expensive file, classify: legitimately heavy compute, accidental
   network or DB access, or a blocking import. Fix the second and third classes
   at the root (inject the client, or move the assertion to a contract test
   against a running server) rather than by raising timeouts.
3. **Question `--maxWorkers=1`.** Find out why `test:core` serializes. If it was
   added to work around a specific flaky interaction, find that interaction and
   fix it, then restore parallelism. If nobody knows, test parallel execution
   and see what actually breaks. Record the answer in the script or in
   `docs/`, because the next agent will ask the same question.
4. Set a target and enforce it: the full suite should finish in a bounded time
   on this machine. Whatever number you land on, make exceeding it visible
   (a reporter threshold, or a slow-test list printed at the end).
5. Do not pipe test runs through `tail`. It masks the exit code, and a vitest
   failure gates the Playwright stage.

## Verification

```bash
npm test                     # completes, with a real summary line
npm run gate                 # no worse than the 00-INDEX.md baseline
```

## Done when

The full suite completes in a bounded, stated time, every file that was slow for
an accidental reason has been root-caused, the `--maxWorkers=1` decision is
either justified in writing or reverted, and the summary line is quotable in a
report.
