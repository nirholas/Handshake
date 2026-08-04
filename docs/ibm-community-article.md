# Inside three.ws: A Technical Tour of the Browser-Based AI 3D Platform, From Text-to-3D Generation to Multiplayer Worlds and Agent Payments

_An in-depth look at the platform this user group is built around: how three.ws turns a text prompt into a textured 3D model, a selfie into an animated avatar, a URL into a persistent multiplayer world, and an HTTP 402 status code into a working machine-to-machine economy. Written for developers and engineers who want to understand the architecture, not just the demo. The group's first in-world meetup takes place Tuesday, August 18 at 12 PM ET at [three.ws/play](https://three.ws/play); details are on the Events tab._

## Why this platform is worth an engineer's attention

Most "AI plus 3D" products are a single feature: a text-to-3D model generator, or an avatar maker, or a virtual meeting room. What makes three.ws interesting from an engineering standpoint is that it is a full vertical stack, built browser-first, where each layer feeds the next:

1.  **Generation:** text or images become 3D assets (models, avatars, scenes, animations).
2.  **Animation:** any humanoid model, from any tool, animates without manual rigging work.
3.  **Distribution:** every asset embeds on any website with a web component, or unfurls as an interactive object via oEmbed.
4.  **Worlds:** assets and avatars enter persistent multiplayer 3D spaces that run entirely in the browser.
5.  **Economy:** AI agents with 3D bodies discover, call, and pay for services per-request using the x402 payment pattern.

Everything below is live and publicly reachable today. Where a claim is architectural, it comes from the platform's published documentation and open-source repositories rather than marketing copy.

## Layer 1: Generative 3D, free and in the browser

The entry point is the Forge, a free text-to-3D generator: describe an object in plain language and receive a downloadable, textured GLB in roughly a minute, with no account and no 3D software. A parallel pipeline turns a single photo into a rigged, animation-ready 3D avatar, and a text prompt can produce a complete humanoid character in one step.

Under the hood this is a fleet of GPU workers on Google Cloud Run running open generative models (the Hunyuan3D, TRELLIS, TripoSG and TripoSR families for mesh generation), surrounded by specialized workers for background removal, segmentation, remeshing, texturing, stylization, garment generation, photo-based avatar reconstruction, automatic rigging, text-to-motion, video-to-motion, and video-to-scene. Each generation lane has a failover chain, so an individual model being unavailable degrades quality gracefully instead of failing the request. The workers scale to zero when idle, which is a large part of why the free tier is economically sustainable.

For developers, the same capabilities are exposed as a free 3D API, and creation tools go well beyond the basic generator: a PBR material and restyling studio, a browser-based 3D scene editor, a text-to-world generator, an AR studio that places generated models in your physical room from the browser, and content-credential provenance so generated assets can prove their origin.

## Layer 2: The animation problem, solved as infrastructure

Anyone who has worked with 3D characters knows the pain point: a model rigged in one ecosystem (Mixamo, VRM/VRoid, Daz, MakeHuman, Avaturn, custom Blender rigs) rarely animates correctly in another. three.ws treats this as an infrastructure problem rather than a content problem. A skeleton canonicalizer maps the bone naming conventions of all the major ecosystems onto one canonical humanoid skeleton, and a retargeting layer drives a shared animation library (idle, walk, run, emotes and more) on any of them, legs included. There is deliberately no allowlist of supported rigs; a new convention is a mapping to add, not a feature to request. A public "Rig Doctor" tool reports in seconds whether a given GLB will animate and why.

The practical consequence: an avatar from effectively any source becomes a first-class citizen across the whole platform, from embeds to multiplayer worlds.

## Layer 3: Distribution as a web component

A generated avatar is not locked into the platform. The `<agent-3d>` web component embeds a live, animated three.ws avatar into any website with a single script tag, framework-agnostic, with animations, moods and speech drivable from page JavaScript. A family of published npm packages builds on the same foundation: a page-walking companion mascot, a talking page guide, a guided-tour engine, an embeddable AI concierge with a face, and an assistant widget. An oEmbed provider makes world and creation links unfurl as interactive 3D embeds in WordPress, Ghost, Discord, dev.to and Notion.

