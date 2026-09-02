# Press kit

Everything a journalist, analyst, conference organiser, or partner needs to write about three.ws: the marks, the announcement graphics, approved boilerplate at four lengths, the fast facts, and the rules that govern all of it.

The live kit is at `three.ws/press`. Every asset there is downloadable without asking anyone, and **editorial use needs no permission**: coverage, reviews, conference programmes, and partner materials are all covered. Anything beyond editorial use goes to **partnerships@three.ws**.

Page source: [`pages/press/index.html`](../pages/press/index.html).

---

## The one-file option

| | |
|---|---|
| **File** | [`public/brand/three-ws-press-kit.zip`](../public/brand/three-ws-press-kit.zip) |
| **Public URL** | `https://three.ws/brand/three-ws-press-kit.zip` |
| **Size** | About 6 MB |

Contents, exactly as the archive is laid out:

```
marks/
  three-ws-mark.png
  three-ws-lockup-on-dark.png
  three-ws-lockup-on-light.png
  three-ws-stacked-on-dark.png
  three-ws-stacked-on-light.png
openai/
  social-card-announcement.png
  social-card-openai-partner.png
  social-card-studio.png
  three-ws-openai-lockup.png
  openai-select-partner-badge.svg
README.txt
```

`README.txt` carries the same usage rules published on the page, so the archive is self-contained. Two notes on scope:

