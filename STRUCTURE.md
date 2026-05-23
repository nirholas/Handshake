# Repository Structure

three.ws ships all platform surfaces from a **single npm-workspaces monorepo**.
This file maps each product surface to where it lives in this repository, so
external developers can find what they need without reading 50 top-level
directories.

When an internal surface gains an external consumer that needs an independent
release cadence, we promote it to its own published package (and optionally its
own repo via `git subtree split`). See [Promotion path](#promotion-path) at the
bottom.

## three.ws surface map

| Surface | Location | Status | Notes |
|---|---|---|---|
| Web renderer / viewer | [avatar-sdk/](avatar-sdk) `→ /viewer` | Published as `@three-ws/avatar` | `<agent-3d>` web component |
| React avatar creator | [avatar-sdk/](avatar-sdk) `→ /react` `/creator` | Published as `@three-ws/avatar` | Same package, React subpath |
| Avatar builder (full app) | [character-studio/](character-studio) | Fork of [m3-org/CharacterStudio](https://github.com/M3-org/CharacterStudio), MIT, see [character-studio/LICENSE](character-studio/LICENSE) | Web-first character creator |
| Embed examples | [examples/](examples) | In-repo | `embed-test.html`, `web-component.html`, `two-agents.html`, `minimal.html` |
| Animation pipeline | [public/animations/](public/animations) + [scripts/build-animations.mjs](scripts/build-animations.mjs) | In-repo | Mixamo source FBX + GLB retargeting pipeline |
| Avatar schema | [packages/avatar-schema/](packages/avatar-schema) | Published as `@three-ws/avatar-schema` | JSON Schema for on-chain avatar manifests |
| Integration demos | [multiplayer/](multiplayer), [examples/coach-leo/](examples/coach-leo) | In-repo | Multiplayer and VR demos |
| Avatar service backend | [api/](api) + [workers/](workers) | In-repo | Vercel functions + Cloudflare workers |
| On-chain identity | [contracts/](contracts) | In-repo | Foundry-based on-chain agent identity, ERC-8004 |
| Cross-chain SDKs | [sdk/](sdk), [solana-agent-sdk/](solana-agent-sdk), [agent-payments-sdk/](agent-payments-sdk), [agent-protocol-sdk/](agent-protocol-sdk) | Published | Cross-chain agent SDKs |
| MCP integration | [mcp-server/](mcp-server), [mcp-bridge/](mcp-bridge) | Published as `@three-ws/mcp-server` | Model Context Protocol surface |
| SNS naming + pay-by-name | [api/sns.js](api/sns.js), [api/sns-subdomain.js](api/sns-subdomain.js), [api/threews/subdomain.js](api/threews/subdomain.js), [api/x402/pay-by-name.js](api/x402/pay-by-name.js), [src/solana/sns-subdomain.js](src/solana/sns-subdomain.js), [pages/threews-claim.html](pages/threews-claim.html) | In-repo | `*.threews.sol` subdomain mint, x402 payments addressed by name. Env: `THREEWS_SOL_PARENT_SECRET_BASE58`. See [SNS_PARTNERSHIP_PROPOSAL.md](docs/internal/SNS_PARTNERSHIP_PROPOSAL.md) |

## npm workspaces

Declared in [package.json](package.json):

```
agent-payments-sdk/    → @three-ws/agent-payments
avatar-sdk/            → @three-ws/avatar
character-studio/      → @m3-org/characterstudio (fork)
mcp-bridge/            → @three-ws/mcp-bridge
mcp-server/            → @three-ws/mcp-server
multiplayer/           → @three-ws/multiplayer
packages/*             → @three-ws/* (new — for clean publishable spec/schema packages)
```

`packages/` is reserved for spec/schema/protocol packages with no runtime
dependencies on the main app — things that need to be installable by external
consumers (e.g. another team building an avatar viewer that wants to validate
our manifest format).

Runtime SDKs and apps live at the top level for historical compatibility with
the deploy pipeline and existing import paths.

## Where things actually live

- **3D viewer & creator** — [avatar-sdk/](avatar-sdk), [character-studio/](character-studio)
- **Avatar / accessory assets** — [public/avatars/](public/avatars), [public/accessories/](public/accessories)
- **Animations** — [public/animations/](public/animations) (Mixamo FBX → built GLB clips), [scripts/build-animations.mjs](scripts/build-animations.mjs)
- **On-chain identity & contracts** — [contracts/](contracts), [packages/avatar-schema/](packages/avatar-schema)
- **API endpoints** — [api/](api) (Vercel functions), [workers/](workers) (Cloudflare workers)
- **Examples & demos** — [examples/](examples), [multiplayer/](multiplayer)
- **Cross-chain SDKs** — [sdk/](sdk), [solana-agent-sdk/](solana-agent-sdk), [agent-payments-sdk/](agent-payments-sdk), [agent-protocol-sdk/](agent-protocol-sdk)
- **MCP integration** — [mcp-server/](mcp-server), [mcp-bridge/](mcp-bridge)
- **Specs & protocol docs** — [specs/](specs)
- **Frontend pages** — [src/](src), [pages/](pages), [public/](public)
- **Tests** — [tests/](tests)

## Promotion path

A surface graduates to its own repo only when there is a concrete external
need that the monorepo cannot serve:

1. **A third party wants to consume it without pulling our whole tree.**
   Mitigation: publish to npm under `@three-ws/*` first. If the npm package
   is enough, no repo split is needed.
2. **Independent release cadence required.** When the surface needs its own
   semver line decoupled from the app.
3. **External contributors blocked.** When the repo size or unrelated CI cost
   is a real friction for outside PRs.

Promotion procedure (when triggered):

```bash
# Cleanly split a directory's full history into a new repo
git subtree split --prefix=packages/avatar-schema -b avatar-schema-split
cd ../  && mkdir avatar-schema-repo && cd avatar-schema-repo
git init && git pull ../three.ws avatar-schema-split
git remote add origin https://github.com/nirholas/avatar-schema.git
git push -u origin main
# Then in three.ws: replace the workspace dir with a normal npm dep
```

Until the trigger fires, splitting is premature: each new repo adds release
overhead, CI cost, and cross-repo PR coordination tax for zero functional
gain.

## See also

- [README.md](README.md) — product overview, quickstart, full feature list
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose changes
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — attribution for derived code and assets
- [CLAUDE.md](CLAUDE.md) — operating rules for AI agents working in this repo
