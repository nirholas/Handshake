# Customize size, position & background

A default embed renders inline where you put the tag, fills its container, and shows the avatar over a transparent background. That's a sensible starting point — it works on every site without tuning. But it is not what you want long-term. You want an agent that feels designed for your page: anchored where it belongs, sized for the layout, blended into the background, framed at exactly the crop that suits your brand.

This tutorial walks through every appearance attribute the `<agent-3d>` element honours. It covers them one at a time, with real snippets you can copy. By the end you have an agent that looks like it shipped with your site, not like a widget bolted on after the fact.

**What you'll build:**
- A floating agent sized and positioned precisely where you want it
- A background that matches your site (transparent, dark, light, or any CSS colour)
- A framing and idle animation tuned to the mood of your page
- A pixel-perfect, brand-aligned embed snippet for any site stack
- A clear map of which attributes do what

**Prerequisites:** A page with the embed working from [Embed in 30 seconds](/tutorials/embed-in-30-seconds). You can write the attributes here straight into that page.

---

## Step 1 — How the element reads your attributes

The embed is two tags: a `<script>` that loads the runtime once, and an `<agent-3d>` custom element that places the agent. Every customisation in this tutorial is an attribute on the **element**, not on the script tag.

The general shape is always the same:

```html
<script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>

<agent-3d
  agent-id="YOUR_AGENT_ID"
  mode="floating"
  position="bottom-left"
  width="320px"
  height="420px"
  background="transparent"
></agent-3d>
```

Order doesn't matter. Capitalisation does: every attribute is lowercase, hyphenated. Spelling matters too — an unknown attribute is silently ignored, so you'll see no error if you typo one, just the default behaviour.

Because this is a real custom element, the appearance attributes are **live**. Change `mode`, `position`, `width`, `height`, `responsive`, `background`, `name-plate`, `framing`, or `clip` from JavaScript at any time and the element re-applies the change on the spot — no reload, no re-embed:

```js
const agent = document.querySelector('agent-3d');
agent.setAttribute('background', 'dark');   // repaints immediately
agent.setAttribute('position', 'top-left'); // re-anchors immediately
```

One loading note worth knowing up front: the element boots lazily. It waits until it is scrolled near the viewport (with a 300px head start) before downloading the 3D body. Add the boolean `eager` attribute if you want it to boot the moment the page loads instead.

---

## Step 2 — `mode`: how the widget sits on the page

`mode` decides the fundamental layout. Four values:

```html
<agent-3d agent-id="YOUR_AGENT_ID" mode="floating"></agent-3d>
```

- `inline` — the default. The element is a normal block in the document flow, sized by its container (100% wide, 480px tall unless you say otherwise). Use it when the agent is a section of the page — a product hero, a team-page member, a docs helper embedded mid-article.
- `floating` — the classic support-widget layout. The element is `position: fixed`, floats above your content, stays put while the visitor scrolls, and can be dragged around by its handle. This is the mode most marketing and support embeds want.
- `section` — like inline, but the chat column is capped at 600px wide so a full-width band on a desktop layout doesn't produce comically wide message bubbles.
- `fullscreen` — the element covers the whole viewport (`100vw` × `100dvh`) with the chat column centred at 800px. Use it for dedicated "/talk-to-us" pages.

### Inline placement

In inline mode the element sits exactly where the tag is rendered:

```html
<h1>About Us</h1>
<p>Meet our digital concierge.</p>

<agent-3d
  agent-id="YOUR_AGENT_ID"
  width="400px"
  height="520px"
  style="margin: 0 auto;"
></agent-3d>

<p>Below, you'll find our services...</p>
```

It's a block-level element, so the usual CSS applies: centre it with `margin: 0 auto`, place it in a grid cell, float it in a column. No special rules.

---

## Step 3 — `width`, `height` and `responsive`: how big it appears

`width` and `height` accept any CSS length. Floating mode defaults to **320px × 420px**; inline mode defaults to the container's width and 480px tall.

```html
<agent-3d
  agent-id="YOUR_AGENT_ID"
  mode="floating"
  width="280px"
  height="380px"
></agent-3d>
```

### Responsive scaling is on by default

You don't get a fixed 280px box on a 320px phone. Unless you opt out, the element wraps your dimensions in a CSS `clamp()` tied to the viewport, so the widget scales down gracefully on small screens (never below roughly two-thirds of the size you asked for, with sane floors of 160px width / 200px height).

Two more responsive behaviours come free:

- **Floating pill collapse.** On viewports narrower than 480px, a floating widget collapses into a 56px round pill. Tapping the pill expands it into a bottom sheet covering 70% of the screen; swiping down (or tapping outside) collapses it again. Visitors on phones get a native-feeling sheet instead of a widget covering half the page.
- **Inline aspect lock.** An inline embed given only a `width` keeps a 3:4 portrait aspect ratio as it resizes with its container.

Opt out of all of it with `responsive="false"` — then your `width` and `height` are used verbatim:

```html
<agent-3d agent-id="YOUR_AGENT_ID" mode="floating" width="280px" height="380px" responsive="false"></agent-3d>
```

Prefer leaving it on. The clamped sizes look intentional on every screen; hard-coded pixels only look right on the screen you tested.

---

## Step 4 — `position` and `offset`: where a floating widget anchors

These two apply to `mode="floating"` only (inline elements are positioned by your page layout, like any other element).

```html
<agent-3d
  agent-id="YOUR_AGENT_ID"
  mode="floating"
  position="bottom-right"
  offset="24px 24px"
></agent-3d>
```

`position` combines a vertical keyword (`top` / `bottom`) with a horizontal one (`left` / `right` / `center`):

- `bottom-right` — the default; the conventional support-widget corner. Visitors expect to find help there.
- `bottom-left` — same behaviour, mirrored. Useful when a cookie banner or another chat tool owns the right side.
- `bottom-center` — horizontally centred along the bottom edge.
- `top-right` / `top-left` / `top-center` — anchored along the top. `top-right` suits agents that introduce themselves above the fold; `top-left` works on docs sites whose right margin is reserved for a table of contents.

`offset` sets the distance from the anchored edges as `"<vertical> <horizontal>"`. One value applies to both. The default is `24px 24px`. Push a widget clear of a fixed footer with `offset="88px 24px"`.

One nice-to-know: floating widgets are **draggable**. A slim grab handle sits along the top edge of the widget, and visitors can move it anywhere on screen. Your `position` is where it starts, not a cage.

---

## Step 5 — `background`: the canvas behind the agent

By default the canvas behind the avatar is transparent, so your page shows through. `background` accepts two keywords plus any CSS colour.

### Transparent (default)

```html
<agent-3d agent-id="YOUR_AGENT_ID" background="transparent"></agent-3d>
```

You don't need to set this explicitly — it is the default — but writing it out makes the intent clear when other developers read your code.

### `dark` and `light` keywords

```html
<agent-3d agent-id="YOUR_AGENT_ID" background="dark"></agent-3d>
```

- `dark` — a near-black `#0b0d10` backdrop.
- `light` — a near-white `#f5f5f5` backdrop. This keyword also flips the speech bubble and name-plate to dark-on-light styling so the text stays readable.

These are the same options the editor's snippet builder offers, so a snippet copied from the editor and one written by hand behave identically.

### Any CSS colour

Anything other than the keywords is treated as a literal CSS colour — hex, `rgb()`, a named colour:

```html
<agent-3d agent-id="YOUR_AGENT_ID" background="#0a0a14"></agent-3d>
```

Use a solid colour when your page has busy content behind the widget — a hero image, a video, a complex pattern — and you want the avatar to stand out.

A few practical notes from putting agents on real sites:

- Dark pages almost always look best with a transparent background — the avatar lighting matches the page mood naturally.
- Light pages can go either way. Transparent works if the avatar is contrasty; the `light` keyword (or a solid pale colour like `#f6f6f9`) reads as more intentional.
- If you're using a brand colour, desaturate it 20–30% for the embed background. Pure brand hues compete with the avatar; the same hue toned down recedes appropriately.
- Avoid pure black `#000000` and pure white `#ffffff`. They look harsh next to a 3D-shaded avatar. The `dark` and `light` keywords are tuned near-black and near-white for exactly this reason.

---

## Step 6 — `framing`, `name-plate` and `poster`: the finishing details

### `framing`

Controls how the camera crops the avatar:

```html
<agent-3d agent-id="YOUR_AGENT_ID" framing="portrait"></agent-3d>
```

- Default (**full**) — the whole body is in frame, with the camera favouring the upper body.
- `portrait` — a head-to-mid-thigh crop. The face fills far more of the canvas, which is what you want for small floating widgets where a full body would render the face at postage-stamp size.

Rule of thumb: `portrait` for floating widgets under ~360px wide, full framing for inline heroes where the whole character is the point. It's live — flip it at runtime and the camera reframes.

### `name-plate`

Conversational embeds (anything bound to a published agent) show a small overlay with the agent's name. Hide it when your page already introduces the agent in its own copy:

```html
<agent-3d agent-id="YOUR_AGENT_ID" name-plate="off"></agent-3d>
```

Bare decoration avatars never show a plate, so there's nothing to turn off there.

### `poster`

A poster image fills the frame while the 3D body downloads, then fades out at the exact moment the avatar appears — the same trick `<video poster>` uses. It also serves as the graceful fallback if a decoration avatar's body fails to load.

```html
<agent-3d
  agent-id="YOUR_AGENT_ID"
  poster="/img/agent-still.webp"
></agent-3d>
```

Use a still render of the same avatar so the swap from image to live 3D is seamless. On slow connections this single attribute is the difference between "blank box, then character" and "character, which then comes alive".

---

## Step 7 — `clip`: the idle animation

A decoration avatar — one embedded without chat, as pure visual presence — plays its `clip` attribute on loop, defaulting to `idle`:

```html
<agent-3d
  body="https://three.ws/avatars/default.glb"
  clip="dance"
  width="320px"
  height="420px"
></agent-3d>
```

The clip library is shared by every embed; useful ones for ambient presence include `idle`, `wave`, `dance`, `think`, `sitloop`, and `celebrate`. Looping clips loop; one-shot clips play once and settle back into idle with a crossfade rather than snapping. Change the attribute at runtime and playback re-cues to the new clip.

Two built-in courtesies you don't have to code:

- **Reduced motion.** When the visitor's OS has `prefers-reduced-motion` set, ambient playback is suppressed and the avatar holds a clean static pose instead. Explicit user-triggered animations still play.
- **Lazy boot.** Offscreen avatars don't render at all until scrolled near, so a page with several decoration embeds doesn't burn GPU on the ones nobody is looking at.

---

## Step 8 — Theming with CSS

Because `<agent-3d>` is a real element on your page, ordinary CSS reaches it. The chat chrome exposes its design tokens as CSS custom properties, which you can override from your stylesheet:

```css
agent-3d {
  --agent-accent: #e11d48;                    /* thinking dots, message accents, spinners */
  --agent-surface: rgba(24, 16, 20, 0.92);    /* message + panel surfaces */
  --agent-bubble-bg: rgba(255, 245, 247, 0.95); /* speech bubble */
  --agent-bubble-color: #2a0a12;              /* speech bubble text */
  --agent-bubble-radius: 12px;                /* corner rounding */
  --agent-chat-font: 'Inter', system-ui, sans-serif;
}
```

For structural styling, the shadow DOM exposes named parts — `stage` (the 3D canvas area), `chrome` (the chat column), `chat` (the message log), `name-plate`, and `loading`:

```css
agent-3d::part(name-plate) {
  font-family: 'Inter', sans-serif;
  letter-spacing: 0.02em;
}
```

Set the custom properties to your brand tokens once, in the same stylesheet as the rest of your site, and every embed on every page inherits them.

---

## Step 9 — Putting it all together: a branded SaaS embed

