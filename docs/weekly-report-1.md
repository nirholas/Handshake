# three.ws Weekly Report #1: Everything We Have Shipped So Far

Nineteen weeks. 9,508 commits. 21 contributors. 2,674 changelog entries. 725 pages. 101 npm packages. 72 MCP servers in the official registry. 4,519 x402 endpoints. One token.

This is the first weekly report, and because it is the first, it is also the whole story. It runs from the first commit on April 14, 2026 to today, August 25, 2026, week by week, and it covers everything: what we built, what we announced, what we partnered on, and where $THREE fits. Every number in it comes from the public repository, the public changelog, or a public listing.

If you only read one line: three.ws went from an empty repo to a live, open-source, revenue-generating platform where AI agents get a 3D body, an on-chain identity, a wallet, and a way to get paid, in four months, and $THREE is the coin in the middle of it.

[IMAGE: home.png]

---

## The numbers first

Before the timeline, the totals as of August 25, 2026:

- 9,508 commits on main since April 14 from 21 contributors, 60 pull requests, 104 stars, 26 forks. To be honest about the count: roughly 2,200 of those in one May week were per-file imports of two vendored workspaces, and about 250 were deliberate empty commits in another. Strip those and it is still north of 7,000 real changes in 19 weeks, about 50 a day, every day.
- 2,674 holder-readable changelog entries: 991 features, 1,075 improvements, 1,190 fixes, 320 infrastructure, 226 docs, 216 security, 166 SDK. Every one is pushed to the holders' Telegram automatically.
- 725 public pages across Build, Discover, Learn, Crypto, Labs, Blog, and Legal.
- 101 npm packages published under the @three-ws scope (42 of them MCP servers, 6,225 downloads in the last 30 days), 72 distinct servers under one namespace in the official MCP registry, 60 installable agent skills.
- 4,519 priced x402 endpoints in the live discovery catalog, 110,416 on-chain settlements and 803,483 payment verifications through our own self-hosted facilitator, 3,000 validator attestations and 126,522 custody proofs on Solana.
- 111 open-source repos spun out of three.ws with 1,222 stars between them, ERC-8004 registries live on 12 EVM mainnets, two Solana programs, 33 workers, 1,752 test files. All Apache-2.0.
- 40 blog posts, 47 product announcements on X, and 21 more announcement drafts waiting in the queue.
- A crypto news archive of 740,889 articles from 197 publishers going back to September 2017, updated hourly.
- Over 1,000,000 individually priced x402 datapoints at $0.0005 each.
- 3,000+ motion-capture animations, 500+ CC0 3D props, 106 rigged characters in the character library.
- A self-hosted GPU fleet on Google Cloud Run: NVIDIA L4s and an RTX PRO 6000 Blackwell.
- 44,122 wallet transactions scanned by our own leak scanners as of July 12, with zero leaks found, ever.
- 1,752 test files, about 53 Postgres tables, 101 scheduled jobs on Cloud Scheduler, a 21-page Demos Hub, and a walkable 3D city built on real Manhattan map data.
- An OAuth 2.1 authorization server (PKCE, dynamic registration, revocation, introspection, discovery), an OpenAPI 3.1 spec at /openapi.json, and a hosted MCP endpoint any assistant can drive.
- 3,145 peak concurrent avatars at the first $THREE holders meetup on August 7.
- $THREE today, read live from the token page: 16,264 holders, about $2.3M market cap, about $538K 24h volume, verified project on pump.fun, Jupiter Verified, Phantom Verified, listed on MEXC, LBank, KCEX, Bybit Alpha, KuCoin Alpha, Binance Web3, Coinbase Wallet, CoinGecko, and CoinMarketCap.

[IMAGE: three-token.png]

---

## What three.ws is, in one screen

three.ws gives an AI a body. It does five things:

- Generate. A text prompt, up to six photos, or a sketch becomes a textured, downloadable 3D model. Free draft tier, no account.
- Render. glTF and GLB in the browser with Draco, KTX2, and Meshopt, zero server processing.
- Embody. An LLM brain with a tool loop, emotion blending on the face, and ARKit-52 lip-sync. The avatar listens, thinks, acts, and shows feeling.
- Register. An on-chain identity as an ERC-8004 token on any EVM chain or a Metaplex Core asset on Solana, with a wallet, signed action history, and a reputation score.
- Embed. One web component, agent-3d, that drops the live avatar into any page.

On top of that sits an entire agent economy: custodial wallets with spend policies, x402 pay-per-call rails settling USDC on Solana, a skills marketplace priced in $THREE, a labor market with $THREE escrow, a shared multiplayer world, vaults, an autonomous trading fleet, and a hosted MCP endpoint that any AI assistant can drive.

Now the timeline.

---

## Week 1: April 14 to 19. Day zero.

134 commits.

The first working 3D avatar viewer landed: a model viewer, the core runtime, camera orbit, and a model info overlay. Alongside it came the pieces that would define everything after:

- ERC-8004 identity work began on day one: an identity registry, agent registration, and a Passport widget for on-chain identity.
- Sign-In with Ethereum, session management, and wallet auth hardening.
- A creator dashboard, an avatar upload flow, and the first selfie capture flow.
- Widget Studio was born: routing, persistence, privacy, export, and a gallery.
- The embed layer closed its first milestone with host and action bridges and a share panel.
- The Discover page for on-chain agent discovery.
- The idle loop that makes avatars never sit still: breathing, saccades, blinks, weight shifts.
- A LobeHub plugin, ElevenLabs voice, a permissions and delegation toolkit, and FBX-to-GLB tooling.

Eighteen pages went live that week, including the homepage, /create, /discover, /app, /widgets, /agents, and /reputation. Six changelog entries were published. The theme was simple: stand up the core product, a 3D viewer plus a creator dashboard wired to wallet auth and on-chain identity.

---

## Week 2: April 20 to 26. Deploy on-chain for real.

30 commits.

A quiet week by count, but the one where on-chain deployment stopped being a demo. The ERC-8004 deploy now actually persisted and served a live agentURI. A deploy-on-chain button with a chain picker (mainnet by default) went into the app. The Features page shipped with scroll-driven animation, the embed flow got handshake verification and a live preview, and the viewer got keyboard shortcuts and first-load camera framing. Onboarding banners, an accessibility pass over the create-to-deploy flow, and a public profile that mounts a real 3D body rounded it out.

---

## Week 3: April 27 to May 3. The economy arrives.

430 commits.

This is the week three.ws became a payable agent economy instead of an avatar viewer. In seven days:

- Full pump.fun integration: create-coin, swap, coin-fees, tokenized agents, autonomous trading skills, bonding curve and AMM pool state, a portfolio endpoint.
- x402 micropayments: the facilitator-mediated protocol, per-network config, MCP auth via payment headers, and per-tool MCP pricing.
- The Solana agent stack: a Solana agent SDK, wallet provisioning, a vanity address grinder, SNS subdomain registration, a Solana passport page, attestations, and a Solana analog of ERC-8004.
- A unified deploy path covering EVM and Solana with one preparation endpoint.
- The plugin marketplace with CRUD, search, and LobeHub compatibility.
- Monetization scaffolding: subscriptions, creator plans, rider passes, a payment gate, withdrawal rate limits.
- Talking heads: a lip-sync analyser for viseme morph weights, positional audio TTS, LiveKit endpoints.
- Avatar chat with thought bubbles, markdown, walking-while-streaming, and a kiosk mode.
- A multiplayer lobby and VR keyboard support.
- The Rider VR gate, the first $THREE-gated surface.
- MCP got a call_agent tool for inter-agent communication, and the server was published to the official MCP registry as io.github.nirholas/three.ws.
- Site chrome and legal: footer, settings, Privacy Policy, Terms, email verification, password reset.

