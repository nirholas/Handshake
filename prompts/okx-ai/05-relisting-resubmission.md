# Work Order 05 — Update agent #2632 and resubmit the listing

Read `prompts/okx-ai/00-CONTEXT.md` and `prompts/okx-ai/PROGRESS.md` end to end. **Hard
gate: 04 must show an explicit GO.** If there is no GO from 04, stop and say so. Read
`/workspaces/three.ws/CLAUDE.md`.

## Mission

Resubmit "three.ws 3D Studio" (#2632) with the decomposed service catalog and the now-real
OKX payment rail. This is the shot that reverses the rejection — treat the submission
itself as a product: every string a reviewer reads, every endpoint they probe, must be
exact. **Update the existing agent #2632 — never deactivate, never re-create; the ID, its
wallet binding, and its history are assets.**

## Step 1 — Pre-submission verification sweep

You are the reviewer for an hour. Against PRODUCTION:

1. Every endpoint in 03's final catalog: unpaid `curl -i` → OKX-valid 402 (or free content
   for the free lane). Any drift from what 03/04 recorded = stop and fix first.
2. Diff every service's name/description/price/URL between the catalog module
   (`api/_lib/okx-catalog.js`), the live free catalog endpoint, and the table you're about
   to submit. Must be identical — three copies, zero drift.
3. Validate every description against OKX limits (2-part format; each part ≤200 chars in
   East-Asian display width, CJK=2/ASCII=1; no links/tech-stack/example-prompts inside
   service descriptions — those rules are in `.claude/skills/okx-agent-identity/references/invariants.md`,
   which read in full before this step, along with `references/update.md`).
4. Agent-level profile: keep the existing description unless evidence says it hurt review
   (do not silently rewrite identity copy); profile photo URL must be the existing OKX CDN
   asset (`https://static.okx.com/cdn/.../49eab781-....png`) — OKX rejects non-CDN links.

## Step 2 — The update flow (interactive — human in the loop)

Session preflight per 00-CONTEXT (login = claude@three.ws; the human relays the OTP).

Follow the okx-agent-identity update flow **exactly** (`.claude/skills/okx-agent-identity/`
SKILL.md + references/update.md): fetch current state via `agent get-agents --agent-ids 2632`
first; build the `--service` JSON with per-service `operation` deltas (`create` for new
entries, `update`/`delete` with `id` for existing ones — pull existing service ids via
`agent service-list --agent-id 2632`); `serviceType: "A2MCP"`, `fee` as plain quoted number
string, `endpoint` = the per-service production URL; run the validate-listing QA; render the
diff card and get the human's explicit confirm before the write. The skill's confirmation
gates exist for a reason — an on-chain write is irreversible; do not shortcut them even
though this is "our own" agent.

## Step 3 — Resubmit for review

Per the rejection email, resubmission happens through the agent flow: after the update
lands, run the activate step (`--preferred-language en-US` is required — see invariants.md
flag gotchas). Confirm the CLI/backend response shows the listing entered review
(approval status moves off "Listing rejected" to pending/in-review). Capture the exact
before/after approval-status values.

## Step 4 — Record + set the watch

- PROGRESS.md: submitted catalog (verbatim), tx/CLI outputs, timestamp, approval status
  after submission, and the daily check command:
  `onchainos agent get-my-agents` (or `get-agents --agent-ids 2632`).
- `data/changelog.json`: no entry yet — the changelog entry ships when the listing is
  APPROVED (07 owns that), not when submitted.

## Definition of done

- [ ] Pre-submission sweep: every catalog endpoint verified live + three-way string diff clean
- [ ] Update executed through the skill's full flow (pre-fetch, deltas by service id,
      validate, human-confirmed diff card) — no bypassed gates
- [ ] Resubmission confirmed: approval status captured before + after, listing is in review
- [ ] Nothing was deactivated/deleted; agent is still #2632
- [ ] PROGRESS.md appended with the full submission record
- [ ] Any incidental fixes committed (explicit paths) + pushed to `threews` (only push target)

## Anti-laziness gates

- Do not paraphrase, trim, or "improve" 03's final descriptions during entry — submit the
  validated strings byte-for-byte. If entry-time validation rejects one, fix it in the
  catalog module FIRST, redeploy, re-verify the free catalog endpoint, then resubmit — the
  three copies must never diverge, even for one review cycle.
- If the CLI or backend errors mid-update, read
  `.claude/skills/okx-agent-identity/references/errors.md` and resolve properly — never
  retry-loop a business error, never leave the listing half-updated without recording
  exactly which services landed.