To bring this from theory to a real example, here is a complete, branded embed for a hypothetical productivity SaaS called "Lumen". The brand colours are a dark indigo and a warm cream; the brand voice is calm and professional.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lumen — modern project tools</title>
  <style>
    body {
      margin: 0;
      font-family: 'Inter', system-ui, sans-serif;
      background: #fafaf6;
      color: #1a1a2e;
    }
    .hero {
      max-width: 720px;
      margin: 120px auto;
      padding: 0 24px;
    }
    h1 { font-size: 3rem; line-height: 1.1; margin: 0 0 16px; color: #1a1a2e; }
    p  { font-size: 1.15rem; line-height: 1.6; color: #444; max-width: 540px; }
    .cta {
      display: inline-block;
      margin-top: 24px;
      padding: 12px 28px;
      background: #2a2a4d;
      color: #fafaf6;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
    }
    /* Brand-match the agent chrome */
    agent-3d {
      --agent-accent: #2a2a4d;
      --agent-chat-font: 'Inter', system-ui, sans-serif;
    }
  </style>
</head>
<body>
  <main class="hero">
    <h1>Project tools that get out of the way.</h1>
    <p>
      Lumen helps modern teams ship faster without the meeting churn. Plan,
      track, and deliver from one calm interface.
    </p>
    <a class="cta" href="/signup">Try Lumen free</a>
  </main>

  <script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>
  <agent-3d
    agent-id="YOUR_AGENT_ID"
    mode="floating"
    position="bottom-right"
    offset="24px 24px"
    width="300px"
    height="400px"
    background="light"
    framing="portrait"
  ></agent-3d>
</body>
</html>
```

The position is the conventional bottom-right where SaaS visitors expect to find help. The size is a restrained 300 × 400 — present but not dominating the hero — and responsive scaling (on by default) collapses it to a pill on phones. The `light` background gives the widget a pale, intentional panel against the cream page, with bubble contrast handled automatically. Portrait framing keeps the agent's face legible at this size, and the accent custom property ties the chat chrome to the brand indigo.

Compare this to a more playful brand. Imagine a children's learning app, "Sparrow", with bright colours and a cheerful tone:

```html
<agent-3d
  agent-id="YOUR_AGENT_ID"
  mode="floating"
  position="bottom-left"
  width="360px"
  height="480px"
  background="transparent"
></agent-3d>
```

Same attribute set, completely different feel — bigger, transparent so the avatar sits directly on the colourful page, full-body framing so the whole character shows. The point is that a handful of attributes — mode, position, size, background, framing — combine to express your brand without a build step.

---

## Step 10 — Programmatic control after load

A note for engineers: the `<agent-3d>` element exposes a JS API for driving the agent from your page's event flow. The full tour lives in [Drive the agent with the JavaScript API](/tutorials/js-api-events); here is the appearance-relevant slice.

Wait for the `agent:ready` event before calling methods — it fires once the body is loaded and the scene is live:

```html
<agent-3d id="agent" agent-id="YOUR_AGENT_ID" mode="floating"></agent-3d>

<script type="module">
  const agent = document.getElementById('agent');

  agent.addEventListener('agent:ready', () => {
    agent.wave();                       // quick hello gesture
  });

  // Play a named clip with polished defaults (loop flag + reduced-motion honoured)
  document.querySelector('#celebrate-button').addEventListener('click', () => {
    agent.playClip('celebrate', { userInitiated: true });
  });

  // Re-anchor and resize on the fly. Set `offset` before `position` —
  // the position change is what triggers the layout pass that reads it.
  document.querySelector('#move-button').addEventListener('click', () => {
    agent.setAttribute('offset', '16px 16px');
    agent.setPosition('top-left');
    agent.setSize('280px', '380px');
  });
</script>
```

The appearance-related methods on the element:

- `play(name)` — plays an animation clip by exact name from the shared clip library (or one baked into the GLB).
- `playClip(name, { fade_ms, userInitiated })` — the polished version of `play`: honours the clip's loop flag (one-shots settle back into idle) and respects `prefers-reduced-motion` unless the call is user-initiated.
- `playEmote(name)` — a named emote (`'cheer'`, `'flinch'`, `'celebrate'`) with a built-in fallback chain, so it always does *something* on any rig.
- `wave()` — the hello gesture.
- `lookAt(target)` — turn the head toward `'camera'`, `'center'`, or `'user'`.
- `setMode(mode)`, `setPosition(pos, offset)`, `setSize(width, height)` — attribute setters with the same live effect as editing the HTML.

These are independent of the declarative attributes. Set the look declaratively, then drive motion from your page's events.

---

## What you learned

You now know the full set of appearance attributes the `<agent-3d>` element honours:

- `mode` picks the layout: `inline` (default), `floating`, `section`, `fullscreen`
- `width` / `height` accept any CSS length; `responsive` (on by default) scales them per-device and collapses floating widgets to a pill on phones
- `position` and `offset` anchor a floating widget to any corner or centre edge
- `background` is `transparent` (default), `dark`, `light`, or any CSS colour
- `framing="portrait"` crops to head-and-shoulders for small widgets
- `name-plate="off"` hides the name overlay; `poster` covers the load with a still image
- `clip` picks the ambient animation for decoration avatars
- CSS custom properties (`--agent-accent` and friends) and `::part()` selectors theme the chrome
- The element's JS API (`play`, `playClip`, `playEmote`, `wave`, `lookAt`, `setMode`, `setPosition`, `setSize`) drives everything at runtime

Most production embeds use four or five of these together. The combination is what makes an agent feel like part of the page rather than a widget glued on.

---

## Next steps

- [Pick and swap an avatar in Studio](/tutorials/swap-avatar-in-studio) — change the agent's body without touching your snippet
- [Add a greeting and first speech line](/tutorials/greeting-and-first-speech) — give the agent its spoken introduction
- [Embed in 30 seconds](/tutorials/embed-in-30-seconds) — revisit the two-tag embed if you skipped any setup
- [Share your agent](/tutorials/share-your-agent) — generate a public URL, QR code, and social previews
- [Embed on a website](/tutorials/embed-on-website) — the full embed reference including framework-specific guidance
- [Build your first agent](/tutorials/first-agent) — drop down a level into manifests and skills
