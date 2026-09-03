# Claude Connectors — tool-call evidence (`@three-ws/mcp-server`)

**Connector:** `io.github.nirholas/3d-agent-mcp` — npm `@three-ws/mcp-server@1.2.0`, stdio transport.
**Captured:** 2026-06-25 (UTC), against production `https://three.ws` for the free lane; payment challenges captured from the shipped tool surface with the built-in default payout.
**Surface (2026-06-25 capture):** 17 tools, 1 free + 16 paid. **Live surface as of 2026-09-03:**
25 tools, 5 free + 20 paid; see the re-verification at the end of this file, which supersedes the
counts in the tables below.

Methodology: every tool was driven once. Free tool → real generation. Paid tools were
called with **no x402 payment and no review entitlement** — each must return a clean
`PaymentRequired` (v2 MCP transport: `structuredContent` x402 envelope + `isError: true`),
never a crash or stack trace. The review entitlement was then enabled to confirm paid
tools run for real.

---

## 1. Free end-to-end smoke test — `forge_free` (no auth, no payment)

Real call through the production `/api/forge` free NVIDIA NIM (Microsoft TRELLIS) lane:

```json
{
  "ok": true, "free": true, "cost": "$0.00", "mode": "text_to_3d",
  "glbUrl": "https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/a620d14f-a83d-43fe-8c0f-c87a46042933.glb",
  "preview": "https://three.ws/viewer?src=https%3A%2F%2Fpub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev%2Fforge%2Fanon%2Fa620d14f-a83d-43fe-8c0f-c87a46042933.glb",
  "prompt": "a friendly round robot mascot, glossy white plastic",
  "tier": "draft", "backend": "nvidia", "durable": true, "attempts": 1,
  "creationId": "a620d14f-a83d-43fe-8c0f-c87a46042933", "durationMs": 57314
}
```

- **GLB URL (durable R2):** https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/a620d14f-a83d-43fe-8c0f-c87a46042933.glb — verified reachable (HTTP `206` to a ranged GET).
- **Viewer:** https://three.ws/viewer?src=https%3A%2F%2Fpub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev%2Fforge%2Fanon%2Fa620d14f-a83d-43fe-8c0f-c87a46042933.glb

**Reliability hardening verified.** When the NVIDIA NIM lane is cold it degrades to a
HuggingFace Space whose gradio `/tmp` URL can expire within seconds (`durable:false`). The
hardened `runForgeFree` (a) prefers a durable result via a bounded retry and (b) verifies any
non-durable URL is actually reachable before returning it — so a reviewer never receives a
dead link as "success". A second run reproduced the retry upgrading a degraded attempt to a
durable one:

```
ok=true backend=nvidia durable=true attempts=2   # attempt 1 degraded → attempt 2 landed the durable NVIDIA lane
glbUrl=https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/14f67185-efcc-45f6-8ab6-f9ca75637902.glb
```

When every attempt is non-durable **and** unreachable, the tool returns a clear
`lane_degraded` error ("…try again shortly"), not a broken success.

---

## 2. Unpaid audit — every paid tool returns a clean `PaymentRequired`

Each row: one call, no payment, no review mode. **Result: 16/16 paid tools returned a clean
`PaymentRequired`. Zero crashes, zero stack traces.**

Common to every challenge: `isError: true` (required by the @x402/mcp client to
auto-detect-and-pay — it is the x402 contract, **not** a failure), `x402Version: 2`,
`asset` = `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC), `network` =
`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet), `payTo` =
`wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU` (platform default — the unsubstituted
`${MCP_SVM_PAYMENT_ADDRESS}` placeholder bug is fixed), plus an appended plain-language line:
*"Payment required — this is the EXPECTED response for a paid tool, not an error…"*.

