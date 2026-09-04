# P100-05: Guards that exist but run nowhere

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/production-100-05-unwired-guards.md`".
Read [00-INDEX.md](production-100-00-INDEX.md) and `CLAUDE.md` first.

## Why this order exists

On 2026-09-04 production answered `/api/healthz`, `/api/wk`, `/api/x402-pay` and every
`/api/home/*` route with a 500 for roughly thirteen hours. The cause was a packaging rule:
`.gcloudignore` is an allowlist and never re-included `services/`, so two modules the server
imports at load time were absent from the image. Nothing was red. A missing re-include is not
a build error, it is a runtime one.

`scripts/check-gcloudignore.mjs` had been written specifically to catch that, and its own
commit message claimed it "fails before a build instead of in production". It did not, because
it was referenced by no npm script. An unwired guard is not a guard, and the commit that
added it read as protection while providing none.

That guard is now wired into `gate` and `deploy:gcp:submit`, and
`tests/gcloudignore-wiring.test.js` pins the wiring. This order handles the rest of the class:
**39 of the repo's 73 `check:*` / `audit:*` scripts are referenced by no other npm script.**

## Binding operating clause

1. Finish 100% of what this machine can do. Never end with a question or an unexecuted plan.
2. **Do not wire a red guard into `gate`.** `gate` is the deploy path for every agent here;
   adding a failing check blocks everyone's work, including concurrent sessions. A guard is
   either fixed to green and then wired, or left unwired with its reason recorded.
3. Hard rules: no mocks, no shortcuts, explicit-path commits only, no em-dash characters.

## Step 0: re-derive the state (trust no number in this file)

```bash
node -e "
const s=require('./package.json').scripts, all=Object.keys(s);
const bodies=all.map(k=>s[k]).join(' && ');
const guards=all.filter(k=>/^(check|audit):/.test(k));
const unwired=guards.filter(k=>!new RegExp('npm run '+k.replace(/[:.]/g,'\\\\\$&')+'(\\\\s|\$|&)').test(bodies));
console.log(guards.length+' guards, '+unwired.length+' unwired'); unwired.forEach(u=>console.log('  '+u));
"
```

Measured 2026-09-04: 73 guards, 39 unwired. Sampling ten of the cheap repo-only ones gave:

| Guard | Exit | Note |
|---|---|---|
| `audit:deploy` | 0 | Already covered by `tests/deploy-artifacts.test.js`, so `npm test` runs it. Wire or leave, but say which. |
| `check:skills-seed` | 0 | Green, cheap, wireable today. |
| `audit:motion` | 0 | Green, cheap, wireable today. |
| `audit:route-shadowing` | 1 | Real findings. Fix first. |
| `check:runnable-docs` | 1 | Real findings. Fix first. |
| `check:doc-media` | 1 | 30 problems. Fix first. |
| `check:docs-search` | 1 | Committed index stale; `npm run build:docs-search` and commit. |
| `audit:tour-global` | 1 | `public/tour-builder/tour.global.js` stale; `npm run build:tour-global`. |
| `audit:csp` | 124 | Exceeded 150s. Measure its real runtime before considering it for `gate`. |
| `audit:overlays` | 124 | Same. |

The other 29 were not sampled. Many are legitimately manual: they need a browser
(`audit:web*`, `audit:a11y`), live network or funds (`audit:service-wallets`,
`check:relayer-balances`, `check:evm-rpc`), a credential (`audit:custodial-keys`), or live
`gcloud` (`check:cron-drift`, which belongs to
[fix-queue-03](fix-queue-03-cron-drift-garment-sweep.md)). `check:rules` and `check:secrets`
are wired into the pre-push hook rather than a script, which counts as wired. Classify before
you judge.

## Tasks

1. **Classify all 39.** Produce a table in `docs/ops/guard-wiring.md` with one row per unwired
   guard: what it checks, its measured exit code and runtime, and a verdict of `gate`,
   `npm test`, `deploy path`, `manual (reason)`, or `delete (superseded)`. Measure every row;
   do not infer a verdict from the script's name.
2. **Fix the cheap reds**, in their own topical commits: the stale generated artifacts
   (`check:docs-search`, `audit:tour-global`) are a regenerate-and-commit; `check:doc-media`,
   `check:runnable-docs` and `audit:route-shadowing` need their findings read and fixed.
3. **Wire the ones that earn it.** Green plus fast (under about 15s) plus repo-only goes into
   `gate`. Anything needing network, a browser, or a credential does not go into `gate`; give
   it a `npm test` home or leave it manual with the reason recorded in the doc.
4. **Pin each new wiring with a test**, following `tests/gcloudignore-wiring.test.js`: assert
   the guard is referenced by the script that is supposed to run it, so the next `git add -A`
   sweep cannot silently unwire it.
5. **Delete what is superseded.** A guard whose job is fully covered by a vitest suite is dead
   weight; remove the script and say so in the doc rather than leaving a decoy.

## Definition of done

- [ ] `docs/ops/guard-wiring.md` exists, is linked from `docs/ops/README.md`, and has a
      measured row for every guard the step 0 command reports as unwired.
- [ ] Every guard the doc marks `gate` is actually in `gate`, and `npm run gate` exits 0.
- [ ] Every newly wired guard has a wiring assertion in a test file, and `npm test` passes.
- [ ] The step 0 command's unwired count has dropped, and every guard still on the list has a
      recorded reason in the doc.
- [ ] `npm run audit:docs` exits 0; `npm run check:rules -- --paths <files you touched>` clean.
- [ ] Run logged in [PROGRESS.md](production-100-PROGRESS.md).

## Never blocked

| Blocker | Resolution |
|---|---|
| A guard is red and the fix is large | Do not wire it. Record the finding count in the doc and open a numbered order for the fix. A recorded red beats a hidden one. |
| A guard needs a credential this box lacks | It is `manual` by definition. Record the credential it needs and which OWNER-ACTIONS row covers it, if any. |
| `gate` is already red from another agent's work | Capture the baseline first, then judge your own additions against that baseline, never against green. |
| A guard times out | Measure it with a longer timeout before judging. A slow guard is a `npm test` or deploy-path candidate, not a `gate` one. |

## Report format

State the before and after unwired counts, the guards you wired and where, the reds you fixed
against the ones you recorded, and anything you deleted with the reason.
