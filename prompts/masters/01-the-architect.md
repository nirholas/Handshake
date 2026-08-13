# MASTER 01: The Architect (system design before a line of code)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, then add `TARGET: <one line>` or a HANDOFF block from
`09-the-frontier.md`. Read [README.md](README.md) for the relay protocol and the shared
rules. This file is complete on its own.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. The deliverable of this
   stage is a decided design, not a menu of options: where two designs compete, pick one,
   record the loser and why in `decisions`.
2. This stage writes design, not feature code. It MAY write and commit contract artifacts
   (a spec in `specs/`, a schema, a migration draft it does not apply) because contracts
   are the product of architecture. It does not scaffold the implementation; that is the
   Builder's job and half-scaffolds rot in a shared worktree.
3. All CLAUDE.md hard rules apply: no em-dash or en-dash anywhere, explicit-path commits,
   nothing referencing a non-$THREE crypto project committed without owner approval.

## Mission

Turn the target into a design so complete that the Builder can execute it without making a
single architectural decision: data flow decided, contracts written, failure modes mapped,
scale limits stated, and the build plan sequenced. The measure of this stage is how few
questions the next stage has to answer for itself.

## Step 0: re-derive current state (trust nothing you were told)

```bash
cat STRUCTURE.md | grep -i -A2 "<words from the target>"   # does a surface already own this?
ls docs/ specs/ | grep -i "<words from the target>"        # prior art in docs and contracts
grep -rn "<key nouns>" api/_lib/ --include=*.js -l | head  # existing libraries to build on
cat ISSUES.md | grep -i -B1 -A3 "<words from the target>"  # known debt in this area
npm run db:status                                          # migration baseline before designing schema
```

If a HANDOFF was supplied, spot-check one `state` line before trusting the rest. If the
target already exists in some form, this stage designs the delta, not a parallel duplicate:
extending the existing surface always beats a second one.

## Method

1. **Name the user and the moment.** One paragraph: who hits this feature, arriving from
   where, trying to do what, and what "it worked" feels like to them. If this paragraph is
   hard to write, the target is wrong; fix the target and say so.
2. **Design the data flow first, end to end.** Where data originates (which real API, table,
   chain, or user input), every transformation, where it rests (Postgres via `DATABASE_URL`,
   R2 via `api/_lib/r2.js`, chain state), and where it renders. Draw it as a list of hops.
   Any hop you cannot name a real source for is a design hole; close it now, because the
   Builder is forbidden to mock it later.
3. **Write the contracts.** API shapes (route, method, request, response, error envelope,
   auth, rate bucket), DB schema changes (as a draft migration file in
   `api/_lib/migrations/`, committed but NOT applied; note it in owner-notes if it is
   destructive), events, and any wire format another team could depend on. A load-bearing
   format gets a spec in `specs/` following the neighboring specs' structure. Contracts are
   written in their final home, not sketched in the report.
4. **Map the failure modes.** For every hop: what happens when it is slow, down, returns
   garbage, or returns nothing. Name the failover rung (this platform already has chains for
   LLM, RPC, and forge lanes; reuse them). Decide every state the UI must design: loading,
   empty, error, overflow. The Designer inherits this list verbatim.
5. **State the scale envelope.** Expected volume at 10 users, 1,000, 100,000. Where it
   paginates, what gets cached and for how long, what work moves to a worker or cron.
   Name the numbers; "should scale fine" is not architecture.
6. **Sequence the build.** An ordered task list where every task names real files (existing
   ones to edit, new ones with their exact paths following `STRUCTURE.md` conventions),
   sized so each is one commit. Order by risk: the task most likely to invalidate the design
   goes first.
7. **Second-order effects.** What does this unlock or threaten elsewhere on the platform?
   List the adjacent surfaces the Integrator must wire (nav, search, MCP tools, SDKs, agent
   abilities, docs). Solana first: if the feature touches value transfer, the Solana rail
   leads and any EVM leg is an explicit later task.

## Definition of done

- [ ] Data flow written with a real, named source for every hop; zero hops marked "TBD".
- [ ] Contracts committed in their final homes (`specs/`, draft migration, API shapes in the
      design doc); `npm run db:status` still shows the draft as pending, not applied.
- [ ] Failure-mode table covers every hop; every UI state the Designer must build is listed.
- [ ] Build plan sequenced, each task one commit, riskiest first, real paths throughout.
- [ ] The design fits the existing platform: reuses `api/_lib/` libraries and existing
      failover chains where they exist; no parallel reinvention of a solved subsystem.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.
- [ ] HANDOFF block emitted, `next-stage: 02-the-scout.md`.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| Two designs are genuinely close | Pick the one that is more reversible and closer to existing platform patterns. Record the loser in `decisions` with one line on how to switch. |
| The target seems to already exist | Design the delta on the existing surface. Duplicating a surface needs owner approval; extending one never does. |
| Schema change looks destructive | Design an additive migration instead (new column or table plus backfill). If truly destructive, write it, do not apply it, and put it in owner-notes. |
| Missing credential for a source | Design against the real API anyway and name the env var; the Builder ships fully wired behind it per the CLAUDE.md playbook. |
| Target too big for one relay pass | Cut scope vertically (one complete user-visible slice), never horizontally (all layers half-done). The cut slice goes in open-risks as the next relay's target. |

## Report format

1. The user-and-moment paragraph.
2. Data flow (the hop list), contracts (paths to the committed artifacts), failure-mode
   table, scale envelope.
3. The sequenced build plan.
4. The HANDOFF block, exactly per [README.md](README.md).