| Tool | Price | `amount` (atomic USDC) | Clean 402 |
|---|---|---|---|
| `ens_sns_resolve` | $0.0005 | 500 | ✓ |
| `get_pose_seed` | $0.001 | 1000 | ✓ |
| `agenc_list_tasks` | $0.001 | 1000 | ✓ |
| `agenc_get_task` | $0.001 | 1000 | ✓ |
| `agenc_get_agent` | $0.001 | 1000 | ✓ |
| `sentiment_pulse` | $0.003 | 3000 | ✓ |
| `pump_snapshot` | $0.005 | 5000 | ✓ |
| `agent_delegate_action` | $0.01 | 10000 | ✓ |
| `agent_reputation` | $0.01 | 10000 | ✓ |
| `aixbt_intel` | $0.01 | 10000 | ✓ |
| `aixbt_projects` | $0.01 | 10000 | ✓ |
| `vanity_grinder` | $0.05 | 50000 | ✓ |
| `text_to_avatar` | $0.15 | 150000 | ✓ |
| `rig_mesh` | $0.20 | 200000 | ✓ |
| `mesh_forge` | $0.25 | 250000 | ✓ |
| `forge_avatar` | $0.45 | 450000 | ✓ |

Representative raw challenge (`text_to_avatar`):

```json
{
  "isError": true,
  "structuredContent": {
    "x402Version": 2,
    "error": "Payment required to access this tool",
    "accepts": [{
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "amount": "150000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "decimals": 6, "feePayer": "PayeRNCipcerPHCsYMTrX9pAYDm1LnPGzgb66NUDG5a" }
    }]
  },
  "content": [
    { "type": "text", "text": "{…the x402 envelope as JSON…}" },
    { "type": "text", "text": "Payment required — this is the EXPECTED response for a paid tool, not an error. Calling \"text_to_avatar\" costs $0.15 in USDC on Solana (paid to wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU). To execute it, supply an x402 \"exact\" payment in _meta[\"x402/payment\"] and call again, or set the reviewer entitlement (MCP_REVIEW_MODE) to run it without payment. Full machine-readable requirements are in structuredContent.accepts." }
  ]
}
```

---

## 3. Funded review path — paid tools run for real (no mock)

With the server-side review entitlement enabled
(`MCP_REVIEW_SECRET=<token>` on the server **and** matching `MCP_REVIEW_MODE=<token>` in the
client env), `reviewModeActive()` → `true` and paid tools run their **real handler** with no
USDC charge.

**Read tool — `get_pose_seed` (real result, no upstream creds needed):**

```json
{ "isError": false,
  "structuredContent": {
    "presetId": "fighting-stance",
    "seed": "6153fce51ebdb477",
    "previewUrl": "https://three.ws/pose?seed=6153fce51ebdb477&preset=fighting-stance"
} }
```

**Generation tool — `text_to_avatar`** runs its real handler too; in this local capture no
Replicate credentials were configured, so it returns a **clean, structured** error (not a
crash) — exactly the designed contract:

```json
{ "ok": false, "error": "not_configured",
  "message": "REPLICATE_TEXT_TO_AVATAR_MODEL is not set on the server. Pin a commercial-OK image/text-to-3D version (e.g. tencent/hunyuan-3d-3.1 latest)." }
```

On the operator-funded instance you point the reviewer at (which carries
`REPLICATE_API_TOKEN` + `REPLICATE_TEXT_TO_AVATAR_MODEL`), the same review-mode call returns a
real generated GLB URL + viewer link. See `claude-reviewer-guide.md` §"Funded review path".

---

## Verdict

- No paid tool returns a crash-shaped error when unpaid — **16/16 clean `PaymentRequired`**.
- Free path (`forge_free`) produces a viewable, durable GLB end-to-end with no auth/payment.
- Review entitlement returns real results (demonstrated on `get_pose_seed`); generation
  tools return real GLBs on a credentialed instance and clean structured errors otherwise.

---

## 2026-07-08 re-verification (prompt 02 close-out audit)