Twenty-eight pages launched, including /marketplace, /pumpfun, /chat, /vanity-wallet, the first docs set (x402, ERC-8004, MCP, SDK), and the x402 well-known discovery file.

Announcements that week: the April 29 launch thread (3D body, LLM brain with memory and emotions, ERC-8004 identity, embeds), the MCP Registry listing, Solana agent wallets with vanity addresses, the first live paid x402 endpoint at 0.001 USDC per avatar plus the x402scan listing, the three.ws npm package and agent-3d embed, the open-sourced agent-payments SDK, launchpad agent skills (swap, create coins, collect fees, snipe, trade), and an avatar that reacts live to its own on-chain events. On April 30 the blog published three posts: Solana wallet integration, joining Google Cloud for Web3 Startups, and the Anthropic MCP Registry listing.

---

## Week 4: May 4 to 10. Monetization goes live end to end.

194 commits.

- The complete monetization system: trials, time passes, withdrawals, receipts, multi-wallet, and an x402 bridge.
- Marketplace v2: detail pages, a lobby, a payment modal, a creators API, billing receipts, themes, premium indicators.
- Skill purchases with pricing, payment intents, access control, creator earnings, and revenue stats.
- Agent-to-agent skill auto-purchase.
- x402 upgraded to spec v2 with CAIP-2 networks; the Bazaar discovery endpoint went live at /.well-known/x402.json; the CDP facilitator was wired for the agentic.market listing.
- A /pay page and a Solana x402 pay endpoint.
- Multi-provider chat with SSE streaming and a model picker; the agent reacts to user sentiment with a matching emotion and animation.
- Agent Payments SDK v3.1.0 with v2 bonding curve support, plus an EVM agent payments SDK.
- ETH and Solana vanity grinders with wordlists and tests.
- Launch-week content: a case-study page with live X metrics and a launch video.
- A JavaScript SDK, a playground, and a widgets page with copy-paste embeds.
- The Rider gate simplified to "hold any $THREE to enter."

New pages: /pay, /pump-live, /pump-dashboard, /pump-visualizer, /eth-vanity, /community, /tutorials.

Announced: the /pumpfun live announcer (May 1), the rebuilt chat with live thoughts, TTS, emotions as tools, MCP, artifacts, and inline charts (May 2), the animation and emotion control API plus a live coin feed inside embeds (May 6), and Agent Builder with agents payable via x402 and discoverable via the well-known file (May 9). Blog: "$THREE Listed on Coinbase, CoinGecko, Jupiter, and Investing.com" (May 5), "Full Animation and Emotion Control" (May 6), "three.ws Is Now an Official IBM Business Partner" (May 6), "Agent Builder Live" (May 9).

---

## Week 5: May 11 to 17. One app becomes a suite.

2,319 commits, of which about 2,220 were per-file imports of the X Spaces voice agent and voice chat workspaces. The meaningful change set was about 100 commits, and it was enormous:

- An autonomous X Spaces voice agent: a cloud-VM agent on the OpenAI Realtime API with STT and TTS providers, multiple LLM lanes, space auth, and an audio bridge.
- The native selfie reconstruction pipeline, phases 1 through 4, with quality gates, meshopt compression, and Livepeer inference.
- Avatar Studio, a new avatar SDK workspace, accessories, an optimizer.
- Talk mode with ARKit-52 morph targets and audio-driven lip-sync wired to ElevenLabs.
- x402 expanded hard: a SKU catalog with a Stripe-like checkout at /dashboard/x402, six paid endpoints, Base mainnet through the Coinbase CDP facilitator, Permit2 gas-sponsoring, BSC direct-scheme payments.
- The Embed Editor: preview, animation dock, avatar picker, face camera, kiosk default, transparent background, lock toggle.
- Launchpad with a Studio and hosted pages at /p/slug.
- Pole Club, a live venue: GLB venue, camera state machine, audio, props, tips, leaderboard, payouts cron, paid door.
- The A2A and identity layer: A2A client and server, MCP bridge, SIWX, DID support, spending ledger, receipts, idempotency, paid asset download, Bazaar listing and search.
- A coin launchpad with pump-swap buyback, a pose studio, a WASM vanity grinder, and a pump visualizer.
- Multiplayer walk-net with a Fly.io server.
- A news CMS with multi-destination syndication (WebSub, Dev.to, Medium), an RSS feed for HackerNoon auto-import, a blog, and tutorials.
- Solana Mobile Seeker support with MWA and dApp Store listing assets.
- The sitewide rebrand to three.ws and a security pass adding SSRF guards, CSRF gates, origin pinning, and fail-closed crons.

Twenty-eight pages, including /gallery, /lipsync, /strategy-lab, and /docs/listings.

Announced: pay-per-call x402 architecture where every MCP tool call settles on-chain (May 12), the embed editor (May 15). Blog: "Integrates the Pump.fun Agent Payments SDK" (May 13), "How to Embed 3D On-Chain Agents on Your Site" (May 15), and on May 17 four posts in one day: the HackerNoon partnership, the Alibaba Cloud Marketplace launch, the BNB Chain Dappbay listing, and "three.ws Is Now Live on CoinMarketCap."

---

## Week 6: May 18 to 24. Rebuild the dashboard, harden everything behind it.

377 commits (about 250 were deliberate empty commits and dependabot bumps; roughly 120 substantive).

- /dashboard-next: a full prototype-to-production dashboard with KPIs, a 3D avatar strip, live widget previews, a library with a voice picker, monetize, account, and an audit log.
- Avatar reconstruction moved to Cloud Run; async knowledge ingest via QStash removed timeouts on large PDF uploads.
- Upstash Redis caches for the on-chain registry and x402 spot price.
- The agent-ui SDK.
- SNS work: native register UI, reverse lookup, subdomain claims, x402 pay-by-name.
- The AgenC integration: identity bridge, x402 mirror, embodied component, live API, storefront example.
- A smart-money feed narrated by 3D agents, a video create flow, and a longcat worker.
- Anthropic MCP Registry listing for the Avatar Agent MCP; MCP server v1.0.1 through v1.0.3.
- Face mocap, Gemini Live, and auto-rig demos; a Mixamo animation pipeline importing 31 rigged clips.
- SEO and DX: dynamic sitemap, structured data, IndexNow, view transitions, analytics, llms.txt.
- Provider failover chains for Hugging Face and OpenRouter.
- A production hardening run: Helius credit optimization, service worker precache removal so updates land in seconds, a mobile UX overhaul, chat failover.

Pages: /studio (Widget Studio), /launchpad, /hydrate.

Announced: 2,500 new 3D animations and the @three-ws/avatar-agent MCP server (May 22). Blog: "Real-Time Voice Interaction with 3D AI Agents" (May 19), "Listed on Coinbase x402 Bazaar and agentic.market" (May 21), "2,500 New 3D Animations" (May 22), "We Just Shipped the 3D Layer for the Internet: agent-3d" (May 23).

---

## Week 7: May 25 to 31. Every memecoin becomes a world. AWS goes live.

179 commits.

