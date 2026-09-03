# 16. The test program: e2e, the Home Assistant version matrix, the live harness

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Run this after the
orders it tests have landed, and before order 20.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
npx vitest run --root . 2>&1 | tail -5
ls tests/home-*.test.js tests/e2e/home-*.spec.js 2>/dev/null
npx playwright test --list 2>/dev/null | grep -i home | head
cat packages/home-bridge/tests/fixtures/home.json | head -3
```

## The problem this order solves

By now the lane has tests written by six different orders against whatever Home Assistant version
happened to be `stable` that day. Home Assistant ships a release every month and deprecates
WebSocket commands and entity attributes across them. **The lane's correctness depends on a third
party's monthly release, and nothing currently notices when that breaks.**

## The harness

A single, reusable way for any test or any developer to get a real Home Assistant.

`scripts/home-test-instance.mjs`, doing everything the investigation did by hand:

| Command | Does |
|---|---|
| `--up [--version 2026.9]` | pulls and starts a container on a free port, waits for readiness |
| `--onboard` | completes onboarding through the real API, mints a long-lived token, prints it |
| `--seed` | enables `demo:`, creates areas, a floor, assigns entities, creates the Bedtime and Away Mode scenes, enables `mcp_server`, exposes a lock to Assist |
| `--down` | removes the container and its config directory |
| `--json` | machine-readable output so a test can consume it |

Idempotent, safe to run twice, and it must never touch a container it did not create. It writes
its config under a gitignored path and never commits a token.

**Every existing live test in the lane switches to this harness.** One way to get an instance,
not six.

## The version matrix

Home Assistant versions to hold: **the current `stable`, the two previous monthly releases, and
the oldest still in wide use.** Determine the real version list from the Home Assistant release
history at the time you run this; do not hardcode the list from this file.

`scripts/home-version-matrix.mjs` runs the lane's live suite against each version and produces a
table:

| Version | Connect | Registries | State stream | Service call | Scenes | `mcp_server` | Notes |
|---|---|---|---|---|---|---|---|

A cell that fails is a finding, and the finding is either "we depend on something version-specific
and must feature-detect" or "this version is genuinely unsupported and the UI must say so". Both
are acceptable outcomes; silence is not.

Feature detection, never version sniffing: ask the instance what it supports (the `mcp_server`
probe already does this) rather than parsing a version string and branching. Record the supported
range in `docs/smart-home.md` and in `packages/home-bridge/README.md`.

## The e2e set

Playwright, in `tests/e2e/`, against a real seeded instance from the harness. The journeys, each
end to end through the real UI:

1. Connect a home, see the rooms, disconnect.
2. Toggle a light from the 3D scene and see the real device change (assert on the Home Assistant side).
3. Change a light in Home Assistant and see the scene update.
4. Say "good night" through the chat surface, watch the confirmation flow if the house's scene
   touches a lock, and assert the real scene ran.
5. Attempt an unlock, get the confirmation card, cancel it, assert the door stayed locked.
6. Attempt an unlock, confirm it, assert the door unlocked.
7. A guest member (order 12) attempts an unlock and is refused by role.
8. Kill Home Assistant mid-session, see the stale state, restart, see recovery. No page reload.
9. Author a floorplan, reload, see it persist.
10. The private-host refusal, with no network call.

Journeys 5, 6 and 7 are the ones that matter. **Every one of them asserts on the real lock's real
state read back from Home Assistant, never on our own UI text.**

## Flake policy

A flaky test in this lane is worse than no test, because it trains people to ignore a suite that
guards a door.

- No arbitrary `waitForTimeout`. Wait for a condition: the SSE event, the state in Home Assistant,
  the element.
- Every live test has a hard timeout and cleans up its instance in a `finally`.
- A test that fails intermittently gets fixed or deleted in the same session it is discovered.
  Never quarantined and never retried into passing.
- The suite must pass ten consecutive runs before you call this order done. Run it ten times.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | The harness. | `scripts/home-test-instance.mjs` |
| 2 | Migrate every existing live test in the lane onto it. | `tests/home-*.test.js`, `packages/home-bridge/tests/live-home.test.js` |
| 3 | The version matrix runner and its output table. | `scripts/home-version-matrix.mjs`, `docs/smart-home.md` |
| 4 | Feature detection wherever the matrix found a version difference. | `packages/home-bridge/src/*` |
| 5 | The ten e2e journeys. | `tests/e2e/home-*.spec.js` |
| 6 | Regenerate the fixture from the current stable so the pure suite tracks reality. | `scripts/capture-home-fixture.mjs`, the fixture |
| 7 | A `README.md` section in `tests/e2e/README.md` explaining how to run the lane's suites. | as listed |

## Definition of done

- [ ] `node scripts/home-test-instance.mjs --up --onboard --seed --json` produces a working instance and a token, twice in a row, and `--down` cleans up completely. Paste both runs.
- [ ] Every live test in the lane uses the harness. `grep -rn "localhost:8123" tests/ packages/` shows only the harness itself.
- [ ] The version matrix table is filled in from real runs, is published in `docs/smart-home.md`, and every failing cell has either a feature detection or a stated unsupported range.
- [ ] All ten e2e journeys pass. Paste the run.
- [ ] Journeys 5, 6 and 7 assert on Home Assistant's own lock state, and the assertion is visible in the test source. Quote it.
- [ ] `grep -rn "waitForTimeout" tests/e2e/home-*.spec.js` returns nothing.
- [ ] Ten consecutive full runs of the lane's suites, all green. Paste the tally.
- [ ] The fixture is regenerated and the pure suite still passes against it.
- [ ] `npx vitest run --root .` shows no new failures.
- [ ] `npm run audit:docs` clean, `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| Docker is unavailable | Then this order cannot be done honestly, because every claim here rests on a real instance. Say so at the top of your report and stop that specific work; do not substitute fixtures and call the matrix verified. |
| An old Home Assistant version fails to boot | Record it as unsupported with the error, and set the supported floor accordingly. That is a finding, not a blocker. |
| Disk fills from many container images | `npm run clean:worktrees` reclaims worktrees; `docker image prune` reclaims images. Pull versions one at a time in the matrix runner and remove each after. |
| A journey is slow because it waits on real hardware timing | Real is the point. Bound it with a hard timeout and wait on conditions, not sleeps. |
| A test is flaky and the deadline is close | Delete it and say so. A flaky test on a door is worse than an absent one. |

## Report format

1. The two harness runs and the cleanup.
2. The version matrix table, filled from real runs.
3. Every feature detection added.
4. The e2e run, and the quoted lock assertions from journeys 5 to 7.
5. The ten-consecutive-runs tally.
6. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-16-test-program.md

Never delete it on a partial.