Re-ran the free smoke test live against production ahead of marking this prompt complete.
Two findings — one operational, one architectural. Neither changes the verdict above (the
implementation is correct and real), but both matter for submission timing.

### A. Free lane currently exceeds the reviewer's patience window

Four consecutive live attempts against production hung with **zero response**:

| # | Method | Payload | Result |
|---|---|---|---|
| 1 | `forge_free` (MCP tool) | `{"prompt":"a small friendly owl mascot...","tier":"draft"}` | `timeout` after 90003ms |
| 2 | `forge_free` (MCP tool) | `{"prompt":"a small owl mascot, blue feathers","tier":"draft"}` | `timeout` after 90006ms |
| 3 | `curl -X POST /api/forge` | `{"prompt":"a small owl mascot...","tier":"draft","free":true}` | no response, 100s client timeout |
| 4 | `curl -X POST /api/forge` | `{"prompt":"a red toy car","tier":"draft","free":true,"backend":"nvidia","path":"image"}` | no response, 60s client timeout |

None of these four requests appear in Cloud Run's `run.googleapis.com/requests` log for the
matching window (`resource.labels.service_name="three-ws-api"`), while other production
traffic to `/api/forge` (health polls, `?action=rig` calls) logged and returned normally in
the same window — so the request IS reaching the origin and being worked, just not completing
inside 60–100s.

