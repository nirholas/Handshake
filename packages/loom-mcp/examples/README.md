# Examples: @three-ws/loom-mcp

Two runnable examples. Both spawn this package's own MCP server over stdio (the
same `node src/index.js` entry point the README documents), speak real MCP
JSON-RPC to it, and read the live public Loom gallery.

| File | What it does | Run |
|---|---|---|
| [`list-tools.mjs`](list-tools.mjs) | Prints all 3 tools with titles, annotation hints, and full input schemas. | `node examples/list-tools.mjs` |
| [`browse-loom.mjs`](browse-loom.mjs) | A page of the gallery, the next page via its cursor, then one creation with a paste-ready embed. | `node examples/browse-loom.mjs` |

Run them from the package directory:

```bash
cd packages/loom-mcp
node examples/list-tools.mjs
node examples/browse-loom.mjs
```

Nothing to install and nothing to configure: every tool here is keyless. The
server prints a one-line banner to stderr on connect
(`[loom-mcp@x.y.z] connected over stdio with 3 tools`), which is normal.

**Both examples are deliberately read-only.** `submit_creation` posts to a
world-readable public gallery, so no example here writes on your behalf.

## list-tools.mjs

Runs the MCP `initialize` handshake, then `tools/list`, and formats every tool.
Expected output (abridged):

```
server:       loom-mcp v0.1.2 (stdio)
capabilities: tools
tools:        3

1. get_loom_feed
   hints: read-only, open-world
   params:
     - limit (optional; integer, min 1, max 120)
     - before (optional; integer)

2. get_creation
   hints: read-only, open-world
   params:
     - id (required; string, minLength 1)

3. submit_creation
   hints: open-world
   params:
     - prompt (required), glbUrl (required), author, previewImageUrl, tier, backend
```

`submit_creation` is the one tool without `read-only`: it appends to the public
feed, and it is not idempotent (only an identical `glbUrl` re-posted while it is
still among the newest few dedupes).

## browse-loom.mjs

```bash
node examples/browse-loom.mjs        # 3 creations
node examples/browse-loom.mjs 5      # page size, 1-120
```

```
get_loom_feed: 3 creation(s), nextBefore=1786772590629
  - a low-poly wooden treasure chest with brass hinges
      by nova on 2026-08-15 via hunyuan

next page (before=1786772590629): 0 older creation(s)

get_creation: d67a1e0c-3e87-4200-b834-114b10b2ce9f
  prompt: a low-poly wooden treasure chest with brass hinges
  glb:    https://…/chest.glb
  viewer: https://three.ws/forge/embed?src=…
  card:   https://three.ws/api/avatar-og?src=…

  paste this anywhere:
  <iframe src="https://three.ws/forge/embed?src=…" width="640" height="360" …></iframe>

Every call was read-only. Nothing was submitted to the public gallery.
```

The gallery is live, so ids, prompts, and counts move between runs. What stays
stable is the shape: a full page hands back a `nextBefore` cursor, feeding it
back as `before` walks older items, and a null cursor means you reached the end.
An empty gallery is a normal outcome and the example says so instead of failing.

### Environment

Optional, forwarded to the server if set: `THREE_WS_BASE` (default
`https://three.ws`) and `THREE_WS_TIMEOUT_MS`. Point `THREE_WS_BASE` at your own
deployment to browse its gallery instead.
