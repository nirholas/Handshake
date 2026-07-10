# Embody — give your agent a 3D body in one paid call

`POST /api/x402/embody` is the only embodiment endpoint in the x402 ecosystem.
An agent on any framework pays **$1 USDC** and gets back an embeddable, animated,
voiced 3D presence: a rigged GLB, a durable persona that reloads by id in any
future session, a voice, and a copy-paste `<iframe>` embed for any website.

No account, no wallet setup beyond the x402 payment itself, no API key.

## Why this exists

The three.ws thesis is that every AI agent should have a body. Until now that
capability lived behind the web UI and the MCP server. Embody puts it on the open
x402 rail: any autonomous agent can buy itself a face, drop the embed on its
site, and be seen — in a single HTTP call.

## The call

```
POST https://three.ws/api/x402/embody
```

Body:

| Field | Required | Notes |
| ----- | -------- | ----- |
| `name` | yes | Display name, ≤64 chars. |
| `prompt` | one of | Text description of the body to generate. |
| `image_url` | one of | A reference image URL to reconstruct into 3D. Provide **exactly one** of `prompt` / `image_url`. |
| `personality` | no | Flavor text stored on the persona, ≤600 chars. |
| `voice` | no | A TTS voice id (see `GET /api/tts/voices`). Defaults to `nova`. |

Response (`200`):

```json
{
  "agent_id": "persona_8f2a1c9d4b",
  "glb_url": "https://…/personas/persona_8f2a1c9d4b.glb",
  "viewer_url": "https://three.ws/viewer?src=…",
  "profile_url": "https://three.ws/embodiment/embed?persona=persona_8f2a1c9d4b",
  "embed_html": "<iframe src=\"https://three.ws/embodiment/embed?persona=persona_8f2a1c9d4b\" width=\"480\" height=\"640\" …></iframe>",
  "reload_url": "https://three.ws/api/mcp3d/persona?id=persona_8f2a1c9d4b",
  "voice": "nova",
  "rigged": true,
  "name": "Nova Scout"
}
```

- **`agent_id`** is a durable persona id. Reload the exact same body in any future
  session with `GET /api/mcp3d/persona?id=<agent_id>` (`reload_url`).
- **`embed_html`** is the real one-tag embed — drop it into any page and the body
  renders, idles, lip-syncs, and emotes (the same embodiment component the 3D
  Studio uses).
- **`profile_url`** is the hosted presence page the iframe frames.
- **`rigged`** is `true` when the auto-rig succeeded. A model that can't be
  skeleton-rigged (e.g. a non-humanoid prop) falls back to the un-rigged mesh and
  `rigged` is `false` — never a broken T-pose.

## Payment & failure semantics

Embody is **synchronous and settles on delivery**. The generate → rig → persona
chain runs inside the single paid request, and payment is captured only when a
finished body is returned. If generation times out or fails, the payment is
verified but **never settled** — you are not charged for a body you didn't get.
This is a deliberate, more consumer-fair reading than a submit-then-poll job:
there are no orphaned paid jobs, and the returned bundle is complete on the one
call. Because the chain is real GPU work, allow up to a few minutes for the
response.

## Example

```bash
# 1. Unpaid call returns a 402 challenge with the accepts[] (Solana + Base).
curl -si https://three.ws/api/x402/embody \
  -H 'content-type: application/json' \
  -d '{"name":"Nova Scout","prompt":"a friendly explorer robot in a teal jumpsuit","voice":"nova"}'

# 2. Settle the challenge with your x402 client (see docs/x402-buyer.md), then
#    re-send with the X-PAYMENT header. On success you get the bundle above.
#
# 3. Reload the body later by id:
curl -s "https://three.ws/api/mcp3d/persona?id=persona_8f2a1c9d4b"

# 4. Drop the returned embed_html into any web page — the avatar renders and idles.
```

## What it reuses

Embody is a thin, honest wire over pieces that already exist — no new pipeline:

- the free NVIDIA TRELLIS **generate → auto-rig** chain the 3D Studio runs
  (`api/_mcp-studio/forge-client.js`);
- the durable **persona store** behind the embodiment embed
  (`api/_lib/persona-store.js`), so the body survives the provider URL expiring
  and reloads by id;
- the hosted **embodiment embed** page that lip-syncs and emotes.

## Related

- [Live embodiment](./mcp-studio.md) — the 3D Studio tools that persist and drive a body in chat.
- [x402 Paid Endpoints](./x402-endpoints.md) — the full paid catalog and pricing.
- [x402 Buyer Client](./x402-buyer.md) — how to settle a 402 challenge from code.
- [Avatar creation](./avatar-creation.md) — generate a rigged avatar in the web UI.
