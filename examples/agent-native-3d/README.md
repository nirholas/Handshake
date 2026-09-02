# Agent-native 3D — create, embody, and distribute, end to end

An agent given a goal ("get yourself a body") generates the 3D assets it needs
and uses them — no browser, no mocks, no human in the loop. This is the
roadmap campaign's work order 10 demo (retired; readable in git history): the closing
proof that three.ws's MCP tools compose into a real autonomous create-and-use
loop, and that the result is trivially distributable everywhere.

## What it does

Drives the live, **free** three.ws "Free 3D Studio" MCP server
(`/api/mcp-studio` — see [`docs/mcp-studio.md`](../../docs/mcp-studio.md)) through
the full chain:

1. `tools/list` — confirms the composable tool contracts are live.
2. `mesh_forge(prompt)` — text → a static 3D mesh (Granite-directed model chain).
3. `rig_mesh(glb_url)` — auto-rig it into an animation-ready GLB.
4. `create_agent_persona(glb_url, name)` — save the rigged GLB as a NAMED,
   persistent agent body.
5. `persona_say(persona_id, text)` — perform a line through that body
   (lip-sync + emotion).
6. `get_agent_persona(persona_id)` — reload the SAME body in a **fresh** call,
   proving continuity (not a per-call random result).
7. Build every distribution snippet — iframe, `<model-viewer>`, `<agent-3d>`, a
   `@three-ws/page-agent` talking guide, and a `@three-ws/walk` companion —
   using the exact same pure functions
   ([`src/forge-embed-snippets.js`](../../src/forge-embed-snippets.js)) the
   Forge web app's "Embed this model" panel uses, so what this script prints is
   byte-identical to what a human copies from the UI.

All six MCP tools it calls are **free** — no x402 payment, no wallet, no API
key. Every request/response is a real HTTP round-trip against production (or
your local dev server); nothing here is stubbed.

## Run it

```bash
cd examples/agent-native-3d
node run.mjs
```

Against a local dev server instead of production:

```bash
npm run dev            # from the repo root, in another terminal
MCP_STUDIO_URL=http://localhost:3000/api/mcp-studio node run.mjs
```

Every request and response is written to
[`prompts/roadmap/_generated/10/agent-native-3d-transcript.json`](../../prompts/roadmap/_generated/10/agent-native-3d-transcript.json)
after each run.

## About the rate-limit fallback

`mesh_forge` / `rig_mesh` share one platform-wide free-tier generation lane
(the same one `/forge` web-page drafts use) with a real capacity ceiling. If
that lane is saturated when you run this, the script backs off using the
server's own quoted `retry_after` (bounded, never a blind sleep loop) and, if
it's still saturated past the budget, falls back to a known-good rigged GLB
(`https://three.ws/avatars/default.glb`) so steps 4–7 — embodiment, speech,
continuity, and distribution — still run for real. The fallback is logged
loudly in the console and recorded in the transcript (`result.fallback_used`),
never silently substituted; the failed generation calls are preserved verbatim
in `transcript.steps` for audit.

## Why this matters

This is the "own → use everywhere" half of the roadmap's closing loop
(prompts 08/09/10): generate a body, embody an agent identity with it, and
hand out real distribution in one call each — the same primitives a human
uses from the Forge UI, callable end to end by an agent with zero UI.
