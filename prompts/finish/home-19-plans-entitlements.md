# 19. Plans, entitlements and quotas

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[03](home-03-api-surface.md), [12](home-12-households-rbac.md) and
[14](home-14-reliability-scale.md) must have landed: you cannot price what you have not measured.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated. **Setting a price the platform charges is an owner decision**:
implement the mechanism, propose the numbers, and batch the price approval into one message.

---

## Step 0: re-derive the current state

```bash
grep -n "^export" api/_lib/account-tier.js | head
node -e "import('./api/_lib/account-tier.js').then(m=>console.log(JSON.stringify(m.ACCOUNT_TIERS,null,1)))" | head -40
grep -n "^export" api/_lib/three-tier.js | head
ls api/billing api/credits api/subscriptions 2>/dev/null
grep -rn "resolveAccountTier\|tierById" api/ --include=*.js -l | head
```

The platform already has tiers (`api/_lib/account-tier.js`), a $THREE holder ladder
(`api/_lib/three-tier.js`), credits and subscriptions. **Join them. Do not invent a fourth
entitlement system for this lane.**

## What actually costs money here

Be honest about the cost model before proposing anything, because it is unusual: the expensive
part is not compute per action, it is **holding a live socket**.

| Cost | Driver | Measured in |
|---|---|---|
| Connection hold | homes connected concurrently, from order 14's per-connection heap | memory, and therefore instance count |
| SSE streams | dashboards and wall displays left open | same |
| Agent turns | LLM tokens per voice or chat interaction | the existing brain-router costs |
| Speech | ASR and TTS per utterance | the existing lanes |
| Relay (order 10) | sustained outbound sockets from houses | memory plus egress |

A house that is connected and idle costs real money whether or not anyone speaks to it. Any
entitlement design that meters only actions will be wrong.

## The dimensions to meter

Propose limits per tier along these, with the measured cost behind each:

| Dimension | Why |
|---|---|
| Homes connected | the primary cost driver |
| Household members per home | the enterprise dimension |
| Concurrent live streams per home | wall displays |
| Voice minutes per month | the ASR and TTS lane cost |
| Agent turns per month | LLM cost, probably already metered by an existing counter; find it before adding one |
| Action-log retention | order 15's decision, and a natural enterprise upsell |
| Relay connections | if order 10 landed |

## The rules the limits must obey

These are product commitments, not implementation details. Write them into the code as comments
and into the docs as text:

1. **A limit never blocks a safety action.** Over quota, a user can still lock their door, close
   their garage and arm their alarm. The safe direction is always free. A product that will not
   let someone lock up because they hit a quota is indefensible.
2. **Downgrading never silently disconnects a house.** It marks connections over the new limit as
   inactive with a clear explanation and lets the user choose which to keep. Nothing is deleted.
3. **A quota is shown before it is hit**, on the manage surface, with the reset date.
4. **Enterprise limits are configurable per account**, not hardcoded, because that is what the
   sales conversation is.
5. **Nothing about the gate is a paid feature.** Confirmations, the audit log's integrity, and the
   role system's safety properties exist on every tier. Selling safety would be wrong and would
   also make the free tier a liability.

Rules 1 and 5 are the ones to fight for if anyone pushes back.

## Proposal, not decision

Produce a table of tiers and numbers, each justified by the measured cost from order 14, and put
it in your report as a proposal for the owner. Implement the **mechanism** fully so that applying
a number is a config change. Do not invent a price and ship it.

Also state, honestly, whether the free tier can carry a connected home at all given the measured
per-connection cost, and if it cannot, what the free experience is instead (a session-scoped
connection that closes when the tab does, is the obvious candidate).

## Tasks

| # | Task |
|---|---|
| 1 | An entitlement resolver for the lane, reading the existing tier system. `api/_lib/home/entitlements.js`. |
| 2 | Enforcement at the acquisition point (connections), the stream point, and the metered lanes. Never at the safe-action point. |
| 3 | Usage counters, reusing the platform's existing counter if one exists (`grep -rn "usage_events\|UsageCounter" api/ packages/`). |
| 4 | The downgrade path: mark inactive, explain, let the user choose. |
| 5 | The manage-surface quota display with the reset date. |
| 6 | Per-account overrides for enterprise. |
| 7 | Tests: the safe-action exemption, the downgrade path, counter accuracy, and per-account overrides. |
| 8 | The proposal table and the single owner message. |

## Definition of done

- [ ] Over quota, `lock`, `close_cover` and `alarm_arm_away` still execute. Three transcripts. This is the most important line in this order.
- [ ] Over quota, a new home connection is refused with a designed message naming the limit and the upgrade path, not a 500.
- [ ] A simulated downgrade marks the excess connections inactive, deletes nothing, and presents the choice. Recorded.
- [ ] The quota display shows real usage and a real reset date, screenshotted.
- [ ] A per-account override raises a limit without a code change. Prove it.
- [ ] Usage counters match reality: run 20 actions and 3 voice turns, then read the counters. Paste both.
- [ ] No new entitlement system was created: `grep` shows the lane reads `api/_lib/account-tier.js` (and the $THREE ladder where relevant) rather than its own table.
- [ ] The gate is unaffected by tier. Prove a free-tier account still gets confirmations and a full audit log.
- [ ] The proposal table names a measured cost per dimension.
- [ ] `npx vitest run --root .` shows no new failures.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| The price is not decided | You are not deciding it. Build the mechanism, propose numbers with the measured costs, and batch the approval. Ship with generous defaults behind a config value. |
| The measured per-connection cost makes a free tier look impossible | Say so plainly and propose the session-scoped free experience. An honest constrained free tier beats an unsustainable generous one. |
| Someone proposes gating confirmations or the audit log behind a paid tier | Refuse, and leave the reason in the code. Safety is not an upsell. |
| An existing usage counter is hard to reuse | Reusing it is still right. A second counter means two numbers that disagree, and the one on the invoice will be wrong. |
| $THREE holder tiers complicate the matrix | `api/_lib/three-tier.js` already models the ladder and the discount. Read it and apply it; do not model holding twice. |

## Report format

1. The three safe-action-over-quota transcripts.
2. The refusal message and the downgrade recording.
3. The quota display screenshot.
4. The override proof and the counter accuracy check.
5. The grep proving no new entitlement system.
6. The proposal table with measured costs, and the single owner message.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-19-plans-entitlements.md

If the price approval is the only outstanding step, leave the file in place and name the owner
action. Never delete it on a partial.