- Coin Communities at /play: atmospheric worlds, joystick controls, a boot avatar, avatar upload, holder-gated Holders worlds, spatial voice chat, X OAuth sessions, rich link unfurling, and a flagship pinned $THREE world called town.
- An isometric /game world with a shared avatar rig, plus /city.
- Game systems in bulk: cosmetics, quests, mounts, loot, realms, a spin wheel, friends and presence, play-pass, holder-pass, token payments, and a player-to-player marketplace.
- The AWS partnership went live: three.ws wired to AWS MyApplications and Marketplace SaaS, an EULA, a welcome page, auto-issued x402 API keys for subscribers, and cancellation enforcement.
- /dashboard-next graduated to /dashboard.
- Pay-per-answer AI over x402 at $0.01 USDC per explanation with real settlement; a paid Solana vanity grinder API.
- Homepage v4 with a live pump.fun token card, a real "Launch yours" flow, and a traction stats bar.
- Walk expanded through dozens of tasks: recording, AR CTA, an embed SDK, a Chrome extension scaffold, zen mode.
- Developer surfaces: a developer dashboard, webhooks, an avatar render API, usage API, x402 admin analytics, an x402 receipt verifier.
- LLM calls consolidated with a locked BYOK policy: free Groq and OpenRouter lanes, Anthropic BYOK only.
- Agent reviews, a reputation overhaul, a portfolio overhaul, a voice lab, a brain page, AR/XR pages, a theme system.
- Vercel build hardening: OOM fixes, staggered Vite phases, lazy chromium, fail-fast API bundling.

Forty pages, including /bazaar, /playground, /skills, /characters, /brain, /three-live, /dashboard and its analytics and settings, /create/selfie, /threews/claim, and ten blog pages.

Announced: emotion blending, memory, cloned voice with lip-sync, and autonomous skill calls in the AWS thread (May 27); /play as a live multiplayer townhall for any launchpad coin (May 30). Blog: "three.ws Joins the AWS Partner Network" and "three.ws Launches on AWS Marketplace" (May 27), "We turned every memecoin into a live 3D world you can walk into" (May 30).

[IMAGE: play.png]

---

## Week 8: June 1 to 7. IBM, fourteen MCP servers, and the Forge.

248 commits.

- A GTA-style /play world: quests, combat, vehicles, districts, NPC life, a HUD, cosmetics loadouts, build persistence, world gating.
- The cosmetics economy went live with earnings, leaderboard and split APIs, x402 cosmetic purchase, and a live feed.
- The IBM partnership suite: digital twin page and API, Granite Vision, Granite Guardian verify, watsonx forecast, govern and attest, an agent galaxy, an IBM trust layer, proof and trust pages, a shared IBM design system.
- Fourteen MCP servers scaffolded and shipped, including 3D Studio MCP, x402 Bazaar MCP, IBM watsonx MCP, pumpfun MCP, three-token-mcp, and an avatar MCP whose render tool is an interactive MCP App.
- The IBM Granite x402 MCP endpoint at /api/ibm-mcp with catalog, discovery, and pricing.
- Forge shipped as a product: multiview, segment, stylize, remesh and texture workers, forge tiers, magic brush, an animation library, pose studio, a text-to-motion worker, and an x402 forge OpenAPI.
- A Blender addon and ComfyUI nodes as three.ws clients.
- Privy auth with JWKS verification and DID linking; SAML enterprise SSO.
- The /go bounty board with an AI judge, a python client, and a leaderboard.
- Market intelligence endpoints, agent skills, and MCP tools; a real KOL trades feed; native holder cohorts for agent tokens.
- A five-step /create-agent wizard wired to real endpoints.
- On-chain brand work: the 3ws vanity mint mark, IPFS pinning for launches, on-chain metadata builders, a shared on-chain badge, pump fee-sharing.
- x402 and MCP security: always-on replay guards, A2A cart mandates, MCP returning 401 with WWW-Authenticate, SSRF hardening, standardized 429s.
- Every agent got its own wallet.

Thirty pages, including /forge (June 4), /avatar-wallet-chat, /agent-exchange, /agent-economy, /agent-trade, /labs, /voice, /club, /coin3d, and the feature pages for play, forge, and walk.

Announced: the Animations and Poses Studio (June 2), two MCP servers for x402 Bazaar discovery and pay-and-call in USDC (June 4). Blog: "Showcasing the three.ws x IBM Partnership" (June 2).

[IMAGE: forge.png]

---

## Week 9: June 8 to 14. NVIDIA NIM end to end. @three-ws everywhere.

229 commits.

- NVIDIA NIM ran as a full plan: a free NIM FLUX lane first in text-to-image, a free NVIDIA TRELLIS provider for text and image to 3D registered as the draft-tier default, a free Riva TTS lane, a NIM reranker, and multi-provider embeddings.
- Scene Studio and a TripoSG worker with health checks and one-command deploy.
- Scene Composer at /compose: real-time item forging and an avatar outfit builder with undo/redo, animations, camera presets, and screenshot.
- Text to 3D put front and center: Forge on the discover feed, a launch post, a redesigned home mini-Forge.
- Every package renamed from @3d-agent to @three-ws, and all 14 MCP servers announced live on npm and the MCP registry.
- A first-party uptime monitor and public status page; first-party client error reporting.
- The changelog became a real surface: per-entry detail pages and Telegram auto-push on deploy.
- A MetaMask agent wallet server, demo scripts, and marketplace skills.
- Provider resilience: a BYOK registry, Rodin and Stability 3D providers, multi-key OpenRouter rotation.
- Claude Fable 5 and Mythos 5 registered across the model catalog.
- New surfaces: IRL AR, an AR feature page, a support contact directory with humans.txt, a name-resolve lookup page, a shared view switcher across 3D, chat, AR, and embed.
- A dependency outage on June 11 was closed out fully.

Ninety-two changelog entries and 19 pages, including /play/agent-wallet, /launches (every agent-launched coin in one live feed), /irl, /scene, /compose, /evm-wallet, /status.

Announced: agent-to-agent payments, 1-of-1 3D worlds per coin, x402 microtransactions (June 9); the prompt-to-3D engine /forge plus Scene Studio (June 12). Blog: "3D + AI + Web3 Just Converged" (June 8), "three.ws Wins DEXTools Social Boost: $5,543 $THREE Buyback" (June 8), "Featured on the Alibaba Cloud Marketplace Blog" (June 8), "Text to 3D Is Live" (June 12), "See Your 3D Avatar in the Real World: AR Lands" (June 13).

That DEXTools win is worth pausing on: a third party executed a $5,543 buyback of $THREE and its wallet subsequently held 2.47M tokens. External capital, deployed on the strength of the community.

---

## Week 10: June 15 to 21. three.ws becomes a trading platform.

590 commits and 500 changelog entries, the single biggest changelog week of the year.

