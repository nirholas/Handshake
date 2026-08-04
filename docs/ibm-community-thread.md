# Everything We Have Built at three.ws: The Free AI 3D Engine, Embeddable Agents, the x402 Agent Economy, and Why We Are Building Toward a $1B Platform

_Posted by the three.ws team. This is the long one: what three.ws is, everything that is live today, the full technology stack, what we are building next, and the honest version of why we believe this platform grows into a billion-dollar company. Grab a coffee. And mark your calendar: our first community meetup happens inside the platform itself, on the $THREE server at [three.ws/play](https://three.ws/play), Tuesday, August 18 at 12 PM ET._

## What is three.ws, in one paragraph

three.ws is the AI-agent layer for the open web. The tagline is four words: **give your AI a body.** In practice that means a free AI 3D model generator (type a prompt, get a downloadable textured GLB in about a minute, no account), an AI avatar generator (a selfie or a sentence becomes a rigged, animation-ready 3D character), a one-script-tag embed that puts a living, talking 3D agent on any website, a browser MMO where every token community has its own persistent 3D world, and an agent economy where autonomous agents discover, call, and pay each other per request in USDC. All of it runs in the browser. None of it requires a download, a game engine, or a 3D artist.

## Everything that is live today

We ship constantly (the public changelog at [three.ws/changelog](https://three.ws/changelog) is the receipt; it pushes to our holders' Telegram automatically on every deploy). Here is the map of what exists right now, grouped the way a new user meets it.

### 1\. Creation: from words to 3D assets

-   **The Forge, our free text-to-3D generator.** Describe anything in plain language and get a downloadable, textured 3D model. Free lane, no key, no account. This is the front door of the platform and the single most-shared feature we have.
-   **Selfie to 3D avatar.** One photo becomes a rigged humanoid avatar you can pose, animate, and drop into any page or world.
-   **Prompt to avatar.** "A knight in obsidian armor" becomes a walking, talking character, mesh plus skeleton in one step.
-   **Universal rigging and animation.** Bring any humanoid GLB or VRM and it animates. There is no allowlist: our canonicalizer maps Mixamo, Avaturn, VRM/VRoid, Daz, MakeHuman, Unreal and more onto one canonical skeleton, and our retargeter drives the full clip library on all of them. The Rig Doctor tool tells you in seconds whether any model will animate, and why.
-   **Restyle Studio** (PBR material editing plus AI restyling and variants), **Scene Studio** (a full 3D scene editor in the browser), **Diorama** (text to a whole 3D world), **AR Forge** (prompt to model to your actual room), **Daily Forge** (a daily creation challenge with creator streaks), and a **character studio** for deep avatar customization.
-   **Verifiable 3D provenance.** Content credentials on generated assets, so a model can prove where it came from.

### 2\. Distribution: your creation goes everywhere

-   **The `<agent-3d>` web component.** One script tag embeds a live, animated three.ws avatar in any website, any framework. Moods, animations, and speech are drivable from page code.
-   **A family of embeddable products**, all published on npm: the walk companion (a mascot that strolls your page), the page agent (a talking guide for any page), the guided tour engine, the concierge (embeddable AI support chat with a face), and the assistant widget.
-   **oEmbed provider.** Links to three.ws worlds and creations unfurl as interactive 3D embeds on WordPress, Ghost, Discord, dev.to, and Notion.
-   **AR-ready exports.** "View in your space" on mobile, straight from the browser.

### 3\. The worlds: /play, /walk, and the venue layer

-   **[three.ws/play](https://three.ws/play) is Coin Communities:** a browser isometric MMO where every token community has its own persistent 3D world. Spatial voice chat (walk up to someone and you hear them, from their direction), collaborative Minecraft-style building that persists per world, a real in-game economy with vendors, banks, quests and heists, NPCs, vehicles, day-night cycles, and live market data on in-world screens.
-   **Every pump.fun coin already has a world.** Not "can request one". Has one: `three.ws/play?coin=<mint>` is a complete meetup venue for any community, live the moment the coin exists. Creators can token-gate their Holders tier, verified server-side against real on-chain balances.
-   **The $THREE home town** is the flagship world, pinned at the top of the lobby. That is where the August 18 meetup happens.
-   **/walk** is the open walkaround world, **Crew HQ** gives crews a 3D presence room, and **Docs World** renders our documentation as an immersive 3D space, because we could not resist.

### 4\. The agent economy: machines paying machines

This is the part most people have not seen anywhere else. three.ws agents are not chatbots with costumes; they are economic actors.

-   **x402 pay-per-call.** Any API on the platform can charge per request in USDC, settled on-chain. An agent hits an endpoint, gets a 402 Payment Required, pays, and gets its answer, with no API key, no subscription, no sales call.
-   **A live paid Market Data API** (17 endpoints) and a **datapoint fabric exposing 480,000+ payable endpoints**, plus a unified service catalog, buyer-side receipt vault, and marketplace analytics.
-   **On-chain agent identity (ERC-8004)**, agent wallets, a fleet monitor, a live agents wall showing what every agent is doing in real time, and "take the wheel": watch an agent's screen and drive it yourself.
-   **Launch tooling.** Agents and creators can launch coins through the platform, and every launch gets its 3D world on day one.

### 5\. The developer platform: MCP, SDKs, and open source

-   **Around 30 MCP servers** published under `@three-ws` on npm, covering 3D generation, avatars, scenes, spatial responses (3D as a native MCP response type), market intel, notifications, payments, and more. If you use Claude, Cursor, or any MCP-capable client, three.ws capabilities plug straight in.
-   **Two of them are IBM-specific**, which this community may appreciate: `@three-ws/ibm-watsonx-mcp` (chat, generation, embeddings, tokenization, forecasting and model discovery against your own IBM Cloud watsonx.ai account) and `@three-ws/ibm-x402-mcp` (pay-per-use IBM Granite models over MCP, billed in USDC on Solana, no IBM account required). We think Granite-over-x402 is one of the cleanest demonstrations anywhere of what agent-native billing looks like.
-   **60+ published npm packages** in total: the avatar SDK and CLI, GLB tools, retargeting, mocap, voice, sign-language recognition, forge clients, Solana agent SDK, agent payments SDK, an X/Twitter automation toolkit, and more.
-   **Live Docs** (every code sample runs in place), a cookbook of runnable recipes, an examples gallery, and a free 3D API plus a free crypto data API for anyone to build on.

### 6\. The platform glue people do not see

-   **The agent shell.** Every visitor gets a named companion agent within five seconds of landing, and the command palette executes real platform actions in place: forge a model, stream a chat, pull live market data.
-   **Cross-entity search, rankings, streaks and badges, a follow graph, notifications, an activity feed**, creator portfolios, and a daily agent-output arena.
-   **Cinematic rendering quality bar** shared by every 3D viewer on the platform, and a frame governor so worlds are polite to laptop batteries.

## The technology stack, all of it

For the engineers. This is the real stack, not the marketing version.

-   **Frontend:** vanilla JavaScript modules with Vite. No framework. Three.js for rendering, Rapier (WebAssembly) for physics, meshopt-compressed GLBs, instanced rendering for voxel builds. The whole site is static files plus web components, which is why every page loads fast and embeds anywhere.
-   **3D generation:** a GPU worker fleet on Google Cloud Run running open models including Hunyuan3D, TRELLIS, TripoSG and TripoSR for meshes, plus dedicated workers for background removal, segmentation, remeshing, texturing, stylization, garment generation, avatar reconstruction from photos, automatic rigging (UniRig lineage), text-to-motion, video-to-motion, and video-to-scene. Every lane has a failover chain, so one model being down never takes the feature down.
-   **Multiplayer:** an authoritative Colyseus (Node.js) server on Cloud Run. One room definition filtered by coin mint gives every community an isolated world on shared infrastructure. 50 players per room instance with automatic spillover, 15 Hz binary delta state sync at roughly 24 bytes per player per update, server-side validation on every message (movement clamps, bounds, rate limits, type checks), and per-world persistence. Voice is a proximity-gated WebRTC mesh with true spatial audio; the server only relays signaling and never touches audio.
-   **Backend:** a single container on Google Cloud Run serves the static frontend and every API handler, with 103 scheduled jobs on Cloud Scheduler, Cloud Build for deploys, a global load balancer and CDN in front, and Neon Postgres as the database. Boring, observable, and cheap to run, on purpose.
-   **AI:** Vertex AI (Gemini and Imagen) plus a multi-provider LLM failover chain, and the same failover discipline on Solana RPC across providers. No single upstream can take us down.
-   **Chain:** Solana first. $THREE lives on Solana, the x402 rail settles in USDC, agent identity uses ERC-8004, and additional EVM surfaces exist as secondary venues.
-   **Programs:** three.ws is an NVIDIA Inception member and an OpenAI Select Partner.

## What we are building next

Directional, and in the order we care about it:

-   **Event infrastructure for /play.** The August 18 meetup is checkpoint one. Scheduled community events surfaced in the world lobby and on world cards, richer creator controls, and capacity work backed by load tests against production, not a staging toy.
-   **Deeper agent autonomy.** More payable services, more MCP surface, and better tooling for agents that earn, spend, and maintain reputations without a human in the loop.
-   **The creation-to-commerce loop.** Tightening the path from "I typed a prompt" to "my creation is embedded on my site, animated in my world, and earning".
-   **Scale-out.** The room architecture already shards; cluster-aware matchmaking across machines is a configuration change on the current stack, planned for when sustained concurrency demands it.

## Why we believe this grows to a $1B platform

We are going to make the argument the way we would to an investor, because this community can handle it. This is a thesis, not a promise, and nothing here is financial advice.

1.  **We sit at the intersection of three markets that are each enormous alone.** 3D content creation (games, e-commerce, AR/VR, film previz) has historically been gated on expensive software and rarer skills; generative 3D removes the gate. AI agents are the fastest-growing software category in the world. And tokenized communities mint thousands of new micro-communities every single day, each one needing identity, tools, and places to gather. three.ws is the only platform we know of that serves all three with one stack.
2.  **Our customer acquisition cost rounds to zero.** The free Forge and free avatar generator are top-of-funnel that markets itself: every generated model is downloadable, every avatar is embeddable, and every embed is a live advertisement on someone else's website. Every world is a shareable URL. The product distributes the product.
3.  **The venue layer is a structural moat.** Every pump.fun coin already has a 3D world on three.ws, at zero marginal provisioning cost, because worlds are derived from mint addresses rather than provisioned. Whichever platform hosts a community's gathering place owns that community's attention. We built the venue layer before anyone else realized it was a layer.
4.  **Machine-to-machine commerce is the revenue model that scales without headcount.** When agents pay per call in USDC, revenue scales with API traffic, not with a sales team. We already operate a paid data API and a fabric of 480,000+ payable endpoints, and we publish the tooling (x402 SDKs, MCP servers) that makes every other developer's service payable too, which puts us at the toll booth of a network we are simultaneously growing.
5.  **Our cost structure is embarrassing, in a good way.** One container serves the site and APIs. GPU workers scale to zero when idle. A full 50-player world costs about 18 KB/s of egress and 5 MB of memory. The browser is our client, so our distribution cost is a CDN. Platforms with this shape (high gross margin, near-zero marginal cost per user, self-distributing product) are exactly the ones that compound into large valuations.
6.  **$THREE aligns the community with the platform.** The platform's coin gates cosmetic and premium surfaces, the changelog streams to holders, and the flagship world is the token's own town square. The people most invested in three.ws succeeding are the same people gathering inside it. (Contract address: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`, on Solana.)
7.  **The comparables are not small.** Roblox built tens of billions of dollars of value on user-created worlds with a closed engine and a downloaded client. Unity built billions on tooling. We are building open, browser-native, AI-generated, and agent-operated. If the next generation of virtual worlds and agent commerce is even a fraction of the last one, the platform that is free to enter, instant to share, and already wired for payments is positioned to take an outsized share of it.

Will the road be linear? No. But every piece listed in this post is live, verifiable, and running in production today, and the thesis above is built on those pieces, not on a whitepaper.

## Come see it instead of reading about it

**Tuesday, August 18, 12 PM ET, on the $THREE server at [three.ws/play](https://three.ws/play).** First community meetup, held inside the platform. Show up as a 3D avatar, tour everything in this post live, demo what you have built, and grill us in open Q&A. No download, no account, just a browser. Details are on this group's Events tab.

## Links

-   Platform: [three.ws](https://three.ws)
-   Free text-to-3D: [three.ws/create](https://three.ws/create)
-   The worlds: [three.ws/play](https://three.ws/play)
-   Docs: [three.ws/docs](https://three.ws/docs)
-   Changelog: [three.ws/changelog](https://three.ws/changelog)
-   GitHub: [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)
-   X: [@trythreews](https://x.com/trythreews)

_Questions, skepticism, and feature requests all welcome below. The skeptical ones are the most useful._
