# OKX-08: resubmit agent #2632 with the three.ws Forge listing

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/okx-ai-08-forge-relisting.md`". Read
`prompts/finish/okx-ai-00-CONTEXT.md`, the 2026-08-22 entry in `prompts/finish/okx-ai-PROGRESS.md`,
`prompts/finish/okx-ai-RUNBOOK.md` and `CLAUDE.md` first.

This supersedes `okx-ai-05-relisting-resubmission.md`, which submits the retired 11-row catalog.
Do not run 05.

## Binding operating clause

1. Finish 100% of everything that is not an on-chain write or an OTP. Never end with a
   question about scope or design.
2. **Stop and wait only twice, batched into one message:** the email OTP for
   `claude@three.ws`, and the human confirmation of the diff card before the irreversible
   on-chain update. Both are CLAUDE.md gates that override the autonomy rule.
3. Never deactivate or delete agent #2632. All changes go through update plus re-activate;
   the ID, its wallet binding and its history are assets.
4. CLAUDE.md hard rules apply. Stage explicit paths only. No em-dash or en-dash characters.

## Mission

Replace the seven stale services on the live listing with the seven-row three.ws Forge
line-up, then resubmit for review. The rejection cause (an A2MCP service with no OKX Agent
Payments Protocol integration) is resolved in code: every listed row is a real MCP
Streamable HTTP server whose paid `forge_3d` tool answers an unpaid call with a 402 whose
`accepts[0]` is `eip155:196`.

## Step 0: gate check (autonomous)

The forge endpoints must be LIVE in production before anything is submitted. They ship in
the same container as the rest of `api/`, so this is a deploy check, not a code check.

```bash
curl -s https://three.ws/api/version                     # is the deployed SHA >= the rebuild?
curl -s https://three.ws/api/okx/3d/catalog | python3 -m json.tool | head -40
```

`services` must be the seven forge/free rows and `unlisted` must hold the back burner. If
`services` still lists `identity-studio`, production predates the rebuild: **stop, report
that a deploy is required, and do not submit.** A listing whose endpoints 404 on a
reviewer's probe is worse than no listing.

## Step 1: be the reviewer (autonomous)

Probe every advertised endpoint the way a reviewer will, with slugs read from the live
catalog rather than from this file:

```bash
for s in $(curl -s https://three.ws/api/okx/3d/catalog \
  | python3 -c "import sys,json;[print(x['endpoint'].rsplit('/',1)[-1]) for x in json.load(sys.stdin)['services']]"); do
  echo "== $s"
  curl -si -X POST "https://three.ws/api/okx/3d/$s" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forge_3d","arguments":{"prompt":"a low-poly orange fox"}}}' \
    | head -20
done
```

Required results, no exceptions:

1. Each of the four paid rows answers **402**, and the body's `accepts[0]` is
   `{scheme:"exact", network:"eip155:196"}` at that row's own atomic amount. Anything else
   is the rejection cause reappearing: stop and fix it before submitting.
2. `accepts[]` names each rail exactly once (`mergeAccepts` in `api/_mcp/auth.js`).
3. `forge-status` never 402s, and `tools/call getting_started` is free everywhere.
4. `catalog` and `health` answer 200 on GET.
5. Three-way string diff, module vs live vs submission, zero drift:
   ```bash
   node scripts/okx-three-copy-check.mjs
   ```
6. Validate the listing strings against OKX limits before you build the payload. The rules
   are in `.agents/skills/okx-agent-identity/references/invariants.md`; read it and
   `references/update.md` in full. Every listed row must hold: name 5 to 30 display
   columns, each of the two description parts within 200 display columns (CJK counts 2),
   no links, no tech-stack names, no example prompts. `npm run test -- okx-forge` enforces
   all of it, so run the test rather than eyeballing.

Known deviation to state honestly if it comes up, do not "fix" it blind: `catalog` and
`health` are listed as `serviceType: A2MCP` (OKX has no third type) while being plain free
GET endpoints. They carry no payment surface, so the payment-protocol requirement does not
apply to them. If review objects specifically to these two rows, the remedy is to drop them
from the listing, not to redesign the forge rows.

## Step 2: build the delta (autonomous)

```bash
onchainos agent get-agents --agent-ids 2632
onchainos agent service-list --agent-id 2632 \
  | node scripts/okx-listing-payload.mjs --delta > /tmp/forge-delta.json
python3 -m json.tool /tmp/forge-delta.json | head -60
```

Expect seven `operation: delete` entries (the stale live rows, none of whose names match
the new catalog) and seven `operation: create` entries. If any row comes back as `update`,
a name collided; read it before proceeding.

## Step 3: the update flow (the one owner interaction)

Session preflight per `okx-ai-00-CONTEXT.md`. Follow the `okx-agent-identity` update flow exactly:
current state via `agent get-agents`, existing ids via `agent service-list`, then
`agent update --agent-id 2632 --service "$(cat /tmp/forge-delta.json)"`, with `fee` as a
plain quoted number string and `endpoint` as the per-service production URL.

Agent-level fields: keep the existing name, description and OKX CDN photo URL unless
evidence says they hurt review. A non-CDN photo link is rejected.

QA is a single batch pass: run `validate-listing` exactly once over the create + update
entries (without the `operation`/`id` keys), render findings as suggestions, and wait for
the user's choice before applying any of them. Never re-run it.

Then render the diff card and **stop for the human's confirm**. On confirm, run the update,
then `agent activate --agent-id 2632 --preferred-language en-US` to resubmit for approval.

## Step 4: record and watch (autonomous)

Append a dated entry to `prompts/finish/okx-ai-PROGRESS.md`: the delta that was submitted, the CLI
responses verbatim, the new `approvalDisplayStatus`, and the timestamp. Then poll
`onchainos agent get-agents --agent-ids 2632` until `approvalDisplayStatus` moves off
"pending", and record the outcome. On a rejection, capture the exact reason (it arrives by
email to `claude@three.ws`; `approvalRemark` has historically been empty) and open the next
work order against that reason. Never respond to a rejection by creating a new agent.

## Not in scope

Funding. A real settled payment is a separate gate (`okx-ai-04-e2e-real-payment-test.md`) and is
still blocked on the relayer and buyer wallets, both empty as of 2026-08-22. The listing
does not require a settled payment to be submitted; do not wait on it, and do not claim a
settlement that has not happened.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/okx-ai-08-forge-relisting.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
