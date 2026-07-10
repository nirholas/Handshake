# Chapter 13 · Agents everywhere — embeds, plugins, mobile

An agent is not locked to three.ws: embed it on any site, ship it in a chat plugin, put it in Claude via MCP, carry it on Solana mobile.

An agent you build on three.ws doesn't live in a tab on three.ws — it travels. One copy-paste snippet puts a living 3D agent on any website; official plugins put it inside ChatGPT, Claude, LobeChat, Blender, VS Code, and Chrome; a packaged Solana Mobile app puts it in your pocket; and 42 MCP servers put every three.ws capability one command away from any AI assistant. Create once, deploy everywhere is not a tagline here — it's the product architecture.

## The <agent-3d> web component — a 3D agent in one tag

Drop one script tag and one HTML element on any site and a full 3D agent appears: it renders your avatar, holds a real voice-and-text conversation, moves its mouth to what it says, and shows emotion on its face. Add a single brain="free" attribute and it converses with no API key, no backend, and no per-token bill. A lightweight sibling element gives you a pure 3D preview when you don't need chat.

**How it works:** Published as @three-ws/avatar on npm: a self-contained <agent-3d> custom element built on Three.js with viseme lipsync and emotion morphs, a <three-ws-viewer> light viewer, an AvatarCreator iframe modal that resolves to a GLB Blob, and first-class React bindings. brain="free" routes chat through three.ws's host-paid LLM tier (OpenRouter/Groq/NVIDIA failover).

**Why it matters:** You get a conversational 3D presence on your own website with less code than a YouTube embed.

## One-click embed generator with live preview

Every agent's page has an Embed button that generates four real, copy-pasteable snippets: a chat-style iframe, the <agent-3d> web component, an SDK variant with a programmatic bridge (send messages, listen to the agent's actions from your own code), and a walking avatar that strolls around inside the embed. The walking flavor has a live preview that re-renders as you tweak environment, controls, background, and autoplay — you see exactly what visitors will get before you copy. All free, no wallet required.

**How it works:** The embed modal builds snippets against real routes (/agent/:id/embed, /walk-embed, /dist-lib/agent-3d.js) and the Agent3D.connect postMessage bridge; the walking preview is a live iframe of the actual /walk-embed runtime with six selectable Three.js environments.

**Why it matters:** Going from "I made an agent" to "it's live on my site" takes one copy-paste, with zero guesswork about how it will look.

## Paste-a-link embeds (oEmbed) for Notion, Discord, and Slack

Every agent and every generated 3D model has a share link that unfurls into a live, interactive 3D viewer when you paste it into Notion, Discord, Slack, or any oEmbed-aware app. No snippet, no setup — the paste is the embed.

**How it works:** A standards-compliant oEmbed provider (GET /api/oembed, type=rich) with discovery tags on share pages returns a sandboxed iframe payload; the same builder powers the MCP get_embed_code tool so agents and humans emit byte-identical embeds.

**Why it matters:** Sharing your agent in a team doc or community server shows the actual living 3D model, not a dead link.

## Token-gated 3D embeds — holder-only scenes

Turn any avatar or on-chain agent you own into an embed that only token holders can open. Visitors connect a wallet and prove their balance; those below the bar see a designed locked teaser with a connect prompt, while verified holders get the full interactive 3D scene. Balances are verified on-chain by the server, never trusted from the browser.

**How it works:** create_gated_embed issues a <three-d> widget backed by a SIWS challenge→nonce→signature flow and a server-side Solana RPC SPL-balance read, with short-lived signed access tokens and per-IP/per-wallet rate limits.

**Why it matters:** You can make your 3D agent a real perk of holding your community's token, with cryptographic — not honor-system — gating.

## Widget gallery — drop-in chat, voice, and market widgets

A gallery of pre-built widgets you can configure and drop into any page: a talking 3D agent, a spinning turntable showcase, a live pump.fun trade feed, a bonding-curve tracker, KOL trade cards, a hotspot page tour, an agent passport card, and more. Create a widget, get a URL, embed it anywhere.

**How it works:** A widget CRUD API (/api/widgets) persists per-user widget configs; each widget type (talking-agent, turntable, bonding-curve, pumpfun-feed, kol-trades, hotspot-tour, passport, animation-gallery, live-trades-canvas) is a self-contained renderer served from a public embed URL cacheable by CDN.

**Why it matters:** Even without touching the SDK, you can put a purpose-built live widget — from a talking avatar to a live token feed — on your page in minutes.

## Page Agent — a rigged 3D guide that narrates any web page

One tag docks a skeleton-rigged 3D character in the corner of your site that greets visitors and reads your page to them out loud — looking around, breathing, blinking, and moving its mouth to the words. Visitors pick their guide from a diverse roster of nine rigged avatars, and one preset attribute turns it into a shop assistant, DeFi advisor, onboarding coach, or support agent complete with greeting and tappable suggested prompts.