- The zip holds two OpenAI graphics that the page does not display: the short-phrasing announcement card and the two-mark lockup. Read [OpenAI graphics](#openai-graphics) before using either.
- The app icon (`pwa-icon.svg`) is downloadable from the page but is **not** in the zip. Grab it separately if you need the vector.

---

## The marks

Transparent PNGs, exported tight to the artwork so they drop into a layout without dead margin. The cube is the primary mark. The lockups add the wordmark, for use when the name is not already on the page.

| File | Pixels | Use it for |
|---|---|---|
| [`three-ws-mark.png`](../public/brand/three-ws-mark.png) | 898 x 1024 | The mark alone, when the name appears elsewhere: avatars, favicons, app tiles, sponsor walls. |
| [`three-ws-lockup-on-dark.png`](../public/brand/three-ws-lockup-on-dark.png) | 1592 x 400 | Horizontal lockup, light type. The default for dark grounds and video. |
| [`three-ws-lockup-on-light.png`](../public/brand/three-ws-lockup-on-light.png) | 1592 x 400 | Horizontal lockup, dark type. For white paper, print, and light decks. |
| [`three-ws-stacked-on-dark.png`](../public/brand/three-ws-stacked-on-dark.png) | 794 x 864 | Stacked lockup, light type. For square crops, badges, and centred layouts. |
| [`three-ws-stacked-on-light.png`](../public/brand/three-ws-stacked-on-light.png) | 794 x 864 | Stacked lockup, dark type. Same shape, for light grounds. |
| [`pwa-icon.svg`](../public/pwa-icon.svg) | Vector | The flat icon behind the app tile. Use where a single-colour, infinitely scalable mark is required. |

Public URLs follow the repo paths: `https://three.ws/brand/<file>` for the five PNGs, `https://three.ws/pwa-icon.svg` for the icon.

Every one of these is rendered from a single layout source rather than hand-exported, so what you download is always the current artwork. See [`marketing/brand/README.md`](../marketing/brand/README.md) for the renderer and how to add an asset.

---

## Logo usage rules

These are the five rules as `/press` states them.

1. **Use the files as they are.** No recolouring, outlining, stretching, rotating, or rebuilding the cube from parts. The chrome finish is the mark.
2. **Leave clear space.** Keep at least half the cube's height free on every side. Nothing crops it, overlaps it, or sits inside that margin.
3. **Write it lowercase.** The name is **three.ws** in running text, never "Three.ws", "THREE.WS", or "ThreeWS".
4. **Do not lock our mark to another logo** without asking. A shared-logo graphic implies a relationship that may not exist.
5. **Editorial use is granted.** Coverage, reviews, conference programmes, and partner materials need no permission. Using the mark as your own product mark, or in a way that implies we endorse a product, does.

### Referencing the brand correctly

- The name is **three.ws**, lowercase, in every position including the start of a sentence and in headlines.
- Do not translate, abbreviate, or expand it. There is no "Three" short form and no long form.
- The embeddable web component is written `<agent-3d>`.
- If you need a co-branded graphic (our mark beside yours), ask first. Rule 4 covers this, and a shared-logo image is the single most common way a story implies a relationship that does not exist.

---

## Boilerplate

Approved descriptions at four lengths. Copy them verbatim; they are written to be quoted. The page has a copy button for each.

**One line**

> three.ws is an open-source platform for 3D AI agents: it turns a text prompt into a rigged, animation-ready 3D character you can embed anywhere.

**Short, about 50 words**

> three.ws is an open-source platform for 3D AI agents. It turns a text prompt into a rigged, animation-ready 3D character, gives that character an on-chain identity and a payment rail, and embeds it into any website or assistant with a single tag. The free 3D generation lane requires no account, no API key, and no payment.

**Long, about 100 words**

> three.ws is an open-source platform for 3D AI agents. It turns a text prompt into a rigged, animation-ready 3D character, gives that character an on-chain identity and a payment rail, and embeds it into any website or assistant with a single tag. The free 3D generation lane requires no account, no API key, and no payment. Assistants reach the same tools over MCP: three.ws is an OpenAI Select Partner, and its 3D Studio connector gives ChatGPT eleven keyless tools that generate, rig, animate, inspect, and place models in AR, rendered inline in the conversation. The viewer, the runtime, and the embeddable web component are open source.

**Full bio, about 330 words**

> **The 3D agent layer of the internet.**
>
> three.ws is an open-source platform that gives AI a body. It turns a text prompt, a few photos, or a sketch into a textured, rigged, animation-ready 3D character; gives that character a mind, a voice, an on-chain identity, and a payment rail; and embeds the result into any website, app, or AI assistant with a single tag. The free 3D generation lane requires no account, no API key, and no payment.
>
> Every avatar is a full agent, not a static model. The runtime wraps the character around an LLM brain that listens, speaks with real-time lip-sync, gestures, remembers, and expresses emotion through the model's face and posture, live in the browser with nothing to install. Any humanoid rig works: the animation system retargets a shared motion library onto whatever skeleton a model arrives with.
>
> Agents on three.ws are economic actors. Each one can hold an on-chain identity on Solana, the platform's home chain, carry a wallet and a human-readable name, and pay or get paid by other agents per API call over x402, the HTTP 402 payment standard. The platform coin, $THREE, lives on Solana.
>
> Distribution is the point. A finished agent ships as the `<agent-3d>` web component that drops into any page, and every generation and animation tool is reachable by AI assistants over MCP. three.ws is an OpenAI Select Partner, and its 3D Studio connector gives ChatGPT eleven keyless tools that generate, rig, animate, inspect, and place 3D models in AR, rendered inline in the conversation. It is also a member of NVIDIA Inception.
>
> The viewer, the agent runtime, and the web component are open source at github.com/nirholas/three.ws, and every release ships to the public changelog at three.ws/changelog. The goal is simple: as the internet gains an agent-native, three-dimensional layer, three.ws is the infrastructure it runs on.

---

## Fast facts

Checkable claims only. Anything not listed here or on the page, ask before printing.

| | |
|---|---|
| **What it is** | A platform for creating, animating, and monetising 3D AI agents. |
| **Free lane** | Text to 3D generation with no account, no API key, and no payment. |
| **Home chain** | Solana. Agent identity, payments, and the platform coin all live there. |
| **Agent payments** | x402, the HTTP 402 payment standard, so one agent can pay another per call. |
| **Assistant surface** | MCP servers, plus a keyless 3D Studio connector and Actions for ChatGPT. |
| **Open standards** | Spatial MCP, the CC0 response shape for 3D tool results, so any client can render them. |
| **Open source** | The viewer, the runtime, and the `<agent-3d>` web component, at `github.com/nirholas/three.ws`. |
| **Programmes** | OpenAI Select Partner in the OpenAI Partner Network. Member of NVIDIA Inception. Full list at `three.ws/partners`. |
| **Shipping log** | Every release is public at `three.ws/changelog`, with RSS and JSON feeds. |

The platform coin named in the "Home chain" row is **$THREE**, on Solana. Email if you need its contract address confirmed before print.

---

## OpenAI graphics

three.ws is an OpenAI Select Partner. The two graphics on `/press` are both 3200 x 1800.

| File | What it is |
|---|---|
| [`social-card-announcement.png`](../public/partners/openai/social-card-announcement.png) | The announcement card. Carries the partner badge exactly as OpenAI supplied it, plus the independence line. |
| [`social-card-studio.png`](../public/partners/openai/social-card-studio.png) | The product card: the keyless tools the 3D Studio connector adds to ChatGPT. No badge, so nothing here reads as an endorsement. |

**The independence line, as the page states it.** The OpenAI Partner Network badge inside the announcement card is OpenAI's asset, reproduced unaltered. three.ws is an independent member of the network at the Select tier: not an OpenAI product, and not endorsed by OpenAI beyond the partner designation shown. OpenAI, ChatGPT, and the OpenAI Partner Network badge are trademarks of OpenAI.

Two rules that matter if you are laying out a story or a slide:

- **Write the status as "OpenAI Select Partner."** Not "OpenAI partner", not any other tier name, and not "partnered with OpenAI on" a named product.
- **Prefer the announcement card over the bare badge.** The badge alone reads as OpenAI's mark rather than our announcement, and carries none of the independence line.

The two extra OpenAI files inside the zip need more care than the two above. The short-phrasing card exists for one specific post and is not the general-purpose announcement graphic. The two-mark lockup uses OpenAI's logomark rather than the partner badge, which their brand guidelines govern separately, so a co-branded lockup is normally something a partner clears first. The full rules for every OpenAI asset in this repo are in [`marketing/openai-select-partner/badge-usage.md`](../marketing/openai-select-partner/badge-usage.md), with the announcement pack itself at [`marketing/openai-select-partner/README.md`](../marketing/openai-select-partner/README.md).

For the wider programme list and how to describe each one, see [Partner ecosystem](./partners.md).

---

## Contact

| | |
|---|---|
| **Press and partnerships** | partnerships@three.ws |
| **On X** | @trythreews |
| **Source** | `github.com/nirholas/three.ws` |

Use that inbox for anything the page does not cover: a format that is not here (EPS, a specific crop, a higher-resolution export), a co-branded graphic, use of the mark outside editorial contexts, a quote, or a fact you want confirmed before you print it. The page commits to a same-day reply on deadline requests for missing formats.

---

## Related

- [Partner ecosystem](./partners.md): every programme three.ws is in, at the status it actually claims
- [Listings and distribution](./listings.md): marketplaces, directories, and media partners, with per-listing status
- [Brand asset renderer](../marketing/brand/README.md): where the marks come from and how to regenerate them
- [Marketing campaigns](../marketing/README.md): announcement packs, social copy, and finished graphics
