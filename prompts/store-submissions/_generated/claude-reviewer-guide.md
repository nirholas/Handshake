# Claude Connectors — reviewer setup & verification guide

**Connector:** three.ws 3D Agent — `io.github.nirholas/3d-agent-mcp`
**Package:** npm `@three-ws/mcp-server` (v1.2.2+) · **Transport:** stdio (MCP 2025-06-18)
**Surface:** 25 tools, measured live 2026-09-03 by `npm run audit:mcp-reviewer`: **5 free**
(`forge_free`, `vanity_premium`, `crypto_news`, `crypto_news_digest`, `crypto_news_archive`) +
**20 paid** (x402 USDC on Solana mainnet, `exact` scheme).

This guide lets someone with **zero prior context** verify the whole server: connect it, run
the free path, exercise the paid tools for real, and understand why the paid tools answer
`PaymentRequired` (that is expected, not a bug).

---

## 0. TL;DR for the reviewer

1. Add the connector (one command, no account, no wallet).
2. Call `forge_free` → get a real 3D GLB + viewer link, **free**. ✅ end-to-end proof.
3. Call any paid tool with no payment → a clean `PaymentRequired` (price, USDC-on-Solana,
   how to pay). This is the **designed** response. ✅ "behaves well when every tool is called".
4. To run paid tools **for real and free**, set the review entitlement (one env var) and call
   again → real results. ✅ paid surface verified without a funded wallet.

---

## 1. Connection