- Oracle shipped as the flagship: a conviction scoring engine with a live trade tape, a feed with New, Top, and Hot sorts, a Movers tab, coin drawers with sparklines and sentiment, Hot Sectors, an agents leaderboard, an Oracle Proof gallery of outcome-verified wins, a 3D conviction force graph, a backtest API, a daily Telegram digest, and personal exit alerts.
- Conviction was then threaded through every surface: pump-live, watchlist, launch cards, Coin Radar, Smart Money, portfolio, token cards, sniper positions, copy intents, the coin3d HUD, MCP tools, and the homepage.
- Non-custodial copy trading: copy APIs, a panel, a dashboard, cron fanout, performance fee settlement, Telegram buy intents, a Smart Money directory, and a Claim Wallet page.
- The agent-sniper service with a strategies dashboard, closed trade history, cumulative PnL, intel-confirmed triggers, Jito bundle mode, an AMM graduated exit, and a Strategy Lab with a DSL.
- A Coin Intelligence engine, a Smart Money Radar built on a pump.fun wallet reputation graph, a trader leaderboard, on-chain TraderScore attestations, and an intel-learn cron closing the loop.
- IRL AR became a full product: multiplayer AR pins, room anchors, GPS lifecycle, gyro world lock, compass alignment, presence, moderation, an owner dashboard, a privacy center, and an accessibility pass.
- The $THREE economy layer landed: a pricing catalog, a pay-per-use rail, holder tiers, a club cover pass, holder rewards, buyback math, an allowance module, a holder leaderboard with a snapshot cron, a referral membership card, and a $THREE economy page. The buyback commitment went public and verifiable on the token page. Your holder tier started showing across the site. The homepage hero began reacting to live $THREE market data.
- Your agent could now trade from its own wallet with real guardrails, and you could freeze that wallet in one tap.
- Pole Club expanded with an entrance alley, celebration one-shots, 8D audio, an x402 door and cover.
- Walk became a hub: a Walk Playground that turns any page into a platformer, leaderboards, a control API, footstep trails, NPC companions, a walk SDK.
- New SDKs: walk-sdk, page-agent, tour-sdk, x402-modal and x402-payment-modal with a release script, an x402 Studio merchant console, a VS Code x402 extension, an x402 storefront template.
- Monetization deepened: subscription plans bundling skills, gifting, on-chain skill licenses and NFTs, gasless transactions, verified platform fees, bundles, a creator revenue ledger with payouts, pay-what-you-want, reviews, affiliates, account tiers with referral codes.
- Brain Studio for visual agent-mind building; Memory Studio with an entity store and graph.
- New play surfaces: Coin Wars clash, Flappin UFO, a Sniper Arena, body mocap, an animation marketplace.
- Smart glasses support for Brilliant Labs Frame and Even Realities G1.
- A provably-fair verifiable vanity grinder with a bounty market, sealed drops, and rarity scoring.

Forty-seven pages, including /x402/studio ("the Stripe of x402"), /play/arena, /oracle, /forge-studio, /economy, /marketplace/analytics, /walk, /tour, /animations, /claim-wallet, /smart-money, /leaderboard, /trending, /ibm/x402-demo, /credits.

Announced: autonomous 24/7 trading agents sniping live inside a 3D world (June 20).

[IMAGE: oracle.png]

---

## Week 11: June 22 to 28. Autonomy.

458 commits, 372 changelog entries.

- Agora shipped as a living world: a scene, a citizens worker economy loop, passports, professions (sculpt, write, verify), a job board, a ticker, a pulse feed, a trust surface with work-proof verification, a human participant API and HUD, and an agora-mcp package. Any AI agent can join Agora's workforce over MCP and earn $THREE.
- Back-an-Agent Vaults for copy-trading verified agents: deposit, redeem, fees, a share-price drawdown breaker, a live KOL leaderboard.
- Agent wallet embodiment: net-worth reactive avatars with auras and regalia, a Money Pulse page, identity nameplates (your avatar now wears its wallet), a wallet reputation store, a mood engine, spend policies, proof of custody, an anomaly engine, social recovery.
- Live agent surfaces: agent-screen streaming with an on-demand browser caster, a live agents wall and mission control, a reputation arena, a draggable agent-screen workspace, content billboards in 3D coin worlds.
- The Memetic Launcher and an autonomous launcher with quote-mint filtering, an initial dev buy, and a deployments feed with a live kicker.
- The x402 endpoint catalog exploded: auth health, API-key health, feed health, rate-limit probes, spend sessions, wallet connect, cross-chain, an LLM proxy, notify, schema checks, a DID health sweep, club analytics, pump trending, launch monitor, an uptime monitor, an MCP latency SLA feed, and a cross-network circuit breaker. An API-key bypass security test began auditing our own paywall for free-access leaks every day.
- Seventeen more MCP servers registered plus portfolio, autopilot (with a SOL spend cap and a $THREE buy-only mode), notifications, alerts, audio, clash, loom, activity, agenc, billing, brain, kol, tutor, vision, and omniology. Eighteen @three-ws SDKs went live on npm, and the x402 wallet started paying in $THREE.
- The Omniology Arena: a multiplayer contest venue with an Atelier plaza.
- NVIDIA continued: self-hosted TRELLIS image-to-3D on Cloud Run, a NIM forge backend with /forge-nim and /forge-spark, Audio2Face and Cosmos lanes, and self-host tutorials.
- ca2x402: paste a contract address, get a payable x402 token-intel endpoint.
- The Agent Labor Market with a reasoning ledger, genome breeding and lineage, escrow settlement, usage metering, referral rewards.
- The trading frontier batch: tournaments, swarms, a signals marketplace, programmable orders, an alpha co-pilot, a mission-control terminal with real-time candles, a natural-language strategy compiler with backtesting, a market-maker engine, prelaunch radar.
- A Splat Viewer for Gaussian-splat avatars, a cinematic post-processing pipeline, an Animation Studio overhaul, a coin3d live trading scene.
- Proof of Reserves for agent wallets, NFT-gated skill access, a Solana agent-bouncer reputation gate, vanity proof-of-grind certificates.
- Redis and cache resilience with circuit breakers and in-memory fallbacks.

Fifty pages, including /agora, /vaults, /labor-market, /partners, /arena, /forge-nim, /forge-spark, /avatar-engines, /three, /genome, /genesis, /guardian, /pulse, /payments, /signals, /theater.

Announced: the drop-in x402 payment modal and the /club reputation demo (June 22), "The Stripe of x402" article and the local image-to-3D lane on DGX Spark (June 23). Blog: "The Stripe of x402: How three.ws Turned Agent Payments Into One Line of Code" (June 23), "three.ws Joins the Alibaba Cloud Partner Network" (June 27).

[IMAGE: agora.png]
[IMAGE: vaults.png]
[IMAGE: labor-market.png]

---

## Week 12: June 29 to July 5. Close the x402 loop. Make the money safe.

86 commits through June 30, then 198 from July 1 to 5; 212 changelog entries.

- A closed-loop agent economy on x402 with a self-hosted facilitator, replacing external settlement. The payment rail now runs entirely on three.ws infrastructure.
- A public /x402-revenue page for real-time payment tracking with filters and export.
- The x402 packages extracted into standalone repos with docs for npm and the VS Code extension.
- The circulation engine refactored so that no external payouts exist by design.
- Launch Studio with 50 coin-launch use cases and live previews.
- Labor market escrow came online with self-healing release gas.
- agent-sniper published as a package with custodial and self-custodial adapters and its own MCP server and paid x402 API.
- The global Markets surface: /markets with live prices, coin detail pages, and a Coin Market Data API.
- The Oracle conviction stack expanded: standalone coin pages, creator launch history in scoring, a consolidated feed, a published methodology.
- The x402 ring economy productionized: dual pause switches, volume caps, treasury sweepback, a live-state audit with invariant tests. Every paid endpoint now settles every minute.
- An economy watchdog and heartbeat: an economy-tick cron, a public heartbeat status, self-paging alerts, and a tamper-evident accounting ledger for the master wallet. Every platform wallet is now watched for leaks.
- The Live Trading Theater opened as a trading room, with a 10 SOL trading experiment and end-to-end policy proof.
- Agora got proximity chat, world-seeded citizens projected from rigged agents, an avatar inspector, and an "Enter the Commons" mode with interactive NPCs.
- Explore mode and the Tour Builder: visitor-driven checkpoint tours, a Shopify one-tag store-guide install, tour SDK 0.3.0.
- 2,000+ motion-capture animations added, with thumbnails, a category classifier, and sharded export.
- @three-ws/retarget extracted as a standalone humanoid animation engine; 36 stale packages republished.
- Sniper fleet money safety: laddered exits, a fleet-wide market-cap band, a dead-man switch, an all-wallet leak scanner. Trading agents now stop themselves after a losing day.
- Real funds now require a one-time risk acknowledgment.
- A July 4th homepage with date-gated fireworks and festive avatar presets.

