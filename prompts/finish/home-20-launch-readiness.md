# 20. Launch readiness: the go/no-go

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Run this **last**, after
every other order in the campaign has been retired, and run it again after any change to the lane.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**This order verifies, it does not build.** If a check fails, either fix it here (small) or
re-open the owning order (large) and say which. A go/no-go that finds nothing because it looked
at nothing is worse than no gate at all.

---

## Step 0: re-derive the current state

```bash
ls prompts/finish/home-*.md                              # what is still open. Every open order is a no-go input.
npx vitest run --root .
npx playwright test tests/e2e/ 2>&1 | tail -20
npm run gate 2>&1 | tail -30
npm run audit:docs && npm run check:claude && npm run check:docs-search
git log --oneline -20
```

## The go criteria

Every line is mechanically checkable and every line needs the command output pasted. A line you
cannot verify is a no-go, not a judgement call.

### Correctness and safety

- [ ] Order 11's eleven security checks all pass, re-run today.
- [ ] The confirmation-integrity invariant holds: zero rows anywhere in `home_action_log` with `guarded = true`, `confirmed_by is null`, `outcome = 'ok'`. Paste the query and the count.
- [ ] The order 16 e2e journeys all pass, including the three that assert on a real lock's real state.
- [ ] No home tool schema anywhere exposes `confirmed`. Re-dump and paste.
- [ ] The prompt-injection regression passes with the real physical assertion.
- [ ] SSRF refusals still hold, including the DNS-rebinding pin.
- [ ] The role matrix passes every cell, and a `guest` still cannot confirm.

### Reliability

- [ ] The order 14 chaos scenarios re-run green, or every deviation is explained.
- [ ] p95 action latency measured today against the published SLO.
- [ ] A ten-minute live session leaves heap flat.
- [ ] Ten consecutive runs of the lane's suites, green.

### Operations

- [ ] `/api/healthz` reports the `home` subsystem with real numbers.
- [ ] All three alerts are wired and each has been fired at least once in a test, with the transcript.
- [ ] `docs/home-operations.md` exists and every command in it was run.
- [ ] The rollback path in `docs/ops/gcp-production.md` was walked, at least in a dry run, and the exact commands are in your report.
- [ ] Any cron the lane added: `npm run check:cron-drift` clean, `vercel.json` cron count matches CLAUDE.md, `npm run check:claude` passes.

### Product completeness

- [ ] Every state enumerated by orders 05, 06, 07, 08 exists. Walk the list and screenshot each. A missing state is a no-go.
- [ ] No dead paths: every button acts, every link resolves, every reachable state has a way out.
- [ ] Zero console errors and zero console warnings from lane code, on every surface.
- [ ] `npm run audit:web` (authed, per `docs/ops/page-audit.md`) clean for every home route.
- [ ] axe passes on every home route.
- [ ] `npm run i18n:lint` clean.
- [ ] 320px, 768px and 1440px correct on every state.

### Data and privacy

- [ ] The order 15 inventory matches the schema exactly, re-checked today.
- [ ] Account deletion leaves zero rows across every lane table.
- [ ] The log-scrub proof re-run: zero hits for base URL, token and entity names.
- [ ] No persisted entity-state history exists.

### Documentation and release

- [ ] `npm run audit:docs` clean.
- [ ] Every tutorial command re-run today and still working.
- [ ] `STRUCTURE.md` and `data/pages.json` cover every surface.
- [ ] The `data/changelog.json` entry is present, plain-language, and validated by `npm run build:pages`.
- [ ] `docs/smart-home.md` describes what shipped, with no plan-tense claims left.

### The build

- [ ] `npm run gate` passes.
- [ ] `npm test` passes with no new failures. Do not pipe it through `tail`; that masks the exit code.
- [ ] `npm run check:rules -- --base <lane start sha> --head HEAD` clean across the whole lane.
- [ ] `node scripts/check-secrets.mjs --base <lane start sha> --head HEAD` clean.
- [ ] The `deploy-preflight` subagent has been run and reports the deploy safe.

## The launch decision

Produce a one-page verdict in your report:

1. **Go or no-go**, stated first, in one line.
2. Every failing check, what it blocks, and which order owns it.
3. Every accepted residual, with the risk named and the reason.
4. The measured numbers: p95 latency, state freshness, connection cost, the version matrix.
5. The rollback plan in three commands.
6. The single owner message, containing everything owner-gated in one place: the deploy, the npm
   publishes, the add-on repository publish, and the entitlement prices.

## The deploy itself

Owner-gated. Follow the CLAUDE.md deploy runbook **exactly and in order**, and do not hand-run
its steps out of order:

```
npm run clean:worktrees -- --apply
npm run prep:worktree -- --apply
npm run build:gcp
npm run deploy:gcp:submit
npm run deploy:gcp:purge-cdn
npm run smoke:prod
```

Then verify: `curl -s https://three.ws/api/version` returns the shipped SHA and revision.

Prepare all of it, run everything up to the submit, and stop for the owner's yes. Do not deploy.

## Post-launch watch, first 48 hours

Write this into `docs/home-operations.md` before launch, not after:

| Hour | Check |
|---|---|
| 0 | `/api/healthz` home block, the first real connection, the first real action |
| 1 | handshake success rate across all tenants; confirmation expiry rate |
| 6 | heap trend on the API service; subscriber counts |
| 24 | p95 latency against the SLO; the action-log integrity query |
| 48 | the full alert set has not fired spuriously; the error budget consumed so far |

## Never blocked

| Blocker | Do this |
|---|---|
| An order is still open | Then it is a no-go input. Say so, name the order, and do not paper over it with a judgement call. |
| A check cannot be run in this environment | Name it, name what access it needs, and mark it explicitly unverified in the verdict. Never mark it green. |
| Something fails and the fix looks small | Fix it, re-run the whole section, and note it. |
| Something fails and the fix looks large | Re-open the owning order, put it in the no-go list, and say what it blocks. |
| Pressure to ship with a failing safety check | There is no version of this where a door that opens without a confirmation ships. That check is a hard no-go with no override. |

## Report format

The one-page verdict above, then the full command output for every checked line, grouped by
section. Nothing summarised, nothing claimed without its output.

## Retire this prompt when it is done (required)

This order is **standing**: re-run it before every deploy of the lane. Delete it only when the
campaign is retired and the lane is in steady operation, in the same commit that removes
[00-CONTEXT.md](home-00-CONTEXT.md):

       git rm prompts/finish/home-20-launch-readiness.md

Until then, leave it in place and record each run in `prompts/finish/home-PROGRESS.md`.
