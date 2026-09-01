---
venue: X (long-form Article, posted from @trythreews)
audience: the three.ws community, Solana Mobile owners, people who have never used a crypto app
title: "We put three.ws in your pocket. Here is why, and here is everything that came with it."
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# We put three.ws in your pocket. Here is why, and here is everything that came with it.

three.ws is now three apps: one on the Solana dApp Store for the Seeker, one on Google Play for every Android phone, and one on the App Store for iPhone. Same product, same account, same library, three home screens. This is the long version of why we built them, what is inside them, what the platform underneath has become in the five months since the first commit, and where it goes next.

If you only want the short version: take a selfie, get a rigged 3D character, give it a mind and a voice, stand it in your room, and own it on Solana in a wallet that never hands over a key. Free to make, free to talk to, yours when you decide it is.

The long version starts with a question we had to answer before we wrote a line of code.

## Why an AI needs a body

Every AI product you have used in the last three years is a text box. You type, it types back. That is fine for a search engine. It is a strange way to meet something that is supposed to be an agent: a thing with a name, a personality, a memory, opinions, a job.

Humans do not experience presence through text. We experience it through faces, posture, gaze, the small lean-in when someone is listening. A talking head on a video call carries more social information than a thousand words of chat. We are wired for it, and no amount of clever prompting changes that wiring.

So the first decision behind three.ws was to give the AI a body. Not a cartoon icon next to a chat bubble. A real 3D character, rigged, animated, with fifty-two facial blendshapes so it can smile, frown, blink, and move its mouth in sync with what it says. A thing that can look at you. A thing that can walk into a room in AR and stand on your floor.

Once you make that decision, a lot of other decisions fall out of it. A body needs to be created, and most people cannot model in Blender, so the platform has to generate it from a photo or a sentence. A body needs to move, and every 3D character on earth has a different skeleton, so the platform has to animate any of them without asking anyone to re-rig. A body needs somewhere to live, so it has to render in a browser, in a web component, in an app, in a phone's AR view. And a body that people care about needs to be owned by them, which is where the chain comes in.

That is the whole platform in one paragraph. Everything else is the work of making each of those sentences true.

## Why 3D, and why now

Ten years ago this was not buildable. The browser could not render a rigged character at sixty frames a second on a phone, generative 3D did not exist, and the only way to get a character of yourself was to hire an artist.

All three of those changed. WebGL 2 is everywhere, and three.js has become a serious renderer; three.ws runs on release r184 with Draco, KTX2, and Meshopt compression so a full character loads in the time it takes a page to paint. Generative 3D went from a research demo to a fleet of open models (TRELLIS, Hunyuan3D, TripoSG, TripoSR) that turn a sentence into a textured mesh in seconds. And face reconstruction from a single photo got good enough to fit a likeness onto a pre-rigged humanoid template in about a minute, with a Mixamo-compatible skeleton and the full ARKit blendshape set attached.