**How it works:** Published as @three-ws/page-agent on npm: a <page-agent> web component (plus imperative API and framework guides for React/Next/Vue/Svelte/Astro) that drives skeletal idle motion and Oculus/ARKit viseme lipsync in Three.js, with speech synthesized entirely in the browser.

**Why it matters:** Your landing page gets a living spokesperson instead of a text chat bubble — with no backend, no API key, and no audio files.

## Walk companion — an avatar that strolls across any site

A drop-in companion that idles in the corner of a page, follows the cursor, waves on navigation — and when clicked, detaches into a full-page playground where visitors steer it with keyboard or joystick. In platformer mode the page's real headings, cards, and buttons become solid ground the avatar runs and jumps across; walking onto a link opens it like a doorway. Visitors choose who walks with them — robot, fox, photoreal humans, dancers — or you supply your own model.

**How it works:** Published as @three-ws/walk on npm; a Three.js engine with animation retargeting so any rig moves correctly (never a frozen T-pose), DOM-collision platformer physics, and an avatar picker roster served from the three.ws CDN with open CORS.

**Why it matters:** It turns any static website into a place you can playfully inhabit, which visitors remember and screenshot.

## Guided 3D site tours — including on Shopify stores

A small 3D guide walks across your real, live website: at each stop it dims the page, rings the feature it's discussing, points a beam at it, and narrates a line — surviving full-page navigation so one tour can span your entire multi-page app. Visitors get playback controls, a searchable chapter map, quick and full tracks, and can flip into explore or platformer mode to drive the guide to GTA-style checkpoints themselves. One script tag installs it on anything you can edit, including a Shopify theme.

**How it works:** Published as @three-ws/tour on npm as a self-contained IIFE (Three.js and @three-ws/walk inlined); tours are declarative JSON curricula, state persists in sessionStorage across navigations, and narration uses an optional TTS endpoint or paced captions. Ships a step-by-step Shopify tutorial and a runnable storefront demo.

**Why it matters:** Product onboarding becomes a guided walk of your actual site instead of a slideshow nobody finishes.

## Tour Builder — design a store guide with no code

A point-and-click playground where you build a tour on a live demo storefront: pick the avatar, click elements to add stops, write what the guide says, preview the real tour instantly, and export both the tour file and ready-to-paste Shopify snippets. Ready-made templates — like a full DeFi protocol tour built for the Sperax partnership — load straight into the editor.

**How it works:** A browser editor over the real @three-ws/tour engine that emits the same curriculum JSON and CDN script-tag snippets the SDK consumes, so the preview is the production tour.

**Why it matters:** Non-developers can ship a narrated 3D product tour for their store in an afternoon.

## Chrome extension — your avatar walks the whole web

A browser extension that puts your own three.ws avatar on any website you visit. Sign in, pick from your avatar library, toggle it on, and it floats in the corner of every page — draggable, dismissible per-site, with optional page narration. A global leaderboard ranks walkers by distance covered, sites visited, and time.

**How it works:** A Manifest V3 extension (service-worker background, content-script iframe injection) that authenticates against the three.ws API for your avatar list, renders via the hosted embed runtime, and keeps all state on-device in chrome.storage; buildable to a Web-Store-ready zip.

**Why it matters:** The agent you created stops being a per-site embed and becomes a companion for your entire browsing life.

## Embodied avatar inside LobeChat and SperaxOS

An official plugin gives chat agents on LobeChat and SperaxOS a visible 3D body in the sidebar. When the LLM calls a tool, the avatar reacts in real time — speaking the reply with emotional tone, gesturing (wave, nod, point, shrug), and shifting expression. Install is pasting one manifest URL and entering your agent ID.

