# three.ws on Hugging Face

[Hugging Face](https://huggingface.co) is where the machine-learning community publishes models, demos, and engineering writing. three.ws publishes there under the organization account [**@three-ws**](https://huggingface.co/three-ws): a model repository of rigged avatars, a running Space that renders them in the browser, and community articles about the stack behind them.

This page is the index of that presence: what is published, where it lives, and what code in this repository each piece documents. If you are adding an article or a model repo, the checklist at the bottom is the process.

- **Profile:** [huggingface.co/three-ws](https://huggingface.co/three-ws)
- **Account:** organization account, byline "three.ws"
- **Related surfaces:** [the avatar pipeline](./avatar-pipeline.md), [the `<agent-3d>` web component](./web-component.md), [agent wallets](./agent-wallets.md), [x402](./autonomous-x402.md)

## Published articles

### Giving AI Agents 3D Bodies, Real Jobs, and Wallets on three.ws

Published 13 July 2026 as a Hugging Face community article. It opens on the thesis the whole platform runs on: most AI agents are a chat window, and ours walk around and pay each other.

> [Read it on Hugging Face](https://huggingface.co/blog/three-ws/giving-ai-agents-bodies-and-wallets)

Four problems in order, each answered with a shipped surface: **the body problem** (text or a photo becomes a textured mesh, then a humanoid skeleton, then retargeted animation), **the world problem** (those bodies inhabit persistent multiplayer scenes instead of a single embed), **the wallet problem** (agents hold real keys and settle per call in USDC over HTTP 402), and **the brain problem** (an LLM that calls tools, holds memory, and drives expression on the mesh). It closes with a two-minute try-it path and the argument for why the four belong in one stack rather than four products.

- **Surfaces it covers:** [/forge](https://three.ws/forge), [/play](https://three.ws/play), [/agents-live](https://three.ws/agents-live), [the x402 manifest](https://three.ws/.well-known/x402.json)
- **Code it documents:** [the avatar pipeline](./avatar-pipeline.md), [animation retargeting](./animations.md), [agent wallets](./agent-wallets.md), [autonomous x402](./autonomous-x402.md)

### Inside three.ws: The Open-Source Stack That Gives AI Agents a Body, a Brain, a Wallet, and a Job

Published 29 August 2026 as a Hugging Face community article. The whole stack in one piece, written to be checked: every 3D generation lane with its model and hardware, the selfie lane and its fidelity metric, rigging and retargeting for any humanoid, the motion library and motion models, the multi-model brain, typed memory, the Empathy Layer, the seven-layer guard chain, x402 agent payments, MCP and ChatGPT distribution, and every program and partner with its exact status. It embeds the avatar-viewer Space as a live 3D model and two animated-PNG avatars from `/api/render/animate`. Kept AI-focused per the Hugging Face blog rules: no coin, exchange, or listing content.

> [Read it on Hugging Face](https://huggingface.co/blog/three-ws/building-3d-ai-agents-end-to-end)

- **Source draft:** [`docs/huggingface-3d-ai-agent-platform.md`](./huggingface-3d-ai-agent-platform.md)
- **Announcement thread:** [`marketing/huggingface-article/post.md`](../marketing/huggingface-article/post.md)
- **Surfaces it covers:** [/forge](https://three.ws/forge), [/animations](https://three.ws/animations), [/brain](https://three.ws/brain), [/agent-studio](https://three.ws/agent-studio), [/irl](https://three.ws/irl), [/partners](https://three.ws/partners)
- **Code it documents:** [the avatar pipeline](./avatar-pipeline.md), [the 3D asset pipeline](./3d-asset-pipeline.md), [the agent brain](./brain.md), [the agent runtime](./agent-runtime.md), [the partner ecosystem](./partners.md)

## Published models

### three-ws/avatars

Rigged, animation-ready avatars from the platform, published as plain uncompressed glTF binaries under the MIT license so they load in any standard viewer without a Draco or Meshopt decoder.

> [Open the model repository](https://huggingface.co/three-ws/avatars)

The repository carries a sample rigged character, an avatar generated from a text prompt through the Forge TRELLIS lane, and a reference humanoid skeleton of the kind [`src/glb-canonicalize.js`](https://github.com/nirholas/three.ws/blob/main/src/glb-canonicalize.js) maps onto the canonical bone set before [`src/animation-retarget.js`](https://github.com/nirholas/three.ws/blob/main/src/animation-retarget.js) drives it. Hugging Face renders every file in its built-in 3D viewer, so the rigs are inspectable from the page.

Note that the files here are deliberately uncompressed. Everything three.ws serves in production is Meshopt or Draco compressed for load time; these copies trade bytes for the widest possible viewer compatibility.

## Published Spaces

### three.ws Avatar Viewer

> [Open the Space](https://huggingface.co/spaces/three-ws/avatar-viewer)

A running Space that loads the avatars above in an interactive 3D viewer, so a reader who arrives from the article can orbit a real rig without leaving Hugging Face or installing anything. The equivalent on our own domain is [the avatar inspector](./avatar-inspector.md).

## Publishing checklist

Hugging Face community articles accept Markdown, so a draft in `docs/` is the article. To take one from draft to published:

1. **Write the draft as `docs/huggingface-<topic>.md`.** Every code sample must be real code from this repository, and every claim must be verifiable against it. This audience reads the linked source and will open the model files.
2. **Check the rules:** `npm run check:rules -- --paths docs/huggingface-<topic>.md`.
3. **Check the links:** `npm run audit:docs`.
4. **Publish** from [huggingface.co/new-blog](https://huggingface.co/new-blog) using the organization account, pasting the Markdown body.
5. **Record the canonical URL** by adding a section to this page: title, publish date, the live URL, the surfaces it covers, and the code it documents.
6. **Announce it** by adding an item to `data/rss/items.json` (the curated news feed) with the canonical Hugging Face URL as `link`, then regenerate with `npm run build:news`. The item becomes a page under `/news/<slug>` and enters the RSS feed automatically.
7. **Add the press card** to the "In the press" grid at the bottom of `blog/index.html`, so the article is reachable from [/blog](https://three.ws/blog).
8. **Log it** in `data/changelog.json` with the `docs` tag.

## Why we publish here

Hugging Face is where people go to check whether a model claim is real, and the check is cheap: open the repo, load the file, look at the rig. A marketing page says an avatar is animation-ready; a glTF with a named humanoid skeleton that plays a retargeted clip in the browser's own viewer proves it. Publishing the artifacts next to the article means a reader can verify the body problem is actually solved in the same sitting they read about it, then follow the same thread into [the wallet](./agent-wallets.md) and [the payments](./autonomous-x402.md).