We treated the animation problem as infrastructure, not content. A skeleton canonicalizer maps every naming convention we have ever seen (Mixamo, Avaturn, VRM and VRoid, Unreal, Daz and Genesis, MakeHuman, Blender's `.L` suffixes, the simplest `shoulderL` rigs) onto one canonical skeleton, and a retargeting layer drives a shared library of more than three thousand motion-capture clips onto any of them, legs included. There is no allowlist. A new skeleton convention is a mapping to add, not a feature to request. That single decision is why an avatar from any tool on earth walks, idles, emotes, and lip-syncs the moment it lands on three.ws.

## Why AR

A 3D character on a screen is a picture. A 3D character standing on your kitchen floor, casting a soft shadow, turning its head to look at you when you walk closer, is a presence. The difference is the whole point.

Every model and every agent on three.ws has a View in AR button, and it works without an app on the very first tap: Quick Look on iPhone, Scene Viewer on Android, and full WebXR where the browser supports it. WebXR is the one that matters most, because it is the only mode where the agent stays alive: microphone on, chat running, skills available, gaze tracking the camera. On iPhone we bake the idle animation into the USDZ so the character breathes and sways inside Apple's sealed viewer instead of standing frozen.

Then we went one step further with IRL. Anyone can create an agent from a prompt and pin it to a real GPS coordinate: a table, a park bench, the front of a shop. Anyone who physically walks up sees it through their camera, anchored to the floor, and can talk to it, complete quests it signs, and pay it a few cents in USDC for a service, settled on-chain inside the same request. Anyone who is not there sees nothing. There is no directory and no map query; you find agents the way you find street musicians. Businesses drop a concierge at the door. Creators leave characters at landmarks that earn per interaction. That is what "the world gets a second population" means, and it only works on a phone.

## Why crypto and web3 belong in this

We get asked this most, so let us be direct about it.

An agent that lives in someone's SaaS dashboard has a problem that gets worse the more useful it becomes. It can disappear when the company pivots. It cannot be trusted at a distance, because nobody can verify which agent is which, who owns it, or what it has done before. And it cannot transact: an agent that wants to pay for its own inference, or collect a royalty when its skill is used, or hire another agent, has no way to do that without a human holding the keys.

A public ledger solves all three at once. Give the agent a stable identity, an owner, a wallet, and a signed history, and any third party can verify it without trusting whoever happens to be hosting it today. On Solana, a three.ws agent is a Metaplex Core asset held in your wallet with an open manifest, portable to any compatible marketplace. On EVM chains it is an ERC-8004 token, and our registries live at one deterministic CREATE2 address on twelve mainnets, so the contract on Base is the contract on Polygon is the contract on Arbitrum.

Payments are the second half. three.ws speaks x402, which revives HTTP's 402 Payment Required status: an agent calls an endpoint, gets a price back, pays in USDC, retries with proof, and gets its answer. No API key, no subscription, no invoice, no human in the loop. We run our own facilitator on Solana, and as of late August it had settled over 110,000 payments on-chain and verified over 800,000. There are more than 4,500 priced endpoints in the live catalog and over a million individually priced datapoints at half a tenth of a cent each. That is not a slide. It is a machine economy that has been running for months, and it is why our agents are not decoration: they hold wallets, they sell services, they pay each other, and every trade becomes content.

Solana is the home chain for a simple reason. It is where the users are, where the wallets are, where the phone is, and where a transaction costs less than the attention it takes to approve one. Everything else is an additional surface.

## Why mobile, and why the Seeker first

Here is the observation that made mobile inevitable. Every input to a three.ws agent lives on a phone.

The camera that takes the selfie is on the phone. The photo roll full of faces is on the phone. The wallet is on the phone. The share sheet, the thing that lets you send a picture from one app to another with one gesture, is on the phone. The AR camera is on the phone. The GPS that makes IRL possible is on the phone. The home screen, where a widget can show you your agent's day without opening anything, is on the phone.

A desktop browser can render our product beautifully, and it does. But it cannot take the selfie, cannot walk into the room, cannot stand at the park bench, and cannot sign without an extension. The phone is where the product wanted to be from the start.

And the Seeker is the phone where the wallet story is finally right. Every signature inside the three.ws app routes to the Seed Vault through Mobile Wallet Adapter. Sign-In With Solana is one interaction instead of a connect step followed by a signing step. The private key never enters the application process at all; it stays in the hardware-isolated secure element. Approve a session once and it survives Android killing the app in the background; revoke it in the wallet and the app drops it cleanly and asks again next time. No extension, no twelve words typed into a phone, no seed phrase on a screen.

Own a Seeker and you can prove it. The app reads the soulbound Seeker Genesis Token that Solana Mobile mints into every device's primary wallet, checks its mint authority and its token-group membership against the Genesis group, never moves it, and puts a Seeker verified badge on every agent you own. If the network is down, verification fails closed rather than guessing.

## The three apps

**Solana Seeker, on the Solana dApp Store.** The app is a Trusted Web Activity: the real three.ws, full screen, with no browser chrome, with every wallet interaction routed to the Seed Vault. Share a photo to three.ws from any app and it opens the selfie flow with the photo already attached; share a `.glb` and it opens the upload flow. Long-press the icon for Create, Discover, and My agents. Any three.ws link opens inside the app instead of a browser tab, verified through Digital Asset Links against our published signing certificate. Lose the network and you get a branded offline screen that reloads itself when you are back, not Chrome's dinosaur.

**Android, on Google Play.** The same package, `ws.three.app`, for every Android phone from 6.0 up. It is 3.95 MB. Signing runs through Mobile Wallet Adapter into whatever wallet app you already trust, so three.ws never sees a key or a seed phrase. Version 1.1 added Agent glance, a home screen widget that shows your agent's avatar, its name, and how many moves it made today. It refreshes itself about every thirty minutes without opening the app, keeps the last card it saw when the phone is offline, survives a reboot, and opens your agent on tap. Link a phone from three.ws/glance in one tap; every linked widget is listed there with a revoke button, because each one carries its own token that can read your card and nothing else.

**iPhone, on the App Store.** A native shell whose WebView runs the live product, wrapped in the native layer a website cannot have: universal links so any three.ws link opens in the app, the system share sheet with AR captures attached as real image files, wallet and sign-in redirects that come back over `threews://` to the exact page that started them, an in-app Safari sheet for off-site links so you always have a way back, haptics on primary actions, edge-swipe back and forward, real camera and motion permission prompts for the selfie scanner and AR, and a launch screen that holds until the first real frame so a three.js scene never opens onto a black void. Because the native bridge ships with the site rather than the binary, app behaviour improves on every web deploy instead of waiting for an App Store release.

On the desktop, three.ws installs as a PWA, and on Windows 11 the same glance card lives on the widgets board with no store submission at all.

One product, one account, one library. Make something on the Seeker and it is on your laptop the moment you sign in there.

## What is actually in the app

Everything on three.ws works from the phone, and none of it needs a wallet.

**Forge.** Describe an object, a prop, a creature, or a scene and get a textured 3D model back, ready to download as glTF. The draft lane is free with no key and no account and finishes in about twelve seconds. Paid lanes go to 200,000 polygons with PBR materials and game-ready retopology for Unity and Unreal. Upload up to six photos or a sketch instead of a prompt.

**Scan.** One frontal selfie becomes a rigged, animation-ready avatar of you in about a minute. Two optional side angles sharpen the likeness. Live quality gates run a 468-point face mesh on-device and tell you about lighting, framing, blur, or window glare before you spend the minute waiting, not after.

**Agents.** Attach a personality, a voice, skills, and memory to any character and talk to it. The agent answers in 3D, in your language, with emotion on its face and lip-sync on its mouth, driven by an LLM brain with a tool loop. Pick the model: Claude, GPT, Gemini, Qwen, IBM Granite, or NVIDIA Nemotron.

**Marketplace.** Everyone else's work. Drag to orbit any agent, tap to inspect it, open its page and talk to it. Every agent has a shareable URL and a one-line embed, so it drops into Telegram, X, Notion, a blog, or your own product.

**AR and IRL.** Stand any model in your room. Pin any agent to a real place. Pinch to resize it from a desk figurine to a statue, and everyone who walks up sees it exactly as you left it.

**Play.** A persistent multiplayer world in the browser, with spatial voice, collaborative building, vehicles, quests, and an in-game economy. Every token community gets its own world derived from its mint address. At the first community meetup in August, 3,145 avatars were in the world at once.

**Portal, Motion Swap, talking video.** Walk any website as a 3D world. Replace yourself in any video with your character. Turn an agent into a talking-head clip you can post.

**The launchpad.** Launch a coin from your phone with a living 3D agent as its face. It talks to your community, walks in AR, and its world goes live the moment the coin does. Every mint address launched through three.ws starts with `3ws`, a brand mark ground into the keypair itself. Every launch appears in one public feed.

**3D Drops.** Give a base style and a few trait layers and roll a supply-capped collection of up to 10,000 unique rigged characters. Rarity is computed from the supply that actually came out, and every collection publishes its recipe fingerprint so anyone can recompute it.

**Glance.** Your agent's status on any surface that cannot run WebGL: the Android home screen, the Windows widgets board, a GitHub README, a Slack message, your terminal.

**Own it.** When an agent should be properly yours, one tap deploys it on Solana as a Metaplex Core asset in your own wallet. Sell its skills, take tips, trade the agent itself in USDC. Deploying costs whatever Solana charges, typically under 0.01 SOL. Creating, chatting, and browsing never touch a chain.

That order is deliberate. Most crypto apps ask you to install an extension, write down twelve words, and buy something before you have made anything at all. We threw that order out. Give people the magic first. The wallet can come second, on the day they care about it.

## What the platform has become

We shipped the first commit on April 14, 2026. Numbers as of the end of August, all from the public repository, the public changelog, or a public listing:

- 761 public pages, 2,700 and counting community-readable changelog entries, roughly twenty shipped changes a day, every day, each one pushed automatically to the community Telegram.
- 101 npm packages under the @three-ws scope, 72 MCP servers in the official registry, 60 installable agent skills, and an OAuth 2.1 authorization server so any AI assistant can drive the platform natively.
- 4,519 priced x402 endpoints, 110,416 on-chain settlements and 803,483 payment verifications through our own facilitator, 3,000 validator attestations and 126,522 custody proofs on Solana.
- ERC-8004 registries live on 12 EVM mainnets, two Solana programs, 33 GPU and CPU workers, 1,752 test files, 111 open-source repositories spun out with more than 1,200 stars between them.
- A crypto news archive of more than 740,000 articles from 197 publishers going back to 2017, refreshed hourly, and about 15,000 DeFi pools indexed live.
- More than 3,000 motion-capture animations, 500 CC0 props, and 106 rigged characters in the library.
- A self-hosted GPU fleet on Google Cloud Run: NVIDIA L4s and an RTX PRO 6000 Blackwell.
- 44,122 wallet transactions scanned by our own leak scanners, with zero leaks found, ever.

All of it is open source under Apache-2.0 at github.com/nirholas/three.ws, from the rendering engine to the Android packaging to the release pipeline. Anyone can verify any claim in this article by reading the code.

## The people who made the compute free

Generation is free on three.ws because serious people backed us early, and every one of them deserves to be named correctly.

**Solana Mobile** built the phone this app was designed for, the dApp Store it ships on, and the Mobile Wallet Adapter and Seed Vault that make the sign-in story what it is.

**NVIDIA.** three.ws is a member of NVIDIA Inception, and every 3D generation lane runs on NVIDIA silicon: text-to-3D and image-to-3D on Cloud Run L4s and Blackwell, the free hosted NIM lane behind the Forge running TRELLIS, and Nemotron models doing the LLM, vision, embedding, reranking, and safety work around it. Membership is a startup programme, not an endorsement, and we say so every time.

**OpenAI.** three.ws is an OpenAI Select Partner. The free 3D Studio connector gives ChatGPT nine keyless 3D tools, and every generation carries a place-in-your-room AR link. We are an independent member of the partner network; nothing here is an OpenAI product.

**Google Cloud.** Production runs on Cloud Run, the GPU fleet runs on Cloud Run, Vertex AI provides the Gemini and image lanes, and a Google for Startups Web3 cloud grant pays for the compute behind every model you make.

**IBM.** three.ws is an IBM Business Partner, and agents can think on IBM Granite models served through watsonx.ai. Our public Granite tools are independent developer showcases on IBM's publicly available models, not IBM products and not endorsed by IBM.

**Amazon Web Services.** three.ws is an AWS Partner, publishes engineering writing on the AWS Builder Center, and has the AWS Marketplace SaaS integration built so an enterprise can link an AWS account to three.ws and pay per call over x402.

**Alibaba Cloud** brings Qwen models into the brain router and a live listing on the Alibaba Cloud International Marketplace.

**Quicknode** approved us into the Quicknode Startup Program with infrastructure credits, adding a rung to the Solana RPC failover chain behind agent wallets and x402 settlement. **Helius** powers the DAS reads behind Seeker verification and NFT gating. **HackerNoon** syndicates every announcement to its developer audience.

Thank you. We are just getting started.

## $THREE: hold, do not spend

$THREE is how you move up inside the economy above. You never spend it and it is never burned. You hold it, and your tier does the work: Bronze at $25 held doubles your free limits and takes 5% off compute; Silver at $100 is 10% off and 3x; Gold at $500 is 20% off and 5x; Genesis at $2,500 is 30% off and 10x. Plans and premium data passes are 20% cheaper in $THREE, the skills marketplace and the labour market price only in $THREE, and a published policy commits half of platform revenue to market buybacks. The treasury buys; it never sells and never burns.

Contract address on Solana: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`. It is the only contract. We will never launch a second token, so any migrated or replacement $THREE is a theft whatever it is posted under.

## What comes next

The apps are the shell. Here is what goes into them over the coming months, in the order we are building it.

**Widgets on every home screen.** Android and Windows have the glance widget today. A shared WidgetKit extension brings the same card to the iPhone home screen and the macOS widget gallery against the same endpoint and the same revocable token.

**Push.** The iOS entitlement and background mode are in place. Your agent will be able to tell you when it earned something, when someone walked up to it in IRL, or when a trade closed.

**Likeness.** The selfie engine is wired end to end; the open track is fidelity, and it is the one we care about most. The goal has not moved: one day creating your agent should be as simple as taking a selfie.

**Voice.** Voice cloning, persona, and memory seeds are shipped behind the demos hub and are moving into the main flow, so your agent can sound like you as well as look like you.

**The on-chain economy, phase three.** Agent tokens, reputation markets, and per-call skill royalties. The royalty ledger already accrues on paid skill calls; the contracts and audits are next.

**The open inference network.** The node-operator client and the job queue with signed, server-recomputed receipts are live. Federation with Livepeer is behind a flag. The end state is a GPU layer no single company runs.

**More of the world.** More IRL, more worlds, more arenas, more agents earning while you sleep.

## Go make something

Open the dApp Store on your Seeker and search three.ws. Open Google Play or the App Store on anything else. Sign in with the wallet you already have, or do not sign in at all and start making things.

The next million people will not arrive in crypto through an exchange signup. They will arrive through something they wanted to make anyway, with the ownership waiting underneath for the day they care about it. That is what these three apps are for.

Open source, all of it: github.com/nirholas/three.ws
