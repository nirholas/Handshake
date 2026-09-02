# OKX-05: Update agent #2632 and resubmit the listing

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/okx-ai-05-relisting-resubmission.md`".
Read `prompts/finish/okx-ai-00-CONTEXT.md`, all of `prompts/finish/okx-ai-PROGRESS.md`,
`prompts/finish/okx-ai-RUNBOOK.md` and `CLAUDE.md` first.

> **RETIRED 2026-09-02. Do not run this work order.** It submits the 11-row
> `identity-studio` catalog, which was put on the back burner by the 2026-08-22 owner
> directive and replaced by the seven-row three.ws Forge line-up. Those eleven rows are
> `listed: false` in `api/_lib/okx-catalog.js` today, so `scripts/okx-listing-payload.mjs`
> no longer emits them and the Step 0 sweep below reads slugs that are not on the listing.
> Running it anyway would delete seven live, reviewed forge rows and replace them with a
> retired set. The live successor is
> [`okx-ai-08-forge-relisting.md`](okx-ai-08-forge-relisting.md), which executed and
> submitted on 2026-08-27 (X Layer tx
> `0xb4b2f51dc34d4c8ed6adc2cfb55b0e21e2a6a29d787c02a8a9ca110e178415ba`). Agent #2632 has
> read `approvalLabel: "Listing under review"` ever since, so there is nothing to resubmit:
> `activate` on an agent already under review is a no-op the CLI stops on. Watch with
> `onchainos agent get-my-agents` (RUNBOOK section 1), and if the review rejects, open the
> next work order against the stated reason rather than reviving this file.

## Binding operating clause

1. Finish 100% of everything that is not an on-chain write or an OTP. Never end with a question
   about scope or design.
2. **Stop and wait only twice, batched into one message:** the email OTP for `claude@three.ws`,
   and the human confirmation of the diff card before the irreversible on-chain update. Both
   are CLAUDE.md gates that override the autonomy rule.
3. Never deactivate or delete agent #2632. All changes go through update plus re-activate; the
   ID, its wallet binding and its history are assets.
4. CLAUDE.md hard rules apply. Stage explicit paths only. No em-dash or en-dash characters.

## Mission

Resubmit "three.ws 3D Studio" (#2632) with the decomposed service catalog and the real OKX
payment rail. Treat the submission itself as a product: every string a reviewer reads and every
endpoint they probe must be exact.

## Step 0: gate check and full pre-submission sweep (all autonomous)

OKX-04 must have recorded an explicit GO in `okx-ai-PROGRESS.md`. If it did not, run the parts of
OKX-04 that need no funding, report exactly what is missing, and do not submit.

Then be the reviewer for an hour, against production:

```bash
curl -s https://three.ws/api/okx/3d/catalog | python3 -m json.tool | head -80

# probe every advertised endpoint unpaid, slugs read from the live catalog itself
for s in $(curl -s https://three.ws/api/okx/3d/catalog \
  | python3 -c "import sys,json;[print(x['endpoint'].rsplit('/',1)[-1]) for x in json.load(sys.stdin)['services']]"); do
  echo "== $s"; curl -si -X POST "https://three.ws/api/okx/3d/$s" \
    -H 'content-type: application/json' -d '{}' | head -12
done

onchainos agent get-agents --agent-ids 2632
node scripts/okx-listing-payload.mjs | head -40                # the 11 create-format entries
onchainos agent service-list --agent-id 2632 \
  | node scripts/okx-listing-payload.mjs --delta               # the full replace delta
```

`scripts/okx-listing-payload.mjs` takes the live `service-list` output on stdin and supports
`--delta` and `--briefing` only. Adjust the slug extraction above if the catalog's JSON shape
has moved; the point is that the slugs come from the live catalog, never from this file.

1. Every endpoint in the catalog returns an OKX-valid 402 unpaid (or free content for the free
   lane). Any drift from what OKX-04 recorded: stop and fix that first.
2. Three-way string diff: catalog module (`api/_lib/okx-catalog.js`), the live catalog endpoint,
   and the payload you are about to submit. Identical, zero drift.
3. Validate every description against OKX limits (two-part format, each part within 200 chars of
   East-Asian display width where CJK counts 2 and ASCII 1, no links, no tech stack, no example
   prompts inside service descriptions). The rules are in
   `.claude/skills/okx-agent-identity/references/invariants.md`; read it and `references/update.md`
   in full before this step.
4. Agent-level profile: keep the existing description unless evidence says it hurt review. The
   profile photo URL must be the existing OKX CDN asset; OKX rejects non-CDN links.

## Step 1: the update flow (the one owner interaction)

Session preflight per 00-CONTEXT. Follow the okx-agent-identity update flow exactly: fetch
current state with `agent get-agents --agent-ids 2632`, pull existing service ids with
`agent service-list --agent-id 2632`, build the `--service` JSON with per-service `operation`
deltas (`create` for new, `update`/`delete` with `id` for existing), `serviceType: "A2MCP"`,
`fee` as a plain quoted number string, `endpoint` as the per-service production URL. Run the
validate-listing QA. Render the diff card and get the human's explicit confirm before the write.
The confirmation gates exist because an on-chain write is irreversible; do not shortcut them
even though this is our own agent.

## Step 2: resubmit for review

After the update lands, run the activate step (`--preferred-language en-US` is required; see the
flag gotchas in invariants.md). Confirm the response shows the listing entered review (approval
status moves off "Listing rejected"). Capture the exact before and after approval-status values.

## Step 3: record and set the watch

- `okx-ai-PROGRESS.md`: the submitted catalog verbatim, CLI outputs, timestamp, approval status after
  submission, and the daily check command (`onchainos agent get-agents --agent-ids 2632`).
- No `data/changelog.json` entry yet. The changelog entry ships when the listing is approved;
  OKX-07 owns that.

## Definition of done

- [ ] Pre-submission sweep done: every catalog endpoint verified live, three-way string diff
      clean.
- [ ] Update executed through the skill's full flow with no bypassed gates.
- [ ] Resubmission confirmed: approval status captured before and after, listing in review.
- [ ] Nothing deactivated or deleted; the agent is still #2632.
- [ ] `okx-ai-PROGRESS.md` appended with the full submission record.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| Not logged in | `onchainos wallet login claude@three.ws --locale en_US`, then request the OTP in your single owner message. |
| A validated string is rejected at entry time | Fix it in the catalog module first, redeploy, re-verify the live catalog endpoint, then resubmit. Never paraphrase at entry time; the three copies must never diverge. |
| The CLI or backend errors mid-update | Read `.claude/skills/okx-agent-identity/references/errors.md` and resolve properly. Never retry-loop a business error, and never leave the listing half-updated without recording exactly which services landed. |
| A deploy is required first | Deploys are owner-gated. Prepare it so the ship is one command and say so; do every non-deploy step now. |
| OKX-04 has no GO | Run every OKX-04 step that needs no funding, report the gap precisely, do not submit. |

## Report format

The three-way diff result, the submitted payload, before and after approval status, and the
single owner action if one remains.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/okx-ai-05-relisting-resubmission.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
