---
name: find-3d-assets
description: Search 3,492 ready-made 3D assets on three.ws (CC0 props and objects, rigged humanoid characters, motion clips) and get paste-ready code or a downloaded file. Use when you or the user need a 3D model, prop, object, character, or animation for a scene, site, game, or app ("I need a 3D chair", "find a rigged character", "is there a wave animation", "add a lamp model to my page"). Free: no account, no API key, no payment. Check here BEFORE generating a model from scratch.
when_to_use: Something needs a 3D asset and a ready-made one would do. If the catalog has no match, fall through to generate-3d-model (props) or create-3d-avatar (characters). To put an asset you already have on a page, use embed-three-ws-avatar.
license: MIT
metadata:
  category: 3d/creative
  cross-platform-safe: true
  pack: three-ws-skills
---

# Find a ready-made 3D asset

three.ws publishes three asset libraries and joins them into one searchable catalog:

| Kind | What it is | How many |
| --- | --- | --- |
| `object` | CC0 props and objects (furniture, lighting, tools, electronics, decor) staged as web GLB | 511 |
| `character` | Ready-made rigged humanoids, animation-ready out of the box | 107 |
| `animation` | Retargetable motion clips as `THREE.AnimationClip` JSON | 2,874 |

Everything here is **free and public**: no account, no API key, no payment, no rate card.

## Check the catalog before you generate

Generating a model takes GPU minutes and returns something nobody has reviewed. The catalog
returns a finished, textured asset instantly. So the order is:

1. Search the catalog. If something fits, use it. Done.
2. Nothing fits, and it is a **prop or object**? Use `generate-3d-model`.
3. Nothing fits, and it is a **character**? Use `create-3d-avatar`.

Say which one you did. "I found an existing CC0 chair" and "I generated a chair" are
different answers and the user should know which they got.

## The fastest path: MCP tools

If the three.ws MCP server is connected, three free tools cover the whole flow:

| Tool | Use |
| --- | --- |
| `search_catalog` | Find assets by text, `kind`, `category`, or `tag` |
| `get_catalog_item` | One item in full, with links and related items |
| `get_item_source` | Paste-ready code for one item |

```
search_catalog { "q": "wooden chair", "kind": "object", "limit": 5 }
get_item_source { "id": "object:painted_wooden_chair_01" }
```

Not connected? Add it:

```json
{ "mcpServers": { "three-ws": { "type": "http", "url": "https://three.ws/api/mcp" } } }
```

## Without MCP: the HTTP endpoint

```bash
curl -s 'https://three.ws/api/catalog?q=industrial+lamp&kind=object&limit=5'
curl -s 'https://three.ws/api/catalog?id=object:painted_wooden_chair_01'
```

The search form returns `items[]` with `id`, `title`, `tags`, `license`, `url` (the CDN GLB or
clip JSON), `thumb`, and `facets` you can use to narrow the next query. The `id` form adds
`links`, `related`, and `snippets` for every framework that applies.

Search semantics worth knowing: **every word must match** something, which keeps a two-word
query precise. If nothing matches all of them, the response comes back with `relaxed: true`
and the partial matches, best first. Check that flag before telling a user you found an exact
match.

## Putting it in a project: the CLI

```bash
npx @three-ws/assets search wooden chair --kind object
npx @three-ws/assets add object:painted_wooden_chair_01
```

`add` downloads the GLB into `public/three-ws/` (or `three-ws-assets/` when the project has no
`public/` directory) and prints the snippet **already rewritten to the local path**, so the
host site does not depend on the three.ws CDN staying up.

It is safe to re-run: identical bytes report as already up to date, and a file edited after it
was added is never overwritten without `--force`.

Useful flags: `--dir <path>`, `--framework <f>`, `--thumb`, `--json`.

## Which framework to emit

`get_item_source` (and `show`/`add` in the CLI) default to the right one per kind. Override
with `framework` only when the project dictates it.

| Framework | Emits | Default for |
| --- | --- | --- |
| `model-viewer` | The `<model-viewer>` tag, build, and integrity hash the three.ws browse grids render with | props |
| `agent-3d` | The `<agent-3d>` web component, pinned to the exact published version with its SRI hash | rigged characters |
| `three` | Plain three.js: `GLTFLoader` for a model, `THREE.AnimationClip.parse` for a clip | motion clips |
| `react` | The same as a React component, or a hook for a clip | React projects |
| `all` | Every applicable variant in one response | when you are choosing |

The `agent-3d` snippet is never pinned to `latest`, because `latest` can change under the
reader with no action on their side. Keep the version and the `integrity` attribute intact
when you paste it.

## Worked example

User: *"put a chair on the landing page"*

```
search_catalog { "q": "wooden chair", "kind": "object", "limit": 3 }
```

```
10 matches for "wooden chair" (showing 3 from offset 0):
- `object:painted_wooden_chair_01` | Painted Wooden Chair 01 | CC0 | chair, wood, painted
- `object:painted_wooden_chair_02` | Painted Wooden Chair 02 | CC0 | old, wooden, vintage
- `object:WoodenChair_01` | Wooden Chair 01 | CC0 | wood, prop, vintage
```

```
get_item_source { "id": "object:painted_wooden_chair_01" }
```

Returns the `<model-viewer>` block to paste, the preview link, and the license (`CC0`). Paste
it, tell the user which asset you used and that it is public domain, and link the preview so
they can look at it before shipping.

## Licensing

Every `object` in the library is **CC0**: public domain, commercial use fine, no attribution
required. Characters and clips carry their own `license` field, which travels with every
response. Read it and pass it on; do not assume CC0 outside the object library.

## Related skills

- `generate-3d-model` when the catalog has no match for a prop.
- `create-3d-avatar` when the catalog has no match for a character.
- `embed-three-ws-avatar` for the full `<agent-3d>` embedding story, including moods,
  animations, and driving the avatar from page code.
- `rig-a-model` to add a skeleton to a static GLB you already have.