The frontend philosophy is notable: the site is vanilla JavaScript modules built with Vite, with Three.js for rendering, Rapier compiled to WebAssembly for physics, and meshopt-compressed assets. There is no heavyweight framework, which is precisely what makes the embed story credible: the components carry no runtime tax onto host pages.

## Layer 4: Multiplayer worlds in the browser, and the architecture behind them

At [three.ws/play](https://three.ws/play), the platform runs Coin Communities, a persistent isometric MMO in the browser. Every token community has its own 3D world, derived on demand from the token's mint address, reachable as a plain URL. Inside a world: spatial voice chat (proximity-based, with genuine positional audio), collaborative voxel building persisted per world, a working in-game economy with vendor NPCs, banking, daily-rotating quests and multi-player heists, vehicles, day-night cycles, and live market data rendered on in-world screens.

The multiplayer architecture is a clean case study in doing real-time systems economically:

-   **An authoritative Colyseus (Node.js) server** on Google Cloud Run, with browser clients connecting over WebSockets.
-   **One room definition, filtered by community.** Players joining a world pass its token identifier, and the matchmaker groups only players of the same community. Every community gets an isolated world on shared infrastructure with zero provisioning.
-   **50 players per room instance**, with the matchmaker spinning up additional instances as rooms fill. A full room costs roughly 5 MB of server memory.
-   **State synchronization at 15 Hz using binary delta encoding.** Each player is a small schema and only changed fields go over the wire, roughly 24 bytes per player per update; a fully occupied room costs about 18 KB/s outbound. This is why the experience holds up on modest connections.
-   **Zero client trust.** Every movement message is validated server-side: physically plausible step distances, world bounds, vertical clamps, per-client rate limits, and type checks against allow-lists.
-   **Voice as a proximity-gated WebRTC mesh.** Peer connections open only between players within earshot and tear down as they part, bounding the mesh regardless of room size. Audio is peer-to-peer through Web Audio panner nodes for true spatial positioning; the game server relays only the signaling handshake and never carries audio.
-   **Optional token gating, verified server-side.** A community's creator can require a minimum holding to enter the holders' tier of their world. Eligibility is checked against actual on-chain balances by the server, which then signs a short-lived pass; the browser never self-asserts what it holds.

Guests are first-class: no account is needed to enter open worlds, and every guest still gets a full avatar, voice, and chat. That decision, more than any single feature, is what makes the worlds usable as drop-in event venues, which is exactly how this group will use one on August 18.

## Layer 5: The agent economy, and the x402 pattern

The most forward-looking layer is the payment infrastructure. three.ws implements the x402 pattern, which revives HTTP's long-dormant 402 Payment Required status code: an agent calls an API, receives a 402 challenge describing the price, pays in USDC (settled on Solana, the platform's home chain), retries with proof of payment, and receives the response. No API keys, no subscriptions, no invoicing, and crucially, no human in the loop. On top of this rail the platform operates a paid market-data API, a catalog-and-receipt layer for service discovery and proof of purchase, and a fabric exposing hundreds of thousands of payable data endpoints. Agents carry on-chain identities using the ERC-8004 pattern, and an operations layer (a fleet monitor, a live wall of agent activity, and owner takeover of an agent's screen) makes the whole thing observable.

Whether or not one holds any view on tokens, the engineering claim stands on its own: machine-to-machine commerce with per-request settlement is a real, working pattern here, not a slide.

## The IBM connection: watsonx.ai and Granite, agent-native

Two packages in the three.ws open-source portfolio are directly relevant to this community:

-   **`@three-ws/ibm-watsonx-mcp`** is a Model Context Protocol server for IBM watsonx.ai: chat, text generation, embeddings, tokenization, forecasting and model discovery, running against your own IBM Cloud account. Any MCP-capable client (Claude, Cursor, and a growing list of IDEs and agents) gets watsonx.ai as a native tool.
-   **`@three-ws/ibm-x402-mcp`** exposes pay-per-use IBM Granite models over MCP with x402 billing: chat, code, embeddings, analysis and forecasting, paid per request in USDC, with no IBM account required on the caller's side. It is one of the cleanest public demonstrations of what usage-based, agent-native billing for foundation models can look like.

Both are published on npm and listed in the MCP registry. For teams exploring how enterprise models fit into agentic workflows, they are worth a look purely as reference implementations.

## The rest of the stack, briefly

Production runs on Google Cloud: a single container on Cloud Run serves the static frontend and every API handler, Cloud Scheduler drives more than a hundred recurring jobs, Cloud Build handles deploys, and a global load balancer and CDN front the whole thing, with Neon Postgres as the database. AI features ride on Vertex AI (Gemini and Imagen) behind a multi-provider failover chain, and the same failover discipline applies to blockchain RPC. The platform publishes over 60 npm packages (avatar SDK and CLI, GLB tooling, animation retargeting, motion capture, voice, sign-language recognition, payment SDKs, and roughly 30 MCP servers), keeps runnable code samples in its documentation, and maintains a public changelog with RSS and JSON feeds. It is a member of NVIDIA Inception and an OpenAI Select Partner.

## Try it in ten minutes

1.  Open [three.ws/create](https://three.ws/create) and type a description of any object. Download the GLB it hands back.
2.  Open [three.ws](https://three.ws) and generate an avatar from a prompt or a selfie.
3.  Drop the `<agent-3d>` embed snippet from the docs into any HTML page and watch your avatar live on your own site.
4.  Open [three.ws/play](https://three.ws/play), enter the pinned home-town world, and walk up to someone.

That sequence, prompt to asset to embed to world, is the whole thesis of the platform in miniature, and it requires no account at any step.

## Join the meetup, inside the platform

This user group's next event is a community meetup held inside three.ws itself: **Tuesday, August 18, 12:00 PM to 1:00 PM ET, in the flagship world at [three.ws/play](https://three.ws/play)**. Attendance is a browser tab: no download, no account. Expect a guided tour of everything described above from inside the world, live demos from community members, and open Q&A with the three.ws team. If you have never used a 3D world, arrive ten minutes early and you will be walking and talking before the event starts. Full details are on the group's Events tab.

## Frequently asked questions

**Is the text-to-3D generator really free?**  
Yes. The free lane requires no account or key. Generated models are downloadable GLBs you can use in any engine or viewer.

**What browsers and hardware do the 3D worlds need?**  
A current Chrome, Edge, Firefox or Safari on an ordinary laptop. The renderer is Three.js over WebGL with aggressive asset compression; there is no install.

**Do I need cryptocurrency to use the platform?**  
No. Creation, embedding, and open worlds are free and account-optional. A wallet becomes relevant only for token-gated world tiers, premium cosmetics, and the agent-payment features. The platform has an associated token ($THREE) used within those surfaces; nothing in this article is investment advice, and none of it is required to attend the meetup or use the tools described.

**Can my team embed an avatar or a world in our own product?**  
Yes. The `<agent-3d>` web component covers avatars, oEmbed covers link unfurls, and the platform documentation covers embedding worlds, including a transparent-background mode for compositing onto host pages.

**Where is the source?**  
The platform repository is public at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws), and the SDKs and MCP servers are on npm under the `@three-ws` scope.

## Further reading

-   Documentation: [three.ws/docs](https://three.ws/docs)
-   The in-game economy reference, rendered live from the running server: [three.ws/play/economy](https://three.ws/play/economy)
-   Public changelog: [three.ws/changelog](https://three.ws/changelog)
-   This group's welcome thread and platform tour, pinned on the group home page.
