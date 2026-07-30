# Examples

Runnable demos for the three.ws SDKs and agent runtime. Two kinds live here:

1. **Single-file HTML demos** in this directory. Each one exercises a real web component or embed surface against the live code in [src/](../src/), with no build step.
2. **Example projects** in subdirectories. Each is a self-contained agent, skill bundle, or end-to-end script with its own README, which is the authoritative doc for that project.

Use these as working references when embedding three.ws on your own site (see [docs/embedding.md](../docs/embedding.md) and [docs/web-component.md](../docs/web-component.md)) or when defining an agent as files (see [coach-leo/](./coach-leo/)).

## Run the HTML demos

Start the dev server from the repo root, then open any demo by path:

```bash
npm run dev   # port 3000
# then visit e.g. http://localhost:3000/examples/bare-avatar.html
```

The demos import the framework source directly (`../src/element.js`, `../src/lib.js`), so edits to `src/` hot-reload into them. Two demos are different on purpose: [embed-test.html](./embed-test.html) loads the published production bundle from `https://three.ws/dist-lib/agent-3d.js` to verify the shipped artifact, and [monicas-apartment/index.html](./monicas-apartment/index.html) opens directly in a browser with no server at all.

## HTML demos

| Demo | What it shows | Loads |
|---|---|---|
| [bare-avatar.html](./bare-avatar.html) | The default `<agent-3d>` output: just the avatar on a transparent background, no chat UI. A checkerboard body proves the transparency. | [src/element.js](../src/element.js) |
| [one-line-demo.html](./one-line-demo.html) | One `<agent-3d chat>` tag turns a page into a full conversational 3D agent (body, instructions, brain, chat UI). | [src/element.js](../src/element.js) |
| [sign-language.html](./sign-language.html) | Two ways to sign: `<agent-3d chat sign-language>` for signed chat replies, and the engine driven directly to compile any text into one clip. | [src/element.js](../src/element.js), [src/sign-speech.js](../src/sign-speech.js) |
| [minimal.html](./minimal.html) | `<agent-3d>` dropped into an ordinary landing-page layout. | [src/element.js](../src/element.js) |
| [web-component.html](./web-component.html) | The `<mv-viewer>` custom element: three viewers with different attributes plus its event log. | [src/components/ModelViewerElement.js](../src/components/ModelViewerElement.js) |
| [two-agents.html](./two-agents.html) | `<agent-stage formation="row">` hosting two `<agent-3d>` elements in one shared scene, with a chat input that addresses both. | [src/lib.js](../src/lib.js) |
| [three-concierge.html](./three-concierge.html) | Trinity, a complete agent mounted live from [three-concierge/manifest.json](./three-concierge/manifest.json): body, voice, skills, and scene tools resolved from JSON. | [src/element.js](../src/element.js) |
| [agent-presence.html](./agent-presence.html) | Standalone harness for the `<agent-presence>` studio element and its store. | [src/studio/agent-presence.js](../src/studio/agent-presence.js) |
| [agent-wallet-embed.html](./agent-wallet-embed.html) | `<agent-3d wallet>` on a deliberately unstyled "stranger's blog" page: the portable custodial wallet with live balance and tip flow. | `/dist-lib/agent-3d.js` |
| [embed-test.html](./embed-test.html) | Production-bundle smoke test: `<agent-3d chat>` from the live CDN plus the `<three-ws-widget type="kol-trades">` smart-money widget. | `https://three.ws/dist-lib/agent-3d.js`, [src/widgets/kol-trades.js](../src/widgets/kol-trades.js) |
| [widget-rpc.html](./widget-rpc.html) | Driving the `/widget` iframe from a host page over its JSON-RPC `postMessage` API. | the `/widget` route in an iframe |

## Example projects

| Directory | What it is |
|---|---|
| [coach-leo/](./coach-leo/) | The smallest complete agent defined entirely as files: an `agent-manifest/0.1` manifest, a system prompt, and one installed skill. The template to copy for your own agent. |
| [three-concierge/](./three-concierge/) | Trinity, the reference agent for manifest spec `agent-manifest/0.2`: multiple pump.fun skills, extended thinking, and an ERC-8004 style discovery card. |
| [pump-fun-agent/](./pump-fun-agent/) | An agent manifest composing all four production skills from [pump-fun-skills/](../pump-fun-skills/): swap, coin creation, creator fees, and token payments. |
| [skills/](./skills/) | Six installable skill bundles (`wave`, `solana-wallet`, `pump-fun`, `pump-fun-trade`, `pump-fun-compose`, `pump-fun-strategy`). Each `SKILL.md` documents its tools, config, and safety caps. |
| [agent-native-3d/](./agent-native-3d/) | A Node script that drives the free `/api/mcp-studio` MCP server end to end: generate a mesh, rig it, save it as a persistent agent persona, speak through it, and emit every distribution snippet. |
| [agenc-task-roundtrip/](./agenc-task-roundtrip/) | End-to-end AgenC coordination-protocol demo on Solana devnet: two wallets register, post, claim, and complete a task with real on-chain transactions. |
| [metamask-agent-wallet/](./metamask-agent-wallet/) | A localhost bridge plus single page that gives an agent a real server-side wallet through the authenticated MetaMask Agentic CLI. |
| [paid-mcp-server/](./paid-mcp-server/) | An MCP server whose tools charge per call in USDC on Solana over x402: one free orientation tool, one paid glTF/GLB inspector. The seller side of the agent economy, with the verify-work-settle ordering that means a failed call never takes money. |
| [monicas-apartment/](./monicas-apartment/) | A walkable first-person Three.js scene in one self-contained HTML file: procedural textures, AABB collision, pointer-lock controls. |

More SDK-specific examples live next to their SDKs: [concierge-sdk/examples/](../concierge-sdk/examples/) and [assistant-sdk/examples/](../assistant-sdk/examples/).

## The one-tag embed, from [bare-avatar.html](./bare-avatar.html)

The core pattern every `<agent-3d>` demo builds on is two lines:

```html
<agent-3d body="/avatars/cz.glb" width="420px" height="560px"></agent-3d>

<script type="module" src="../src/element.js"></script>
```

That renders the animated avatar alone: no chat, no input, no name-plate, transparent background. Add the `chat` attribute (as [one-line-demo.html](./one-line-demo.html) does) to opt into the conversational UI. On a third-party site, replace the module source with the published bundle `https://three.ws/dist-lib/agent-3d.js`, exactly as [embed-test.html](./embed-test.html) does.

## Related docs

- [docs/embedding.md](../docs/embedding.md): all the ways to put a three.ws avatar on another site.
- [docs/web-component.md](../docs/web-component.md): the `<agent-3d>` attribute and API reference.
- [specs/EMBED_SPEC.md](../specs/EMBED_SPEC.md): the embed protocol contract.
- [STRUCTURE.md](../STRUCTURE.md): where every product surface lives in the repo.
