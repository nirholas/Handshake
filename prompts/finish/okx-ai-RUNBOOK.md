# OKX.AI Operator Runbook: agent #2632 "three.ws 3D Studio"

The operator's guide for launch day and the days before it. Written for a zero-context
human or agent: every command below was run from this repo and its real output recorded.

- **Shared facts:** [`okx-ai-00-CONTEXT.md`](okx-ai-00-CONTEXT.md) (agent id, wallets, chain, CLI).
- **Full history:** [`okx-ai-PROGRESS.md`](okx-ai-PROGRESS.md).
- **Public docs:** [`docs/okx-marketplace.md`](../../docs/okx-marketplace.md), [`specs/okx-agent-payments.md`](../../specs/okx-agent-payments.md).

**CLI:** `onchainos` at `~/.local/bin/onchainos` (v4.5.2 as of 2026-09-02; check drift with
`onchainos --version`). Almost everything here needs an authenticated session as
`claude@three.ws`: every **write** (update, activate, resubmit) and, as of v4.3.0, the
**reads** too (see the note after the login block). **Login mechanics
changed as of v4.3.0** (older sessions in `okx-ai-PROGRESS.md` describe a direct `wallet login
<email>` + OTP-typed flow; that no longer exists):

```bash
onchainos wallet login --phase init
# -> {"authSessionId": "...", "loginUrl": "https://web3.okx.com/account/sociallogin?...", "opened": true}
```

A human must open `loginUrl` in a browser, choose email, enter `claude@three.ws`, and complete
the emailed OTP there (agents cannot type OTP into this flow directly, it never surfaces as a
CLI prompt). Then poll for completion (long-running, times out at 120s per call, re-issue as
needed while the human finishes the browser step):

```bash
onchainos wallet login --phase poll --session-id <authSessionId>
onchainos wallet status   # loggedIn: true once done
```

> **Trap, learned the hard way 2026-08-01: a login URL goes stale, so never hand one to a
> human "for later".** A second `--phase init` (for example the one `npm run okx:bot` issues
> as part of its own run) invalidates the earlier session, and an idle session expires on its
> own. Polling a dead one answers
> `{"ok":false,"error":"no login in progress for this session, run `onchainos wallet login --phase init` first"}`,
> which reads like a CLI bug but just means the URL is expired. **Issue `--phase init` only
> when the human is at the keyboard ready to click it**, and if `okx:bot` also printed a URL,
> the newest one issued is the only live one.

`onchainos agent get-agents` / `service-list` / `search` need this session even though they
are reads. Re-confirmed 2026-08-01: logged out, all three return
`{"ok":false,"error":"session expired, please login again: onchainos wallet login"}`, so
**approval status cannot be read at all without a human completing the browser login.**
Only `curl` against our own `/api/okx/3d/*` endpoints (§7), public RPC reads, and
`--help` on any subcommand are truly login-free.

---

## 0.5 The chat bot goes offline on its own: `npm run okx:bot`

The marketplace chat bot for #2632 is a LOCAL `okx-a2a` daemon plus the `onchainos` wallet
session, both outside this repo. A codespace rebuild wipes the CLIs; an idle nap kills the
daemon (observed: alive 21:09, dead by 03:13 the same night). OKX-side chat tests then time
out with "no delivery in 30 min", which is what got the listing flagged as offline on
2026-07-26.

**One command does the whole recovery:**

```bash
npm run okx:bot
```

It installs/updates both CLIs, starts the daemon, wires the runtime, regenerates the chat
briefing from the live catalog module, links the OKX skills into the AI workspace, turns on
permission bypass, and reports health. Exit code 0 = online. Exit code 2 = everything is
staged but the wallet is logged out, and it prints the login URL a human must open (email
OTP, `claude@three.ws`) plus the two follow-up commands.

What it wires, and why each matters:

