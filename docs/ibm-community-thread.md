# Community Meetup This Friday, Inside three.ws: Join Us on the $THREE Server at three.ws/play

_Posted by the three.ws team. This Friday we are holding our first community meetup, and it is not a video call: it happens inside the platform, in the flagship world at [three.ws/play](https://three.ws/play). This post covers everything you need to join, what the venue actually is, and (for those who want the long read) a full tour of what we have built, the technology behind it, and where we are taking it._

## The event

|  |  |
| --- | --- |
| **When** | Friday, August 7, 2026, 8:00 AM to 9:00 AM Pacific Time (11:00 AM to 12:00 PM Eastern) |
| **Your time** | 8 AM San Francisco · 11 AM New York · 4 PM London · 5 PM Berlin · 8:30 PM Mumbai · 11 PM Singapore/Hong Kong · midnight Tokyo |
| **Where** | [three.ws/play](https://three.ws/play), in the $THREE home town (pinned at the top of the world list) |
| **Cost** | Free |
| **What you need** | A modern browser. No download, no install, no account required. |

On the agenda: a live tour of the platform from inside the world, demos from community members (bring what you have built), open Q&A with the team, and a first look at what is coming next. If you have never been in a 3D world before, come 10 minutes early and we will get you walking and talking before it starts.

## How to join, in three steps

1.  **Open [three.ws/play](https://three.ws/play)** at the event time and click the pinned $THREE world.
2.  **Pick an avatar.** Guests get one automatically. If you want a custom one, make it beforehand at [three.ws](https://three.ws) from a text prompt or a selfie; it follows you into the world.
3.  **Walk up to people and talk.** Voice chat is spatial: you hear the people near you, from the direction they stand, and they fade as you walk away. Text chat works too.

## About the venue: what three.ws/play actually is

three.ws/play is Coin Communities: a persistent multiplayer 3D world that runs entirely in the browser. Every world is a real place, with terrain, buildings, NPCs, a day-night cycle, a working in-game economy, and the other people who are there with you. Three things make it a genuinely practical event venue:

-   **It is a URL.** No client, no launcher, no account wall. If you can open a web page, you can attend.
-   **Every world is a shareable link.** A community's world is `three.ws/play?coin=<mint>`. Post the link anywhere and everyone who clicks it lands in the same world, together.
-   **Worlds are persistent.** There is a collaborative, Minecraft-style building layer, saved server-side per world. What a community builds is still there tomorrow.

And this is not just our venue. **Every pump.fun coin already has a world**, derived from its mint address the moment the coin exists. Any community that wants to hold its own meetup can do exactly what we are doing on Friday: take its mint, share the link, show up. Creators can optionally token-gate their world's Holders tier, verified server-side against real on-chain balances, while the general tier stays open. We wrote up the full guide, including the URL parameters and the APIs behind it, on the event page in this group's Events tab.

Inside a world you get spatial voice chat, text chat, the building layer, a real economy (vendors, banking, daily quests, crew heists; game cash and $THREE are deliberately separate currencies, and gameplay never pays out tokens), vehicles, and live market data on in-world screens. The $THREE home town, where we will be on Friday, is the platform's permanent flagship world.

## The platform behind the venue

For those who found this group recently: /play is one surface of a larger platform. The short tour of what is live today, grouped the way a new user meets it.

### 1\. Creation: from words to 3D assets

-   **The Forge, a free text-to-3D generator.** Describe anything in plain language and get a downloadable, textured 3D model in about a minute. No key, no account.
-   **Selfie to 3D avatar** and **prompt to avatar**: one photo or one sentence becomes a rigged, animation-ready character.
-   **Universal rigging and animation.** Any humanoid GLB or VRM animates: a canonicalizer maps Mixamo, Avaturn, VRM/VRoid, Daz, MakeHuman, Unreal and other conventions onto one skeleton, and a retargeting layer drives the shared animation library on all of them. The Rig Doctor tool tells you in seconds whether a model will animate, and why.
-   Deeper tools when you want them: Restyle Studio (PBR materials and AI restyling), Scene Studio (a 3D scene editor in the browser), Diorama (text to a whole 3D world), AR Forge (prompt to model to your actual room), Daily Forge (a daily challenge with streaks), a full character studio, and content-credential provenance on generated assets.

### 2\. Distribution: creations go everywhere

-   **The `<agent-3d>` web component:** one script tag embeds a live, animated avatar in any website, with animations, moods and speech drivable from page code.
-   A family of embeddable products on npm: a page-walking companion, a talking page guide, a guided-tour engine, an embeddable concierge, an assistant widget.
-   **oEmbed support:** world and creation links unfurl as interactive 3D embeds on WordPress, Ghost, Discord, dev.to and Notion.
-   AR-ready exports: "view in your space" on mobile, from the browser.

### 3\. The agent economy

-   **x402 pay-per-call:** APIs charge per request in USDC, settled on-chain. An agent gets a 402 Payment Required, pays, retries, gets its answer. No API keys, no subscriptions.
-   A live paid market-data API (17 endpoints), a fabric of 480,000+ payable data endpoints, a unified service catalog, and buyer-side purchase receipts.
-   On-chain agent identity (ERC-8004), agent wallets, a fleet monitor, a live wall of agent activity, and owner takeover of an agent's screen.

### 4\. The developer platform

-   Around 30 MCP servers published under `@three-ws` on npm: 3D generation, avatars, scenes, spatial responses, market intel, payments and more, usable from Claude, Cursor, or any MCP-capable client.
-   Two are IBM-specific, which this community may appreciate: `@three-ws/ibm-watsonx-mcp` (watsonx.ai chat, generation, embeddings, tokenization and forecasting on your own IBM Cloud account) and `@three-ws/ibm-x402-mcp` (pay-per-use IBM Granite over MCP, billed in USDC, no IBM account required).
-   60+ published npm packages overall: avatar SDK and CLI, GLB tools, retargeting, mocap, voice, sign-language recognition, Solana agent SDK, payment SDKs, and more. Docs with runnable samples, a cookbook, an examples gallery, and free 3D and crypto-data APIs.

## The technology stack

-   **Frontend:** vanilla JavaScript modules with Vite, Three.js for rendering, Rapier (WebAssembly) physics, meshopt-compressed assets. No framework, which is what keeps pages fast and embeds lightweight.
-   **3D generation:** a GPU worker fleet on Google Cloud Run running open models (Hunyuan3D, TRELLIS, TripoSG, TripoSR), plus dedicated workers for background removal, segmentation, remeshing, texturing, stylization, garments, photo-based avatar reconstruction, automatic rigging, text-to-motion, video-to-motion and video-to-scene. Every lane has a failover chain; workers scale to zero when idle.
-   **Multiplayer:** an authoritative Colyseus server on Cloud Run. One room definition filtered by coin mint gives every community an isolated world on shared infrastructure: 50 players per room instance with automatic spillover, 15 Hz binary delta sync (roughly 24 bytes per player per update, about 18 KB/s for a full room), server-side validation on every message, per-world persistence. Voice is a proximity-gated WebRTC mesh with positional audio; the server only relays signaling.
-   **Backend:** a single container on Cloud Run serves the static frontend and every API handler, with 103 scheduled jobs on Cloud Scheduler, Cloud Build deploys, a global load balancer and CDN, and Neon Postgres.
-   **AI and chain:** Vertex AI (Gemini and Imagen) behind a multi-provider LLM failover chain, the same failover discipline on Solana RPC. Solana is the home chain; $THREE lives there and the x402 rail settles there in USDC.
-   **Programs:** NVIDIA Inception member, OpenAI Select Partner.

## What we are building next

-   **Event infrastructure for /play.** Friday is checkpoint one. Scheduled community events surfaced in the world lobby and on world cards, richer creator controls, and capacity work backed by load tests against production.
-   **Deeper agent autonomy:** more payable services, more MCP surface, better tooling for agents that earn and spend without a human in the loop.
-   **Tightening the creation-to-commerce loop** from "I typed a prompt" to "my creation is embedded, animated, and earning".
-   **Scale-out:** the room architecture already shards; cluster-aware matchmaking across machines is a configuration change on the current stack, planned for when sustained concurrency demands it.

## Where we are trying to take this

People ask why we work at this pace, so here is the honest version of the growth thesis. It is a thesis, not a promise, and none of it is financial advice.

1.  **Three markets converge here.** Generative 3D removes the skill gate from 3D content creation; AI agents are the fastest-growing software category; and token communities mint thousands of new micro-communities daily, each needing tools and places to gather. One stack serving all three is rare.
2.  **Distribution is built into the product.** The free tools are the top of the funnel, every creation is downloadable and embeddable, and every world is a shareable URL. The product spreads itself, which keeps acquisition cost near zero.
3.  **The venue layer compounds.** Every pump.fun coin already has a world here at zero marginal provisioning cost. Communities that gather somewhere tend to keep gathering there.
4.  **Machine-to-machine commerce scales without headcount.** When agents pay per call, revenue tracks API traffic rather than a sales team, and we publish the tooling that makes other developers' services payable too.
5.  **The cost structure is lean by design.** One container, GPU workers that scale to zero, a 50-player world costing kilobytes per second, and the browser as the client.
6.  **$THREE keeps the community and the platform aligned.** The coin gates cosmetic and premium surfaces, the changelog streams to holders, and the flagship world is the token's own town square. (Contract address: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`, on Solana.)
7.  **The precedents are large.** Roblox built enormous value on user-created worlds with a downloaded client and a closed engine. We are building open, browser-native, AI-generated and agent-operated, and we think that combination earns a meaningful share of what comes next. That is the ambition behind the $1B number we hold ourselves to internally.

Everything above is live and verifiable today; judge the thesis by the product, and Friday is a good day to do exactly that.

## See you Friday

**Friday, August 7, 8 AM PT / 11 AM ET (4 PM London, 11 PM Singapore), on the $THREE server at [three.ws/play](https://three.ws/play).** Show up as an avatar, tour the platform from inside it, demo what you have built, and ask us anything. Details on this group's Events tab.

## Links

-   Platform: [three.ws](https://three.ws)
-   Free text-to-3D: [three.ws/create](https://three.ws/create)
-   The worlds: [three.ws/play](https://three.ws/play)
-   Docs: [three.ws/docs](https://three.ws/docs)
-   Changelog: [three.ws/changelog](https://three.ws/changelog)
-   GitHub: [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)
-   X: [@trythreews](https://x.com/trythreews)

_Questions, skepticism, and feature requests all welcome below. The skeptical ones are the most useful._
