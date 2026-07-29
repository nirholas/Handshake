# @three-ws/chat-plugin

Render an embodied 3D avatar in the **LobeChat** or **SperaxOS** sidebar. The avatar reacts to the LLM's tool calls — speaking, gesturing, and emoting — in real time.

SperaxOS is a LobeChat-lineage host: both platforms speak an identical plugin
protocol, differing only in the channel prefix (`lobe-chat:` vs `speraxos:`). This
package targets both. The primary, no-bundle integration is the **standalone
manifest** (a hosted iframe the host frames directly); this React component is for
hosts that mount a plugin via a bundled SDK component.

> **Designed icon:** [`/sperax/icon-256.svg`](../public/sperax/icon-256.svg) is the production avatar referenced by the manifests. `assets/icon-256.svg` remains as a local fallback.

---

## One-click install

### SperaxOS

1. Open **Plugins → Add Plugin → Custom Plugin** (or submit to the marketplace at `plugin.delivery`).
2. Paste the manifest URL:
    ```
    https://three.ws/.well-known/sperax-plugin.json
    ```
3. Click **Install**, then set your **Agent ID** (from `https://three.ws/dashboard`).
4. The avatar appears in the chat panel and reacts to the agent's tool calls.

### LobeChat (≥ 1.x)

1. In LobeChat, open **Plugins → Plugin Store → Custom plugins**.
2. Paste the manifest URL:
    ```
    https://three.ws/.well-known/chat-plugin.json
    ```
3. Click **Install**. LobeChat will show the plugin settings dialog.
4. Enter your **Agent ID** (UUID from the three.ws dashboard at `https://three.ws/dashboard`).
5. Click **Save**. The 3D avatar appears in the right sidebar.

---

## Configuration

| Setting     | Type     | Required | Default             | Description                            |
| ----------- | -------- | -------- | ------------------- | -------------------------------------- |
| `agentId`   | `string` | Yes      | —                   | Agent UUID from the three.ws dashboard |
| `apiOrigin` | `string` | No       | `https://three.ws/` | Override for self-hosted instances     |

---

## How it works

```
Host (LobeChat / SperaxOS)
  │  postMessage({ type: '<ns>:init-standalone-plugin',
  │               payload: { apiName, arguments }, settings })
  ▼
Standalone iframe — /sperax/iframe/  (boot.js)        ← primary path (no bundle)
  │  parses apiName + JSON.parse(arguments)
  ▼
<agent-3d> web component — avatar speaks / gestures / emotes
```

`<ns>` is `lobe-chat` or `speraxos`. When the LLM calls one of the plugin's tools
(`speak`, `gesture`, `emote`, `render_agent`), the host renders the manifest's
`ui.url` iframe and delivers the triggering function call to it by postMessage. The
iframe's `boot.js` parses the call and drives the `<agent-3d>` element. The host's
plugin gateway also POSTs the arguments to the function's `api[].url`
(`/api/chat-plugin/<tool>`) to obtain the concise tool result the model reads back.

The React `AgentPane` component (this package) follows the same contract for hosts
that mount a bundled sidebar component instead of framing the manifest iframe.

### Message format (verified)

Channel names are verified against `@lobehub/chat-plugin-sdk@1.32.x` and the Sperax
`AI-Plugin-Marketplace-SDK`. The host posts:

```json
{
	"type": "speraxos:init-standalone-plugin",
	"payload": {
		"identifier": "three-ws",
		"apiName": "speak",
		"arguments": "{\"text\":\"Hello!\",\"sentiment\":0.5}"
	},
	"settings": { "agentId": "<uuid>" }
}
```

`arguments` is a JSON **string**; `settings.agentId` binds the avatar. The same
shape applies with the `lobe-chat:` prefix on LobeChat. The iframe announces
readiness with `{ type: '<ns>:plugin-ready-for-render' }` so the host knows to
deliver the payload.

### Wire protocol (v1)

Bridge envelope:

```json
{
	"v": 1,
	"source": "agent-host",
	"id": "<uuid>",
	"inReplyTo": "<request-id>",
	"kind": "request | response | event",
	"op": "speak | gesture | emote | look | setAgent | ping | subscribe",
	"payload": {}
}
```

The envelope above plus the op table below are the full spec for this bridge.
Not to be confused with [`specs/EMBED_HOST_PROTOCOL.md`](../specs/EMBED_HOST_PROTOCOL.md),
the separate versioned postMessage bus between a host page and an embedded
three.ws iframe, which uses a different `v`/`type`/`payload` envelope.

---

## Available tool ops

| Op             | Payload                             | Description                           |
| -------------- | ----------------------------------- | ------------------------------------- |
| `render_agent` | `{ agentId }`                       | Swap the agent in the sidebar         |
| `speak`        | `{ text, sentiment? [-1,1] }`       | Avatar speaks with emotional valence  |
| `gesture`      | `{ name: wave\|nod\|point\|shrug }` | Trigger a named gesture               |
| `emote`        | `{ trigger, weight? [0,1] }`        | Inject emotion into the Empathy Layer |

---

## Dev harness

Two harnesses live in `chat-plugin/dev/`:

- **`sperax.html`** — drives `boot.js` with the **exact** standalone-plugin wire
  protocol (`<ns>:plugin-ready-for-render` → `<ns>:init-standalone-plugin` tool
  calls). Toggle the namespace between `speraxos:` and `lobe-chat:`. This is the
  one to use when verifying the SperaxOS / LobeChat integration.
- **`index.html`** — drives the lower-level v1 bridge directly.

The harness files live outside `public/` (so they never ship), which means the Vite
dev server can't serve them — run a plain static server for the harness and point its
iframe at the dev server:

```bash
# Terminal 1 — the dev server (serves /lobehub/iframe/, /src/lib.js, /api proxy):
npm run dev            # http://localhost:3000

# Terminal 2 — a static server for the harness:
python3 -m http.server 8080

# Open the protocol harness; ?origin points the iframe at the dev server:
open "http://localhost:8080/chat-plugin/dev/sperax.html?origin=http://localhost:3000&agent=<your-agent-id>"
```

Click **Load iframe**, wait for the green **plugin-ready ✓** dot, then **Inject
speak / gesture / emote** and watch the avatar react. Every postMessage is logged
in both directions.

---

## Build

```bash
cd chat-plugin
npm install
npm run build        # → dist/bundle.js
npm run type-check   # TypeScript strict check
```

Output: `dist/bundle.js` — tree-shaken, browser-targeted. React and react-dom are external (provided by LobeChat at runtime).

---

## Troubleshooting

| Symptom                | Likely cause                         | Fix                                                                              |
| ---------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| Avatar never appears   | Wrong `agentId`                      | Copy UUID from dashboard; ensure agent has an avatar                             |
| "Loading agent…" stuck | Bridge handshake failed              | Check browser console for `[3d-agent]` messages; verify `apiOrigin` is reachable |
| `speak` does nothing   | LobeChat hasn't installed the plugin | Confirm plugin is active in LobeChat Plugin Store                                |
| CORS error             | Self-hosted origin not allowed       | Add origin to `CORS_ORIGINS` in your three.ws deployment                         |
| Timeout errors         | Network latency                      | The bridge has a 10 s timeout; the iframe may still be loading the web component |

---

## Source note

`src/config-schema.ts` uses `placeholder` as a property name — these are form input hint strings shown in LobeChat's settings UI (standard HTML `<input placeholder="...">` semantics), not implementation stubs.

---

## License

All rights reserved. See [LICENSE](./LICENSE).