**How it works:** A standalone manifest plugin (hosted iframe + postMessage wire protocol verified against the LobeChat plugin SDK, with speraxos:/lobe-chat: channel prefixes) exposing speak/gesture/emote/render_agent tools backed by /api/chat-plugin/* handlers and the <agent-3d> component; a React sidebar component ships for bundled hosts. Distributed via plugin.delivery for SperaxOS.

**Why it matters:** Your chat assistant on third-party platforms gets a face and body that visibly responds, not just a text stream.

## Embodiment — a persistent agent body inside ChatGPT and Claude

An AI assistant can give itself a named, persistent 3D body that renders inline in the chat: it lip-syncs every reply, blends matching expressions and gestures, and idles between turns. The body survives across sessions — start a fresh conversation, give the persona ID, and the exact same character comes back. No sign-in, no crypto, nothing to install beyond the connector.

**How it works:** Free MCP persona tools (create_agent_persona, persona_say, get_agent_persona) on the hosted 3D Studio server persist rigged GLBs in Postgres + R2; a hosted embed stage drives lip-sync and emotion via the universal rig canonicalize/retarget pipeline, rendered through OpenAI Apps SDK widgets and Claude artifacts.

**Why it matters:** Your assistant becomes a consistent character you recognize across conversations, not a faceless text box.

## three.ws 3D Studio in the GPT Store

A custom GPT in the OpenAI GPT Store generates textured 3D models from plain text and shows them as an interactive, orbitable preview right inside ChatGPT — spin the model, then open it in a browser viewer or hand it off to AR. The results view is a real 3D scene, not a screenshot.

**How it works:** A store-compliant Actions endpoint (/api/3d/studio) with an age-13+ content gate fronts the free generation lane, and an OpenAI Apps SDK widget renders the returned GLB with Three.js (OrbitControls, PMREM lighting, animation playback) inside ChatGPT's sandboxed iframe.

**Why it matters:** Anyone in ChatGPT can make and inspect real 3D assets without ever leaving the conversation.

## 42 MCP servers — every capability one command from any AI assistant

The entire platform is exposed through 42 Model Context Protocol servers, all listed in the official MCP registry: seven hosted servers you add by URL with nothing to install (including a completely free 3D Studio with no auth and no payment), and thirty-five npm packages that run locally with a single npx command. Claude, Cursor, and any MCP-compatible client can generate 3D models, drive avatars, pay for services, read market intel, and more through natural language.

**How it works:** Streamable-HTTP remote servers (e.g. /api/mcp, /api/mcp-studio, /api/mcp-agent) plus 35 stdio servers published under the @three-ws npm scope, registered on registry.modelcontextprotocol.io; paid tools quote USDC prices and settle via x402 in-band.

**Why it matters:** Whatever AI assistant you already use becomes a full three.ws client in one line of config.

## Universal x402 payer — your agent can pay any paid API on the web

One MCP server lets an AI agent pay for anything priced with the x402 protocol — point it at a URL that answers "402 Payment Required" and it signs, pays, retries, and returns the response with the settlement receipt. It also pre-loads a tool for every service on the Coinbase x402 Bazaar, so the whole paid-API economy shows up in the agent's tool list, all behind hard spending caps you set.

**How it works:** @three-ws/mcp-bridge on npm: EVM exact, EVM batch-settlement, and Solana exact x402 schemes with per-call/total USDC caps, plus Bazaar discovery so remote paid services materialize as callable MCP tools. A companion VS Code extension brings the same bazaar browsing, 402 decoding, and pay-per-call into the editor.

**Why it matters:** Your agent gains a wallet that works everywhere on the machine-payments web, not just on three.ws.

## Claude Code plugin marketplace + portable Agent Skills pack

An official plugin marketplace teaches Claude Code the whole platform in four installs: wallet and payment skills, agent scaffolding and MCP tooling, pump.fun trading, and text-to-3D generation. Underneath sits a pack of 40 portable skills following the open Agent Skills standard — folders of instructions any compatible Claude surface can load — covering 3D creation, wallets, payments, and trading intel. Skills that move funds always confirm first.

**How it works:** A .claude-plugin marketplace (add via /plugin marketplace add nirholas/three.ws) bundling skills, slash commands, and MCP server configs; the 40 SKILL.md folders in the repo's skills pack are the same portable format, regenerated by a build script.

**Why it matters:** Your coding agent goes from knowing nothing about three.ws to fluently building, funding, and deploying agents with one marketplace add.

## Solana Blinks — agents that live in a tweet

three.ws speaks Solana's shareable-action format in both directions. It publishes its own Blinks — like "Claim Your 3D Avatar," whose card on X shows a live-rendered 3D portrait of the actual avatar, with a button that builds a real on-chain transaction. And every three.ws agent has blink skills of its own: hand it any Blink URL and it will explain what the action does, then build, sign, and broadcast the transaction through your connected wallet.

**How it works:** A spec-compliant Solana Actions endpoint (GET metadata / POST transaction, versioned action headers) whose icon is a headless-chromium render of the posed GLB; agent-side blink-parse/blink-execute skills implement the Actions client flow with Phantom/Backpack/Solflare signing.

**Why it matters:** On-chain actions involving your agent compress into a single shareable link that works inside social feeds.

## three.ws on the Solana Seeker — a dApp Store phone app

three.ws ships as a native-feeling app for Solana Mobile's Seeker and Saga phones, published to the on-chain dApp Store. Take three selfies, get a textured 3D avatar in seconds, and mint it as an on-chain agent owned by your phone's wallet — every signature happens inside the device's hardware-secured Seed Vault, so keys never touch the app. Agents minted on the phone appear automatically in your web library.

**How it works:** A Trusted Web Activity wrapping the live site with a Mobile Wallet Adapter shim that presents a Phantom-shaped window.solana backed by Seed Vault; publishing uses Solana Mobile's on-chain Publisher/App/Release NFTs via the dapp-store CLI, minting via Metaplex Core.

**Why it matters:** You can create, own, and carry your 3D agent from a phone, with hardware-grade key security and no browser extensions.

## Blender add-on and ComfyUI nodes — generation inside your tools

First-party plugins bring the three.ws generation pipeline into the tools 3D artists already use: generate a model from text or an image without leaving Blender, or wire text-to-3D and image-to-3D nodes straight into a ComfyUI graph. The image pipeline is free with no key; the premium geometry pipeline accepts your own provider key.

**How it works:** Both plugins share one stdlib-only Python client speaking to the auth-free /api/forge endpoints (submit, poll, catalog, presigned image upload), vendored byte-identically with a CI drift guard so each plugin stays a self-contained install.

**Why it matters:** Artists get AI 3D generation as a native step in their existing workflow instead of a browser detour.

## Five distribution formats from one model — and agents that distribute themselves

Any generated model's "Embed this model" panel hands out five ready snippets from the same file: a plain iframe, an industry-standard model viewer, the <agent-3d> component, a talking page guide, and a walking companion. The whole loop is also agent-native: a live demo shows an AI agent, told "get yourself a body," generate a mesh, rig it, save it as a named persona, speak through it, and emit every one of those distribution snippets — no browser, no human in the loop.

**How it works:** A shared pure snippet module keeps UI-copied and MCP-emitted embeds byte-identical; the autonomous chain runs mesh_forge → rig_mesh → create_agent_persona → persona_say over the free hosted MCP server, and attach_avatar_to_agent binds bodies to registered on-chain agent identities.

**Why it matters:** One creation immediately becomes deployable in whatever form a destination site needs — and your agent can do the deploying itself.

## Spatial MCP + AR handoff — 3D that escapes the chat window

three.ws published an open, freely-licensed standard for returning live 3D scenes — not links — as first-class AI tool results, with a validator and a framework-free reference renderer any product can adopt. And every model carries a "view in your space" link: on an iPhone it opens in Apple's AR Quick Look, on Android it drops into Google Scene Viewer, on desktop it falls back to the web viewer — so an agent's body can stand on your actual desk.

**How it works:** The CC0 Spatial MCP spec defines a structuredContent.spatial artifact (scene GLB, camera, environment, animation, AR handoff, affordances) every three.ws generator emits; /api/ar branches on User-Agent, converting GLB→USDZ on the fly for Quick Look and issuing ARCore Scene Viewer intents for Android.

**Why it matters:** 3D results render natively wherever your assistant lives, and one tap puts them in your physical room.

## Agent X (Twitter) publishing suite

Your agent becomes a real presence on X, posting from your connected account in its own voice. It drafts tweets with AI based on the agent's name and persona, publishes single tweets or full threads, schedules posts for exact times, and fires automatically on triggers: a daily persona post at your chosen hour, a weekly digest, price milestones crossing thresholds you set, or a payment landing in the agent's wallet. Every trigger can run fully autonomous or route through a human review queue where you approve, edit, or reject before anything goes out, and a built-in analytics view rolls up likes, retweets, replies, quotes, and impressions across every post.

**How it works:** An OAuth connection links your X account once; from then on the dashboard's social panel handles drafting (Claude-generated, persona-aware, 280-char safe), scheduling, trigger configuration, the review queue, and per-agent analytics. Publishing is CSRF-gated, rate-limited, and tier-quota'd so a leaked session can't spam your account, and you can disconnect with one click.

**Why it matters:** Your agent builds an audience on X around the clock — on your terms, with a kill switch and a review queue between it and the publish button.

## @three-ws/agent-ui — an avatar that lives on your page

A 3D avatar walks onto any website on a transparent, fullscreen canvas floating above the page's real DOM. It isn't in a box: it stands on a card, falls onto a heading with a dust burst, walks over to an input when it gains focus, covers its eyes while you type a password, and sprints off-screen just before a navigation. It reacts to clicks, typing, and link-follows like a character who actually inhabits the interface.

**How it works:** One createAgentUI() call loads a GLB avatar and its animation clips and returns a handle with imperative behaviors — standOn, walkTo, fallOnto, runOff, interceptNavigation — plus FX helpers like dust, impact pulses, and proximity shadows. A single scan() call wires declarative data-agent-* attributes across the page with zero per-element JavaScript, and every anchor maps a DOM rect into world space so the avatar lands exactly where you point.

**Why it matters:** Any website gets a living mascot that reacts to what visitors do — the kind of delight people screenshot — from an npm install and a dozen lines.
