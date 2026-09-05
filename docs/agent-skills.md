# three.ws Agent Skills pack

The three.ws **Agent Skills pack** is a set of portable skill folders that teach any
Claude surface — Claude Code, the Claude apps, the Agent SDK — how to use the
three.ws platform: create and rig 3D models, run a wallet, and buy/sell services in
the x402 agent economy.

> Not to be confused with the [in-app skills system](skills.md), which extends
> avatars and agents **inside** three.ws with `manifest.json` + `tools.json` +
> `handlers.js` bundles. Agent Skills are the inverse: they extend **external**
> AI agents with three.ws capabilities.

Each skill follows the [Agent Skills open standard](https://agentskills.io/specification):
a folder with a `SKILL.md` whose frontmatter `description` is the *trigger* — the only
text the model sees when deciding to load the skill — plus optional scripts and
reference files loaded on demand (progressive disclosure).

## What's in the pack

The pack lives at [`.agents/skills/`](../.agents/skills/). The full index with every
trigger is generated into [`.agents/skills/SKILLS.md`](../.agents/skills/SKILLS.md)
(human) and [`.agents/skills/skills-pack.json`](../.agents/skills/skills-pack.json)
(machine/registry) by `node scripts/build-skills-pack.mjs`.

Three categories:

| Category | Skills | Notes |
| --- | --- | --- |
| **3d/creative** | `find-3d-assets`, `generate-3d-model`, `create-3d-avatar`, `rig-a-model` | Text→GLB on the free lane, one-call rigged avatars, auto-rigging. **Cross-platform-safe**: zero coin/wallet/payment content, so this subset is reusable on non-Claude tracks (OpenAI, etc.). |
| **wallet/payments** | `authenticate-wallet`, `fund`, `send-usdc`, `trade`, `search-for-service`, `pay-for-service`, `monetize-service`, `query-onchain-data`, `x402`, `metamask-agent-*`, okx wallet/identity set | The x402 agent-economy set. Never bundle these on non-crypto tracks. |
| **intel/trading** | okx dex/defi market-data and execution set | Vendored partner skills (byte-identical to the vendor drop; categorized only in the pack manifest). |

`skills-pack.json` carries `category`, `origin` (`three.ws` / `okx` / `metamask`), and
`crossPlatformSafe` per skill, so a registry or a bundling script can slice the pack
without reading every folder.

## Install paths

### a) As a Claude Code plugin

The pack ships inside the `three-ws-core` plugin of this repo's
[plugin marketplace](../.claude-plugin/marketplace.json):

```
/plugin marketplace add nirholas/three.ws
/plugin install three-ws-core@three-ws
```

Skills load automatically; invoke one directly with `/generate-3d-model`,
`/send-usdc`, etc.

### b) Dropped into a project

Copy (or symlink) any skill folder into a project's `.claude/skills/`. This repo
does exactly that: on every `npm install`,
[`scripts/setup-claude-skills.mjs`](../scripts/setup-claude-skills.mjs) symlinks
every folder from `.agents/skills/` into the gitignored `.claude/skills/`:

```bash
cp -r .agents/skills/generate-3d-model  ~/my-project/.claude/skills/
```

Claude Code picks it up on the next session; the folder is self-contained, so it
works copied out of this repo.

### c) Uploaded to a Claude app / project

In the Claude apps, upload a skill folder (or its zipped form) under
**Project → Skills** (capabilities). The same `SKILL.md` drives triggering there —
no code changes needed. For the Agent SDK, pass the folder via the `skills`
option / skills directory the SDK exposes.

## Authoring rules for this pack

- **Frontmatter**: `name` (must equal the folder name, kebab-case, ≤64 chars) and
  `description` (≤1024 chars, written as a trigger: *what it does + when to use it*,
  with the phrases users actually say). Optional `when_to_use` adds routing hints.
- **Metadata tags**: native skills carry `metadata.category`,
  `metadata.cross-platform-safe`, and `metadata.pack: three-ws-skills` in
  frontmatter. Vendored skills (`okx-*`, `metamask-*`) are never edited — their
  categories live in `scripts/build-skills-pack.mjs`.
- **Progressive disclosure**: `SKILL.md` stays short (<500 lines); heavy reference
  material goes in a linked file (`reference.md`, `references/…`) loaded on demand.
- **Real content only**: every endpoint, tool name, and response shape in a skill
  is the production one; every bundled script must run. No stubs, no mock output.
- **Self-contained**: a skill folder must work when copied out of this repo — no
  relative imports into app internals.
- After adding or editing a skill, regenerate the manifest:
  `node scripts/build-skills-pack.mjs` (CI-style check: `--check`).

## The 3D-creation skills

The platform's signature set, safe to reuse anywhere:

- **`find-3d-assets`**: search the 3,492 ready-made assets three.ws already
  publishes (511 CC0 props, 107 rigged characters, 2,874 motion clips) and get
  paste-ready code or a downloaded file. Free, and the one to try FIRST: an
  existing asset is instant where a generation is GPU minutes. Reachable three
  ways off one catalog (the `search_catalog` / `get_catalog_item` /
  `get_item_source` MCP tools, `GET /api/catalog`, or `npx @three-ws/assets`).
- **`generate-3d-model`** — text → textured GLB on the free `forge_free` lane
  (NVIDIA NIM / TRELLIS; no key, no account). Returns `glbUrl` + viewer link.
- **`create-3d-avatar`** — text/image → **rigged** avatar via `forge_avatar`
  (generate + auto-rig in one call, humanoid gate). Returns rigged `glbUrl` +
  pose-studio link.
- **`rig-a-model`** — existing GLB → animation-ready GLB via `rig_mesh` /
  `POST /api/forge?action=rig` (Make-It-Animatable). Returns `riggedGlbUrl` +
  pose-studio link.

The three generation skills run free against the hosted studio endpoint
`https://three.ws/api/mcp-studio` (JSON-RPC `tools/call`), documented with runnable
`curl` examples inside each skill.

## Related

- [STRUCTURE.md](../STRUCTURE.md) — where every surface lives
- [In-app skills system](/docs/skills) - the avatar/agent skills system inside three.ws
- [MCP overview](/docs/mcp) - the three.ws MCP server the 3D skills call
- [3D Studio MCP endpoint](/docs/mcp-studio) - the free hosted endpoint the 3D skills run against
