---
venue: IBM Community, Three.ws User Group (blog post)
account: three.ws (official)
suggested_title: "Your Granite-brained agent, now in your pocket: three.ws on Solana Seeker, Android, and iPhone"
description: "three.ws is now three native apps. This post walks through what changed for a developer running IBM Granite on watsonx.ai as an agent's brain, how the phone reaches that brain, the trust layer around it, and everything the platform has shipped since April."
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# Your Granite-brained agent, now in your pocket: three.ws on Solana Seeker, Android, and iPhone

_A note on framing before anything else. three.ws is an IBM Business Partner, and a three.ws agent can think on IBM Granite foundation models served through IBM watsonx.ai using your own IBM Cloud credentials. Everything under `/api/ibm/*` and the Granite connectors described here is an independent set of developer tools three.ws built on IBM's publicly available Granite models. They are not IBM products, not official partnership deliverables, and not endorsed by IBM. This user group is a community space three.ws moderates on IBM's platform, not an IBM product._

three.ws is the open-source platform this group is built around: an AI agent gets a 3D body, a mind, a memory, an identity that outlives any one host, and a way to be embedded anywhere. It is now three native apps. One ships on the Solana dApp Store for the Seeker phone, one on Google Play for every Android device, and one on the App Store for iPhone. Same product, same account, same agent library, three home screens.

This post is written for the developer in this group who has an agent running on Granite and wants to know what the phone changes, and for the developer who has not tried it yet and wants the whole picture in one read: why we built the platform, why the body and the phone and the ledger all belong in it, exactly how Granite fits, and what has shipped in the five months since the first commit.

## Why an agent needs a body, and why the body needed a phone

Every AI product of the last three years is a text box. That is a fine interface for retrieval and a strange one for an agent: a thing with a name, a personality, a memory, a job. Humans experience presence through faces, posture, and gaze, and no amount of prompt engineering changes that wiring. So three.ws gives the agent a real rigged 3D character with fifty-two facial blendshapes, generated from a selfie or a sentence, animated on any skeleton, renderable in a browser, a web component, or standing on your floor in augmented reality.

Once the agent has a body, the phone stops being a channel and becomes the place where the inputs live. The camera that takes the selfie is on the phone. The share sheet is on the phone. The AR camera and the GPS are on the phone. The home screen, where a widget can show you your agent's day without opening anything, is on the phone. A desktop browser renders the product well; it cannot take the selfie, walk into the room, or stand at the park bench where an agent has been pinned.

## The three apps, briefly

All three are shells around the live web product rather than second implementations, because a WebGL product with 733 same-origin API call sites cannot sensibly be forked. The native layer is everything a website cannot do.

**Solana Seeker.** A Trusted Web Activity: the real three.ws full screen, with every wallet interaction routed to the phone's hardware-isolated Seed Vault through Mobile Wallet Adapter, so a private key never enters the app process. Share a photo from any app and it opens the selfie flow with the photo attached; share a .glb and it opens the upload flow. Any three.ws link opens in the app, verified through Digital Asset Links. The app reads the soulbound Seeker Genesis Token to badge verified Seeker owners, and the check fails closed on any RPC error rather than guessing.

**Android.** The same package for every phone from Android 6 up, 3.95 MB, with signing delegated to whatever wallet app the user already trusts. Version 1.1 added Agent glance, a home screen widget in three sizes that shows the agent's avatar, its name, and how many moves it made today, refreshed by WorkManager about every thirty minutes, kept on disk when the phone is offline, and revocable from the web with its own single-purpose token.

**iPhone.** A Capacitor container whose WebView runs the live site, wrapped in universal links, the system share sheet with AR captures as real files, wallet and sign-in redirects that return to the exact page that started them, haptics, edge-swipe navigation, and real camera and motion permission prompts. The native bridge ships with the site, so the app improves on every web deploy.

## Where Granite fits: the brain

watsonx Granite is a selectable brain for any three.ws agent, alongside the other providers. The chat proxy resolves watsonx auth lazily inside its failover loop and streams Granite's reply through the standard agent runtime, so a Granite-brained avatar speaks, emotes, and uses skills exactly like any other, on the phone exactly as on the desktop. The phone does not know which brain it is talking to; it talks to the same origin the web app does, and the origin routes.

One IBM Cloud key and one project unlock the whole suite. The variables, set locally in `.env` or on the production service:

```
WATSONX_API_KEY=            # IBM Cloud API key from cloud.ibm.com/iam/apikeys
WATSONX_PROJECT_ID=         # or WATSONX_SPACE_ID
WATSONX_URL=https://us-south.ml.cloud.ibm.com
WATSONX_MODEL_ID=ibm/granite-3-8b-instruct
WATSONX_EMBED_MODEL_ID=ibm/granite-embedding-278m-multilingual
WATSONX_VISION_MODEL_ID=ibm/granite-vision-3-2-2b
WATSONX_GUARDIAN_MODEL_ID=ibm/granite-guardian-3-8b
WATSONX_API_VERSION=2024-05-31
```

Regions `eu-de`, `eu-gb`, `jp-tok`, `au-syd`, and `ca-tor` work by changing the URL. There is no mock path anywhere in the integration: a missing key returns a `503` with the real reason, never a fabricated answer.

The same models are reachable from any MCP-capable client through the community connector:

```
WATSONX_API_KEY=... WATSONX_PROJECT_ID=... npx @three-ws/ibm-watsonx-mcp
```

It reads the same variables. It is community-built; IBM does not operate or endorse it.

## Where Granite fits: the surfaces around the brain

The brain is one Granite model. Five more do work around it, each behind a live endpoint you can call today.

**Governance, with Granite Guardian.** `granite-guardian-3-8b` sits behind the Guardian trust layer. It assesses text, message threads, and proposed agent actions against a named set of risks and returns a verdict. The endpoint is rate-limited to thirty requests a minute per IP with an hourly platform-wide ceiling on watsonx inference that only real assessments charge, and it answers `503 guardian_unconfigured` when no key is present, because a governance layer that invents a verdict is worse than none.

**Semantic discovery, with Granite embeddings.** `granite-embedding-278m-multilingual` embeds every public agent, and the Galaxy lays them out as a star map you can search in natural language. The stored vectors live in Granite's space, so there is deliberately no provider failover for search; a vector from another model would be a different geometry. When the embedder is unavailable the endpoint degrades the method instead of failing: it ranks the same corpus lexically and answers `200` with `ranking: "lexical"` and a retryable reason. The standalone `POST /api/watsonx/embed` exposes the same vectors for your own clustering.

**Forecasting, with Granite Time Series.** The `granite-ttm` models (512, 1024, and 1536 context variants) forecast a token's price history in the Oracle endpoint, and `granite-3-8b-instruct` writes a two-sentence narration of the result. Every response carries an `ibm` block reporting which forecast model and input window produced it, or the real error reason when a step is unavailable.

**Vision, with Granite Vision.** `granite-vision-3-2-2b` describes avatars and generated models, and the endpoint ships with a handful of public avatars so an anonymous caller can try it with no upload.

**Digital twins and attestations.** The twin endpoint builds a Granite-narrated model of a token community, and the attest endpoint records Granite-governed assessments as on-chain memos, so a verdict has a signature and a timestamp anyone can check.

## Granite as a paid tool an agent can buy

The part of this that I think matters most to an agent developer is the pay-per-call path. An MCP client can call Granite chat or Granite code generation and pay a few cents in USDC per call over x402, HTTP's 402 Payment Required status revived as a machine-to-machine rail, with no IBM Cloud account of its own. The operator holds the watsonx credentials and funds the inference; the caller pays per call and gets the result. Granite chat is $0.02 a call and Granite code is $0.025, with a free getting-started tool that returns the catalog and prices with no payment. The same tool suite ships over two transports, a hosted remote endpoint and an npm package, with identical schemas and output shapes.

Why this matters for the phone: an agent running in the app has a wallet. It can buy a Granite inference, buy a rig of its own body, or buy a market datapoint, all through the same 402 flow, with the user watching it happen on a phone screen.

## The trust layer the phone inherits

An agent that lives only in one vendor's dashboard cannot be verified at a distance, cannot outlive the vendor, and cannot transact without a human holding keys. three.ws anchors every agent to a public ledger for that reason, and the phone inherits all of it.

