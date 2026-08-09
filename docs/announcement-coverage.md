# X announcement coverage: every platform surface vs @trythreews

Source: `trythreews_tweets_2026-08-09.json` (174 posts scraped 2026-08-09, first post 2026-04-17) cross-referenced against `data/pages.json`, `packages/*`, the top-level SDKs, and `workers/` + `services/`.

Status legend: **Yes** = the surface was specifically announced or demoed in a post. **Passing** = covered only by a related, aggregate, or partner post (never given its own announcement). **No** = never referenced on X in any form.

## Summary

| Inventory | Total | Announced | Passing mention | Never announced |
|---|---|---|---|---|
| Product pages (main, build, labs, crypto, agent-tools, account, machine) | 298 | 34 | 69 | 195 |
| npm packages (`packages/*`) | 66 | 5 | 2 | 59 |
| Top-level SDKs and apps | 9 | 6 | 2 | 1 |
| GPU workers and services (infrastructure) | 37 | 2 | 4 | 31 |
| **Total** | **410** | **47** | **77** | **286** |

On top of that sit 348 learn/docs pages and 39 blog posts (content, not counted as features). Counting those, 673+ committed surfaces have never appeared on X.

Of the 174 posts: roughly 40 are product/feature announcements, the rest are partnerships, marketplace and registry listings, media coverage, community events, and token posts.

## Feature announcements made so far

