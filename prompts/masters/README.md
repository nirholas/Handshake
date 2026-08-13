# prompts/masters/: the reusable master prompts

Every other pack in `prompts/` is a campaign: fixed targets, run once, retire when shipped.
This pack is different, and the deviation is deliberate (like `swarm-100`'s): these files are
**reusable**. Each one is a complete, paste-and-run operating document for one discipline,
parameterized by a target you supply. They never retire. Point one at any surface, feature
idea, or subsystem in this repo and it drives that target to the bar CLAUDE.md demands: work
that competes with the best products in the world, fully wired, real APIs, zero mocks,
beautiful, documented, verified.

## How to run a master

Paste the whole file into a fresh Claude Code chat opened in `/workspaces/three.ws`, then add
one line at the end:

```
TARGET: <one line naming the feature idea, surface, or subsystem>
```

Or say: `execute prompts/masters/03-the-builder.md against <target>`. If a HANDOFF block from
a previous stage exists (see below), paste it instead of a bare TARGET line; the master will
consume it and skip re-deriving what the previous stage already established.

If you supply neither a TARGET nor a HANDOFF, the master must not stall: `09-the-frontier.md`
is the generator stage and picks its own target; every other master picks the highest-leverage
target it can defend from the repo's own signals (ISSUES.md, `prompts/backlog/`, audit output)
and states the choice in its report.

## The relay: prompts that compose

This is the innovation this pack exists for. Each master ends its report with a machine-usable
**HANDOFF block**, and each master accepts a HANDOFF block as input. The output format of
stage N is the input format of stage N+1, so the masters chain into a relay that takes a
one-line idea to a shipped, verified, documented, production-hardened feature with no human
glue between stages: an assembly line where every station is a prompt.

The full relay, in order:

| Stage | File | Discipline |
|---|---|---|
| 1 | [01-the-architect.md](01-the-architect.md) | System design: data flow, contracts, failure modes, the build plan |
| 2 | [02-the-scout.md](02-the-scout.md) | OSS leverage: sweep npm and GitHub before writing anything |
| 3 | [03-the-builder.md](03-the-builder.md) | Full-stack execution: from plan to wired, working feature |
| 4 | [04-the-designer.md](04-the-designer.md) | Design excellence: screenshot-worthy UI, every state designed |
| 5 | [05-the-integrator.md](05-the-integrator.md) | Cross-pollination: wire the feature into every adjacent surface |
| 6 | [06-the-adversary.md](06-the-adversary.md) | Adversarial verification: attack the work before anyone else can |
| 7 | [07-the-storyteller.md](07-the-storyteller.md) | Narrative: docs, changelog, and the story that makes it findable |
| 8 | [08-the-operator.md](08-the-operator.md) | Production hardening: observability, failover, cost, deploy readiness |

And the generator that feeds the relay:

| Stage 0 | [09-the-frontier.md](09-the-frontier.md) | Innovation engine: finds and specifies the thing that does not exist yet |

Run the whole relay across eight chats (paste each HANDOFF forward), or run any master
standalone: each one is self-sufficient and re-derives whatever state it was not handed.
Skipping stages is legitimate; a small fix might run Builder, Adversary, Storyteller only.
The relay order is the default, not a straitjacket.

## The HANDOFF block (the contract between stages)

Every master ends its final report with exactly this block, fenced as code so it can be
copied whole:

```
HANDOFF
target: <one line: what is being built>
stage-completed: <architect | scout | builder | designer | integrator | adversary | storyteller | operator | frontier>
next-stage: <the next master file to run, or "done">
state:
  - <fact the next stage must not waste time re-deriving: files created, endpoints live, commands that pass>
decisions:
  - <judgment call made> (alternative considered: <what and why rejected>)
open-risks:
  - <what the next stage must attack, verify, or watch>
owner-notes:
  - <only things a human must do: approvals, keys, pushes; "none" if none>
```

Rules for the block: facts only, no prose recap; every `state` line must be mechanically
checkable (a path that exists, a command that passes, an endpoint that responds); `decisions`
carries the alternative so a later stage can reverse it cheaply; a master receiving a HANDOFF
trusts `state` only after spot-checking one line of it (state rots; the work-order standard's
step-0 rule applies between chats too).

## What every master shares (so the files do not repeat it)

Each master file carries its own binding clause, step 0, definition of done, never-blocked
table, and report format, per the pack standard in [../README.md](../README.md). They all
inherit CLAUDE.md in full, and these rules bite most often:

- Finish 100%. Never end with a question or an unexecuted plan.
- No mocks, no fake data, no TODO comments, no placeholder anything. Real APIs, real data.
- No em-dash or en-dash characters anywhere you write.
- Concurrent agents share this worktree: stage explicit paths only, never `git add -A`,
  re-check `git status` and `git diff --staged` immediately before each commit.
- Pushes, production deploys, spends, and on-chain writes are owner-gated. Commits are not.
- Nothing referencing a crypto project other than $THREE gets committed without owner approval.
- Solana first. Robinhood means crypto. `STRUCTURE.md` before exploring, `ISSUES.md` for
  known debt, `docs/ops/gcp-production.md` for production facts.

## Quality bar (the sentence every master enforces)

The work must be good enough that a senior engineer at a top-tier company would screenshot it
and ask "who built this?". If any stage's output would not survive that question, the stage
is not done, whatever its checklist says.