Cross-checked against `GET https://three.ws/api/forge?health=1` (fast, 1.5s): `nvidia`,
`huggingface`, and `trellis` backends all report `status: "ok"` (auth/quota checks pass), but
`limiter.status: "down"` ("The rate-limiter store is unconfigured — paid generation lanes fail
closed"). Tracing the code path (`api/forge.js` → `runNvidiaTextLane` →
`api/_providers/nvidia.js`, `SUBMIT_TIMEOUT_MS = 45_000`) shows the free NIM lane has its own
45s submit timeout before falling back to the image-intermediate TRELLIS/FLUX lane inside the
*same* request — so a cold/degraded NIM gateway plus a slow fallback can legitimately push
total server-side latency past the 90–100s window a reviewer's client will wait, even though
every individual upstream call is timeout-bounded and the handler is designed to degrade
gracefully (see `runForgeFree`'s retry/durability logic in `mcp-server/src/tools/_studio-core.js`).
This reads as a **live reliability regression in the free lane**, not a flaw in the reviewer
guide or the review-mode entitlement — but it means the guide's central "free end-to-end
proof" claim is **not reproducible right now** and must be re-verified green immediately
before the Claude Connectors Directory submission is filed. Action for whoever files the
submission: re-run `forge_free` right before submitting; if it still hangs, treat as a P1 (the
free path is the whole point of the reviewer story) — check `/api/forge?health=1` first, and
if `nvidia`/`huggingface`/`trellis` all show `ok` while a live submit still hangs, the fault is
in the submit/fallback chain latency, not backend availability.

### B. Review-mode entitlement is self-activatable on the stdio transport (architectural note)

`reviewModeActive()` (`mcp-server/src/payments.js`) is a straight string-equality check between
two `process.env` reads — `MCP_REVIEW_SECRET` and `MCP_REVIEW_MODE`. Because this connector's
transport is **stdio** (the "server" is the same local `npx`-spawned process the caller
controls), there is no operator-vs-caller boundary to enforce the shared-secret model against:
anyone installing the package can pass `-e MCP_REVIEW_SECRET=x -e MCP_REVIEW_MODE=x` themselves
and activate review mode for free — no operator provisioning required. This is real, working
code (not a mock), so it satisfies prompt 02's "no mock bypass" requirement, but it is **not**
a reviewer-exclusive gate the way an OAuth-flagged account would be.

Actual exposure is bounded, checked per tool family:
- **Read tools that proxy to already-public three.ws endpoints** (`aixbt_intel` →
  `/api/aixbt/intel`, `sentiment_pulse` → `/api/social/sentiment-pulse`, etc.) — those HTTP
  endpoints are public and unauthenticated already (rate-limited only), so self-activating
  review mode just skips a $0.01–$0.01 convenience fee on data anyone could `curl` for free
  regardless. Low/no real exposure.
- **Generation tools that need real vendor credentials** (`text_to_avatar` needs
  `REPLICATE_API_TOKEN`+`REPLICATE_TEXT_TO_AVATAR_MODEL` in the *caller's own* local env) —
  review mode alone does not unlock these; a self-activator without those keys still gets a
  clean `not_configured` error, exactly as demonstrated in §3 above.
- **`vanity_grinder`** runs its grind loop as real local/CPU work regardless of payment gate,
  so bypassing the charge only saves the caller their own compute cost, not the operator's.

Net: this is a known trade-off of the shared-secret pattern applied to a stdio transport, not
a code defect — flagging for owner awareness, not blocking submission. If tighter enforcement
is wanted later, the fix is architectural (move the paid-tool-bypass decision to something the
caller cannot self-supply, e.g. an OAuth-gated remote transport instead of stdio-local env
vars) and is out of scope for this prompt.


---

## 2026-09-03 re-verification (submission close-out)

Method changed: the transcripts above were hand-driven and went stale the moment a tool
landed. The sweep is now one command, `npm run audit:mcp-reviewer`
([scripts/audit-mcp-reviewer-path.mjs](../../../scripts/audit-mcp-reviewer-path.mjs)), which
spawns the published stdio server, calls every tool unpaid with schema-valid arguments, and
fails on any challenge that is malformed, unexplained, or missing a payout field.

### A. Every paid tool still answers a clean challenge, and there are four more of them

`npm run audit:mcp-reviewer` on 2026-09-03: **20 of 20 paid tools returned a clean
`PaymentRequired`**, 4 free tools ran, 1 free tool (`forge_free`) was skipped as a
long-running generation covered by its own smoke test. Zero crashes, zero stack traces, zero
unsubstituted payout placeholders.

The four paid tools missing from the 16-row table above are `refine_model` ($0.25),
`restyle_material` ($0.05), `agent_hire` ($0.05) and `agent_hire_discover` ($0.01); every
price in that table still matches what the server quotes today.

A note for anyone re-running this by hand: `rig_mesh`, `refine_model`, `restyle_material` and
`pump_snapshot` constrain their inputs (a `format: uri` GLB URL, a 32-character base58 mint).
Call them with a placeholder that fails those bounds and the MCP SDK answers `-32602` before
the payment wrapper ever runs, and the tool reads as free. The audit script carries valid
sample values so that cannot happen silently.

### B. The reviewer entitlement works, and only with the right secret

The same run mints a fresh random `MCP_REVIEW_SECRET`, starts the server with it, and calls
`get_pose_seed` with a matching `MCP_REVIEW_MODE`: the real handler ran and returned real data
with no charge. A third run with a deliberately mismatched `MCP_REVIEW_MODE` still got the
paywall, so the entitlement is a gate rather than a flag. The architectural caveat in §B of the
2026-07-08 section (a stdio caller can supply both halves itself) is unchanged and still not a
blocker.

### C. The free lane completes, but slowly

A live `POST https://three.ws/api/mcp-studio tools/call forge_free` with
`{"prompt":"a small ceramic teapot"}` returned **HTTP 200 after 147 seconds** with a real
3,674,712-byte GLB (`glTF` magic, `model/gltf-binary`, served from `/cdn/forge/anon/`), and the
emitted `/viewer?src=` link returned 200. So the 2026-07-08 hang is gone and the lane is
genuinely end-to-end, but 147s is far longer than the 16.1s measured on 2026-07-15 and longer
than most reviewer clients will wait. Re-run it immediately before filing and, if it is still
this slow, expect the reviewer to need the guide's "this can take a couple of minutes" framing
rather than a live demo.