| Date | Announcement | Post |
|---|---|---|
| 2026-04-29 | Launch thread: 3D body, LLM brain + memory + emotions, ERC-8004 identity, embeds | [post](https://x.com/trythreews/status/2049406826719137937) |
| 2026-04-29 | MCP Registry listing + remote MCP server | [post](https://x.com/trythreews/status/2049412062837928202) |
| 2026-04-29 | Solana agent wallets with vanity addresses | [post](https://x.com/trythreews/status/2049447738434339171) |
| 2026-04-29 | Live paid x402 endpoint (0.001 USDC per avatar) + x402scan listing | [post](https://x.com/trythreews/status/2049458671139336613) |
| 2026-04-29 | three.ws npm package + agent-3d embed | [post](https://x.com/trythreews/status/2049476546285740512) |
| 2026-04-29 | Agent-payments SDK reverse-engineered and open-sourced | [post](https://x.com/trythreews/status/2049567362693963905) |
| 2026-04-29 | Launchpad agent skills: swap, create coins, collect fees, snipe, trade | [post](https://x.com/trythreews/status/2049573582247022869) |
| 2026-04-29 | Avatar reacts live to its own on-chain events | [post](https://x.com/trythreews/status/2049576023856181676) |
| 2026-05-01 | /pumpfun live announcer: graduations, whale buys, claims, custom layout | [post](https://x.com/trythreews/status/2050049239301165535) |
| 2026-05-02 | Chat rebuilt: live thoughts, TTS, emotions as tools, MCP, artifacts, inline charts, agent selector | [post](https://x.com/trythreews/status/2050682956042338719) |
| 2026-05-06 | Animation and emotion control API; live coin feed inside embeds | [post](https://x.com/trythreews/status/2051858035862335505) |
| 2026-05-09 | Agent Builder: agents payable (x402 + CDP), tradeable, discoverable (/.well-known/x402.json) | [post](https://x.com/trythreews/status/2053025259645981078) |
| 2026-05-12 | Pay-per-call x402 architecture: every MCP tool call settles on-chain | [post](https://x.com/trythreews/status/2054065160491499951) |
| 2026-05-15 | Embed editor: one line of HTML, live preview, device frames, AR, voice | [post](https://x.com/trythreews/status/2055307440921702738) |
| 2026-05-22 | 2,500 new 3D animations | [post](https://x.com/trythreews/status/2057721370310775223) |
| 2026-05-22 | @three-ws/avatar-agent MCP server on npm | [post](https://x.com/trythreews/status/2057782522994684413) |
| 2026-05-27 | Emotion blending, memory, cloned voice + lip-sync, autonomous skill calls (AWS thread) | [post](https://x.com/trythreews/status/2059456294189498830) |
| 2026-05-30 | /play: live multiplayer 3D townhall for any launchpad coin | [post](https://x.com/trythreews/status/2060749325404361113) |
| 2026-06-02 | Animations and Poses Studio | [post](https://x.com/trythreews/status/2061713039624405062) |
| 2026-06-04 | Two MCP servers: x402 Bazaar discovery + pay-and-call in USDC | [post](https://x.com/trythreews/status/2062325751840432172) |
| 2026-06-09 | Agent-to-agent payments, 1-of-1 3D worlds per coin, x402 microtransactions | [post](https://x.com/trythreews/status/2064306640313360511) |
| 2026-06-12 | Prompt-to-3D engine (/forge) + Scene Studio (/scene) | [post](https://x.com/trythreews/status/2065382633014542744) |
| 2026-06-20 | Autonomous 24/7 trading agents, sniping live inside a 3D world | [post](https://x.com/trythreews/status/2068290242109726994) |
| 2026-06-22 | Drop-in x402 payment modal; /x402 live demo; /club demo with agent reputation | [post](https://x.com/trythreews/status/2068951336918638699) |
| 2026-06-23 | "The Stripe of x402" article: agent payments in one line of code | [post](https://x.com/trythreews/status/2069309191089717280) |
| 2026-06-23 | Local image-to-3D lane: Nemotron, FLUX, TRELLIS on DGX Spark | [post](https://x.com/trythreews/status/2069510627299860827) |
| 2026-07-01 | VS Code x402 extension: pay-per-call APIs with built-in wallet | [post](https://x.com/trythreews/status/2072133364765831371) |
| 2026-07-06 | 3,000+ animations: largest animation library in existence | [post](https://x.com/trythreews/status/2073943451499131112) |
| 2026-07-08 | Tour: 3D guides that walk your live site (/tour, /walk, /tour-builder) | [post](https://x.com/trythreews/status/2074759289668039153) |
| 2026-07-08 | "70+ packages on npm" (aggregate mention; only tour and walk named) | [post](https://x.com/trythreews/status/2074761553346478138) |
| 2026-07-10 | Crypto intelligence platform: real-time market context for agents | [post](https://x.com/trythreews/status/2075378343323795903) |
| 2026-07-15 | 3D Studio inside ChatGPT; AR placement; /irl world map | [post](https://x.com/trythreews/status/2077196551018213486) |
| 2026-07-23 | 500+ free CC0 3D props library | [post](https://x.com/trythreews/status/2080151348629356727) |
| 2026-07-24 | 10k+ x402 transactions; stats dashboard teased (reply) | [post](https://x.com/trythreews/status/2080779347359908347) |
| 2026-07-25 | Sketch/photo to rigged 3D agent: multi-view Forge reconstruction | [post](https://x.com/trythreews/status/2080987792734343495) |
| 2026-07-25 | Forged avatar hired as autonomous trader with on-chain profile | [post](https://x.com/trythreews/status/2081030781049422130) |
| 2026-08-01 | Sign language: fingerspelling avatars, webcam sign reading, /api/sign, sign_text MCP tool | [post](https://x.com/trythreews/status/2083675644463038810) |
| 2026-08-07 | Live meetup inside the $THREE world: spatial voice, 3,145 peak concurrent avatars | [post](https://x.com/trythreews/status/2085742637529870405) |

Partnership and distribution posts (not feature announcements): Google Cloud, Alibaba Cloud, IBM (Business Partner, user group, live builds), AWS (Partner Network + Marketplace), W3C membership, .sol naming, MCP Registry and directory listings, x402 Bazaar verified provider, MetaMask Agent Wallet early access, security partner, NVIDIA Inception, OpenAI Partner Network, Hugging Face, hackathons, Product Hunt, the podcast, press features, exchange/token listings, and community meetups.

## Full inventory: product pages

### Main product surfaces (51 pages, 33 never announced)

| Path | Feature | Added | Announced | First/main post |
|---|---|---|---|---|
| `/` | Home | 2026-04-16 | Yes | [2026-04-29](https://x.com/trythreews/status/2049406826719137937) |
| `/discover` | Discover | 2026-04-17 | Passing | [2026-05-09](https://x.com/trythreews/status/2053025259645981078) |
| `/gallery` | Avatar Gallery | 2026-05-13 | Passing | [2026-05-15](https://x.com/trythreews/status/2055307440921702738) |
| `/animations` | Animation Gallery | 2026-06-17 | Yes | [2026-05-22](https://x.com/trythreews/status/2057721370310775223), [2026-07-06](https://x.com/trythreews/status/2073943451499131112) |
| `/gestures` | Agent Gestures | 2026-07-30 | No |  |
| `/choreograph` | Choreographer | 2026-07-31 | No |  |
| `/character-library` | Character Library | 2026-07-19 | No |  |
| `/sign-language` | Sign Language Avatars | 2026-07-20 | Yes | [2026-08-01](https://x.com/trythreews/status/2083675644463038810) |
| `/asl-alphabet` | ASL Alphabet | 2026-07-30 | Yes | [2026-08-01](https://x.com/trythreews/status/2083675644463038810) |
| `/sign-mirror` | Sign Mirror | 2026-08-06 | Yes | [2026-08-01](https://x.com/trythreews/status/2083675644463038810) |
| `/objects` | Object Library | 2026-07-21 | Yes | [2026-07-23](https://x.com/trythreews/status/2080151348629356727) |
| `/forged` | Agent-Forged Gallery | 2026-07-25 | No |  |
| `/wardrobe` | Wardrobe | 2026-07-26 | No |  |
| `/diorama` | Diorama | 2026-07-01 | No |  |
| `/mocap-studio` | Mocap Studio | 2026-07-01 | No |  |
| `/autopilot` | Coin Autopilot | 2026-07-01 | No |  |
| `/agenc/embodied` | AgenC · Embodied | 2026-07-01 | No |  |
| `/agenc/room` | AgenC · Task Room | 2026-07-01 | No |  |
| `/create/video` | Talking Avatar Video | 2026-07-01 | No |  |
| `/temporary` | Drive Your Avatar | 2026-05-10 | No |  |
| `/irl` | IRL | 2026-06-13 | Yes | [2026-07-15](https://x.com/trythreews/status/2077196551018213486) |
| `/irl-privacy` | How location works on IRL | 2026-06-17 | Passing | [2026-07-15](https://x.com/trythreews/status/2077196551018213486) |
| `/alpha-copilot` | Alpha Co-pilot: your agent narrates its own alpha | 2026-06-23 | No |  |
| `/world-lines` | World Lines: agent proof-of-presence quests | 2026-06-23 | No |  |
| `/marketplace` | Marketplace | 2026-04-29 | Passing | [2026-05-09](https://x.com/trythreews/status/2053025259645981078) |
| `/marketplace/analytics` | Marketplace Analytics | 2026-06-17 | No |  |
| `/conversions` | Trial Conversions | 2026-07-31 | No |  |
| `/collection` | My Collection | 2026-06-17 | No |  |
| `/notifications` | Notifications | 2026-07-12 | No |  |
| `/skills` | Skills Marketplace | 2026-05-27 | Passing | [2026-04-29](https://x.com/trythreews/status/2049573582247022869) |
| `/community` | Community | 2026-05-04 | No |  |
| `/crews` | Crew HQ | 2026-07-31 | No |  |
| `/search` | Search | 2026-07-12 | No |  |
| `/atlas` | Atlas | 2026-07-31 | No |  |
| `/sitemap` | Sitemap | 2026-05-13 | No |  |
| `/characters` | Characters | 2026-05-25 | No |  |
| `/what-is` | What is three.ws? | 2026-06-05 | Passing | [2026-04-29](https://x.com/trythreews/status/2049406826719137937) |
| `/pitch` | Pitch Deck | 2026-06-22 | No |  |
| `/timeline` | The Story So Far | 2026-07-25 | No |  |
| `/tour` | Guided Tour | 2026-06-20 | Yes | [2026-07-08](https://x.com/trythreews/status/2074759289668039153) |
| `/tour/atlas` | Tour Atlas | 2026-07-31 | Passing | [2026-07-08](https://x.com/trythreews/status/2074759289668039153) |
| `/walk` | Walk Anywhere on the Web | 2026-06-21 | Yes | [2026-07-08](https://x.com/trythreews/status/2074759289668039153) |
| `/concierge` | Concierge: AI Chat Widget | 2026-07-18 | No |  |
| `/feed` | Feed | 2026-06-21 | No |  |
| `/partners` | Partner Ecosystem | 2026-06-27 | Passing | [2026-05-06](https://x.com/trythreews/status/2052167399399735476) |
| `/openai` | three.ws is an OpenAI Select Partner | 2026-07-25 | Yes | [2026-07-15](https://x.com/trythreews/status/2077196551018213486) |
| `/nvidia` | three.ws on NVIDIA | 2026-07-30 | No |  |
| `/press` | Press kit | 2026-07-29 | No |  |
| `/pricing` | Pricing |  | No |  |
| `/showcase` | Showcase |  | No |  |
| `/demos` | Lab Demos |  | No |  |

### Build: creation tools (59 pages, 34 never announced)

| Path | Feature | Added | Announced | First/main post |
|---|---|---|---|---|
| `/assistant` | Assistant widget | 2026-07-18 | No |  |
| `/embed-doctor` | Embed Doctor | 2026-07-31 | No |  |
| `/agora` | Agora: the Commons | 2026-06-24 | No |  |
| `/start` | Get Started | 2026-05-27 | No |  |
| `/create` | Create | 2026-04-16 | Yes | [2026-04-29](https://x.com/trythreews/status/2049406826719137937) |
| `/genome` | Agent Genome: breed two agents | 2026-06-23 | No |  |
| `/genesis` | Instant Agent Genesis | 2026-06-23 | No |  |
| `/create-agent` | Create an Agent | 2026-06-05 | Yes | [2026-05-09](https://x.com/trythreews/status/2053025259645981078) |
| `/agent-screen` | Agent Screen | 2026-06-26 | No |  |
| `/agents-live` | Live Agents | 2026-06-27 | No |  |
| `/monitor` | Agent Monitor | 2026-08-01 | No |  |
| `/agent-studio` | Agent Studio | 2026-06-19 | Passing | [2026-05-09](https://x.com/trythreews/status/2053025259645981078) |
| `/app` | Viewer | 2026-04-17 | No |  |
| `/create/prompt` | Describe it to 3D | 2026-06-05 | Passing | [2026-06-12](https://x.com/trythreews/status/2065382633014542744) |
| `/forge` | Forge: Text & Image to 3D | 2026-06-04 | Yes | [2026-06-12](https://x.com/trythreews/status/2065382633014542744), [2026-07-15](https://x.com/trythreews/status/2077196551018213486), [2026-07-25](https://x.com/trythreews/status/2080987792734343495) |
| `/image-to-3d` | Image to 3D: Turn a Photo into a 3D Model | 2026-07-17 | Yes | [2026-06-23](https://x.com/trythreews/status/2069510627299860827), [2026-07-25](https://x.com/trythreews/status/2080987792734343495) |
| `/forge-max` | Forge Max: Highest-Quality Text & Image to 3D | 2026-07-25 | No |  |
| `/restyle` | Restyle Studio: material presets, AI restyle & variants | 2026-07-08 | No |  |
| `/avatar-engines` | Avatar Engines Atlas | 2026-06-26 | No |  |
| `/splat` | Splat Viewer: Photoreal Gaussian Avatars | 2026-06-26 | No |  |
| `/capture` | Scene Capture: Video to 3D Point Cloud | 2026-06-27 | No |  |
| `/motion-swap` | Motion Swap: Replace Yourself in Video with Your Avatar | 2026-07-19 | No |  |
| `/forge-nim` | Forge · NIM: Self-Hosted Image to 3D | 2026-06-23 | Passing | [2026-06-23](https://x.com/trythreews/status/2069510627299860827) |
| `/forge-spark` | Text → 3D: Nemotron → FLUX → TRELLIS | 2026-06-23 | Yes | [2026-06-23](https://x.com/trythreews/status/2069510627299860827) |
| `/forge-studio` | Studio: Object + Avatar from text | 2026-06-21 | Passing | [2026-06-12](https://x.com/trythreews/status/2065382633014542744) |
| `/cosmos` | Cosmos: Living Worlds | 2026-06-23 | No |  |
| `/scene` | Scene Studio | 2026-06-12 | Yes | [2026-06-12](https://x.com/trythreews/status/2065382633014542744) |
| `/compose` | Scene Composer | 2026-06-13 | Passing | [2026-06-12](https://x.com/trythreews/status/2065382633014542744) |
| `/pose` | Animation Studio | 2026-06-17 | Yes | [2026-06-02](https://x.com/trythreews/status/2061713039624405062) |
| `/validation` | glTF Validator | 2026-04-17 | No |  |
| `/studio` | Widget Studio | 2026-05-24 | Yes | [2026-05-15](https://x.com/trythreews/status/2055307440921702738), [2026-05-09](https://x.com/trythreews/status/2053025259645981078) |
| `/artifact` | Artifact Viewer | 2026-04-17 | Passing | [2026-05-02](https://x.com/trythreews/status/2050682956042338719) |
| `/widgets` | Widgets Gallery | 2026-04-15 | No |  |
| `/hydrate` | Hydrate | 2026-05-20 | No |  |
| `/integrations` | Integrations | 2026-06-26 | No |  |
| `/features` | Features | 2026-04-14 | Passing | [2026-04-29](https://x.com/trythreews/status/2049406826719137937) |
| `/features/ar` | AR & WebXR: Place Any 3D Agent in Your Real World | 2026-06-13 | Passing | [2026-07-15](https://x.com/trythreews/status/2077196551018213486) |
| `/features/forge` | Forge: Text & Image to 3D Models | 2026-06-05 | Passing | [2026-06-12](https://x.com/trythreews/status/2065382633014542744) |
| `/features/scan` | Scan: Selfie to 3D Avatar | 2026-06-05 | No |  |
| `/features/play` | Play: Live 3D Coin Worlds | 2026-06-05 | Passing | [2026-05-30](https://x.com/trythreews/status/2060749325404361113) |
| `/features/walk` | Walk: 3D Avatar AR | 2026-06-05 | Passing | [2026-07-08](https://x.com/trythreews/status/2074759289668039153) |
| `/features/studio` | Studio: Embeddable AI Widget Builder | 2026-06-05 | Passing | [2026-05-15](https://x.com/trythreews/status/2055307440921702738) |
| `/features/marketplace` | Marketplace: Discover and Fork AI Agents | 2026-06-05 | No |  |
| `/features/agent-exchange` | Agent Exchange: AI Agents Paying Each Other | 2026-06-05 | Passing | [2026-06-09](https://x.com/trythreews/status/2064306640313360511) |
| `/features/deploy` | Deploy: On-Chain Agent Identity | 2026-06-05 | Passing | [2026-04-29](https://x.com/trythreews/status/2049406826719137937) |
| `/create/selfie` | Selfie to Avatar | 2026-05-25 | No |  |
| `/import/rpm` | Import an avatar URL | 2026-05-25 | No |  |
| `/threews/claim` | Claim threews.sol Subdomain | 2026-05-25 | Passing | [2026-05-07](https://x.com/trythreews/status/2052181307002929363) |
| `/voice` | Voice Lab | 2026-06-05 | No |  |
| `/dad` | Make Dad a 3D Avatar | 2026-06-21 | No |  |
| `/ca2x402` | CA → x402 | 2026-06-23 | No |  |
| `/avatar-studio` | Avatar Studio |  | Passing | [2026-04-29](https://x.com/trythreews/status/2049406826719137937) |
| `/nim-forge` | TRELLIS NIM Forge |  | Passing | [2026-06-23](https://x.com/trythreews/status/2069510627299860827) |
| `/avatar-sdk` | Avatar SDK |  | No |  |
| `/inspect` | Model Inspector | 2026-07-31 | No |  |
| `/avatar-cli` | Avatar CLI | 2026-07-30 | No |  |
| `/render-lab` | Render Lab | 2026-07-31 | No |  |
| `/rig-doctor` | Rig Doctor | 2026-07-31 | No |  |
| `/bundles` | Skill Bundles | 2026-07-31 | No |  |

### Labs (20 pages, 16 never announced)

| Path | Feature | Added | Announced | First/main post |
|---|---|---|---|---|
| `/launchpad` | Launchpad Studio | 2026-05-18 | No |  |
| `/brain` | Multi-LLM Brain | 2026-05-27 | Passing | [2026-04-29](https://x.com/trythreews/status/2049406826719137937) |
| `/lipsync` | Lipsync (TTS) | 2026-05-17 | Passing | [2026-05-27](https://x.com/trythreews/status/2059456294189498830) |
| `/lipsync/mic` | Lipsync (Mic) | 2026-05-17 | Passing | [2026-05-27](https://x.com/trythreews/status/2059456294189498830) |
| `/avatar-artifact` | Avatar Artifact | 2026-04-28 | No |  |
| `/viewer` | glTF / GLB Viewer | 2026-07-08 | No |  |
| `/watch` | Generation Watch | 2026-07-29 | No |  |
| `/ar` | AR Forge | 2026-07-14 | Passing | [2026-07-15](https://x.com/trythreews/status/2077196551018213486) |
| `/ar/studio` | AR Studio | 2026-07-17 | No |  |
| `/daily` | Daily Forge | 2026-07-17 | No |  |
| `/spatial-mcp` | Spatial MCP: reference renderer | 2026-07-08 | No |  |
| `/playground` | Playground | 2026-05-25 | No |  |
| `/labs` | Labs Showcase | 2026-06-05 | No |  |
| `/rankings` | Rankings | 2026-07-12 | No |  |
| `/daily-match` | Daily Match | 2026-07-19 | No |  |
| `/walk-leaderboard` | Walk Leaderboard | 2026-06-21 | No |  |
| `/galaxy` | Agent Galaxy |  | No |  |
| `/symphony` | Agent Symphony | 2026-07-28 | No |  |
| `/economy-lab` | Runway Lab | 2026-07-31 | No |  |
| `/holo` | Holo Sticker | 2026-08-02 | No |  |

### Crypto and the agent economy (134 pages, 83 never announced)

| Path | Feature | Added | Announced | First/main post |
|---|---|---|---|---|
| `/sperax` | Sperax on three.ws | 2026-07-05 | Yes | [2026-05-11](https://x.com/trythreews/status/2053698115203743922) |
| `/agi` | The AGI: narrow by design | 2026-06-23 | No |  |
| `/oracle` | Oracle: AI Conviction Engine | 2026-06-16 | No |  |
| `/oracle/docs` | Oracle Docs: the conviction engine, end to end | 2026-06-30 | No |  |
| `/oracle/arm` | Arm your agent: automate Oracle conviction | 2026-06-21 | No |  |
| `/activity` | Agent Activity: Oracle conviction in real time | 2026-06-16 | No |  |
| `/pipeline` | Recording Pipeline: the data loop, live | 2026-06-27 | No |  |
| `/guardian` | Guardian console: recover & inherit agent wallets | 2026-06-23 | No |  |
| `/launch` | Launch a Coin | 2026-06-15 | Passing | [2026-04-29](https://x.com/trythreews/status/2049573582247022869) |
| `/launch-studio` | Launch Studio: 50 ways to mint a coin | 2026-06-30 | No |  |
| `/launches` | Agent Launches | 2026-06-12 | No |  |
| `/minted` | Minted 3D Assets | 2026-07-08 | No |  |
| `/creations` | Creator Gallery | 2026-07-08 | No |  |
| `/theater` | Live Trading Theater | 2026-06-23 | No |  |
| `/pulse` | Money Pulse | 2026-06-23 | No |  |
| `/flow` | Money Flow Map | 2026-07-31 | No |  |
| `/x402-revenue` | Endpoint Revenue | 2026-06-30 | Passing | [2026-07-24](https://x.com/trythreews/status/2080779347359908347) |
| `/fits` | Fits: the cosmetics economy | 2026-07-28 | No |  |
| `/receipts` | Receipt Vault | 2026-07-28 | No |  |
| `/viability` | Viability | 2026-06-30 | No |  |
| `/deployments` | On-chain Deployments | 2026-06-27 | No |  |
| `/portfolio` | Wallet Portfolio | 2026-08-06 | No |  |
| `/airdrops` | Airdrop Checker | 2026-08-06 | No |  |
| `/launcher` | Memetic Launcher | 2026-06-27 | No |  |
| `/clash` | Coin Clash | 2026-06-19 | No |  |
| `/leaderboard` | Trader Leaderboard | 2026-06-15 | No |  |
| `/tracker` | KOL Tracker | 2026-07-23 | No |  |
| `/integrity` | Custody Integrity | 2026-06-23 | No |  |
| `/proof` | Verify Custody | 2026-06-23 | No |  |
| `/labor-market` | Agent Labor Market | 2026-06-23 | No |  |
| `/vaults` | Back-an-Agent Vaults | 2026-06-23 | No |  |
| `/signals` | Signal Marketplace: paid alpha feeds, ranked by proven edge | 2026-06-23 | No |  |
| `/dashboard/capabilities` | Capabilities: Alpha Hunt, Launcher, Auto-Claim & Market Maker | 2026-06-27 | No |  |
| `/arena` | The Arena: live PvP trading tournaments | 2026-06-23 | No |  |
| `/trending` | Trending: Top Agents & Coins on three.ws | 2026-06-16 | No |  |
| `/trades` | Live Trade Feed: Notable pump.fun Exits | 2026-06-16 | No |  |
| `/claim-wallet` | Claim Your Wallet: Verified pump.fun Track Record | 2026-06-16 | No |  |
| `/ghost-copy` | Ghost-copy: what if you'd copied them? | 2026-08-02 | No |  |
| `/meta-allocator` | Meta-Allocator: the ETF of degens | 2026-07-16 | No |  |
| `/clip-director` | Clip Director: every trade becomes content | 2026-07-16 | No |  |
| `/pay` | Pay (x402) | 2026-05-10 | Yes | [2026-04-29](https://x.com/trythreews/status/2049458671139336613) |
| `/x402/studio` | x402 Studio: the Stripe of x402 | 2026-06-19 | Yes | [2026-06-23](https://x.com/trythreews/status/2069309191089717280) |
| `/play/agent-wallet` | Agent Wallet (x402 on Solana) | 2026-06-11 | Passing | [2026-06-09](https://x.com/trythreews/status/2064306640313360511) |
| `/play/arena` | Sniper Arena: autonomous AI agents trading live | 2026-06-15 | Yes | [2026-06-20](https://x.com/trythreews/status/2068290242109726994) |
| `/play/war` | Coin Wars arena: two communities, one battlefield | 2026-08-08 | No |  |
| `/sniper/experiments` | Sniper Experiments: rules vs LLM judgment, scored live | 2026-07-19 | No |  |
| `/play/ufo` | Flappin UFO: retired demo | 2026-06-19 | No |  |
| `/smart-money` | Smart Money Radar: follow the wallets that win on pump.fun | 2026-06-15 | No |  |
| `/pumpfun` | Pump.fun Stream | 2026-04-29 | Yes | [2026-05-01](https://x.com/trythreews/status/2050049239301165535) |
| `/pump-live` | Pump Live | 2026-05-04 | Passing | [2026-05-01](https://x.com/trythreews/status/2050049239301165535) |
| `/terminal` | Mission Control | 2026-06-23 | No |  |
| `/radar` | Coin Radar | 2026-06-15 | No |  |
| `/watchlist` | Watchlist | 2026-06-16 | No |  |
| `/pump-dashboard` | Pump Dashboard | 2026-05-04 | Passing | [2026-05-01](https://x.com/trythreews/status/2050049239301165535) |
| `/strategy-lab` | Strategy Lab | 2026-05-15 | No |  |
| `/strategies` | Strategy Objects | 2026-06-23 | No |  |
| `/vanity-wallet` | Solana Vanity Wallet | 2026-04-29 | Yes | [2026-04-29](https://x.com/trythreews/status/2049447738434339171) |
| `/fact-check` | Fact Check | 2026-07-08 | No |  |
| `/vanity/verify` | Verify a Vanity Receipt | 2026-06-19 | Passing | [2026-04-29](https://x.com/trythreews/status/2049447738434339171) |
| `/vanity/gallery` | Proof-of-Grind Gallery | 2026-06-20 | Passing | [2026-04-29](https://x.com/trythreews/status/2049447738434339171) |
| `/vanity/premium` | Premium Vanity Inventory | 2026-07-06 | No |  |
| `/vanity/bounties` | Grind-Bounty Market | 2026-06-20 | No |  |
| `/eth-vanity` | ETH Vanity (CREATE2) | 2026-05-09 | No |  |
| `/pump-visualizer` | Pump Visualizer | 2026-05-04 | No |  |
| `/coin-intel` | Coin Intelligence | 2026-06-15 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/coins` | Coins: Live Prices & Market Caps | 2026-07-04 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/heatmap` | Crypto Market Heatmap | 2026-07-07 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/fear-greed` | Crypto Fear & Greed Index | 2026-07-07 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/gas` | Ethereum Gas Tracker | 2026-07-07 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/compare` | Compare Crypto Side by Side | 2026-07-07 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/screener` | Crypto Token Screener | 2026-07-08 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/categories` | Crypto Categories by Market Cap | 2026-07-08 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/exchanges` | Top Crypto Exchanges | 2026-07-08 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/derivatives` | Crypto Derivatives & Perpetual Futures | 2026-07-08 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/converter` | Crypto Currency Converter | 2026-07-08 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/defi` | DeFi TVL & Top Protocols | 2026-07-08 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/chains` | Blockchain TVL by Chain | 2026-07-08 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/stablecoins` | Stablecoins Market Cap & Peg Health | 2026-07-08 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/yields` | DeFi Yields Explorer | 2026-07-11 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/fees` | Protocol Fees & Revenue | 2026-07-11 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/dex-volumes` | DEX Volume Leaderboard | 2026-07-11 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/hacks` | DeFi Hacks Database | 2026-07-11 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/markets/trending` | Trending Crypto | 2026-07-11 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/bnb` | BNB Chain: Three Genuinely-Unique Demos | 2026-07-08 | No |  |
| `/bnb-latency` | BNB Chain Live Block Race: 0.45s vs Base, Ethereum, Solana | 2026-07-08 | No |  |
| `/vault` | Vault: Buy & Unlock Encrypted 3D Models on BNB Chain | 2026-07-08 | No |  |
| `/constellation` | watsonx Constellation | 2026-06-03 | Passing | [2026-05-06](https://x.com/trythreews/status/2052167399399735476) |
| `/bazaar` | x402 Bazaar | 2026-05-25 | Yes | [2026-06-04](https://x.com/trythreews/status/2062325751840432172) |
| `/ibm/x402-demo` | x402 Live Demo (IBM × three.ws) | 2026-06-17 | Passing | [2026-05-06](https://x.com/trythreews/status/2052167399399735476) |
| `/ibm/hello` | IBM × three.ws partnership |  | Passing | [2026-05-06](https://x.com/trythreews/status/2052167399399735476) |
| `/lookup` | Agent Lookup | 2026-06-09 | No |  |
| `/arbitrage` | x402 Arbitrage | 2026-05-29 | No |  |
| `/providers` | x402 Providers | 2026-05-29 | Passing | [2026-05-21](https://x.com/trythreews/status/2057582209536835593) |
| `/gmgn` | GMGN Smart Money | 2026-05-25 | No |  |
| `/three` | $THREE Tiers · Hold-to-Access | 2026-06-23 | No |  |
| `/three-live` | $THREE Live · Protocol Pulse | 2026-05-29 | No |  |
| `/fact-checker` | Fact Checker | 2026-05-27 | No |  |
| `/tutor` | Pay-As-You-Learn Tutor | 2026-05-29 | No |  |
| `/unstoppable` | Unstoppable Agent | 2026-05-27 | No |  |
| `/shopper` | Endpoint Shopper | 2026-05-27 | No |  |
| `/forever` | Forever: etch a message into Bitcoin | 2026-05-29 | No |  |
| `/club` | Pole Club | 2026-06-05 | Yes | [2026-06-22](https://x.com/trythreews/status/2068951336918638699) |
| `/stage` | Living Stages | 2026-06-23 | No |  |
| `/agent-exchange` | Agent Exchange | 2026-06-03 | Passing | [2026-06-09](https://x.com/trythreews/status/2064306640313360511) |
| `/agent-economy` | Agent Economy: Live Demo | 2026-06-03 | Passing | [2026-06-09](https://x.com/trythreews/status/2064306640313360511) |
| `/economy` | The Agent Economy: Live | 2026-06-21 | Passing | [2026-06-09](https://x.com/trythreews/status/2064306640313360511) |
| `/agent-economy-volume` | Agent Economy Volume | 2026-06-29 | No |  |
| `/agent-trade` | Agent Commerce | 2026-06-03 | No |  |
| `/autopilot-activity` | Autopilot Activity | 2026-06-23 | No |  |
| `/avatar-wallet-chat` | Avatar Wallet | 2026-06-02 | No |  |
| `/demo` | Agent Economy: NOVA & ORACLE | 2026-06-03 | No |  |
| `/live` | Agent Economy: Live | 2026-06-03 | No |  |
| `/coin3d` | Token in 3D | 2026-06-02 | No |  |
| `/hero-demo` | Hero Stage | 2026-06-21 | No |  |
| `/evm-wallet` | EVM Vanity Wallet | 2026-06-08 | No |  |
| `/markets` | Markets Hub | 2026-07-10 | Yes | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/markets/robinhood` | Robinhood Chain | 2026-07-12 | No |  |
| `/markets/news` | Crypto News | 2026-07-10 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/markets/news/article` | Crypto News Reader | 2026-07-10 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/markets/archive` | Crypto News Archive | 2026-07-10 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/markets/digest` | Crypto News Digest | 2026-07-10 | Passing | [2026-07-10](https://x.com/trythreews/status/2075378343323795903) |
| `/three-token` | $THREE Token |  | No |  |
| `/x402` | x402 Catalog |  | Yes | [2026-06-22](https://x.com/trythreews/status/2068951336918638699) |
| `/communities` | Coin Communities |  | Passing | [2026-05-30](https://x.com/trythreews/status/2060749325404361113) |
| `/play` | Play |  | Yes | [2026-05-30](https://x.com/trythreews/status/2060749325404361113), [2026-08-07](https://x.com/trythreews/status/2085742637529870405) |
| `/event` | Live event | 2026-08-07 | Yes | [2026-08-07](https://x.com/trythreews/status/2085742637529870405) |
| `/mirror` | Copy Trading |  | No |  |
| `/swarms` | Trading Swarms |  | No |  |
| `/agent-wallet` | Agent Wallet |  | No |  |
| `/wallet` | Your master wallet | 2026-07-30 | No |  |
| `/trading` | Autonomous Trading | 2026-07-30 | Yes | [2026-06-20](https://x.com/trythreews/status/2068290242109726994), [2026-07-25](https://x.com/trythreews/status/2081030781049422130) |
| `/exit-lab` | Exit Lab | 2026-07-31 | No |  |
| `/play/economy` | The in-game economy | 2026-07-30 | No |  |
| `/play/solver` | The economy solver | 2026-07-31 | No |  |

### Agent tools (6 pages, 4 never announced)

| Path | Feature | Added | Announced | First/main post |
|---|---|---|---|---|
| `/chat` | Chat | 2026-04-29 | Yes | [2026-05-02](https://x.com/trythreews/status/2050682956042338719) |
| `/agent-identities` | Agent Identity Studio: 3D avatars for AI agents | 2026-07-06 | No |  |
| `/agents` | Agents Index | 2026-04-17 | No |  |
| `/ledger` | Reasoning Ledger | 2026-07-20 | No |  |
| `/my-agents` | My Agents | 2026-04-17 | No |  |
| `/reputation` | Reputation Explorer | 2026-04-17 | Passing | [2026-06-22](https://x.com/trythreews/status/2068951336918638699) |

### Account (14 pages, 14 never announced)

| Path | Feature | Added | Announced | First/main post |
|---|---|---|---|---|
| `/credits` | Credits | 2026-06-21 | No |  |
| `/payments` | Agent Payment Sessions | 2026-06-26 | No |  |
| `/pay/simulator` | Spend Policy Simulator | 2026-07-31 | No |  |
| `/login` | Sign in | 2026-04-14 | No |  |
| `/register` | Create account | 2026-04-14 | No |  |
| `/forgot-password` | Forgot password | 2026-04-14 | No |  |
| `/dashboard` | Dashboard | 2026-05-25 | No |  |
| `/dashboard/account` | Dashboard · Account | 2026-05-25 | No |  |
| `/dashboard/data-api` | Dashboard · Data API | 2026-07-11 | No |  |
| `/dashboard/billing` | Dashboard · Billing & Passes | 2026-07-11 | No |  |
| `/dashboard/analytics` | Dashboard · Analytics | 2026-05-25 | No |  |
| `/dashboard/settings` | Dashboard · Settings | 2026-05-25 | No |  |
| `/settings` | Settings | 2026-04-28 | No |  |
| `/profile` | Your creator portfolio | 2026-07-12 | No |  |

### Machine-readable endpoints (14 pages, 11 never announced)

| Path | Feature | Added | Announced | First/main post |
|---|---|---|---|---|
| `/sitemap.xml` | sitemap.xml | 2026-05-25 | No |  |
| `/api/mcp-policy` | MCP trust policy | 2026-07-31 | No |  |
| `/llms.txt` | llms.txt | 2026-05-13 | No |  |
| `/llms-full.txt` | llms-full.txt | 2026-05-13 | No |  |
| `/robots.txt` | robots.txt | 2026-04-14 | No |  |
| `/openapi.json` | OpenAPI | 2026-04-27 | No |  |
| `/.well-known/x402` | .well-known/x402 | 2026-04-29 | Passing | [2026-04-29](https://x.com/trythreews/status/2049458671139336613) |
| `/.well-known/agent-attestation-schemas` | .well-known/agent-attestation-schemas | 2026-04-29 | No |  |
| `/.well-known/oauth-authorization-server` | .well-known/oauth-authorization-server | 2026-04-29 | No |  |
| `/.well-known/chat-plugin.json` | .well-known/chat-plugin.json | 2026-04-17 | No |  |
| `/api/mcp` | MCP server |  | Yes | [2026-04-29](https://x.com/trythreews/status/2049412062837928202) |
| `/.well-known/mcp.json` | .well-known/mcp.json | 2026-07-31 | No |  |
| `/.well-known/agent-card.json` | .well-known/agent-card.json |  | No |  |
| `/.well-known/x402.json` | .well-known/x402.json |  | Yes | [2026-05-09](https://x.com/trythreews/status/2053025259645981078) |

## Full inventory: npm packages

One 2026-07-08 [post](https://x.com/trythreews/status/2074761553346478138) said "70+ packages on npm" in aggregate, but only tour and walk were ever named. Individually announced or not is tracked below.

| Package | What it is | Announced | Post |
|---|---|---|---|
| `@three-ws/activity-mcp` | three.ws live discovery surface from any AI agent - trending agents and coins, the $THREE holder leaderboard w | No |  |
| `@three-ws/agenc-mcp` | The AgenC agent-to-agent coordination surface over MCP - browse the on-chain task marketplace, query the agent | No |  |
| `@three-ws/agenc` | Client for the AgenC agent-coordination protocol on Solana - discover tasks, read task status + lifecycle, and | No |  |
| `@three-ws/agent-guards` | Safety rails for autonomous agents - per-agent spend policies and trade guards that cap what an agent can spen | No |  |
| `@three-ws/agent-memory` | Persistent, embeddings-backed memory for agents. Store facts and entities, recall them semantically, and surfa | No |  |
| `@three-ws/agent-runtime` | The three.ws agent engine: a plan/execute decision loop with human-approval gates, a seven-layer GuardChain (s | No |  |
| `@three-ws/agent-sniper` | Lightweight, embeddable pump.fun sniper engine for 3D AI agents - multi-agent, multi-user, with pluggable wall | No |  |
| `@three-ws/agentcore-payments-mcp` | Platform-managed agent payment sessions - create a budget, pay any x402 endpoint without holding a private key | No |  |
| `@three-ws/agora-mcp` | Agora - the living agent + human economy - over MCP. Browse the job board (open AgenC tasks + x402 services),  | No |  |
| `@three-ws/alerts-mcp` | Manage your three.ws pump.fun alert rules from any AI agent - create, update, and delete monitoring rules with | No |  |
| `@three-ws/alibaba-cloud-mcp` | MCP server for Alibaba Cloud DashScope by three.ws - Qwen chat, embeddings, and model discovery using your own | No |  |
| `@three-ws/assistant-mcp` | Generate a paste-ready three.ws assistant widget from any AI agent. build_assistant_widget turns a config into | No |  |
| `@three-ws/audio-mcp` | Give 3D AI agents a voice and a face from any MCP client - text-to-speech, speech-to-text, audio-to-face lipsy | No |  |
| `@three-ws/autopilot-mcp` | An AI agent's own autonomous-execution control plane over MCP - set autopilot scopes, a daily SOL spend cap, a | No |  |
| `@three-ws/avatar-agent` | 3D AI Agent Avatar - MCP server that spawns a textured GLB avatar, inspects/validates/optimizes any 3D model,  | Yes | [2026-05-22](https://x.com/trythreews/status/2057782522994684413) |
| `@three-ws/avatar-cli` | Terminal-native tooling for on-chain avatars: scaffold, validate, hash, and preview avatar manifests from your | No |  |
| `@three-ws/avatar-schema` | JSON Schema and validator for three.ws on-chain avatar manifests - the canonical, hash-anchored format any cro | No |  |
| `@three-ws/billing-mcp` | An AI agent's own account economics over MCP - plan quotas, metered usage, invoices, receipts, and earnings. R | No |  |
| `@three-ws/brain-mcp` | Any model, one interface - the three.ws multi-provider LLM router over MCP. Discover available providers/model | No |  |
| `@three-ws/clash-mcp` | Play three.ws Coin Clash - the community faction war backed by real holdings + pump.fun data - from any AI age | No |  |
| `@three-ws/concierge-mcp` | Ask any website's AI concierge a grounded question, and generate the copy-paste embed code to add a three.ws C | No |  |
| `@three-ws/copy-mcp` | Manage your three.ws copy-trade follows from any AI agent - follow/unfollow leaders, tune sizing & guard rules | No |  |
| `@three-ws/defi-utils` | Zero-dependency single source of truth for chain IDs, native tokens, token addresses, ERC-20 ABI fragments, an | No |  |
| `@three-ws/forge` | Text/image/sketch → textured, rig-ready 3D GLB in one call. The three.ws Forge generation SDK - free TRELLIS l | Passing | [2026-06-12](https://x.com/trythreews/status/2065382633014542744) |
| `@three-ws/glb-tools` | Inspect, re-theme, and bake GLB models from the shell or CI. The client SDK behind the three.ws 3D asset pipel | No |  |
| `@three-ws/guardian` | Content safety + governance for AI agents in one import. IBM Granite Guardian risk classification, NVIDIA Nemo | No |  |
| `@three-ws/ibm-watsonx-mcp` | MCP server for IBM watsonx.ai by three.ws - chat, text generation, embeddings, tokenization, and model discove | No |  |
| `@three-ws/ibm-x402-mcp` | x402 pay-per-use MCP server for IBM Granite AI - chat, code, embeddings, analysis, and time-series forecasting | No |  |
| `@three-ws/intel-mcp` | three.ws market intelligence from any AI agent - smart-money scoring, wallet intel, signal feeds, KOL leaderbo | No |  |
| `@three-ws/intel` | Token sentiment + market intelligence in one import. Sentiment pulse, aixbt narrative intel, momentum-ranked p | No |  |
| `@three-ws/irl` | Geofenced, real-world presence for agents and avatars - check in at a GPS spot with a proof-of-presence fix, d | No |  |
| `@three-ws/kol-mcp` | Track one smart trader from any AI agent - a tracked KOL wallet's portfolio P&L (realized/unrealized, win rate | No |  |
| `@three-ws/loom-mcp` | Loom - the three.ws community 3D-creation gallery from any AI agent. Browse the public feed of community-forge | No |  |
| `@three-ws/marketplace-mcp` | Browse the three.ws agent marketplace and skills catalog from any AI agent. browse_agents and browse_skills se | No |  |
| `@three-ws/mocap` | Motion capture as an API. Turn webcam/video into face, pose, and hand animation clips, then save, share, and r | No |  |
| `@three-ws/names` | ENS + SNS name resolution, *.threews.sol subdomain minting, and pay-by-name in one import. The three.ws agent- | No |  |
| `@three-ws/naming-mcp` | Resolve Solana .sol names and check *.threews.sol agent-identity availability from any AI agent. sns_resolve m | No |  |
| `@three-ws/notifications-mcp` | Read and manage your three.ws notification inbox from any AI agent - list inbound events (pump/market alerts,  | No |  |
| `@three-ws/portfolio-mcp` | An AI agent's own trading state over MCP - portfolio summary, value history, live wallet balances, the public  | No |  |
| `@three-ws/pose` | Deterministic, named pose seeds for rigged 3D avatars. Map a natural-language prompt to a stable seed + full E | No |  |
| `@three-ws/provenance-mcp` | The three.ws agent action-provenance log over MCP - append-only, ERC-191-signed, on-chain-verifiable. Any AI a | No |  |
| `@three-ws/pumpfun-mcp` | Free, read-only pump.fun + Solana MCP server - token discovery, on-chain bonding-curve & holder analysis, crea | No |  |
| `@three-ws/pumpfun-skills` | pump.fun launch + trade skills as composable agent tools. Create a coin, swap on the bonding curve or AMM, and | Yes | [2026-04-29](https://x.com/trythreews/status/2049573582247022869) |
| `@three-ws/react` | React components for embedding three.ws 3D AI agents | No |  |
| `readme-3d` | Put interactive, rotatable 3D models in your GitHub README. Converts GLB, glTF, OBJ, and binary STL into the A | No |  |
| `@three-ws/reputation` | Read ERC-8004 agent trust scores and attest agent-to-agent feedback on-chain, in one import. The three.ws repu | No |  |
| `@three-ws/retarget` | Retarget animations onto any humanoid GLB. Canonicalizes bone names from Mixamo, Avaturn, VRM/VRoid, Daz/Genes | No |  |
| `@three-ws/scene-mcp` | Speak 3D worlds into being from any AI agent. compose_scene turns one sentence into a placed diorama plan (moo | No |  |
| `@three-ws/sign-language` | American Sign Language for 3D avatars. Compile text into one continuous signed animation clip: known words sig | Yes | [2026-08-01](https://x.com/trythreews/status/2083675644463038810) |
| `@three-ws/signals-mcp` | Discover, subscribe to, and track three.ws copy-trade signal feeds from any AI agent - a marketplace ranked by | No |  |
| `@three-ws/skill-license` | On-chain skill licenses for agents - each purchased skill is a 1/1 SPL NFT plus a deterministic SkillLicense P | No |  |
| `@three-ws/spatial-mcp` | Validator, builder, and conformance fixtures for Spatial MCP - the open (CC0) shape for returning a live, inte | No |  |
| `@three-ws/strategies` | Automated on-chain trading strategies for agents - DCA, copy-trading, and mirror execution, in one import. Rul | No |  |
| `@three-ws/three-token-mcp` | The first MCP server whose actions burn a token. Let any AI agent price, hold, and burn $THREE on-chain - ever | No |  |
| `@three-ws/avatar-mcp` | MCP server for three.ws 3D avatars by three.ws - render a live, rotatable on-chain avatar inline (interactive  | No |  |
| `@three-ws/tool-sdk` | Typed tool authoring for three.ws MCP servers: defineTool + defineExecutor + per-tool permission manifests (ne | No |  |
| `@three-ws/tutor-mcp` | three.ws Pay-As-You-Learn tutor ledger from any AI agent - read a learning session's itemized running tab and  | No |  |
| `@three-ws/vanity-mcp` | Read the three.ws vanity-address grind-bounty market and proof-of-grind rarity gallery from any AI agent. Quot | No |  |
| `@three-ws/vanity` | Mine Solana vanity addresses (custom prefix/suffix) fast - WASM-accelerated, in the browser or Node. Ergonomic | Passing | [2026-04-29](https://x.com/trythreews/status/2049447738434339171) |
| `@three-ws/viewer-presets` | Tuned visual presets for three.ws avatar viewers - light rigs, floor reflection, bloom, and PBR material prese | No |  |
| `@three-ws/vision-mcp` | Let any AI agent see - analyze and describe images through the three.ws vision pipeline. Free NVIDIA NIM VLMs  | No |  |
| `@three-ws/voice` | Speech for avatars - ASR (speech→text), TTS (text→speech), and Audio2Face-3D lipsync visemes in one import. Th | No |  |
| `@three-ws/vscode-x402` | Browse the x402 bazaar, decode 402 payment challenges, and pay per call for paid APIs and MCP tools in USDC or | Yes | [2026-07-01](https://x.com/trythreews/status/2072133364765831371) |
| `@three-ws/x402-fetch` | Drop-in fetch wrapper that automatically pays x402 payment challenges with USDC on Base | No |  |
| `@three-ws/x402-mcp` | Give any AI agent a self-custodial x402 wallet. Search the live bazaar, inspect an endpoint's price without pa | Yes | [2026-06-04](https://x.com/trythreews/status/2062325751840432172) |
| `@three-ws/x402-server` | The merchant side of x402 - turn any HTTP endpoint into a paid one. Issue 402 challenges, price SKUs, verify a | No |  |

## Full inventory: top-level SDKs and apps

| Package | What it is | Announced | Post |
|---|---|---|---|
| `three.ws (root package)` | npm i three.ws: the browser SDK and agent-3d element | Yes | [2026-04-29](https://x.com/trythreews/status/2049476546285740512) |
| `@three-ws/sdk` | Cross-chain 3D AI agent SDK (EVM + Solana identity, chat, payments) | No |  |
| `@three-ws/agent-payments` | Agent-payments engine (value-added fork, reconstructed IDL/PDAs/x402 layer) | Yes | [2026-04-29](https://x.com/trythreews/status/2049567362693963905) |
| `@three-ws/solana-agent` | Solana agent SDK: keypair + browser wallet, transfers, swaps, x402 | Passing | [2026-04-29](https://x.com/trythreews/status/2049447738434339171) |
| `@three-ws/tour` | 3D guide avatar that walks your live site | Yes | [2026-07-08](https://x.com/trythreews/status/2074759289668039153) |
| `@three-ws/walk` | Animated 3D avatar that walks and talks over web pages | Yes | [2026-07-08](https://x.com/trythreews/status/2074759289668039153) |
| `@three-ws/x402-payment-modal` | Drop-in x402 payment modal | Yes | [2026-06-22](https://x.com/trythreews/status/2068951336918638699) |
| `@three-ws/x402-modal` | Dependency-free x402 payment modal SDK | Passing | [2026-06-22](https://x.com/trythreews/status/2068951336918638699) |
| `three.ws-chat` | The chat app (open-source, forkable) | Yes | [2026-05-02](https://x.com/trythreews/status/2050682956042338719) |

## Full inventory: workers and services (infrastructure)

These are internal lanes; most should be announced through the features they power, not directly.

| Directory | Announced | Post |
|---|---|---|
| `workers/agent-anchor` | No |  |
| `workers/agent-forge` | Passing | [2026-06-12](https://x.com/trythreews/status/2065382633014542744) |
| `workers/agent-mm` | No |  |
| `workers/agent-orders` | No |  |
| `workers/agent-screen-pool` | No |  |
| `workers/agent-screen-worker` | No |  |
| `workers/agent-sniper` | Passing | [2026-06-20](https://x.com/trythreews/status/2068290242109726994) |
| `workers/agora-citizens` | No |  |
| `workers/avatar-pipeline-controller` | No |  |
| `workers/avatar-reconstruction` | No |  |
| `workers/deploy` | No |  |
| `workers/garment-forge` | No |  |
| `workers/longcat` | No |  |
| `workers/model-asl-recognition` | Yes | [2026-08-01](https://x.com/trythreews/status/2083675644463038810) |
| `workers/model-hunyuan3d` | No |  |
| `workers/model-text2motion` | No |  |
| `workers/model-trellis` | Yes | [2026-06-23](https://x.com/trythreews/status/2069510627299860827) |
| `workers/model-triposg` | Passing | [2026-06-12](https://x.com/trythreews/status/2065382633014542744) |
| `workers/model-triposr` | No |  |
| `workers/model-video2motion` | No |  |
| `workers/model-video2scene` | No |  |
| `workers/okx-chat-bot` | No |  |
| `workers/oracle` | No |  |
| `workers/pump-fun-mcp` | No |  |
| `workers/rembg` | No |  |
| `workers/remesh` | No |  |
| `workers/rig` | No |  |
| `workers/robinhood-feed` | No |  |
| `workers/segment` | No |  |
| `workers/stylize` | No |  |
| `workers/texture` | No |  |
| `workers/unirig` | No |  |
| `workers/vanity-grinder` | Passing | [2026-04-29](https://x.com/trythreews/status/2049447738434339171) |
| `services/agent-screen-caster` | No |  |
| `services/fleet-console` | No |  |
| `services/liquidation-collector` | No |  |
| `services/pump-graduations` | No |  |

## Strongest unannounced candidates

286 real surfaces have never been posted. These are the ones with the most announcement potential, judged by novelty, demo-ability, and fit with what already performed well on the timeline:

| Surface(s) | Why it will land |
|---|---|
| `@three-ws/three-token-mcp` | The first MCP server whose actions burn a token. A $THREE-native world-first, one post writes itself. |
| `/forge-max` | The highest-quality text and image to 3D lane. Forge posts are consistently the best performers. |
| `/motion-swap` + `/mocap-studio` + `@three-ws/mocap` | Replace yourself in any video with your avatar; webcam motion capture as an API. Extremely screenshotable. |
| `/capture` + `/splat` | Video to 3D point cloud, photoreal Gaussian avatars. Visually stunning demo material. |
| `/genome` + `/genesis` | Breed two agents into a child agent; instant agent genesis. Nothing else on the timeline is like it. |
| `/wardrobe` + `/fits` + `workers/garment-forge` | A full cosmetics economy for avatars: forge garments, dress agents, trade fits. |
| `/oracle` + `/activity` | The AI conviction engine with a live activity feed. Backbone of the trading story. |
| `/guardian` | Recover and inherit agent wallets. A trust feature nobody in the agent space has shipped. |
| `/arena` + `/clash` + `/play/war` | Live PvP trading tournaments, faction wars, and the new Coin Wars battlefield. Community-native content. |
| `/vaults` + `/labor-market` + `/signals` | Back an agent with capital, hire agents on a labor market, sell alpha feeds ranked by proven edge. The agent economy endgame posts. |
| `/mirror` + `/swarms` + `/ghost-copy` | Copy trading, trading swarms, and "what if you had copied them" replays. |
| `/launch-studio` | 50 ways to mint a coin. A listicle-shaped feature. |
| `readme-3d` | Interactive 3D models inside any GitHub README. Developer-viral by construction. |
| `@three-ws/agent-memory` + `@three-ws/agent-runtime` + `@three-ws/agent-guards` | The open agent stack: memory, decision loop, and spend-policy safety rails. A strong developer thread. |
| `/concierge` + `/assistant` | The AI concierge and assistant widgets: the embeddable business story beyond avatars. |
| `/agenc/embodied` + `/agenc/room` + `@three-ws/agenc` | On-chain agent-to-agent task coordination on Solana, with embodied task rooms. |
| `/choreograph` + `/gestures` | Choreograph avatar movement and gesture packs on top of the 3,000+ animation library already announced. |
| `/portfolio` + `/airdrops` + `/wallet` | The wallet suite: portfolio, airdrop checker, master wallet. Practical daily-use posts. |
| `/theater` + `/pulse` + `/flow` | Live trading theater and money-flow visualizations: the agent economy as a spectator sport. |
| `@three-ws/skill-license` | Purchased agent skills as on-chain 1/1 licenses. Ties skills, ownership, and revenue together. |

Method note: status was assigned by reading all 174 posts and matching each one to the surfaces it names, shows, or links. Aggregate posts (the packages post, the crypto intelligence post, partner threads) were counted as passing mentions for the surfaces they cover, never as announcements.