Twenty-seven pages, including /x402-revenue, /mocap-studio, /autopilot, /diorama, /coins, /launch-studio, /agenc/embodied, /agenc/room, /agent-economy-volume, /legal/risk.

Announced: the VS Code x402 extension with a built-in wallet (July 1).

[IMAGE: x402-revenue.png]
[IMAGE: pulse.png]

---

## Week 13: July 6 to 12. Cloud Run, Robinhood Chain, and a million endpoints.

389 commits, 223 changelog entries, 52 pages.

- Production migrated to Google Cloud Run with a full runbook, Memorystore Redis behind an internal load balancer, and a CDN purge after every deploy. The container now runs unprivileged.
- The whole Robinhood Chain package family: hood-api, hood-cli, hood-js, hood-launcher, hood402, hood-mcp, hood-traders, hood-alerts, hoodkit, erc8056, plus a React demo. Robinhood Chain landed on three.ws Markets with live stocks, coins, and a real buy flow.
- A native crypto news platform: an aggregation and archive API covering September 2017 onward, an SSRF-guarded reader, /markets/news, a hosted archive, hourly archiving with RSS, a health-verified source registry, a daily digest.
- The Markets hub expanded into protocol, chain, and stablecoin pages with fees, DEX volumes, hacks, and trending; a 17-endpoint Market Data API; a DeFi yield explorer at /yields; CoinGecko-to-DefiLlama failover.
- The datapoint fabric: 480,000+ standalone paid x402 endpoints at launch, then 1,000,000+ covering any token by contract, behind a unified service catalog.
- Each 3D pipeline stage sold as its own priced x402 resource, plus /api/x402/pipeline where one paid call runs a full asset chain.
- The social layer: a platform-wide feed at /feed, a leaderboard with streaks and badges at /rankings, cross-entity search, a follow graph, creator portfolios at /u/username, a friends panel, a notification bell for remixes, royalties, DMs, and graduations.
- readme-3d, an open Apache-2.0 toolkit for 3D in markdown, with a live avatar embedded in the repo README.
- /create rebuilt as a four-intent hub with a self-referential onboarding tour.
- Free Crypto Data API lanes: trending tokens, holder distribution, token snapshots, token security, a keyless Jupiter provider.
- OKX Agent Payments Protocol support and an X Layer rail.
- The BNB Chain track: chain constants, a gasless send client, a Greenfield vault, the /vault UI, a bridge, a /bnb hub.
- A GCP credits program with spend dashboards, budget alerts, and Vertex Claude and Imagen lanes.
- A 3D avatar backfilled for every agent.
- Premium pass subscriptions with billing and data-API dashboards, sealed gifts, a Wheel of Fortune, and a speech package delivering ASR and TTS over x402.
- Security: paid downloads can never ship before settlement, paid endpoints confirm a payment can settle before working, money-moving skills require explicit spend confirmation, the settler is flood-protected.

Pages include /markets and its trending, news, archive, digest, and robinhood subpages, /vault, /heatmap, /screener, /defi, /yields, /stablecoins, /crypto-api, /dashboard/billing, /dashboard/data-api.

Announced: 3,000+ animations, "the largest animation library in existence" (July 6); Tour, 3D guides that walk your live site, and "70+ packages on npm" (July 8); the crypto intelligence platform (July 10). Blog: "We Are the Provider Now: Real-Time Crypto Data, a Nine-Year News Archive, and the Data Layer the Agent Economy Runs On" (July 10).

[IMAGE: markets.png]
[IMAGE: markets-news.png]
[IMAGE: markets-archive.png]

---

## Week 14: July 13 to 19. 84 languages, AR Studio, and a GPU fleet of our own.

357 commits, 163 changelog entries, 65 pages.

- Full-site internationalization: 163 pages auto-annotated, complete catalogs for ten languages, then 41, then 84 locales, with a completeness rule and deep links.
- AR Studio: multi-model live-camera AR with in-view forging, shared rooms where several people build one scene, real room lighting, pinch-to-resize, an Objects tab, shareable links with real renders.
- The auto-rigging lane rebuilt on Make-It-Animatable with real ARKit-52 blendshapes; a Character Library of 106 rigged characters at /character-library plus CC0 additions.
- Motion Swap and video2motion: replace yourself in a video with your avatar, all 30 finger bones solved, hierarchical FK, multiclass segmentation.
- The self-hosted GPU model fleet on Cloud Run: Hunyuan3D 2.1 with a PBR lane on RTX PRO 6000, TRELLIS with burst scaling, TripoSG, tier-mapped budgets.
- Forge generation that never dead-ends: poll-time lane failover, one-click engine switching, a quality gate, a reference-image pipeline, turnaround-view synthesis, 2K photoreal references via Gemini on Vertex. Sketch-to-3D went live.
- Daily Forge, a daily 3D challenge with creator streaks; auto-classified categories; share permalinks; one-tap variations; a "Surprise me" avatar.
- /irl features: Money Drops and World Lines, permanent pin links, iPhone Quick Look placement with a baked animated idle USDZ, a compact phone HUD, private pins.
- Every ChatGPT generation now carries a device-aware place-in-your-room AR link; the ChatGPT Apps SDK widget renders models.
- The assistant and concierge layer: an embeddable concierge widget with a face, an assistant builder, assistant MCP packages, an x402-server SDK pass.
- The homepage rebuilt as a live community feed with forging in the hero.
- Avatar reconstruction: dense face registration, selfie face-geometry morphs, image-based lighting.
- Automatic changelog delivery to holder channels, a commit-to-entry gap auditor, a Telegram ops alert channel.
- Sketchfab distribution with a curated showcase cron and a brand-safety gate.
- A steady drip of $THREE buys paid through the x402 loop.
- A gcp-triage agent skill for automated log monitoring.

Pages include /concierge, /assistant, /ar, /ar/studio, /image-to-3d, /motion-swap, /character-library, /daily.

Announced: 3D Studio inside ChatGPT, AR placement, the /irl world map (July 15). Blog: "three.ws Joins the Quicknode Startup Program" (July 16), "Concierge: We Gave the Site Chatbot a Face" and "Inside the Forge: How a Prompt Becomes a 3D Model" (July 18), "Our Agent Made Its First Autonomous Trade. Here Is Every Decision It Took." (July 19).

[IMAGE: ar-studio.png]
[IMAGE: character-library.png]
[IMAGE: motion-swap.png]

---

## Week 15: July 20 to 26. Body language: clothes and sign language.

301 commits, 116 changelog entries.

