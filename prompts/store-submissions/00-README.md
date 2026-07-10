# Store Submission Prompts — three.ws MCP

Goal: get three.ws's plugins and tools listed across **every** Claude and OpenAI marketplace + the major MCP registries:

1. **Claude Connectors Directory** (remote MCP) — prompts 01–03
2. **OpenAI ChatGPT App Directory** (Apps SDK) — prompts 04–06
3. **Differentiation layer** (the 10x moat) — prompts 07–09
4. **Claude Code plugin marketplace** + **Agent Skills pack** — prompts 10–11
5. **OpenAI GPT Store** (Custom GPT + Actions) — prompt 12
6. **MCP registries & third-party directories** (Smithery, Glama, mcp.so, PulseMCP, LobeHub) — prompt 13
7. **Shared asset kit + submission tracker** — prompt 14

Each file in this folder is a **self-contained prompt** you paste into a fresh Claude Code chat in this repo. Run them in the order below. Each prompt drives one work-stream to a verified, production-complete state and ends by telling you exactly what to hand to the next chat.

---

## Strategic summary (read once)

The two stores are very different problems:

- **Claude Connectors Directory — achievable now.** The server already has remote streamable-HTTP transport, OAuth 2.1, per-tool `title` + annotations, manifests, a privacy policy, and a published npm package. The work is *verify + package + write the reviewer guide*. The directory explicitly permits transactional connectors, so the x402 paid model is allowed — the reviewer just needs a free end-to-end path (`forge_free`) and clean `PaymentRequired` responses.

- **OpenAI ChatGPT App Directory — needs repackaging.** OpenAI's submission policy prohibits "tokens or credits," "embedded third-party payment solutions," and "crypto speculation schemes." The current x402-per-call model and the token/pump.fun tools are disqualifying as-is. The viable route is a **separate, free, non-crypto 3D-avatar app** exposing only the generation tools (`forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`) with an embedded GLB-viewer component — no x402, no token tooling.

Authoritative sources (re-fetch at submission time; requirements move):
- Claude: https://claude.com/docs/connectors/building/submission
- Claude remote-server guide: https://support.claude.com/en/articles/12922490-remote-mcp-server-submission-guide
- OpenAI: https://developers.openai.com/apps-sdk/app-submission-guidelines
- OpenAI submit/maintain: https://developers.openai.com/apps-sdk/deploy/submission

---

## Run order

### Track A — Claude Connectors Directory (do first)
1. `01-claude-tool-annotation-audit.md` — ✅ SHIPPED (verified 2026-07-07; prompt retired — deliverables live in the repo/`_generated/`) — every tool has a correct `title` + annotation set. (Also unblocks OpenAI.)
2. `02-claude-reviewer-access-guide.md` — ✅ SHIPPED (re-audited + closed out 2026-07-08; prompt retired — deliverables live in the repo/`_generated/`) — free verification path, graceful `PaymentRequired`, reviewer setup/test-account doc. Live re-check found the free lane (`forge_free`) currently exceeding a reviewer's patience window — see `_generated/claude-tool-call-evidence.md` and `TRACKER.md` item 8 before filing.
3. `03-claude-submission-package.md` — ✅ SHIPPED (verified 2026-07-07; prompt retired — deliverables live in the repo/`_generated/`) — privacy URL, allowed-links, server metadata, the exact form-fill content + compliance acknowledgments.

### Track B — OpenAI ChatGPT App (do after Track A, or in parallel)
4. `04-openai-free-3d-endpoint.md` — a free, non-crypto, scoped 3D-generation MCP endpoint.
5. `05-openai-apps-sdk-component.md` — ✅ SHIPPED (verified 2026-07-07; prompt retired — deliverables live in the repo/`_generated/`) — the embedded GLB-viewer UI component the Apps SDK expects.
6. `06-openai-submission-package.md` — OpenAI directory metadata, policy-compliance audit, screenshots, developer verification.

### Track C — Differentiation layer (the 10x–100x; what makes us NOT just another listing)
Baseline (01–06) gets us *listed*. Track C makes us *un-ignorable*. The thesis: three.ws is the only platform in either store with generation + agent payments + agent coordination in one place — so we ship the new primitive nobody else can: **embodied, economically-autonomous agents, and 3D as a native conversational medium.**
7. `07-embodied-agent-live-avatar.md` — a persistent 3D body that lip-syncs, emotes, and idles inline. The consumer screenshot moment. (Both stores.)
8. `08-live-agent-commerce.md` — autonomous discover→reputation→pay→delegate, made *visible* with provenance receipts. The agent-economy demo. (Claude/paid only.)
9. `09-conversational-remixable-3d.md` — iterate on a model by talking to it ("bigger helmet"), plus remixable assets with provenance + automatic creator royalties. (Iteration: both stores. Royalties: Claude/paid only.)

The 100x meta-move (positioning, not a single prompt): don't just *be in* the stores — **own a category across them.** Publish an open pattern for 3D-native / spatial MCP responses (tool results that return live interactive scenes, not text) and x402 agent-commerce patterns, and be the reference implementation other apps call under the hood. Infrastructure, not an app.

