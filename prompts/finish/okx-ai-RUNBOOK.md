# OKX.AI Operator Runbook: agent #2632 "three.ws 3D Studio"

The operator's guide for launch day and the days before it. Written for a zero-context
human or agent: every command below was run from this repo and its real output recorded.

- **Shared facts:** [`okx-ai-00-CONTEXT.md`](okx-ai-00-CONTEXT.md) (agent id, wallets, chain, CLI).
- **Full history:** [`okx-ai-PROGRESS.md`](okx-ai-PROGRESS.md).
- **Public docs:** [`docs/okx-marketplace.md`](../../docs/okx-marketplace.md), [`specs/okx-agent-payments.md`](../../specs/okx-agent-payments.md).

**CLI:** `onchainos` at `~/.local/bin/onchainos` (v4.4.0 as of 2026-08-01; check drift with
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

**The durable fix is built:** [`workers/okx-chat-bot/`](../../workers/okx-chat-bot) is an
always-on Cloud Run host for the same stack. It restores the wallet/XMTP identity from GCS
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

Two owner actions remain either way. The wallet OTP is unavoidable (OKX requires a human,
and it never surfaces as a CLI prompt). The AI-provider credential is what lets the headless
box author replies at all: set `ANTHROPIC_API_KEY` on the service (preferred), or
`OPENAI_API_KEY` to run the Codex CLI instead. Without one the host still receives chat and
reports `ai_provider_uncredentialed` rather than pretending to be healthy.

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
onchainos agent get-agents --agent-ids 2632
```

**Last successfully read: 2026-07-10.** Every attempt since (2026-07-23, 2026-07-26,
2026-08-01) hit the logged-out wall above, so the state below is the newest real reading,
not a current one. Re-read it the moment a login lands.

Verified output (2026-07-10):

```json
{ "agentId": "2632", "approvalDisplayStatus": 5, "approvalLabel": "Listing rejected",
  "approvalRemark": "", "status": 2, "soldCount": 0, "role": 2 }
```

### Reading the fields

| Field | Meaning |
| --- | --- |
| `approvalDisplayStatus` | Review state. `5` = **Listing rejected** (our current state). The CLI also returns `approvalLabel`, the human string, **trust `approvalLabel` over memorising numbers**; the numeric map is OKX's and is not documented publicly. |
| `approvalLabel` | Same state as text: `"Listing rejected"`, `"Listing approved"`, `"Under review"`. |
| `approvalRemark` | The reviewer's stated reason. **Currently empty**, the 2026-07-04 rejection reason arrived only by email, not through this field. Do not assume a rejection reason will appear here. |
| `status` | Listing state. `2` = **not listed**. |
| `soldCount` | Lifetime sales. `0` today. First non-zero value is our first revenue. |
| `role` | `2` = ASP (Agent Service Provider). |

Quick one-liner for a scripted check:

```bash
onchainos agent get-agents --agent-ids 2632 \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['data'][0]; print(d['approvalLabel'], '| status', d['status'], '| sold', d['soldCount'])"
```

---

## 2. Known drift: the live listing is NOT our current catalog

Last confirmed 2026-07-10 (service-list read needs the login session in §0 above; re-run once
logged in to refresh this). The listing carried the **old, rejected** service set: **7**
services vs. our catalog module [`api/_lib/okx-catalog.js`](../../api/_lib/okx-catalog.js)'s
**11**, not one name matching.

```bash
onchainos agent service-list --agent-id 2632   # → data[0].total = 7 (as of 2026-07-10)
```

| Live on the listing (7, as of 2026-07-10) | Our catalog module (11) |
| --- | --- |
| Text & Image to 3D Model | Agent Identity Studio |
| Video to 3D Scene Capture | Text to 3D Model (GLB) |
| Auto-Rig Skeleton Builder | Text to 3D Model (Pro) |
| Universal Animation Retarget | Image to 3D Model |
| Masked Texture Repaint | Auto-Rig a GLB |
| Mesh Repair & Format Export | Text to Rigged Avatar |
| Mesh Part Segmentation | Animation Retarget |
| | Pose Seed |
| | FBX Export (rig-preserving) |
| | 3D Studio Catalog (free) |
| | 3D Studio Health (free) |

This is expected: **WO-05 (relisting) has never run**, because it is hard-gated on WO-04.
Nothing is broken, but do not read the live listing as a description of what we sell today.
The catalog module is the source of truth; the listing is stale until WO-05 executes. Note
also that the catalog's listing strings were rewritten 2026-07-17 (`f68ce55bb`) to match OKX's
documented description format (numbered "Provide: 1. ... 2. ..." lists, no tech jargon, no
price-in-name), verify against the CURRENT `api/_lib/okx-catalog.js`, not the table above,
which mirrors the module as of 2026-07-10.

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

**Wallet balances re-checked live 2026-08-01, block 66852405 (X Layer RPC `rpc.xlayer.tech`,
direct `eth_call` on `balanceOf` + `eth_getBalance`). Unchanged since 2026-07-23, and the
live 402's `payTo` was re-probed the same day and had NOT drifted again:**

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
real settlements with transaction hashes. **Only then** does WO-05 (resubmission) unlock.

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
   onchainos agent get-agents --agent-ids 2632     # status should leave 2 ("not listed")
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

1. **Capture the exact reason.** Check `approvalRemark` first, then the `claude@three.ws`
   inbox, the 2026-07-04 rejection came by email with `approvalRemark` empty, so assume the
   email is authoritative.
   ```bash
   onchainos agent get-agents --agent-ids 2632 \
     | python3 -c "import json,sys; print(repr(json.load(sys.stdin)['data'][0]['approvalRemark']))"
   ```
2. **Append the verbatim remark to `okx-ai-PROGRESS.md`** with the date. Never paraphrase a
   reviewer.
3. **Map the reason to the work order that owns it**, fix there, and re-run
   [`okx-ai-05-relisting-resubmission.md`](okx-ai-05-relisting-resubmission.md). Precedent:
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

## 6. First-sale operations

| What | How |
| --- | --- |
| Did we sell? | `onchainos agent get-agents --agent-ids 2632` → `soldCount` |
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
this before any submission:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  https://three.ws/api/okx/3d/identity-studio     # expect 402
```

---

## 8. Live review monitoring

Do not leave a daemon running. When the human wants to watch the review in real time, they
invoke the `okx-task-watch` skill, which polls the task/chat surface and surfaces reviewer
messages. Agents should check status once per session with §1 and stop there.
