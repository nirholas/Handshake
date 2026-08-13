# MASTER 09: The Frontier (the innovation engine that feeds the relay)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. No TARGET needed: finding the target IS this stage. Read
[README.md](README.md) for the relay protocol. This file is complete on its own.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. The deliverable is one
   chosen frontier bet, specified to relay-ready, plus a proven kernel: real code that
   demonstrates the bet's riskiest assumption actually works. Not a brainstorm document.
2. The kernel is real: real APIs, real data, committed. A slideware "vision" with no
   running proof is this stage's definition of failure.
3. All CLAUDE.md gates hold, and two bite here most: nothing referencing a non-$THREE
   crypto project gets committed without owner approval, and no spends or on-chain writes
   without the owner's explicit yes. Solana first in any value-bearing design.

## Mission

Find the thing that does not exist yet: the feature people will one day assume was always
obvious, shipped years before it was obvious. The platform's raw materials are already
frontier-grade: generative 3D with provenance, embodied agents that live inside chat
surfaces, an agent-to-agent payment economy on Solana, MCP as a distribution channel into
every AI assistant, AR handoff from any link. This stage's job is to find the intersection
nobody has shipped and prove it works.

## Step 0: re-derive current state (the raw-materials inventory)

```bash
cat STRUCTURE.md | grep "| Live"           # every live capability, the combinatorial deck
cat ISSUES.md | head -60                   # known gaps: sometimes the frontier is a gap
ls prompts/backlog/ prompts/roadmap/       # what is already planned, to avoid re-proposing it
cat data/changelog.json | tail -60         # the platform's current momentum and direction
```

Also sweep outward: what shipped this quarter in the MCP ecosystem, the Solana agent
economy, generative 3D, and embodied AI (web search is encouraged). The frontier is
relative to the world, not just to this repo.

## Method

1. **Generate from intersections, not thin air.** Take the live-capability deck from
   Step 0 and force combinations: each pair or triple of capabilities that no current
   surface joins. The strongest frontier features are almost always two proven
   capabilities meeting for the first time. Generate at least ten candidates this way
   before judging any.
2. **Score every candidate on five axes,** one line each: user pull (who wants this
   tomorrow, in one sentence), early-mover window (why has nobody shipped it; what makes
   it possible NOW that was not possible a year ago), platform fit (how much existing
   machinery it reuses), kernel provability (can the riskiest assumption be demonstrated
   in one session), and compounding (does it make every later feature stronger, or is it
   a leaf). Kill anything that needs a new paid external API, violates a CLAUDE.md gate,
   or duplicates a planned backlog item.
3. **Choose one. Exactly one.** The relay executes one bet at a time; a portfolio of
   maybes is how nothing ships. Record the two runners-up in `decisions` with one line on
   when each would become the right choice.
4. **Name the riskiest assumption and prove it in code.** Every frontier bet has one load-
   bearing uncertainty (the model can do X, the protocol allows Y, the latency is under
   Z). Build the smallest real thing that settles it: a working endpoint, a script against
   the real API, a rendered result. Commit it somewhere honest (`scripts/` for a probe, or
   its future home if it is the seed of the feature). If the assumption fails, that is a
   successful stage: kill the bet, promote runner-up one, prove ITS assumption, and say
   what died in the report. Never relay a bet whose kernel failed.
5. **Specify to relay-ready.** Write the bet as the Architect's input: the user and the
   moment, the capability intersections it joins, the proven kernel and what it
   demonstrated, the deliberately-cut scope (v1 is one complete vertical slice), and what
   compounding it unlocks. This is a HANDOFF block plus one page, not a manifesto.
6. **The early test.** Before finishing, answer in the report: "when this is everywhere
   in three years, what will people say made it obvious?" If the answer is mush, the bet
   is mush; pick the runner-up.

## Definition of done

- [ ] Ten or more intersection candidates generated and scored on all five axes.
- [ ] One bet chosen; runners-up recorded with their trigger conditions.
- [ ] The riskiest assumption named and settled by committed, running, mock-free code,
      with the evidence (output, screenshot, response body) in the report.
- [ ] The bet specified relay-ready: one page plus HANDOFF, consumable by
      `01-the-architect.md` with zero additional context.
- [ ] Nothing proposed duplicates `prompts/backlog/`, `prompts/roadmap/`, or a live
      surface; the Step 0 sweep is cited as evidence.
- [ ] `npm run check:rules -- --paths <files you touched>` clean; explicit-path commits.
- [ ] HANDOFF block emitted, `next-stage: 01-the-architect.md`.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| All candidates feel derivative | Widen the deck: sweep the world-facing surfaces (MCP stores, the embed SDKs, AR) whose intersections with the Solana economy are least explored. Derivative usually means the deck was too small. |
| The kernel needs a credential or funded wallet | Prove the assumption up to the gated line with real code (the real client, the real 402, the real auth error is itself evidence the rail works), and put the one unblocking step in owner-notes. Spends stay owner-gated, always. |
| The kernel proof fails | Success: the stage just saved a full relay. Kill it, promote runner-up one, prove its kernel. Two kernel failures in one session: ship the report with both corpses and the third candidate specified; that is a complete, honest deliverable. |
| The best bet involves another crypto project | The commit gate applies. Either reshape the bet to be project-agnostic (runtime-supplied, like the existing generic plumbing exceptions) or put the approval in owner-notes and relay the strongest gate-free bet instead. |
| Fear that the bet is too ambitious | Ambition is the assignment. Cut scope vertically until the kernel is one session, never cut the ambition of the end state. The relay exists to absorb big bets one slice at a time. |

## Report format

1. The scored candidate table (all ten-plus, one line each).
2. The chosen bet: the one page, and the kernel evidence.
3. The three-year answer from the early test.
4. The HANDOFF block, `next-stage: 01-the-architect.md`.