### Track D — Claude plugin & skill ecosystem (beyond the Connectors Directory)
10. `10-claude-code-plugin-marketplace.md` — ✅ SHIPPED (verified 2026-07-07; prompt retired — deliverables live in the repo/`_generated/`) — finish, validate, and make installable the three.ws Claude Code plugin marketplace (`/plugin marketplace add`), incl. the missing 3D plugin.
11. `11-claude-agent-skills-pack.md` — harden the wallet/x402 skills into a distributable Agent Skills pack and add the 3D-creation skills. Tags a crypto-free creative subset the OpenAI track reuses.

### Track E — OpenAI GPT Store + MCP registries
12. `12-openai-gpt-store-actions.md` — a Custom GPT backed by an OpenAPI 3.1 Actions schema over the free, zero-crypto 3D endpoints. The fastest OpenAI listing.
13. `13-mcp-registry-directories.md` — get every three.ws MCP server listed + consistent across the official registry, Smithery, Glama, mcp.so, PulseMCP, LobeHub, from one canonical metadata source.

### Track F — Shared (run early, finish last)
14. `14-cross-store-asset-kit.md` — ✅ SHIPPED (verified 2026-07-07; prompt retired — deliverables live in the repo/`_generated/`) — one canonical icon/screenshot/copy kit (Claude-full + OpenAI-free variants) every listing reuses, plus a live submission tracker across all targets.

### Track G — Net-new primitives at the 3D × AI × crypto × web3 intersection (the build layer)
Tracks A–F get us *listed, packaged, and distributed*. Track G is where we **build tools people actually use** by fusing the four things only three.ws has in one place — generation, embeddable 3D, Solana/x402 rails, and agent identity. Each is a standalone, shippable primitive that also becomes a flagship use case for the listings above.
16. `16-tokenized-3d-nft.md` — mint a generated avatar as a real on-chain Solana NFT whose media is a live rigged viewer, with baked provenance + enforced royalties. (Claude/paid.)
17. `17-embodied-onchain-identity.md` — a persona bound to a real Solana wallet + ERC-8004 identity, whose 3D body visually encodes its chain state; tip/send within caps. (Claude/paid.)
18. `18-token-gated-3d-embeds.md` — holder-only interactive 3D embeds, gated by a server-verified on-chain balance (canonical: $THREE; runtime mint as plumbing). (Claude/paid.)
19. `19-verifiable-ai3d-provenance.md` — signed, on-chain-anchored content credentials for AI 3D; a free, coin-clean verify path that ships in BOTH stores. (Anchor: Claude/paid · Verify: both.)
20. `20-spatial-mcp-standard.md` — the open spec + reference renderer + validator for 3D-native MCP responses; three.ws as the reference implementation. (Infra; both.)
21. `21-ar-ready-exports.md` — GLB→USDZ / Scene Viewer one-tap "View in AR" links; pure consumer value, zero crypto. (Both stores.)

**Sequencing:** ship 01–06 first (real listings beat vision). Then 07 is the highest-leverage single add — it's the headline screenshot for both listings. 08 and 09 deepen the moat. Run **14 early** so 03/06/07/10/12/13 reuse its assets. Track D (10–11) and Track E (12–13) are independent of A/B and can run in parallel — 10 and 12 are the two highest-ROI additions (a one-command Claude install and the fastest OpenAI listing). 13 is mostly hygiene on the 38 servers already published. Track G (16–21) is the build pipeline: **19 + 20 + 21 are coin-clean and reusable across both stores** (ship early — they also strengthen the OpenAI listing); **16 + 17 + 18 are the web3 moat** on the Claude/paid track. Highest-leverage net-new build: **21** (consumer AR, both stores), then **19** (authenticity, both stores), then **16** (on-chain ownership — the crypto headline).

---

## Rules every chat must follow (from CLAUDE.md)

- **No mocks, no fake data, no placeholders, no TODOs.** Real APIs, real endpoints, finish what you start.
- **$THREE is the only coin.** Never reference any other token anywhere. The OpenAI track must contain **zero** token/crypto surface.
- **Stage explicit paths only** (never `git add -A`/`.`) — concurrent agents share this worktree. Re-check `git status` before any commit.
- **Commit/push only when the human running the chat explicitly asks.** When they do: `git push threews main` — the only push target. Never push, pull, fetch, or merge `threeD` (the retired `nirholas/3D-Agent` mirror; its `main` has diverged with foreign history).
- **Changelog:** user-visible changes get an entry in `data/changelog.json`; run `npm run build:pages` to validate.
- **Watch the `npx vercel build` trap** — it overwrites `api/*.js` with esbuild bundles. Check `head -1` of changed `api/` files for `__defProp` before committing.

## Repo orientation
- Remote MCP endpoints: `api/_mcp/` (main), `api/_mcp3d/` (3D Studio), `api/_mcpagent/` (agent), `api/_mcpbazaar/`, `api/_mcpibm/`.
- Per-tool defs (with `title` + `annotations`): the `tools/*.js` files under each `api/_mcp*/` dir.
- Published stdio server: `mcp-server/` (`@three-ws/mcp-server`), tools in `mcp-server/src/tools/`.
- Manifests: `server.json`, `server-3d.json`, `server-agent.json`, `server-bazaar.json`, `server-ibm.json`, `server-pumpfun.json`, `mcp-server/server.json`.
- Legal: `public/legal/privacy.html`, `tos.html`, `content-policy.html`.
- Deploy: `vercel.json`. OAuth: `api/_mcp/auth.js` + `/.well-known/oauth-protected-resource`.