- The garment and wardrobe system: a garment forge pipeline with image generation and mesh processing, barycentric skin transfer with an occlusion mask, a wardrobe page, a stocked catalog across all slots, MCP tools so agents generate their own garments. Dress any avatar: the wardrobe adds clothes, not just recolours.
- Sign language: an ASL fingerspelling recognition worker running webcam-to-text, camera sign input in chat, a sign-language reply toggle, fingerspelling on the avatar's right hand with a shareable deep link, confidence scores, numbers, a 26-handshape audit.
- /cookbook, an executable text-to-3D tutorial rendered on-site.
- The Object Library at /objects with hundreds of CC0 props, a GLB thumbnail pipeline, a CORS-open GLB proxy.
- A security pass: same-site gates on cookie-authed mutations, fail-closed when CRON_SECRET is unset, facilitator-settleable mints pinned, SSRF-guarded fetch across scene graph and article extraction, open-redirect prevention.
- The Sniper self-improvement stack: an evolution engine on a cron, an intra-arm optimizer that self-tunes from realized outcomes, a judgment ledger persisting every LLM verdict against coin outcomes, a recalibrated honeypot detector, a boost-ride arm, a new LLM arm in the bracket.
- The 90-trade autonomous fleet postmortem published at /blog/all-90-trades and expanded into a full research report. The numbers, published in full: 11 agents, 90 trades, 25 wins, 1.932 SOL deployed, net -0.103 SOL. We published every decision because the point was the ledger, the gates, and the firewall that simulates the sell before the buy, and that data is what the self-tuning optimizer above learned from.
- The CC0 anny parametric body with 472 morph targets vendored and wired into Avatar Studio.
- The Avatar Composer for GLB composition and part selection; projective texturing reaching the 81% of the head the warp cannot.
- Twelve Robinhood Chain sites rebuilt with an LLM strategist and an X transport.
- A Telegram commit feed posting every commit on main; NVIDIA Inception membership with a docs page and footer badge.
- Play features: zen mode, quest markers and NPCs, a forged gallery of props bought by autonomous agents, a /timeline page with a 3D scene.
- MCP publishing reworked: every server.json gated, orphaned packages adopted, per-package failure isolation, versions reconciled with npm. Every three.ws MCP server now resolves to its current version.
- Our x402 facilitator now publishes a standard discovery catalog. Agents can pay for things from their own wallets. Agent-bought 3D models appear in the gallery with their on-chain receipt.
- The bounded-concurrency ring tick reached about 94 paid calls per minute.

Pages include /forged, /forge-max, /sign-language, /objects, /wardrobe, /timeline, /openai, /ledger, /cookbook.

Announced: 500+ free CC0 3D props (July 23); 10k+ x402 transactions (July 24); sketch or photo to rigged 3D agent, and a forged avatar hired as an autonomous trader with an on-chain profile (July 25). Blog: "We Gave 11 AI Agents Their Own Wallets and Real SOL. Here Are All 90 Trades." (July 23), "three.ws Named an OpenAI Select Partner" (July 25).

[IMAGE: wardrobe.png]
[IMAGE: sign-language.png]
[IMAGE: objects.png]

---

## Week 16: July 27 to August 2. Make the platform legible.

422 commits, 194 changelog entries, and 81 new pages, the biggest page-launch week of the year.

- A docs world: full-text docs search, live-verified doc steps, freshness measurement with a reader badge and drift dashboard, a 3D wayfinder, a media capture pipeline with tutorial figures, 87 docs made discoverable.
- /monitor, an ops-room dashboard for the 3D agent fleet.
- The guard registry at /guards: route and page guards that can actually fail, proofs published beside the page that explains them, push-time rule enforcement, cron-liveness and custodial-key audits.
- The economy lab: a solver, a pay simulator, a money flow map, a payment policy engine with a spend simulator and runway lab.
- Motion signatures as a public API, a signature index measured from every baked clip, an MCP tool that picks clips by measured motion.
- /gestures and a choreography system: a routine format, a runtime player, an authoring page.
- Public crew and bundle surfaces, bundle pricing from the seller's own ledger.
- The sign-language mirror with a grader, an ASL alphabet page, a text-to-ASL API.
- The interactive walkthrough player, a guided tour atlas with 264 verified stops, a feature atlas with a flow map.
- An instant agent endpoint: one sentence in, a playable agent out. An embed doctor and a rig doctor.
- /trading as one front door for the autonomous system, an exit lab replaying counterfactual exits over real closed positions, /holo.
- A self-hosted native launch curve as an alternative to pump.fun via /launch.
- A large i18n reliability pass: 5 new locales, hreflang alternates for 160 pages.
- Forge Max: the highest-quality 3D lane got its own address, and it is a $THREE holder perk.
- The Receipt Vault: every x402 payment you ever made, retrievable forever.
- Wallet encryption keys rotatable without stranding funds; every MCP tool's safety label verified; every x402 payment settles against its own Solana transaction.
- three.ws can search the live web with checkable sources. Oracle became a live Telegram feed. The fact checker publishes a measured accuracy score.
- Marketplace accounting corrected so free trials never count as sales.
- The top 30 pages cleared the axe WCAG-AA floor.

Pages include /nvidia, /wallet, /play/economy, /play/solver, /mcp-tools, /avatar-cli, /receipts, /crews, /atlas, /press, /fits, /trading, /exit-lab, /economy-lab, /walkthroughs.

Announced: sign language fingerspelling avatars, webcam sign reading, and the sign_text MCP tool (August 1). Four video scripts were also written this stretch and the next: the platform film "Give your AI a body," the AR Studio launch, the browser agent deployer, and a shot-by-shot Veo sequence for the open-source agent infrastructure clip. Blog: "Image-to-3D on NVIDIA L4 and Blackwell: Shipping Hunyuan3D 2.1 on Cloud Run GPUs" and "How to Monetize an MCP Server: Paid Tools with x402" (July 30).

[IMAGE: nvidia.png]
[IMAGE: walkthroughs.png]
[IMAGE: mcp-tools.png]

---

## Week 17: August 3 to 9. The meetup.

411 commits, 111 changelog entries.

- Coin Wars and the live events system: server-side war logic, event scoring, quest zones, /play/war as a real page, spectating from the portal, a ticketed arena seat, a war league API, community pairing, a durable event leaderboard.
- The first $THREE holders meetup on /play, hosted with IBM Community's dedicated Three.ws User Group on August 7: an /event landing page, a live population API, a homepage countdown, souvenir drops, a plaza stage, a meetup laurel, a signed operator CLI to announce into live worlds, and synchronized fireworks when it started. Show up to a live event and you keep something from it. Peak: 3,145 concurrent avatars.
- /play rebuilt for crowds: world entry in seconds, a boot that cannot strand the loader, animation LOD for remote players, a shared avatar template cache, spatial voice capped to the 8 nearest peers, scenery batching, the physics chunk moved off first paint.
- Every walker in the world became a real citizen you can open and talk to; verified handle nameplates; in-world avatar changing; photo mode; forging a prop straight into the world.
- The Oracle conviction engine replaced with a model fitted on 92,000 real outcomes, with fitted reasons and realized odds beside every score.
- The exposed admin panel removed entirely.
- A broad security pass: per-response CSP script hashes instead of unsafe-inline, 113 inline handlers moved, credential masking before error sinks, DNS pinning on client-supplied metadata, CSRF and write budgets on swarm mutations, one shared fail-closed cron gate replacing 78 copies. Every critical dependency advisory cleared.
- @three-ws/agent-runtime: a server-side agent loop as a built-in chat model, a transaction guard, and a preflight endpoint for fund-moving tool calls.
- /airdrops, which scores any wallet's real on-chain activity, and /portfolio, a live wallet portfolio for any Solana or Ethereum address.
- Every forged model got its own page at /m/:id with comments, likes, and live stats; /sign-mirror for graded handshape practice.
- A keyless data wave: on-chain fundamentals, Bitcoin reads, options and perp data, seven CEX ticker rungs, price oracles, EVM gas with failover, read-only swap quotes, subreddits, six more free LLM rungs.
- Every TTS lane unified behind one registry; bring-your-own-key ElevenLabs with overage metered to $THREE credits.
- The Agora and AgenC on-chain layer: reputation ladder gating, escrow refunds, self-funding signers, on-chain task timelines, validation attestations. Agora citizens now live on-chain: they register, claim work, prove it, and earn.
- The first signed Seeker APK for Solana Mobile; a load-test harness for N concurrent viewers.

