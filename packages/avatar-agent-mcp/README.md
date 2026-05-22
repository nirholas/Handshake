# 3D AI Agent Avatar

> **The MCP server for 3D + AI agents.** Inspect, validate, and optimize any GLB. Spawn a textured 3D avatar with a Solana wallet, a voice, and full pump.fun powers — including atomic Jito-bundled launches and creator-fee collection.

[![npm](https://img.shields.io/npm/v/%40three-ws%2Favatar-agent?style=flat-square&color=9945FF)](https://www.npmjs.com/package/@three-ws/avatar-agent)
[![license](https://img.shields.io/badge/license-MIT-14F195?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-9945FF?style=flat-square)](https://nodejs.org)
[![mcp](https://img.shields.io/badge/Model%20Context%20Protocol-✓-9945FF?style=flat-square)](https://modelcontextprotocol.io)

Registry name: **`io.github.three-ws/3D-AI-Agent-Avatar`** · npm: **`@three-ws/avatar-agent`**

A single MCP server that's two things at once:

1. **A general-purpose 3D toolkit** — `inspect_glb`, `validate_glb`, `optimize_glb`, `viewer_url` work on **any** GLB/glTF model, no avatar required. Powered by `@gltf-transform/core` + Khronos's official `gltf-validator`.
2. **A full 3D agent in a box** — spawn a textured GLB avatar, give it a voice (OpenAI TTS), a Solana wallet, and pump.fun trading powers (Jupiter swaps, atomic Jito-bundled launches, creator-fee collection).

Install it once. Your Claude / Cursor / Continue / Cline can now:

- **Inspect any GLB** — meshes, materials, textures, animations, bounding box, vertex + triangle counts.
- **Validate any GLB** against the Khronos glTF 2.0 spec (the same engine behind gltf.report).
- **Optimize a GLB** — dedup, prune, weld, Draco-compress; get the smaller file back inline.
- **Build a viewer URL** for any GLB so humans see it in WebGL with one click.
- **Spawn a 3D avatar** from the curated defaults (`default`, `cz`) or any GLB URL.
- **Dress it** — hats, glasses, earrings, poses.
- **Generate a fresh avatar** from a text prompt via Replicate (Hunyuan-3D).
- **Give it a voice** — OpenAI TTS, 11 voices.
- **Hand it a Solana wallet** — vanity-grind a `three…` address in milliseconds.
- **Read live pump.fun data** — Jupiter price, Dexscreener volume, pump.fun meta, holders.
- **Buy any token** — Jupiter swap, optionally inside a sniper-resistant Jito bundle.
- **Launch a coin atomically** — separate funder + creator wallets, both txs in the same block.
- **Collect creator fees atomically** — collect + drain to a safe wallet in one tx.
- **Resolve names** — ENS (`.eth`) and SNS (`.sol`).

Built and maintained by [three.ws](https://three.ws). Atomic pump.fun pieces are ported from [nirholas/atomic](https://github.com/nirholas/atomic).

---

## Quick start (Claude Desktop / Cursor / Continue)

Add this to your MCP config:

```json
{
	"mcpServers": {
		"3d-ai-agent-avatar": {
			"command": "npx",
			"args": ["-y", "@three-ws/avatar-agent"],
			"env": {
				"SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com",
				"OPENAI_API_KEY": "sk-...",
				"THREE_MINT": "<the $three CA on pump.fun>"
			}
		}
	}
}
```

Restart your client. Ask it: **"Inspect https://three.ws/avatars/cz.glb, then spawn CZ, give him shades, and read me the latest snapshot for $three."**

---

## Two 30-second demos

### 3D toolkit demo (no avatar required)

```
You ▸ Inspect this GLB: https://three.ws/avatars/cz.glb — how many triangles?
      Then validate it against the Khronos spec and optimize it with Draco.
```

Runs:
1. `inspect_glb({ url })` → mesh/material/animation breakdown + triangle count + bbox
2. `validate_glb({ url })` → official Khronos report
3. `optimize_glb({ url, draco: true })` → dedup → prune → weld → Draco, returns the smaller GLB inline

### Avatar agent demo

```
You ▸ Spawn cz, give him shades, mint him a "three"-prefixed wallet,
     pull a snapshot of $three, and have him say "we're so back."
```

Behind the scenes the MCP runs:

1. `spawn_avatar({ preset: "cz", voice: "onyx" })` → returns a `sessionId` + viewer URL
2. `dress_avatar({ sessionId, accessoryIds: ["glasses-shades"] })`
3. `wallet_create({ sessionId, vanityPrefix: "three" })` → base58 pubkey starting with `three…`
4. `pump_snapshot({ token: "three" })` → live Jupiter price, Dexscreener volume, holders
5. `speak({ sessionId, text: "we're so back" })` → mp3 base64 the client plays

---

## Tool surface (20 tools)

### 3D toolkit (works on any GLB)
| Tool | What it does |
|---|---|
| `inspect_glb` | Mesh / material / animation / skin breakdown + bounding box + vertex & triangle counts. `@gltf-transform/core`. |
| `validate_glb` | Run Khronos's official `gltf-validator` on a GLB; errors, warnings, infos, hints with JSON pointers. |
| `optimize_glb` | Dedup → prune → weld → optional Draco. Returns optimized bytes inline + before/after sizes. |
| `thumbnail_glb` | **Render any GLB to a PNG** via three.ws's hosted three-light rig + auto-framing camera. Same pipeline as OG cards. Returns base64 PNG inline. |
| `viewer_url` | Build a `three.ws/viewer?...` URL + ready-to-paste iframe snippet for any GLB or avatar session. Supports background, auto-rotate, camera preset OR explicit orbit, AR mode, dimensions. |

### Avatar
| Tool | What it does |
|---|---|
| `list_avatars` | Catalog of default GLB avatars (`default`, `cz`), accessories, and pose presets. |
| `list_animations` | Live fetch of three.ws's 24 pose presets (T-pose, wave, thinker, jump, dance, warrior2, …) grouped by category. |
| `spawn_avatar` | Create an avatar session from a preset or custom GLB URL. Returns `sessionId`. |
| `dress_avatar` | Apply accessories + pose to a session. |
| `render_avatar` | **Render a posed avatar to a PNG** — pose preset + camera orbit (theta/phi/radius) + ARKit-52 facial expression. Same rig + lighting as the three.ws customizer's save-snapshot. |
| `generate_avatar` | Text/image-to-3D via Replicate. New session preloaded with the generated GLB. |

### Voice
| Tool | What it does |
|---|---|
| `speak` | OpenAI TTS — synthesize speech in the avatar's voice. Returns base64 audio. |

### Wallet
| Tool | What it does |
|---|---|
| `wallet_create` | Generate a Solana keypair. Optional vanity grinder (`vanityPrefix: "three"`). |
| `wallet_balance` | Read SOL + all SPL token balances (incl. Token-2022). |
| `wallet_send` | Send SOL on mainnet. **Execution action.** |

### pump.fun
| Tool | What it does |
|---|---|
| `pump_snapshot` | Live market snapshot: price, volume, holders, meta. Pass `target: "three"` for $three. |
| `pump_buy` | Jupiter swap, direct or **Jito-bundled** (funder→buyer transfer + swap atomic). **Execution action.** |
| `pump_launch` | **Atomic launch** via Jito bundle: separate funder + creator wallets, both txs same block. Uploads metadata to pump.fun IPFS if no URI is supplied. **Execution action.** |
| `pump_collect_fees` | **Atomic collect**: `collectCoinCreatorFee` + drain to safe wallet in one tx inside a Jito bundle — leaked-creator-key resistant. **Execution action.** |

### Identity
| Tool | What it does |
|---|---|
| `ens_sns_resolve` | Resolve `.eth` (ENS) and `.sol` (Bonfida SNS) names to addresses with reverse + favorite-domain lookups. |

---

## Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `SOLANA_RPC_URL` | All Solana ops | Defaults to `https://api.mainnet-beta.solana.com`. Bring your own (Helius/QuickNode/Triton) for production. |
| `ETH_RPC_URL` | `ens_sns_resolve` | Optional — falls back to ethers' default public providers. |
| `HELIUS_API_KEY` | `pump_snapshot` (enhanced) | Adds exact supply + DAS data. |
| `OPENAI_API_KEY` | `speak` | Used directly against `api.openai.com/v1/audio/speech`. |
| `REPLICATE_API_TOKEN` | `generate_avatar` | |
| `REPLICATE_TEXT_TO_AVATAR_MODEL` | `generate_avatar` | Pin a commercial-OK version, e.g. latest `tencent/hunyuan-3d-3.1`. |
| `SOLANA_SECRET_KEY` | `wallet_send` / `pump_buy` default signer | Per-call `secret` args override. Treat like cash. |
| `THREE_MINT` | `pump_snapshot` / `pump_buy` shorthand | Set so tools accept `target: "three"`. |

---

## Atomic pump.fun, briefly

The `pump_launch` and `pump_collect_fees` tools wrap the pattern from [nirholas/atomic](https://github.com/nirholas/atomic). Two things matter:

**Launch:** the create tx's `payerKey` is the **creator** wallet, not the funder — so the on-chain `creator` field (which receives pump.fun creator fees forever) is the creator wallet. But the creator doesn't need to hold SOL: the funder transfers rent + tip in Tx1 of the same Jito bundle. Either both land or neither does.

**Collect:** even if a creator key is shared / leaked, the collect-and-drain runs as a single tx inside a Jito bundle. No competing collector can interleave a tx between `collectCoinCreatorFee` and the drain, even with the same key.

If you start hitting `Bundles must write lock at least one tip account`, the [Jito tip account list](https://docs.jito.wtf/) has rotated — refresh `src/lib/jito.js`.

---

## Running locally

```bash
npm install @three-ws/avatar-agent
npx three-avatar-agent             # MCP stdio server
npx @modelcontextprotocol/inspector npx three-avatar-agent   # GUI
```

Or clone this repo:

```bash
git clone https://github.com/nirholas/three.ws.git
cd three.ws/packages/avatar-agent-mcp
npm install
npm start
```

---

## Safety

`pump_buy`, `pump_launch`, `pump_collect_fees`, and `wallet_send` all execute real on-chain transactions and move real funds. The MCP makes no judgment about the input — if your client tells it to send 100 SOL to a random address with a valid signer, it will. Configure your client's tool-approval flow accordingly.

Secrets are never logged or persisted. Secrets returned by `wallet_create` are returned ONCE — store them yourself.

---

## License

MIT © 2026 three.ws

Powered by the [Model Context Protocol](https://modelcontextprotocol.io), the [@nirholas/pump-sdk](https://www.npmjs.com/package/@nirholas/pump-sdk), and Jito's [Block Engine](https://docs.jito.wtf/).