This is a **stdio** connector — there is **no remote URL and no OAuth login**. Paid calls are
authorized per-call by an x402 USDC micro-payment on Solana; account sign-in is not part of
this server. (If you are looking for an OAuth flow, there isn't one here — see §5.)

**Claude Code / Claude Desktop / Cursor:**

```bash
claude mcp add 3d-agent -- npx -y @three-ws/mcp-server
```

Or in an MCP client config:

```json
{
  "mcpServers": {
    "3d-agent": { "command": "npx", "args": ["-y", "@three-ws/mcp-server"] }
  }
}
```

No environment variables are required to start the server or to run the free path. The server
boots with a built-in default payout address, so every paid tool advertises a valid
`PaymentRequired` out of the box.

---

> **Live-status note (2026-07-08).** A close-out re-audit of this prompt re-ran the free smoke
> test live and found the production free lane currently exceeding a reviewer client's
> patience window (90–100s) during degraded conditions, plus documented an architectural
> caveat on the review-mode entitlement below (real, working, but self-activatable on this
> stdio transport — low real exposure since most read tools proxy to already-public
> endpoints). **Re-run §2 immediately before filing the Claude submission** and treat a repeat
> hang as a P1. Full analysis: [`claude-tool-call-evidence.md` §"2026-07-08
> re-verification"](./claude-tool-call-evidence.md#2026-07-08-re-verification-prompt-02-close-out-audit).

## 2. Free smoke test (no auth, no payment) — do this first

Call **`forge_free`**:

```jsonc
// tool: forge_free
{ "prompt": "a friendly round robot mascot, glossy white plastic", "tier": "draft" }
```

Expected (~30–90s; the free NVIDIA NIM / Microsoft TRELLIS lane):

```json
{
  "ok": true, "free": true, "cost": "$0.00", "mode": "text_to_3d",
  "glbUrl": "https://pub-….r2.dev/forge/anon/<id>.glb",
  "preview": "https://three.ws/viewer?src=<encoded glbUrl>",
  "backend": "nvidia", "durable": true, "attempts": 1
}
```

- Open `preview` in a browser → the model renders in the three.ws `<model-viewer>`.
- A verified-real example produced during review:
  https://three.ws/viewer?src=https%3A%2F%2Fpub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev%2Fforge%2Fanon%2Fa620d14f-a83d-43fe-8c0f-c87a46042933.glb

**Reliability note.** If the NVIDIA lane is momentarily cold, `forge_free` may report
`backend:"huggingface"`; it retries to prefer a **durable** result and verifies the URL is
reachable before returning it, so you never get a dead link. If the lane is fully degraded it
returns a clear `lane_degraded` error ("…try again shortly") — just call it again.

---

## 3. Calling the paid tools with no payment — what you'll see

Call any paid tool (e.g. `get_pose_seed` with `{ "prompt": "warrior stance" }`). With no
payment you get a structured **`PaymentRequired`** — this is the correct, expected response:

```json
{
  "isError": true,                       // x402 contract (see §5) — NOT a crash
  "structuredContent": {
    "x402Version": 2,
    "accepts": [{
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",  // Solana mainnet
      "amount": "1000",                  // atomic USDC (6 decimals) → $0.001
      "asset":  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      "payTo":  "wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU"
    }]
  },
  "content": [ /* the JSON envelope, plus a plain-language explanation of the price + how to pay */ ]
}
```

Every priced tool also states its price in its own description (e.g. *"Paid: $0.15 USDC"*) and
in `tools/list` under `pricing`/`extensions.bazaar`. Prices range from **$0.0005**
(`ens_sns_resolve`) to **$0.45** (`forge_avatar`). See
`claude-tool-call-evidence.md` for the full per-tool table (20/20 verified clean on 2026-09-03).

---

## 4. Funded review path — exercise paid tools for real (no wallet needed)

A connector reviewer can't mint x402 payments from a plain MCP host, so the server ships a
**server-side review entitlement**: when the server is started with a secret and the client
presents the matching value, paid tools run their **real handler with no charge** (real
results, no mock).

Set **both** env vars to the **same** secret value when adding the connector:

```bash
claude mcp add 3d-agent \
  -e MCP_REVIEW_SECRET=<token-from-private-reviewer-notes> \
  -e MCP_REVIEW_MODE=<same-token> \
  -- npx -y @three-ws/mcp-server
```

(The reviewer token is supplied in the **private reviewer notes** of the submission, not in
this repo. Review mode is **off** unless `MCP_REVIEW_SECRET` is set, so it can never be
abused on a normal install. Caveat: because this connector's transport is stdio, the "server"
and the caller are the same locally-spawned process — a technically inclined installer could
set both env vars to a matching value themselves. Real exposure is low: most read tools proxy
to already-public three.ws endpoints, and generation tools still require real vendor
credentials the self-activator won't have. See the evidence file for the full breakdown.)

With the entitlement active:

- **A read tool returns real data immediately** — e.g. `get_pose_seed`
  `{ "prompt": "warrior stance" }` →
  `{ "presetId": "fighting-stance", "seed": "6153fce51ebdb477", "previewUrl": "https://three.ws/pose?seed=…" }`.
- **`text_to_avatar`** `{ "prompt": "a cheerful cyberpunk fox in a red hoodie" }` → a real
  generated GLB URL + `preview` viewer link (Replicate / Hunyuan-3D). This requires the
  instance to carry the generation credentials (`REPLICATE_API_TOKEN`,
  `REPLICATE_TEXT_TO_AVATAR_MODEL`); the reviewer instance in the private notes has them set.
  Without those credentials the tool returns a **clean structured** `not_configured` error
  (never a crash).

**Alternative (pay for real with USDC).** If you prefer to test the actual payment rail, fund
a small Solana wallet with USDC and use an x402-capable client to attach an `exact` payment in
`_meta["x402/payment"]`; payments settle to the `payTo` in the challenge. Failed calls are
never billed. For directory review, the entitlement above is the simpler path.

---

## 5. What `PaymentRequired` / `isError: true` means (read this)

The paid tools are **transactional** (the directory allows this). When called without payment
they return a `PaymentRequired` result that carries `isError: true`. **This is not a failure
or a crash** — it is the [x402 MCP transport](https://x402.org) contract:

- The `isError: true` flag is **required** so an x402-capable client recognizes the challenge
  and auto-pays; the machine-readable terms live in `structuredContent` (`x402Version`,
  `accepts[]` with price, asset, network, `payTo`).
- For a human reader, each challenge also includes a plain-language line: *"Payment required —
  this is the EXPECTED response for a paid tool, not an error…"*.
- No payment is moved, nothing is broken, and the call can be completed by paying or by using
  the review entitlement (§4).

So "every tool returns either a real result or a clean `PaymentRequired`" is the intended,
correct behavior across the whole surface.

---

## 6. Expected output by tool category

| Category | Tools | Unpaid | Paid / review-mode result |
|---|---|---|---|
| **Free 3D** | `forge_free` | *n/a, always free* | real GLB URL + viewer link |
| **Free news** | `crypto_news`, `crypto_news_digest`, `crypto_news_archive` | *n/a, always free* | recent headlines / a digest / an archive search |
| **Free catalog** | `vanity_premium` | *n/a, always free* | the premium vanity listings and their prices |
| **3D generation** | `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, `refine_model`, `restyle_material` | clean `PaymentRequired` | GLB / rigged-GLB URL + `preview`/`poseStudioUrl` |
| **Pose** | `get_pose_seed` | clean `PaymentRequired` | preset id + seed + `previewUrl` on three.ws/pose |
| **Names** | `ens_sns_resolve` | clean `PaymentRequired` | resolved ENS/SNS address(es) |
| **Market data** | `pump_snapshot`, `sentiment_pulse`, `aixbt_intel`, `aixbt_projects` | clean `PaymentRequired` | live token/market/sentiment JSON |
| **Agents / reputation** | `agent_reputation`, `agent_delegate_action`, `agenc_list_tasks`, `agenc_get_task`, `agenc_get_agent` | clean `PaymentRequired` | on-chain reputation / AgenC task + agent reads |
| **Agent commerce** | `agent_hire_discover`, `agent_hire` | clean `PaymentRequired` | a reputation-ranked shortlist, then a delegated result with its settlement reference |
| **Solana utility** | `vanity_grinder` | clean `PaymentRequired` | a vanity Solana keypair/seed phrase (treat result as a secret) |

---

## 7. Verification checklist

- [ ] `claude mcp add 3d-agent -- npx -y @three-ws/mcp-server` connects; `tools/list` shows 25 tools.
- [ ] `forge_free` returns a real GLB URL; `preview` opens in a browser.
- [ ] Any paid tool, no payment → clean `PaymentRequired` (price + USDC-on-Solana + `payTo`), not a crash.
- [ ] Re-add with `MCP_REVIEW_SECRET`/`MCP_REVIEW_MODE` (token from private notes); `get_pose_seed` returns real data; `text_to_avatar` returns a real GLB (credentialed reviewer instance).
- [ ] No tool returns an unexplained error or stack trace.

Full captured transcript: [`claude-tool-call-evidence.md`](./claude-tool-call-evidence.md).