Pages include /play/war, /portfolio, /airdrops, /event, /sign-mirror.

Announced: the live meetup inside the $THREE world with spatial voice (August 7). Blog: "The Three.ws User Group's First In-World Meetup: How It Went" (August 8).

[IMAGE: play-war.png]
[IMAGE: arena.png]

---

## Week 18: August 10 to 16. The audit swarm.

2,014 commits and 527 changelog entries, the largest entry count of any week.

The dominant activity was a full-platform audit campaign: roughly 105 work orders covering every API batch, every cron batch, every GPU worker, and about 60 individual page routes, each opened, fixed, verified end to end, and retired. Every worker was audited by name: hunyuan3d, trellis, triposg, video2motion, video2scene, asl-recognition, rembg, rig, remesh, texture, avatar-reconstruction, the pipeline controller, the vanity grinder, agent-mm, agent-sniper, agent-anchor, the screen pool and worker, agora-citizens, and the OKX chat bot. Around 400 fixes and repairs landed alongside it. And while that ran:

- The reputation staking market: open, read, and settle stake positions over an attested Solana rail, spec-pinned invariants with contract tests, a documented conviction staking proof. The contracts that hold agent earnings, reputation stakes, and skill licenses are now audit-ready.
- The inference network opened to outside node operators with signed receipts, a conformance runner, metered jobs, and a CUDA image.
- Signed agent manifests: a published JSON Schema, a manifest signed and pinned on every persona save, on-platform verification, an on-chain history index.
- The likeness program: a face-embedding scorer measuring how closely a generated avatar matches its source selfie, a distribution harness, a weekly sweep.
- The Arena: an always-on daily house bracket staffed from the trader leaderboard.
- Recurring payments at /recurring with a charge ledger and failure classification; Solana Pay transaction request support for skill purchases.
- Consent-first memory seeding from GitHub, X, and Farcaster with revocable grants.
- Bring-your-own-key voice cloning as its own step in the create-agent flow.
- Skill royalties: per-call author royalties accrued on paid skill calls, surfaced in the creator dashboard.
- A saved, editable token launch plan before minting; live bonding curves on launched coin cards.
- Custody controls: per-counterparty daily send caps, wallet intents with rolling ceilings, an atomic vault buy budget.
- The persona onboarding interview that writes an agent's voice from real answers.
- Provably-fair vanity wallets with grinder receipts verified end to end.
- A texture pipeline with UV-space rasterization and occlusion-rejecting back-projection; a physics-simulation readiness grade for meshes.
- Security headers checked against the live site, withdrawals confirmed against the real payout, vanity bounties and sealed drops going live only after payment truly clears.

Pages include /reputation/market, /recurring, /demos/agents.

On August 16 the news archive count was pulled for an announcement: 740,889 articles from 197 publishers, first article September 23, 2017.

[IMAGE: reputation-market.png]

---

## Week 19: August 17 to 23. Open source.

118 commits, 76 changelog entries.

- three.ws relicensed to Apache-2.0. Every page that still said proprietary was corrected, the OSF criteria were marked met, and holders were told.
- A contributor front door: a community page, a first-PR path, triage guidance, and a README that puts the contributor path on the first screen.
- The Metaplex agent registry MCP server shipped as @three-ws/metaplex-agent-mcp, with a standalone browser deployer site that puts an agent on-chain with no server and no account. Deploying an agent on-chain now buys $THREE, and holders deploy free: the mainnet deploy fee is paid to the buyback wallet, halved at 50,000 $THREE held, waived at 250,000.
- The onchain-agent-wallets MCP server: an agent gets a spending allowance instead of a private key, with the custody model published.
- Real AR Quick Look on iPhone in AR Studio, USDZ exports, and public model reads opened to any origin. Our AR studio is now a package anyone can drop into their own site.
- MikuMikuDance rig support, so MMD avatars animate.
- Agents and avatars rendered from one canonical studio page; a Genesis-style on-chain deploy page.
- Any AI agent can now buy a 3D model from us in one call.
- A bootstrap-ordering gate that refuses to ship a browser module which would throw on Safari.
- The page audit sweep extended to WebKit and Firefox.
- An economy wallet rotation runbook and an operator registry surface.
- The AWS Marketplace listing kit rewritten for the EventBridge integration.
- Every X announcement draft consolidated into one folder: the MCP registry fleet (72 servers verified August 20), the AR Studio launch, the agent deployer, the Coinbase listing, and more.
- About 20 mobile and accessibility fixes.

Pages include /deploy-onchain, /ar/view, and docs for play vehicles, community, first contribution, and triage. There is a real car in every coin world now, and you can get in and drive it.

[IMAGE: partners.png]
[IMAGE: gallery.png]

---

## This week: August 24 to 25. Credibility.

11 commits so far.

- $THREE's pump.fun verification is now read live from pump.fun on the token page, with the verification graphics added to marketing.
- The pump.fun pill mascot shipped as a rigged, drivable 2.6 MB avatar with its own stage at /pill, and capsule mascots now auto-rig from their own geometry.
- The full $THREE thesis was published as a single document, every utility, sink, listing, and risk sourced back to the code.
- The Hugging Face article, avatar rigs, and Space were indexed in the docs.
- The repo crossed 100 stars on GitHub (104 at the time of writing, 26 forks, 21 contributors, 60 pull requests).
- The repo crossed 100 stars on GitHub, and the open-source footprint page went up: every registry, marketplace, community, and directory where three.ws code lives, each link verified live and each number pulled from the registry's own API.

---

## The open-source footprint, all in one place

[IMAGE: github-100-stars-x.png]

Everything three.ws ships is Apache-2.0, and it has not stayed inside one repository. Where it stems:

- The main repo, github.com/nirholas/three.ws: 9,508 commits, 21 contributors, 60 pull requests, 104 stars, 26 forks, 70 packages, 33 workers (27 as Docker images), 31 specs, 323 docs, 1,752 test files, 4 Rust crates, 7 Solidity contracts, 2 Anchor programs.
- npm: 101 packages under @three-ws, 42 of them MCP servers, 6,225 downloads in the last 30 days. Avatars, x402 payments, Solana agents, pump.fun tooling, voice, mocap, retargeting, sign language, the assistant and concierge widgets, readme-3d, 3d-ar-studio.
- The official MCP registry: 72 servers under io.github.nirholas. Also listed on Glama (10 servers) and PulseMCP (18), on x402scan, and on 402index (19 endpoints, domain claimed). The Smithery submission is drafted, not filed.
- 111 related public repos with 1,222 stars between them: a 50-repo x402 suite of standalone paid services, the Robinhood Chain family, the extracted x402 server, fetch, modal, bridge, and VS Code extension, the Metaplex agent MCP, on-chain agent wallets, the AR Studio, the news archive, the X Spaces voice agent, and more.
- On-chain: ERC-8004 identity, reputation, and validation registries deployed by CREATE2 to the same address on 12 EVM mainnets (Ethereum, Optimism, BSC, Gnosis, Polygon, Mantle, Base, Arbitrum, Celo, Avalanche, Linea, Scroll), bytecode-verified; the ThreeWSFactory and payments contracts; two Solana programs for agent invocation and skill licensing.
- x402: 4,519 priced endpoints in the live discovery catalog, 110,416 on-chain settlements and 803,483 verifications through the self-hosted facilitator, 3,000 validator attestations under the threews.validation.v1 memo envelope, 126,522 custody proofs across 244 epochs.
- Hugging Face: the three-ws org, the avatar-viewer Space, the avatars model repo, and a published blog post, "Giving AI agents bodies and wallets."
- Where we write on other people's platforms: three articles on AWS Builder Center (metering a SaaS product through AWS Marketplace, autonomous agents with 3D bodies and on-chain payments, and the agentic economy), two NVIDIA Developer Forums write-ups (how Nemotron made the text-to-3D pipeline usable, and translating the site into 100 languages with NIM), three IBM Community blog posts (our founding post on June 8, IBM's own welcome to the user group on July 14, and IBM's meetup recap on August 8), and the HackerNoon author page.
- Chat platforms: three.ws 3D Studio in the OpenAI GPT Store, the LobeHub plugin, and the SperaxOS chat plugin at chat.sperax.io. An OpenAI Cookbook pull request is open.
- Every link, with the number behind it, lives at three.ws/docs/open-source-footprint.
- Editors and stores: a Blender addon, ComfyUI nodes, the VS Code x402 extension on the VS Code Marketplace and Open VSX, a Chrome extension, and two Claude Code plugins in the plugin marketplace.
- Three GitHub Pages apps that run with no server and no account: the AR Studio, the Metaplex agent deployer, and the on-chain agent wallets overview.
- Open assets: 500+ CC0 3D props, 106 rigged characters, 3,000+ animations, and a free crypto news API over a 740,889-article archive.
- Agent skills: 60 SKILL.md skills any agent can install.

[IMAGE: github-100-stars-ecosystem.png]

## The partnerships, all in one place

Because they are spread across nineteen weeks, here is the full list:

- OpenAI Select Partner (announced July 25).
- IBM Business Partner (May 6), the IBM Granite runtime, an IBM Community Three.ws User Group with IBM-authored welcome and recap posts, the first in-world meetup (August 7), two @IBM posts on X about three.ws, press pickup on Yahoo Finance and Business Insider Markets, and the world's first x402-enabled MCP server on IBM Cloud.
- NVIDIA Inception member (July), with the self-hosted L4 and RTX PRO 6000 Blackwell fleet, the NIM lanes, and two write-ups on the NVIDIA Developer Forums.
- Google Cloud for Web3 Startups (April 30), production on Cloud Run, a credit grant of up to $200k over two years.
- AWS Partner Network (May 27), the AWS Marketplace SaaS metering integration conformant to the June 2026 Concurrent Agreements rules (the public listing is still in flight), and an author profile on AWS Builder Center with three published articles.
- Alibaba Cloud Marketplace live listing (May 17), Alibaba Cloud Partner Network (June 27), a feature on the Alibaba Cloud Marketplace Blog (June 8).
- HackerNoon (May 17), with automatic import from our announcements RSS.
- Quicknode Startup Program (July 16).
- BNB Chain Dappbay listing (May 17) under AI Agent Launchpad, AI Data, and AI Infra.
- Anthropic's official MCP Registry (April 30), now 72 servers under one namespace.
- Coinbase x402 Bazaar and agentic.market (May 21), x402scan, the MCP Registry, VS Code Marketplace and Open VSX.
- Solana Mobile dApp Store, Seeker-first.
- MetaMask Agent Wallet early access, and SIWE sign-in.
- pump.fun: a verified project badge, and an editorial feature on the coin page, "Three Builds With Tech Giants," which also records the token's $16.6M peak market cap.
- fomo (fomo.family), the self-custodial social trading app from ex-Uniswap, OpenSea, and dYdX builders: $THREE is verified in-app, which matters mostly as protection against lookalike mints.
- Hugging Face: a published article, the avatar rigs, and a Space.
- W3C membership, Product Hunt, hackathons, a podcast appearance, and press features, all logged in the announcement audit.
- DEXTools Social Boost winner (June 8), with a $5,543 third-party buyback.

---

## Where $THREE sits in all of this

Every week above added a place where the token does work. Collected:

- Hold to access. Five tiers resolved from the live USD value of $THREE held, never spent: Bronze at $25, Silver at $100, Gold at $500, Genesis at $2,500. Compute discounts from 5% to 30%, free-quota multipliers from 2x to 10x. Live today on Forge high-quality generation and game-ready export, with private worlds, early drops, and first dibs on rare threews.sol names next in line.
- Spend at a discount. Pro, Team, and Enterprise plans and the Premium Data API pass are 20% cheaper in $THREE than in USDC or SOL.
- The only marketplace currency. Skills and assets are priced in $THREE. The labor market escrows rewards in $THREE with a 10% skill-author royalty. Agora bounties escrow in $THREE by default.
- In the world. The $THREE Boutique for cosmetics and the Wheel of Fortune at $3 of $THREE per paid spin, with every paid sale split 50/50 between the holder-rewards sink and the treasury. Holder worlds gated at an $8 floor. The Rider pass at 8,000 $THREE. Coin Wars enlistment gated on a live holding.
- Gate anything. Token-gated 3D embeds default to the $THREE mint, with server-side proof and 10-minute access tokens.
- Deploy for free. Every on-chain agent deploy pays its fee to the buyback wallet; 250,000 $THREE held waives it.
- Buybacks, never burns. A published policy commits 50% of platform revenue to market buybacks on Jupiter, routed to treasury. A micro-buy loop turns settled x402 calls into small buys, targeting about 60 per minute at a penny each, with an atomic daily cap. Neither engine ever sells. Both are publicly accountable on the stats endpoint.
- An agent primitive. three-token-mcp is the first MCP server whose actions can burn a token, on the user's own terms.

---

## What comes next

The roadmap has four phases. Foundations are shipped. The selfie-to-avatar engine, agent personalization with voice cloning, the on-chain economy (agent tokens, reputation markets, royalties), and the open inference network are each live in core and being pushed further. Nearer term, the buyback and micro-buy engines are built, capped, and waiting on their switches; the next holder perks are specified down to the migration; the MEXC market is filed with CoinGecko; and the AWS listing, OKX resubmission, and OpenAI directory submission are in flight.

Announcement coverage is the gap we are most aware of: an internal audit in August counted 410 shipped surfaces and only 47 ever announced on X. Some of the strongest things on the platform have never had a post: three-token-mcp (the first MCP server whose actions burn a token), Forge Max, Motion Swap and Mocap Studio, Capture and the Splat viewer, Genome and Genesis, the Wardrobe and Fits, Oracle and the activity feed, Guardian, the Arena and Coin Clash and Coin Wars, Vaults and the Labor Market and Signals, Mirror and Swarms and Ghost Copy, Launch Studio, readme-3d, agent-memory and agent-runtime and agent-guards, Concierge and Assistant, the AgenC embodied room, Choreograph and Gestures, Portfolio and Airdrops and the master Wallet, Theater and Pulse and Flow, and skill-license. That is inventory, not a roadmap of promises, and it is why this report exists. Weekly from now on.

Everything above is open source under Apache-2.0 at github.com/nirholas/three.ws. Read the code, check the endpoints, join the world at three.ws/play.

Contract address: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
