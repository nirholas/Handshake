# P100-04: The `mixed` verdict scores 0/10, and it is the biggest accuracy lever

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/production-100-04-fact-check-mixed-verdicts.md`".
Read [00-INDEX.md](production-100-00-INDEX.md) and `CLAUDE.md` first.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Delete this file when the
   definition of done is verified; follow-up files for any remainder first.
2. **Never publish a number you would not defend.** The benchmark is public trust surface.
   The runner's guards exist because a total LLM outage once nearly published ~25% as the
   product's accuracy with zero errors. Respect the degraded-check guard and the error-rate
   ceiling; never weaken either to make a run publishable.
3. Hard rules: no mocks, no fixture-fitting hacks, explicit-path commits, no em-dashes.

## The problem, measured 2026-08-02 (re-measure in step 0)

Two published runs of the 40-claim benchmark scored 50% and 55% exact-verdict. The `mixed`
class went 0/10 both times. In the first run's confusion matrix the chain never emitted
`mixed` at all (those claims resolved 6 contradicted, 4 insufficient); the second session
confirmed the endpoint CAN emit `mixed`, so this is verdict calculus behavior, not a
taxonomy bug. `computeVerdict` returns `mixed` only when neither side clears 70% of
stance-bearing weight, a band real search evidence rarely lands in. Fixing this class alone
is worth up to +25 points on the headline number.

## Step 0: re-derive the state

```bash
curl -s https://three.ws/api/fact-check-benchmark | head -c 1500   # ran? source? per-class table
grep -rn "computeVerdict\|mixed" api/_lib/fact-check-benchmark.js | head
grep -rln "computeVerdict" api/ | head                             # find the real verdict module
node -e "const f=require('./tests/fixtures/fact-check-benchmark.json');console.log(f.claims?.length ?? Object.keys(f))"
ls docs/fact-check.md && grep -rn "fact-check-benchmark" vercel.json | head -3
```

If the live endpoint still answers `ran: false`, production predates the DB-first handler;
that flips with the A-category ship and does not block this order's code work. If someone
already lifted `mixed` above 0, re-read the whole per-class table and rewrite this order to
whatever the weakest class now is (chunk protocol), or retire it if the lever is spent.

## Tasks

1. **Understand before tuning.** Read the verdict path end to end: how stance weights are
   accumulated, what "stance-bearing weight" excludes, and exactly why each of the 10 mixed
   fixtures resolved wrong (run them through the module locally and log per-claim evidence
   weights). Write the finding down in the report; a threshold nudged blind is not a fix.
2. **Fix the calculus, not the fixture.** Plausible directions the diagnosis should choose
   between: a mixed band defined by BOTH sides holding meaningful support (for example each
   side over a minimum share) rather than neither clearing 70%; counting strong bidirectional
   evidence explicitly; or treating high-variance stances across sources as mixed rather
   than insufficient. Whatever you change must be principled and unit-tested on synthetic
   stance distributions, not shaped to the 10 fixtures.
3. **Guard against seesaw.** The risk is trading `contradicted`/`supported` accuracy for
   `mixed` recall. Add unit tests pinning clear-cut distributions (unanimous support,
   unanimous contradiction, empty evidence) to their verdicts so the band cannot swallow
   them. Then run the full 40-claim suite locally through the module and compare per-class
   exact-match before/after; every class must hold or improve, `mixed` must leave zero.
4. **Re-run the real benchmark and publish honestly.** Use the in-process runner path (the
   weekly cron handler logic, Redis verdict cache disabled) so you measure the chain, not
   the cache. Publish via the established `savePublishedRun` path only if the error-rate
   gate passes and the headline number improved; a run that regresses gets diagnosed, not
   published. Verify the benchmark page renders the new run (denominators, per-class and
   per-difficulty tables) in a real browser.
5. **Docs and changelog.** Update `docs/fact-check.md` if the verdict semantics description
   changed. The benchmark page is public: one `data/changelog.json` entry (tags
   `improvement`) when a better run is published.

## Definition of done

- [ ] Written root-cause finding for the old 0/10 (per-claim, from real runs, in the report).
- [ ] Verdict change unit-tested on synthetic distributions plus the clear-cut pins; all
      green; `npm run gate` no worse than baseline.
- [ ] Full-suite per-class table before/after: `mixed` above zero, no class regressed.
- [ ] A real, non-degraded benchmark run published to the DB with an improved headline
      number, and the page verified in a browser (locally if prod predates the handler).
- [ ] Changelog entry written; outcome logged in [PROGRESS.md](production-100-PROGRESS.md); this file
      deleted, with a follow-up file if a class remains weak enough to be the next lever.

## Never blocked

| Blocker | Resolution |
|---|---|
| LLM lanes exhausted mid-run | Every lane has a failover chain; a degraded check counts as unreachable, never as a verdict. If the whole chain is down, fix the lane first (backlog 06 shipped the map in `docs/ops/llm-lanes.md`). |
| `INTERNAL_API_KEY` missing locally | It is on the Cloud Run service env and mirrored in `.env` since 2026-08-02; the playbook order in CLAUDE.md finds it. |
| The 7-day verdict cache poisons an HTTP re-run | Documented behavior: the in-process runner with cache disabled is the authoritative producer. Use it. |
| Accuracy will not budge past the mixed fix | Publish the honest number anyway if improved, and write the follow-up order naming the next weakest class with its confusion rows. |

## Report format

Root cause in two sentences, the calculus change and why it is principled, before/after
per-class table, the published run's headline and where it is visible, and the next lever.