| Piece | Why the bot is broken without it |
|---|---|
| `okx-a2a` daemon | Holds the XMTP identity chat is delivered to. |
| Wallet session | The daemon takes every client offline the moment `onchainos agent get` 401s. |
| `~/.okx-agent-task/workspace/CLAUDE.md` | The AI subsession's only knowledge of what we sell; generated from `api/_lib/okx-catalog.js` so prices can never drift from the endpoints. |
| `.claude/skills` in that workspace | Without them the subsession has no `okx-agent-task` flow and improvises on task envelopes instead of following accept/negotiate/deliver. |
| `agent bypass on` | Otherwise the subsession stalls on a tool-approval prompt nobody is there to answer, which reads to the buyer as an unresponsive bot. |

Measured reply latency through the real adapter path: ~12 s bare, ~46 s with the full skill
set loaded. Both are far inside OKX's 30-minute test window.

**The durable fix is built and, since 2026-09-02, is what runs the bot on this machine.**
Prefer it over `npm run okx:bot`, which stages the daemon and exits:

```bash
PORT=8080 OKX_BOT_REPO_ROOT=/workspaces/three.ws \
  node --env-file=.env.local workers/okx-chat-bot/index.js
curl -s localhost:8080/readyz     # 200 with health.ready true when chat is deliverable
```

If that port is taken the worker exits on `EADDRINUSE` before it ever spawns the daemon, which
reads as "the bot will not start" rather than "the port is busy". Pick another `PORT`.

Run that way it supervises the daemon itself, beats to `bot_heartbeat` every 30s (so
`/api/healthz` finally shows the `okx_chat_bot` subsystem instead of `no heartbeat reported
yet`), and labels every beat `host=codespace:<name>`, `hostDurable=false`, which reads as
degraded and stopgap on the ops surface rather than green. `--env-file` is not optional:
sourcing `.env.local` in bash splits the Neon URL on its `&`, and the heartbeat then fails
with `DATABASE_URL` unset.

[`workers/okx-chat-bot/`](../../workers/okx-chat-bot) is the same code as an
always-on Cloud Run host. It restores the wallet/XMTP identity from GCS
on boot, supervises `okx-a2a run` directly (`daemon start` is a no-op in a container),
rebuilds the AI briefing from the live catalog every boot, and reports health as the
`okx_chat_bot` subsystem on `/api/healthz`. Ship it with one command (owner-gated):

```bash
gcloud builds submit --config workers/okx-chat-bot/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s) .
```

Until that lands, `npm run okx:bot` before an OKX retest window is still the stopgap: a
codespace cannot stay up on its own, so the local bot dies whenever this workspace sleeps.

**The deploy no longer waits on a credential (2026-09-04).** It used to demand an
`anthropic-api-key` secret that exists nowhere, so it never ran. The service now authenticates
the AI subsession through Vertex AI with the runtime service account (`three-ws@` already holds
`roles/aiplatform.user`), so `--set-secrets` carries only the heartbeat database URL, and the
session snapshot is seeded in `gs://three-ws-okx-bot-state`, so the first boot restores an
authenticated wallet rather than paging for an OTP. Before shipping, re-seed from the host that
holds the live session and stop it: `npm run okx:bot:seed-state -- --apply`, then stop the
stopgap. That GCS object has exactly one writer.

One owner action beyond the deploy: **the GCP billing hold**. Measured 2026-09-04, both AI
credentials this project holds are present and refused, Vertex with
`403 PERMISSION_DENIED: Lightning dunning decision is deny for project: projects/93741856042`
and the `openai-api-key` secret's account with `429 billing_not_active` (that second one kills
the platform's OpenAI lane everywhere, not just here). The host no longer takes a configured
credential on trust: it asks the provider at boot and every 15 minutes and reports
`ai_provider_unauthorized`, which fails `/readyz`, pages ops, and carries the three ways out in
the `remedy`. Until billing clears, a deployed host receives chat durably and authors no
replies. Clearing it needs no redeploy; the next probe flips the verdict on its own.

