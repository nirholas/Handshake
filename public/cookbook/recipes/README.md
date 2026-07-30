# Cookbook recipes

The runnable half of the [three.ws Cookbook](https://three.ws/cookbook). Each
file here is served verbatim at `https://three.ws/cookbook/recipes/<file>` and is
what the "Download" button on a recipe page hands you. The prose that explains
each one lives in [`docs/cookbook/`](../../../docs/cookbook).

Every file in this directory was executed against the live API before it was
published. Nothing here is illustrative pseudocode.

| File | What it does | Needs |
|---|---|---|
| [`text_to_3d.py`](text_to_3d.py) | Prompt in, downloaded `.glb` out | Python 3.10+ |
| [`asset_pack.py`](asset_pack.py) | Many prompts in parallel, plus stills, a manifest, and a gallery | Python 3.10+, `text_to_3d.py` beside it |
| [`asset_gate.py`](asset_gate.py) | Fails CI when a model busts a triangle, size, or material budget | Python 3.10+ |
| [`mcp_3d_server.mjs`](mcp_3d_server.mjs) | An MCP server exposing text-to-3D and rendering as tools | Node 18+, `@modelcontextprotocol/sdk`, `zod` |

None of them need an API key. They call the free, keyless
[3D API](https://three.ws/docs/3d-api).

## Run them

```bash
# One model
python3 text_to_3d.py "a wooden treasure chest with iron bands"

# A themed pack, three at a time
python3 asset_pack.py "a clay flower pot" "a woven wicker basket" --out ./pack

# Budget check, exits non-zero on a bust
python3 asset_gate.py ./pack/models/*.glb --max-triangles 100000

# The MCP server, over stdio
npm install @modelcontextprotocol/sdk zod
node mcp_3d_server.mjs
```

`asset_pack.py` imports `text_to_3d.py` (for `generate`, `download`, and
`slugify`) rather than restating the client, so the two cannot drift. Keep them
in the same directory.

## Conventions these files follow

They are meant to be copied into other people's projects, so they hold a
consistent shape:

- **Standard library only** for the Python recipes. A recipe that needs a
  `pip install` before it can prove anything is a worse recipe.
- **Honor `retryAfter`.** Every pending response from the generation lane carries
  a poll-cadence hint. Ignoring it trips the flood guard and slows the shared GPU
  pool for everyone. Each client clamps the hint to a sane window rather than
  replacing it.
- **Bound every loop.** No recipe polls forever. A tool that hangs is harder to
  debug than one that fails with a clear message.
- **Degrade, do not abort.** A missing thumbnail does not fail an asset; a
  missing model does. The distinction is explicit in the code.
- **Surface the API's own error text.** `urllib` and `fetch` both hide the
  response body on an error status. Every recipe reads it and re-raises with the
  server's message attached.

## Adding a recipe

1. Write the file here and actually run it.
2. Write the prose at `docs/cookbook/<slug>.md`.
3. Add an entry to [`public/cookbook-manifest.js`](../../cookbook-manifest.js).
4. Add the page to `data/pages.json` so it reaches the sitemap and `llms.txt`.
5. Add a `data/changelog.json` entry.

[`tests/cookbook.test.js`](../../../tests/cookbook.test.js) checks steps 1
through 4 agree with each other, so a recipe cannot ship half-wired.
