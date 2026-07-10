# OKX.AI Operator Runbook — agent #2632 "three.ws 3D Studio"

The operator's guide for launch day and the days before it. Written for a zero-context
human or agent: every command below was run from this repo and its real output recorded.

- **Shared facts:** [`00-CONTEXT.md`](00-CONTEXT.md) (agent id, wallets, chain, CLI).
- **Full history:** [`PROGRESS.md`](PROGRESS.md).
- **Public docs:** [`docs/okx-marketplace.md`](../../docs/okx-marketplace.md), [`specs/okx-agent-payments.md`](../../specs/okx-agent-payments.md).

**CLI:** `onchainos` v4.2.0+ at `~/.local/bin/onchainos`. The read commands below need no
login. Every **write** (update, activate, resubmit) requires an email-OTP login as
`claude@three.ws` — a human must read the code from that inbox. Agents cannot complete a
write on their own.

---

## 1. Daily status check

One command. Run it, read three fields.

```bash
onchainos agent get-agents --agent-ids 2632
```

Verified output (2026-07-10):

```json
{ "agentId": "2632", "approvalDisplayStatus": 5, "approvalLabel": "Listing rejected",
  "approvalRemark": "", "status": 2, "soldCount": 0, "role": 2 }
```

### Reading the fields

| Field | Meaning |
| --- | --- |
| `approvalDisplayStatus` | Review state. `5` = **Listing rejected** (our current state). The CLI also returns `approvalLabel`, the human string — **trust `approvalLabel` over memorising numbers**; the numeric map is OKX's and is not documented publicly. |
| `approvalLabel` | Same state as text: `"Listing rejected"`, `"Listing approved"`, `"Under review"`. |
| `approvalRemark` | The reviewer's stated reason. **Currently empty** — the 2026-07-04 rejection reason arrived only by email, not through this field. Do not assume a rejection reason will appear here. |
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

Verified 2026-07-10. The listing still carries the **old, rejected** service set. It has
**7** services; our catalog module [`api/_lib/okx-catalog.js`](../../api/_lib/okx-catalog.js)
defines **11**, and **not one name matches**.

```bash
onchainos agent service-list --agent-id 2632   # → data[0].total = 7
```

| Live on the listing (7) | Our catalog module (11) |
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
Nothing is broken — but do not read the live listing as a description of what we sell today.
The catalog module is the source of truth; the listing is stale until WO-05 executes.

---

## 3. The one blocker: settlement funding

Everything else is code-complete. The rail reports `settleable: true` in production, but no
funded call has ever settled on-chain — the payer wallet is empty, so real attempts return
`insufficient_balance`.

**To unblock, the owner funds one wallet:**

| | |
| --- | --- |
| Wallet (payer + seller) | `0x75d00a2713565171f33216e5aa2a375e076ecf69` |
| Chain | X Layer, chainId **196** (`eip155:196`) |
| Token | `0x779ded0c9e1022225f8e0630b35a9b54be713736` |
| Amount | ~$5 of the fee token, plus OKB dust for gas |

Once funded, run [`04-e2e-real-payment-test.md`](04-e2e-real-payment-test.md). It needs ≥3
real settlements with transaction hashes. **Only then** does WO-05 (resubmission) unlock.

Until a real settlement exists, `docs/okx-marketplace.md` must not claim observed on-chain
settlement — its "Payment semantics" section states the contract as implemented and
unit-tested, with an explicit note that no funded settlement has occurred. Keep that note
until the first tx hash lands, then update both that section and `PROGRESS.md`.

---

## 4. Branch: **APPROVED** (`approvalLabel: "Listing approved"`)

This is the holder-visible moment. Work the list top to bottom.

1. **Confirm the listing is live and activated.**
   ```bash
   onchainos agent get-agents --agent-ids 2632     # status should leave 2 ("not listed")
   onchainos agent service-list --agent-id 2632    # services present, prices correct
   ```
   Reconcile the service names against `api/_lib/okx-catalog.js` — see §2. If they still
   differ, WO-05 did not take; re-run it before announcing.

2. **Search as a buyer would.** We must actually appear:
   ```bash
   onchainos agent search --query "3D avatar rigging GLB"
   ```
   Verified 2026-07-10: returns 2 results, **agent 2632 absent** (correct — we are not
   listed). After approval this must return us. Check the card copy reads well and the
   prices are right.

3. **Announce it.** Append an entry to [`data/changelog.json`](../../data/changelog.json)
   with tag `feature`, in plain holder-readable language, then:
   ```bash
   npm run build:pages          # validates the entry; fails the build if malformed
   npm run changelog:push       # Telegram  (needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHANGELOG_CHAT_ID)
   npm run changelog:push:x     # X / @trythreews — the primary holder channel
   ```
   Both push scripts accept `--dry-run`. They skip silently when credentials are absent.

4. **Set the agent's own avatar live** if WO-06's dogfood upload was deferred (it was — the
   asset is generated but never written on-chain). This is an on-chain write: OTP required.

5. **Record it.** Append the approval, the date, and the first listing screenshot/output to
   `PROGRESS.md`.

---

## 5. Branch: **REJECTED AGAIN** (`approvalDisplayStatus: 5`)

1. **Capture the exact reason.** Check `approvalRemark` first, then the `claude@three.ws`
   inbox — the 2026-07-04 rejection came by email with `approvalRemark` empty, so assume the
   email is authoritative.
   ```bash
   onchainos agent get-agents --agent-ids 2632 \
     | python3 -c "import json,sys; print(repr(json.load(sys.stdin)['data'][0]['approvalRemark']))"
   ```
2. **Append the verbatim remark to `PROGRESS.md`** with the date. Never paraphrase a
   reviewer.
3. **Map the reason to the work order that owns it**, fix there, and re-run
   [`05-relisting-resubmission.md`](05-relisting-resubmission.md). For reference, the
   2026-07-04 rejection ("your A2MCP service has not been integrated with the OKX Agent
   Payments Protocol standard") was owned by the payment rail, now implemented in
   [`api/_lib/x402-xlayer-okx.js`](../../api/_lib/x402-xlayer-okx.js).

---

## 6. First-sale operations

| What | How |
| --- | --- |
| Did we sell? | `onchainos agent get-agents --agent-ids 2632` → `soldCount` |
| What did buyers say? | `onchainos agent feedback-list` (verified present: "Query Agent reviews") |
| Where does revenue land? | The agent wallet `0x75d0…cf69` on X Layer (196) — the same wallet that pays. Confirm the first payout against the settlement tx hash from WO-04. |
| Where do errors surface? | The existing error-reporting path in [`api/_mcp/payments.js`](../../api/_mcp/payments.js); paid-endpoint failures answer **before** settlement, so a failed job never charges a buyer. |
| Daily watch | `soldCount`, `approvalLabel`, and the paid-endpoint health/catalog free routes (§7). |

---

## 7. Free routes worth probing any day

These need no payment, no key, and no login — they are the fastest signal that the surface
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
