# Citing a three.ws artifact in Claude.ai

`GET https://three.ws/api/artifact?agent=<agentId>`

Paste the URL into a Claude.ai conversation. Claude fetches the document and renders it inside an artifact iframe.

The response is a **single self-contained HTML page** — three.js, GLTFLoader, the viewer code, and the GLB are all inlined. No external requests at runtime, which is mandatory: Claude's sandbox CSP forbids fetch to anywhere except `cdn.jsdelivr.net/pyodide/`.

## Worked example

```
Here's my agent for this conversation:
https://three.ws/api/artifact?agent=27a0f649-3b59-4552-bb0b-faf616ac448b
```

The `agent` value is the agent's UUID, shown on its profile page and returned by
`GET /api/agents/public`. Anything that is not a UUID is rejected with a 400 and an
`invalid_request` envelope, because the column it looks up is a `uuid`.

Claude embeds the artifact and the live 3D character renders inline.

## Parameters

| Param   | Description                                             |
| ------- | ------------------------------------------------------- |
| `agent` | Agent UUID (required unless `model` is set)             |
| `model` | Absolute `https://` URL to a GLB from a whitelisted CDN |
| `theme` | `dark` (default) or `light`                             |
| `idle`  | Animation clip name to play while idle                  |
| `bg`    | Background hex colour (without `#`), e.g. `bg=1a0533`   |

## Constraints

- **GLB size cap: 6 MB** — larger avatars return 413. Slimmer GLBs paste faster and render sooner.
- **Viewer overhead: ~565 KB** — three.js + GLTFLoader + viewer code, inlined into every response.
- **Artifact ceiling: ~8.6 MB.** The model is inlined as base64, which costs four bytes per three, so a 6 MB GLB becomes 8 MB of text before the viewer is added. Budget against this total, not against the 6 MB model cap: it is what Claude actually has to load.
- **Rate limit: 600 req/min per IP** — shared with the widget-read preset.

## How to test before pasting

The page at [`/artifact/`](https://three.ws/artifact/) renders the response inside a sandboxed iframe whose CSP mirrors Claude's. If it works there, it works in Claude.

It reports three numbers per build. **Artifact** is the size of the whole document, graded
against the ~8.6 MB ceiling above rather than the 6 MB model cap. **Fetch** is how long
`/api/artifact` took to return those bytes. **Render** is how long the sandboxed frame then
took to parse the document and run the inlined viewer, which is the closest measurable
stand-in for how quickly Claude's panel can show anything: the frame is an opaque origin, so
the page cannot read paint timing out of it directly.

You do not need to know an agent ID to try it: the builder lists real public agents that
carry an embeddable avatar (`GET /api/agents/public?sort=popular&limit=12&avatar=1`), and
clicking one builds its artifact immediately. Typing an ID by hand still works, and the
full configuration (agent, theme, idle clip, background) is mirrored into the page's query
string, so the URL in the address bar rebuilds the same artifact for anyone you send it to.

The "Claude artifact sandbox CSP" panel shows the vendored copy served at
[`/claude-artifact-csp.txt`](https://three.ws/claude-artifact-csp.txt). Those are the same
bytes `tests/api/artifact.test.js` pins the endpoint against; refresh them from the upstream
scraper with `node scripts/refresh-claude-csp.mjs`.

## Behaviour and contract

See [`specs/CLAUDE_ARTIFACT.md`](../../specs/CLAUDE_ARTIFACT.md) for the full contract, error envelope, and the locked-in CSP we test against.
