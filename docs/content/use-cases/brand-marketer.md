# Brand / Marketer — "A talking brand agent people trust, embedded everywhere"

> **Every scenario below is an example workflow, not a real customer.** Features and routes are re-confirmed against [`README.md`](../../../README.md).

## Who this is for

You run brand, growth, or marketing. You want a memorable, interactive brand presence — a talking agent that answers product questions on the site, shows up in campaigns, and feels premium — without a six-month custom build. You also care about trust signals: in a world of cloned brands and fake AI personas, you want a presence you can *prove* is the real one.

## The problem, concretely

A static FAQ page doesn't convert, a generic chatbot bubble feels cheap, and a custom 3D brand experience is a bespoke agency project. Worse, none of those let you prove authenticity — anyone can spin up a look-alike "official" agent. Brands need something that's (a) striking enough to screenshot, (b) easy to drop into existing pages and marketplaces, and (c) verifiably *yours*.

## How three.ws solves it

Four real capabilities cover embodiment, reach, and trust:

1. **Embeddable talking agent widget** — the [`<agent-3d>` web component](../../../README.md#web-component--embedding) and the [talking-agent widget](https://three.ws/studio) put a conversational 3D brand character on any page with one snippet. Pin it as a floating bubble (`mode="floating"`) so it persists as visitors scroll. Open Graph + oEmbed mean shared links get rich previews.
2. **On-chain verifiable identity** — register the brand agent as an [ERC-8004 token or Metaplex Core asset](../../../README.md#on-chain-identity-erc-8004--metaplex-core) with a stable ID, owner wallet, and signed action log. Its [passport](https://three.ws/a/sol/EXAMPLE_ASSET) is a public proof that *this* is the official agent. Bind a [`*.threews.sol` name](../../../README.md#sns--threewssol-subdomains) so every surface shows a human-readable identity instead of a raw wallet.
3. **Cloud marketplace distribution** — three.ws is an **AWS Partner** with an **AWS Marketplace SaaS listing** (in review; see [docs/aws-marketplace.md](../../../docs/aws-marketplace.md) and [three.ws/aws](https://three.ws/aws)) and is **live on Alibaba Cloud Marketplace**. That's a procurement path for enterprise buyers — a marketplace listing, not a cloud-vendor endorsement.
4. **IBM watsonx Granite demos** — the [`/ibm/*` showcase](https://three.ws/ibm) demonstrates brand-relevant AI surfaces (semantic agent maps, forecasting, a Guardian governance "trust layer") **built on IBM watsonx.ai** running IBM Granite. three.ws is an IBM Business Partner; the public `/ibm` demos are independent developer tools, **not** official IBM products or endorsements.

## Example workflow (hypothetical)

> **Imagine a marketer, "Lyra," at a consumer-software brand** who wants an on-site brand agent and a trust badge proving it's official. Here's the path they'd take.

1. Lyra opens [Widget Studio](https://three.ws/studio), picks a branded avatar, and chooses the talking-agent widget. She sets instructions: *"You are Lyra-bot, the official assistant for [brand]. Answer product questions, link to pricing, stay on-brand and concise."*
2. She copies the floating-bubble snippet and pastes it into the marketing site:
   ```html
   <script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>
   <agent-3d
     body="https://three.ws/cdn/models/brand-agent.glb"
     brain="claude-sonnet-4-6"
     name="Lyra-bot"
     instructions="Official brand assistant. Answer product questions, link to pricing, stay on-brand."
     mode="floating" position="bottom-right"
     width="340px" height="440px"
   ></agent-3d>
   ```
3. She [registers the agent on-chain](../../../docs/tutorials/register-onchain.md) (Metaplex Core on Solana), binds `brand.threews.sol`, and links the public [passport](https://three.ws/a/sol/EXAMPLE_ASSET) from the site footer as a "verified official agent" badge — so look-alikes can't credibly impersonate it.
4. For enterprise procurement, she points buyers at the [AWS Marketplace listing](https://three.ws/aws) (a listing, not an endorsement).
5. **Deliverable:** a premium, on-brand talking agent on every page, provably the official one via its on-chain passport, with an enterprise procurement path.

## What you get

A conversational 3D brand presence that's easy to embed and share, plus a public, tamper-evident identity that distinguishes the real agent from imitations. Distribution through real cloud-marketplace listings. Honest scope note: the verifiable-identity benefit depends on you publishing and linking the passport so customers can check it — the chain proves authenticity only if people are pointed at it.

## Next step / CTA

- Start: [Widget Studio](https://three.ws/studio) → [Register On-Chain](../../../docs/tutorials/register-onchain.md) → claim a name at [`/threews/claim`](https://three.ws/threews/claim).
- Enterprise: [AWS Marketplace listing](../../../docs/aws-marketplace.md) · [Alibaba Cloud listing](https://marketplace.alibabacloud.com/products/56724001/sgcmfw00036800.html) · explore Granite on watsonx.ai at [/ibm](https://three.ws/ibm).
- **Social spotlight angle (G03):** "A talking brand agent you can *prove* is official — embedded everywhere, verifiable on-chain."
- `[REAL CASE STUDY — fill on consent: a brand that deployed a verified on-site agent and what it changed.]`