The wallet OTP remains unavoidable whenever the session does expire (OKX requires a human, and
it never surfaces as a CLI prompt).

Once deployed, the fix for a logged-out session is readable off the service itself, so
nobody has to reconstruct it from this runbook:

```bash
URL=$(gcloud run services describe okx-chat-bot --region us-central1 \
  --project aerial-vehicle-466722-p5 --format='value(status.url)')
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/readyz" | jq .remedy
```

## 1. Daily status check

One command. Run it, read three fields.

```bash
onchainos agent get-my-agents
```

> **Trap, found 2026-09-02 on `onchainos` v4.5.2: `get-agents` no longer carries the approval
> fields.** The obvious command for this (`onchainos agent get-agents --agent-ids 2632`) still
> works and still returns the agent, but its payload has NO `approvalDisplayStatus`,
> `approvalLabel`, `status` or `statusLabel`. The one-liner this runbook used to recommend
> against it dies with `KeyError: 'approvalLabel'`, which reads like a broken CLI and is just a
> moved field. `get-my-agents` (own agents only, no `--agent-ids`) carries all four. Use it for
> every status read; keep `get-agents` for the card copy, description and profile photo.

Verified output (2026-09-02, the fields that matter):

```json
{ "agentId": "2632", "approvalDisplayStatus": 2, "approvalLabel": "Listing under review",
  "status": 2, "statusLabel": "not listed", "soldCount": 2, "role": 2, "roleLabel": "ASP" }
```

### Reading the fields

| Field | Meaning |
| --- | --- |
| `approvalDisplayStatus` | Review state. `2` = **Listing under review** (our state since the 2026-08-27 resubmission), `5` = **Listing rejected**. The CLI also returns `approvalLabel`, the human string, **trust `approvalLabel` over memorising numbers**; the numeric map is OKX's and is not documented publicly. |
| `approvalLabel` | Same state as text: `"Listing under review"`, `"Listing rejected"`, `"Listing approved"`. |
| `status` | Listing state. `2` = **not listed**; `statusLabel` says it in words. |
| `soldCount` | Lifetime sales. `2` today. |
| `role` | `2` = ASP (Agent Service Provider). |

Two fields on the OTHER commands look like this one and are not. **Do not read approval state
out of either:**

- `agent service-list --agent-id 2632` returns `data[0].agentInfo.approvalStatus`, a
  DIFFERENT enum from `approvalDisplayStatus` (it read `3` on 2026-09-02 while the display
  status read `2`). Its `approvalRemark` is the last rejection reason ever stored, not the
  current one: on 2026-09-02, mid-review, it still quoted the 2026-07-26 rejection verbatim.
  A reader who takes that pair at face value concludes we were rejected again when we were
  not.
- `agentInfo.updatedAt` tracks the agent's online heartbeat, not the listing. It moves every
  time the `okx-a2a` daemon checks in (observed 1 ms after `lastOnlineTime`), so "updated
  today" says nothing about review progress.

Quick one-liner for a scripted check:

```bash
onchainos agent get-my-agents \
  | python3 -c "import json,sys; a=[x for g in json.load(sys.stdin)['data']['list'] for x in g['agentList'] if x['agentId']=='2632'][0]; print(a['approvalLabel'], '| status', a['statusLabel'], '| sold', a['soldCount'])"
```

Verified 2026-09-02: `Listing under review | status not listed | sold 2`.

---

## 2. Drift resolved: the live listing IS our current catalog

Historic note: from 2026-07-04 to 2026-08-27 the listing carried the old, rejected service
set (7 REST rows, not one name matching the catalog module). That drift was closed by the
2026-08-27 on-chain update (8 deletes, 7 creates, tx
`0xb4b2f51dc34d4c8ed6adc2cfb55b0e21e2a6a29d787c02a8a9ca110e178415ba`).