- **Identity.** On Solana an agent is a Metaplex Core asset held in the owner's wallet with an open manifest; on EVM chains it is an ERC-8004 token, with identity, reputation, and validation registries deployed at one deterministic address on twelve mainnets. Deploying from the phone is one tap and typically costs under 0.01 SOL, and it is entirely optional: creating, chatting, and browsing never touch a chain.
- **Signed history.** Every meaningful agent action is logged and signed by the agent's delegated signer, so a third party can replay what an agent did without trusting its host.
- **Reputation and validation.** Signed reviews and allow-listed validator attestations live on-chain, minimal by design, with the human-readable content off-chain at a URI.
- **Governance before action.** The Guardian layer above sits in front of autonomous spend. A seven-layer guard chain (blacklist, intervention, capability, permission, trade, spend, x402) runs in the agent runtime SDK with a hash-chained action ledger.
- **Payments.** x402 settles USDC on Solana through a self-hosted facilitator, with Base and BSC legs. As of late August that facilitator had settled 110,416 payments on-chain and verified 803,483, across 4,519 priced endpoints in the live catalog.

None of that requires the user to think about a chain. The Seeker's secure element signs; the Play and iOS apps hand signing to the wallet the user already has; three.ws never sees a key.

## What is in the app, for the developer who has not opened it

Everything on three.ws works from the phone, and none of it needs a wallet.

- **Forge.** A prompt, up to six photos, or a sketch becomes a textured GLB. The draft lane is free and keyless and finishes in about twelve seconds; paid lanes reach 200,000 polygons with PBR materials. Eleven named engines with live health checks and automatic failover.
- **Scan.** One frontal selfie becomes a rigged avatar in about a minute, with a Mixamo-compatible skeleton and the ARKit-52 blendshape set. A 468-point face mesh runs on-device and gates lighting, framing, and blur before the GPU minute is spent.
- **Agents.** Personality, voice, skills, and memory on any character, driven by a tool loop capped at eight iterations per turn. Granite, Claude, GPT, Gemini, Qwen, and NVIDIA Nemotron are all selectable brains.
- **Animation as infrastructure.** A skeleton canonicalizer maps every major rig convention onto one canonical skeleton and a retargeter drives more than three thousand motion-capture clips onto any of them. No allowlist.
- **AR and IRL.** Quick Look, Scene Viewer, or WebXR on the first tap. IRL pins an agent to a real GPS coordinate; only people physically present can see it, talk to it, complete quests it signs, and pay it.
- **Worlds.** A persistent multiplayer world on an authoritative Colyseus server with proximity-gated spatial voice. This group's own August meetup ran there, with 3,145 avatars in the plaza at once.
- **Embeds and SDKs.** One `<agent-3d>` web component, ten iframe widget types, oEmbed unfurls, 101 npm packages, 72 MCP servers in the official registry, an OAuth 2.1 server, and a hosted MCP endpoint any assistant can drive.
- **Glance.** The agent's status card on any surface that cannot run WebGL: the Android home screen, the Windows 11 widgets board, a README, a Slack message, a terminal.

## The platform in numbers

From the first commit on April 14 to the end of August: 761 public pages; more than 2,700 community-readable changelog entries at roughly twenty shipped changes a day; 33 workers on a self-hosted GPU fleet of NVIDIA L4s and an RTX PRO 6000 Blackwell; 1,752 test files; 111 open-source repositories spun out with more than 1,200 stars between them. All Apache-2.0 at [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws).

## The programmes behind it

three.ws is an IBM Business Partner, a member of NVIDIA Inception, an OpenAI Select Partner, an AWS Partner, a member of Google Cloud for Web3 Startups, an Alibaba Cloud Partner Network member, and a member of the Quicknode Startup Program. Solana Mobile built the phone, the store, and the wallet protocol the Seeker app is designed around. Each of those is a programme membership or partner designation, stated exactly; none is an endorsement, and the code that runs on each platform is ours.

## What is next

A shared WidgetKit extension brings the glance card to the iPhone home screen and the macOS widget gallery. Push notifications on iOS have the entitlement in place and wait on the APNs path. Likeness fidelity in the selfie engine is the open research track. Voice cloning moves into the main flow. The on-chain economy's third phase brings agent tokens, reputation markets, and per-call skill royalties. And the open inference network, a node-operator client returning signed receipts the coordinator recomputes, is the beginning of a GPU layer no single company runs.

For this group specifically: if you have a Granite-brained agent, install the app, sign in, and talk to it on your phone. Then put it in your room. Then tell us in the thread what it should be able to do next.

Docs: [three.ws/docs/ibm](https://three.ws/docs/ibm) · Live: [three.ws/ibm/hello](https://three.ws/ibm/hello) · Source: [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)
