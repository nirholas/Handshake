# P100-04b: The `mixed` fix is written and tested. Nothing has measured it yet.

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/production-100-04b-fact-check-publish-run.md`".
Read [00-INDEX.md](production-100-00-INDEX.md) and `CLAUDE.md` first.

This is the remainder of P100-04, whose code half landed on 2026-09-02. That order's
diagnosis and fix are done and unit-tested; what is left needs credentials this workspace
does not have and a deploy only the owner can approve.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Delete this file when the
   definition of done is verified.
2. **Never publish a number you would not defend.** Respect the degraded-check guard and
   the 10% error-rate ceiling in `api/_lib/fact-check-benchmark.js`. Never weaken either to
   make a run publishable. A run that regresses gets diagnosed, not published.
3. Hard rules: no mocks, no fixture-fitting, explicit-path commits, no em-dashes.

## What already shipped (do not redo it)

- **`partial` is a fourth stance.** `agents/fact-checker/src/llm-verdict.js` exports
  `STANCES` and its rubric asks for `partial` when a source finds the claim true in one
  respect and wrong, overstated, or only conditionally true in another. Before this, the
  rubric explicitly told the model to collapse such a source onto one side, which made the
  `mixed` verdict unreachable from evidence that agrees with itself.
- **`computeVerdict` counts partial weight** as stance-bearing evidence that takes neither
  side (`api/x402/fact-check.js`). With zero `partial` sources its output is identical to
  the old function, which is the anti-seesaw guarantee.
- **The LLM response reader no longer fails silently.** `extractJsonArray` replaces a
  non-greedy regex that stopped at the first `]`; both stages now report
  `stance extraction unreadable` / `query generation unreadable` instead of returning a
  fabricated all-neutral `insufficient`.
- Tests: `tests/api/fact-check-verdict.test.js` (synthetic stance distributions, clear-cut
  pins) and `tests/fact-check-degradation.test.js` (extraction shapes, degradation
  contract). Docs: `docs/fact-check.md`, `agents/fact-checker/README.md`. Changelog: two
  2026-09-02 entries.

## Step 0: re-derive the state

```bash
curl -s https://three.ws/api/version                        # is the fix live yet?
curl -s https://three.ws/api/fact-check-benchmark | head -c 1200
git log --oneline -5 -- api/x402/fact-check.js agents/fact-checker/src/
npx vitest run tests/api/fact-check-verdict.test.js tests/fact-check-degradation.test.js
```

If `/api/fact-check-benchmark` already reports a run generated after the fix landed with
`mixed` above zero, this order is spent: log the outcome in
[PROGRESS.md](production-100-PROGRESS.md) and delete this file.

## Tasks

1. **Get an LLM lane.** The benchmark's in-process runner needs one, and on 2026-09-02
   this workspace had none: no `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` in
   `.env` or `.env.local`, and `gcloud` refused every call with "Reauthentication failed.
   cannot prompt during non-interactive execution", which also takes out the Vertex Gemini
   anchor (`GOOGLE_CLOUD_PROJECT` plus ADC). Restore `gcloud` auth first; that alone
   unlocks Vertex, and it unlocks reading the rest off the service env
   (`gcloud run services describe three-ws-api --region us-central1 --project
   aerial-vehicle-466722-p5 --format=yaml`). Search needs no key: Wikipedia and DuckDuckGo
   are keyless rungs, though a `BRAVE_API_KEY` / `TAVILY_API_KEY` materially improves the
   evidence the verdict sees.

   **Do not plan on the keyless LLM floor.** It exists and it is real, but it is two rungs,
   not three, and from this workspace's shared egress IP it answered 0 of 8 probes on
   2026-09-02: OVH 429 and Pollinations 429 on every attempt across 64 seconds, with one
   isolated success after a long idle. LLM7 was the third keyless rung and is not one any
   more (llm7.io retired its anonymous tier; every unauthenticated call is 401
   `invalid_api_key`, the `unused` token its docs used to accept included), so it is gated
   on `LLM7_API_KEY` now. A 40-claim run is 80 LLM turns; the keyless floor will not carry
   it. Get a real key.
2. **Check the production chain is not itself degraded before spending a run.** On
   2026-09-02 a live free-lane check returned
   `query generation unavailable: openai 429 billing_not_active`, meaning every free rung
   had already failed and the paid backstop is dead. A benchmark run in that state measures
   provider availability, and the guard will refuse it. Fix the lane first
   (`docs/ops/llm-lanes.md`).
3. **Run the suite in-process, cache disabled, and capture per-claim detail:**
   ```bash
   FACT_CHECK_DETAIL_FILE=/tmp/fc-detail.json \
     node --env-file=.env scripts/fact-check-benchmark.mjs --in-process
   ```
   That writes `data/_generated/fact-check-benchmark.json` without publishing. Compare its
   `by_class` against the last published run (`mixed` must leave zero, no class may
   regress) and read `/tmp/fc-detail.json` for the per-source stances behind any class that
   moved the wrong way.

   **Fidelity trap, and it decides whether step 4 is honest.** The published 2026-08-10 run
   was produced by production, whose search chain leads with Vertex-grounded Google Search.
   A local run without `GOOGLE_CLOUD_PROJECT` and ADC (or a Brave/Tavily/Exa/Serper key)
   silently falls to the keyless rungs, and the evidence is visibly worse: probing the
   `mixed` claims here on 2026-09-02 returned five Wikipedia pages per claim, among them
   "Aunty Donna's Coffee Cafe" for "Coffee is bad for your health" and "Zootopia" for the
   tongue map. That tier is fine for an A/B of the CALCULUS against itself, where both arms
   see the same evidence. It is not the product's accuracy, and publishing it as the
   headline number would understate a chain the public number is supposed to describe.
   Before `--publish`, confirm the run actually used the grounded search rung.
4. **Publish only an improved, non-degraded run:** re-run with `--publish`. The live
   `/api/fact-check-benchmark` reads the DB row first, so this reaches the public page
   without a deploy, but the CHAIN itself only improves once the code is deployed, so
   sequence it after the ship.
5. **Verify the page in a real browser:** `/fact-check` renders the run, denominators, and
   the per-class and per-difficulty tables.
6. **Log the outcome** in [PROGRESS.md](production-100-PROGRESS.md) with the before/after
   per-class table, and add a `data/changelog.json` entry (tag `improvement`) naming the
   new headline number.

## Definition of done

- [ ] A real, non-degraded in-process run exists with a before/after per-class table.
- [ ] `mixed` is above zero and no class regressed; if one did, the diagnosis is written
      down and the run is NOT published.
- [ ] An improved run published to the DB and rendered on `/fact-check` in a browser.
- [ ] Changelog entry written, outcome logged in PROGRESS.md, this file deleted.

## Never blocked

| Blocker | Resolution |
|---|---|
| No LLM key anywhere on the machine | Restore `gcloud` auth for the Vertex anchor, then read the service env. If a key genuinely exists nowhere, that is one line for OWNER-ACTIONS naming the single missing variable, not a reason to leave the rest undone. Do not spend the session retrying the keyless rungs: they were 0/8 from this egress IP on 2026-09-02 (task 1). |
| Tempted to publish a run measured on the keyless search tier | Do not. It measures a chain the public number does not describe (task 3). Report the A/B, leave the published run alone, and say what is missing. |
| The deploy is owner-gated | Prepare it so the ship is one command (`npm run deploy:gcp:full` after `npm run prep:worktree -- --apply`) and say so. Publishing the run does NOT need the deploy, but running it against the OLD chain measures the old code, so do not publish that as the fix's number. |
| Accuracy improves on `mixed` but a neighbour regresses | That is the seesaw the calculus was designed against. Read `/tmp/fc-detail.json` for the regressed claims' stances: a `partial` where the source plainly affirms or plainly refutes is a rubric problem, not a calculus one. |
| The run is refused as degraded | Working as designed. Fix the lane, then re-run. Never lower `MAX_ERROR_RATE`. |

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/production-100-04b-fact-check-publish-run.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