Re-verified 2026-09-02, live listing against
[`api/_lib/okx-catalog.js`](../../api/_lib/okx-catalog.js): **7 rows, every name and every
endpoint matching, no drift.**

```bash
onchainos agent service-list --agent-id 2632   # -> data[0].total = 7
```

| Service id | Name | Fee | Endpoint |
| --- | --- | --- | --- |
| 39975 | Forge 3D Draft | 0.01 | `https://three.ws/api/okx/3d/forge-draft` |
| 39976 | Forge 3D Standard | 0.05 | `https://three.ws/api/okx/3d/forge-standard` |
| 39977 | Forge 3D HD | 0.25 | `https://three.ws/api/okx/3d/forge-hd` |
| 39978 | Forge 3D from Image | 0.25 | `https://three.ws/api/okx/3d/forge-image` |
| 39979 | Forge Job Status | 0 | `https://three.ws/api/okx/3d/forge-status` |
| 39980 | 3D Studio Service Catalog | 0 | `https://three.ws/api/okx/3d/catalog` |
| 39981 | 3D Studio Health Status | 0 | `https://three.ws/api/okx/3d/health` |

All seven are `serviceType: A2MCP`, all on `chainIndex: 196`, all quoting
`contractAddress: 0x779ded0c9e1022225f8e0630b35a9b54be713736` (USD₮0).

The catalog module stays the source of truth. Nine further rows (Identity Studio and the
single-capability REST services) are deployed and payable but carry `listed: false`; they
show up under `unlisted` in `GET /api/okx/3d/catalog` and are deliberately not submitted.
Re-run the comparison above after any change to the module, and after any listing update.

---

## 3. The one blocker: settlement funding

Everything else is code-complete. The rail reports `settleable: true` in production, but no
funded call has ever settled on-chain.

**⚠️ Correction (2026-07-23, WO-07 audit): the seller/payTo address has moved.** Every earlier
session in `okx-ai-PROGRESS.md` (and the pre-2026-07-23 text below in this file) names
`0x75d00a2713565171f33216e5aa2a375e076ecf69` as "the payTo wallet". Live-probed today, the
X Layer accept's `payTo` is **`0x4022de2D36C334E73C7a108805Cea11C0564f402`**, the platform's
standard EVM merchant/deployer wallet (already the Base rail's `payTo`, see
`contracts/DEPLOYMENTS.md`), evidently consolidated onto X Layer sometime between 2026-07-07
and 2026-07-23 with no PROGRESS.md entry recording it. Confirmed against the live Cloud Run
env var (`X402_PAY_TO_XLAYER`), not just the HTTP challenge, so this is the real seller address,
not a caching artifact. `0x75d0…cf69` still has two other real roles that are unaffected: it is
agent #2632's **on-chain identity owner wallet**, and it is the **onchainos buyer/TEE wallet**
this session's `payment pay` command signs from, so a "self-payment" test is no longer
self-payment (buyer `0x75d0…cf69` → seller `0x4022de2D…f402`), which is arguably a more
realistic E2E test, not a problem, but the funding target below is what actually needs money.

**Wallet balances re-checked live 2026-09-02, block 69606689 (X Layer RPC `rpc.xlayer.tech`,
direct `eth_call` on `balanceOf` + `eth_getBalance`). Every figure below is unchanged from
2026-08-01 and from 2026-07-23, and the live 402's `payTo` was re-probed the same day across
all four paid rows and had NOT drifted again:**

| Wallet | Role | USD₮0 | OKB (gas) |
| --- | --- | --- | --- |
| `0x75d00a2713565171f33216e5aa2a375e076ecf69` | Buyer (onchainos TEE wallet) + agent identity owner | **0** | **0** |
| `0x4022de2D36C334E73C7a108805Cea11C0564f402` | Seller / payTo (current) | 2.427731 (irrelevant to the buyer-side test, it's the recipient not the payer) | 0.839596 |
| `0xe81DE501Dd5D9299E2bA8964498858d3fAD0415B` | Relayer (`X402_XLAYER_RELAYER_KEY`, Secret Manager `x402-xlayer-relayer-key` v3, rotated 2026-07-12; superseded the `0x1F4a…bb74` address `okx-ai-PROGRESS.md` names from 2026-07-08) | 0 | 0.02 |

**To unblock, the owner funds the BUYER wallet** (the seller already has funds; gas at the
relayer is thin but present):

| | |
| --- | --- |
| Wallet to fund | `0x75d00a2713565171f33216e5aa2a375e076ecf69` (buyer) |
| Chain | X Layer, chainId **196** (`eip155:196`) |
| Token | `0x779ded0c9e1022225f8e0630b35a9b54be713736` (USD₮0) |
| Amount | ≥$3 to cover one paid call of every catalog service once each; ~$5 for buffer |

The buyer needs **no OKB**: it signs an EIP-3009 authorization off-chain and the relayer
broadcasts and pays gas, which is why the buyer's 0 OKB above is not a second blocker.

Re-verify the relayer's OKB balance is still enough for ≥3 settlement tx before relying on
0.02 OKB, top up a few cents' worth if a dry run shows `broadcast_failed`/out-of-gas.

Once funded, run [`okx-ai-04-e2e-real-payment-test.md`](okx-ai-04-e2e-real-payment-test.md). It needs ≥3
real settlements with transaction hashes.

**Correction (2026-09-02): funding no longer gates the resubmission, and never did.** Earlier
revisions of this file said "only then does WO-05 unlock". WO-05 is retired; its successor
[`okx-ai-08-forge-relisting.md`](okx-ai-08-forge-relisting.md) states plainly that a listing
does not require a settled payment to be submitted, and the 2026-08-27 resubmission went out
with all three wallets exactly as they are in the table above. What funding gates is the
first real end-to-end settlement (WO-04), which is evidence we owe ourselves and the
marketplace, not a precondition for review.

Until a real settlement exists, `docs/okx-marketplace.md` must not claim observed on-chain
settlement, its "Payment semantics" section states the contract as implemented and
unit-tested, with an explicit note that no funded settlement has occurred. Keep that note
until the first tx hash lands, then update both that section and `okx-ai-PROGRESS.md`. Also re-probe
`payTo` live before trusting any address in this file, the mid-stream address change above
went unrecorded once; it can happen again silently on a future deploy.

---

## 4. Branch: **APPROVED** (`approvalLabel: "Listing approved"`)

This is the holder-visible moment. Work the list top to bottom.

1. **Confirm the listing is live and activated.**
   ```bash
   onchainos agent get-my-agents                   # status should leave 2 ("not listed")
   onchainos agent service-list --agent-id 2632    # services present, prices correct
   ```
   Reconcile the service names against `api/_lib/okx-catalog.js`, see §2. If they still
   differ, WO-05 did not take; re-run it before announcing.

2. **Search as a buyer would.** We must actually appear:
   ```bash
   onchainos agent search --query "3D avatar rigging GLB"
   ```
   Verified 2026-07-10: returns 2 results, **agent 2632 absent** (correct, we are not
   listed). After approval this must return us. Check the card copy reads well and the
   prices are right.

3. **Announce it.** Append an entry to [`data/changelog.json`](../../data/changelog.json)
   with tag `feature`, in plain holder-readable language, then:
   ```bash
   npm run build:pages          # validates the entry; fails the build if malformed
   ```
   Delivery to the holders' Telegram channel (@three_ws) is automatic: the
   `/api/cron/changelog-push` cron posts the entry once the deploy that ships
   it is live. No manual push step. **X.com delivery is retired** (owner directive
   2026-07-18), Telegram is the only automatic lane. Never run `npm run changelog:push`
   for a release: its file-based state is separate from the cron's DB state, so a manual
   push double-posts to holders.

4. **Set the agent's own avatar live** if WO-06's dogfood upload was deferred (it was, the
   asset is generated but never written on-chain). This is an on-chain write: OTP required.

5. **Record it.** Append the approval, the date, and the first listing screenshot/output to
   `okx-ai-PROGRESS.md`.

---

## 5. Branch: **REJECTED AGAIN** (`approvalDisplayStatus: 5`)

1. **Capture the exact reason.** The `claude@three.ws` inbox is authoritative: the
   2026-07-04 rejection came by email with `approvalRemark` empty. The only CLI field that
   ever carries a remark is on `service-list`, and it is the LAST reason ever stored, not
   necessarily the current one (see the warning in §1), so read it as a candidate and
   confirm it against the email before acting.
   ```bash
   onchainos agent service-list --agent-id 2632 \
     | python3 -c "import json,sys; print(repr(json.load(sys.stdin)['data'][0]['agentInfo']['approvalRemark']))"
   ```
2. **Append the verbatim remark to `okx-ai-PROGRESS.md`** with the date. Never paraphrase a
   reviewer.
3. **Map the reason to the work order that owns it**, fix there, and re-run
   [`okx-ai-08-forge-relisting.md`](okx-ai-08-forge-relisting.md), which supersedes the
   retired `okx-ai-05-relisting-resubmission.md`. Precedent:
   - 2026-07-04 rejection ("your A2MCP service has not been integrated with the OKX Agent
     Payments Protocol standard") was owned by the payment rail, implemented in
     [`api/_lib/x402-xlayer-okx.js`](../../api/_lib/x402-xlayer-okx.js).
   - 2026-07-17 rejection (avatar not aligned with agent positioning / not polished; wrong
     dimensions/corners) was owned by the listing avatar. Fixed: a logo-style 440x440 square
     avatar at [`prompts/okx-ai/assets/okx-avatar-440.png`](../okx-ai/assets/okx-avatar-440.png)
     (reproducible via `node prompts/okx-ai/assets/render-avatar.mjs`), plus a root-cause fix
     to the render pipeline itself (missing IBL environment made every avatar/PFP render dark
     and murky, see `api/_lib/render-clip.js` / `api/_lib/avatar-render.js`, shipped
     2026-07-17). **As of this audit (2026-07-23) the fixed avatar has not yet been uploaded
     on-chain** (`agent upload` + `agent update` need the login session from §0, then a human
     confirms the write), that upload plus the catalog-string resubmission (§2) is the next
     concrete action once login completes.

---

## 5.5 The pre-resubmission gate: two probes, both must pass

Never resubmit on a code review alone. Both of these run against live production, take about
a minute together, and each one covers a leg the other cannot see. Every rejection since
2026-07-04 would have been caught by one of them.

```bash
node scripts/okx-compliance-probe.mjs      # the 402 quotation, as the reviewer parses it
node scripts/okx-payment-leg-probe.mjs     # the signed replay, as the reviewer pays it
```

- **`okx-compliance-probe.mjs`** walks all four paid rows through five request shapes,
  including the A2MCP guide's own bodyless `curl -i -X POST` self-check, and fails unless
  every one answers 402 with a `PAYMENT-REQUIRED` header that names each rail exactly once at
  the row's registered list price. It exists because a duplicated `eip155:196` accept at two
  prices reads to a validator as "quotation cannot be parsed", which is what rejection #3
  said in the reviewer's internal note.
- **`okx-payment-leg-probe.mjs`** fetches the challenge, signs it through the `onchainos` TEE
  wallet (so the buyer is a real EIP-7702 delegated OKX agentic wallet, the same shape as the
  audit address), replays it, and requires the answer to be `insufficient_balance` and
  nothing else. That error is thrown after the signature, recipient, amount, validity window
  and nonce have all been accepted, so it is the proof that a *funded* buyer settles. Our
  buyer holds no USD₮0, so the run spends nothing; if it is ever funded the script refuses to
  sign without `--allow-spend`, because then a pass would be a real purchase.

Both take `--base` (point them at a staged worktree's server before a deploy) and `--out`
(write the capture into `prompts/okx-ai/e2e-evidence/`). Commit the captures: they are the
evidence trail for the next review.

With both green and the seven rows still matching `api/_lib/okx-catalog.js` (§2), the
resubmission is one command, and it is an on-chain write, so the owner confirms it first:

```bash
onchainos agent activate --agent-id 2632 --preferred-language en-US
```

Do not run the WO-08 service delta when the rows already match: it deletes and recreates
correct rows and loses their service ids.

## 6. First-sale operations

| What | How |
| --- | --- |
| Did we sell? | `onchainos agent get-my-agents` → `soldCount`. `get-agents --agent-ids 2632` also carries `soldCount`, but it is the one command that does NOT carry `approvalLabel` (verified 2026-09-02, it reads `None` there), so use `get-my-agents` for the daily watch below and read both fields from one call. |
| What did buyers say? | `onchainos agent feedback-list --agent-id 2632` ("Query Agent reviews"). `--agent-id` is runtime-enforced: omit it and the CLI answers `missing required parameter: --agent-id`. Optional `--page` / `--page-size`. |
| Where does revenue land? | The seller/payTo wallet on X Layer (196), **verify live**, it has moved before (see §3); as of 2026-07-23 it is `0x4022de2D36C334E73C7a108805Cea11C0564f402`, the platform's standard EVM merchant wallet, not the buyer wallet. Confirm the first payout against the settlement tx hash from WO-04. |
| Where do errors surface? | The existing error-reporting path in [`api/_mcp/payments.js`](../../api/_mcp/payments.js); paid-endpoint failures answer **before** settlement, so a failed job never charges a buyer. |
| Daily watch | `soldCount`, `approvalLabel`, and the paid-endpoint health/catalog free routes (§7). |

---

## 7. Free routes worth probing any day

These need no payment, no key, and no login, they are the fastest signal that the surface
is healthy:

```bash
curl -s https://three.ws/api/okx/3d/catalog | head -c 400   # 1:1 with api/_lib/okx-catalog.js
curl -s https://three.ws/api/okx/3d/health  | head -c 400   # honest lane health
```

An unpaid `POST` to any paid service must return a spec-valid **402** carrying the X Layer
accept. Challenges drift whenever an unrelated deploy touches shared payment code, so re-run
this before any submission, over the four LISTED paid rows (`identity-studio`, which earlier
revisions of this file probed, is `listed: false` since the 2026-08-22 rebuild and is not
what a reviewer sees):

```bash
for s in forge-draft forge-standard forge-hd forge-image; do
  printf '%s ' "$s"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2025-06-18' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forge_3d","arguments":{"prompt":"a low-poly orange fox"}}}' \
    "https://three.ws/api/okx/3d/$s"      # expect 402 on all four
done
curl -s -o /dev/null -w '%{http_code}\n' https://three.ws/api/okx/3d/forge-status   # expect 405
```

**Send the two MCP headers.** A bare curl is a false green: an OAuth-capable client
(`accept: text/event-stream` or `mcp-protocol-version`) used to be answered 401 rather than
402 on this surface, which is a status an OKX buyer cannot pay, and every verification pass
before 2026-08-22 missed it because none of them sent those headers. Verified 2026-09-02:
all four rows answer 402 with `accepts[0].network` = `eip155:196` either way.

---

## 8. Live review monitoring

Do not leave a daemon running. When the human wants to watch the review in real time, they
invoke the `okx-task-watch` skill, which polls the task/chat surface and surfaces reviewer
messages. Agents should check status once per session with §1 and stop there.

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'okx-ai-RUNBOOK' prompts/finish/
       git rm prompts/finish/okx-ai-RUNBOOK.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
