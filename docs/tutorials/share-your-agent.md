# Share your agent (link, QR, social preview)

Every agent on three.ws has its own permanent public page. The URL never changes once the agent is saved. Anyone with the link can open it, talk to your agent, and see whatever body and personality you've configured. The page works on every device, ships rich previews to every chat app and social network, and is the right way to share an agent outside the context of a website embed.

This tutorial covers the full sharing surface: finding the public URL, generating a QR code, understanding how Open Graph and Twitter Card previews are produced, and choosing the right share context — email, business card, social post, restaurant menu, conference badge — for the agent you've built.

**What you'll build:**
- A clear path to find any agent's public URL
- A printable QR code that links to your agent
- Working social previews on iMessage, WhatsApp, Slack, Twitter / X, LinkedIn, Discord
- A small toolkit of share patterns for offline and online contexts
- A working share strategy you can apply to every agent you own

**Prerequisites:** A saved agent on three.ws. The agent should have a body and a name — covered in [Embed in 30 seconds](/tutorials/embed-in-30-seconds) and [Pick and swap an avatar in Studio](/tutorials/swap-avatar-in-studio).

---

## Step 1 — Find your agent's public URL

Go to [https://three.ws/my-agents](https://three.ws/my-agents). Sign in if you're not already.

You see a grid of every agent you own. Click the agent you want to share. The agent's profile page opens at a URL of this shape:

```
https://three.ws/agent/<id>
```

The `<id>` is your agent's permanent identifier. It looks like a hex string or a slugified handle, depending on how the agent was created. Copy the full URL from the browser's address bar — that's the canonical public link.

A few practical notes:

- **The URL is permanent.** It does not change when you update the agent's body, personality, name, or skills. Embeds, QR codes, business cards, and conference badges you produce today remain valid indefinitely.
- **The URL is public.** Anyone with the link can open it. There is no login required to talk to a public agent.
- **The URL is canonical.** Even if the platform's user-facing URL structure ever evolves, the agent ID itself is a stable platform reference. Old links continue to redirect.

If you ever forget the URL, the "Copy share link" button on the agent profile page copies the canonical version to your clipboard.

Every public agent is also in the platform's own directory, which is a plain open endpoint. Press the button and you are looking at the live directory, portrait and all, the way it exists as you read this:

```live
{ "step": "agents-public", "note": "The public directory, unauthenticated. Raise the limit and the cursor fields appear so you can page through it." }
```

Each entry carries `home_url`, which is the same canonical link this step is about. That is the shape to read if you are listing your agents somewhere else rather than copying one URL by hand.

### What visitors see when they open the link

The public agent page renders the agent's full 3D body in the centre of the screen, with chat input below it and microphone access for voice. The agent's name and one-line description show above. There is a small "Embed this agent on your site" prompt below for visitors who want to take the experience back to their own pages.

The page is responsive — on mobile it stacks vertically with the avatar at the top, taking about 60% of the viewport, and the chat input pinned to the bottom. Tapping the avatar zooms it slightly; tapping the microphone activates voice chat. There is no chrome that requires the visitor to sign up or pay before talking.

---

## Step 2 — Generate a QR code

A QR code is the right format for any context where someone is going to encounter your agent in the physical world: a business card, a restaurant menu, a museum placard, a conference badge, a coffee-cup sleeve. The visitor points their phone camera at the code, taps the notification, and the agent opens in their browser.

The easiest way to generate a QR code for a three.ws agent URL is a free online generator. A couple of reliable ones:

- [qr-code-generator.com](https://www.qr-code-generator.com/) — paste your URL, click Download, choose PNG or SVG.
- [qrcode-monkey.com](https://www.qrcode-monkey.com/) — more design control: rounded corners, embedded logos, custom colours.

Both produce QR codes that work with every modern phone camera. For most uses, a plain black QR code on a white background is the right choice — it scans reliably even in poor lighting and prints well at small sizes.

### Inline QR via the same site

If you don't want to leave the documentation flow, you can generate a code in two seconds using an inline service. Open this URL in a new tab, replacing the encoded URL with your agent link:

```
https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=https%3A%2F%2Fthree.ws%2Fagent%2FYOUR_AGENT_ID
```

The page returns a 400x400 PNG of the QR code. Right-click → Save As to download it.

For an SVG (which scales infinitely without loss, important for print):

```
https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=svg&data=https%3A%2F%2Fthree.ws%2Fagent%2FYOUR_AGENT_ID
```

### Sizing the QR code for real-world use

A few rules of thumb that prevent scanning failures:

- **Business card** — Print the QR at minimum 1.5 cm × 1.5 cm. Smaller looks neat but camera focus on phones struggles. Test by scanning the printed proof from 30 cm away before committing to a print run.
- **A4 / Letter page** — 3 cm × 3 cm is comfortable for hand-held scanning. 5 cm × 5 cm is comfortable for wall-mounted scanning.
- **Conference badge** — At least 2.5 cm × 2.5 cm. Badges are often crinkled or angled; give the camera a fighting chance.
- **Window sticker, restaurant menu, public placard** — 4 cm × 4 cm minimum. Glass distorts the scan; size up.

For digital use (a slide deck, a Zoom background, a website footer) the QR can be smaller because the camera has a steady, well-lit target. Phone screens, also, are surprisingly forgiving: a 1.5 cm QR on a laptop screen scans fine from across a meeting table.

### Customising the QR design

If you're using qrcode-monkey, you can:

- Round the corners of the modules for a softer look
- Tint the foreground in a brand colour (keep contrast > 3:1 against the background)
- Embed your logo in the centre (the QR's error correction means this still scans)

Don't tint both foreground and background; the contrast will drop too low and scanners will give up.

---

## Step 3 — Social previews

When you paste your agent URL into iMessage, WhatsApp, Slack, Discord, Telegram, Twitter / X, LinkedIn, Bluesky, Mastodon — every modern chat and social platform fetches the URL, extracts a preview, and shows the recipient a card with a title, description, and image. The right preview can be the difference between a recipient clicking the link and ignoring it.

three.ws sets Open Graph and Twitter Card meta tags automatically on every agent page. You do not need to configure anything for the previews to work — they ship by default.

### What the previews contain

When a platform fetches `https://three.ws/agent/<id>`, it sees:

- **og:title** — Your agent's name. Example: "Iris".
- **og:description** — Your agent's one-line description from the editor. Example: "Personal AI guide for Lumen customers."
- **og:image** — A pre-rendered preview image of the agent. This is generated automatically the first time someone shares the URL, then cached on the platform CDN.
- **og:url** — The canonical public URL of the agent.
- **og:type** — `website`.
- **twitter:card** — `summary_large_image`, so the Twitter preview shows the big-image card.
- **twitter:title**, **twitter:description**, **twitter:image** — Twitter-specific duplicates of the OG fields.

The preview image is a still render of your agent — same body, same lighting as the live page, framed for the 1200×630 standard OG image aspect. The agent's name is composited onto the corner of the image. The whole thing reads as "this is an agent you can talk to" without the recipient having to open the link first.

### How the preview image is generated

When an OG-fetcher (iMessage's link-unfurler, Slack's link preview service, Twitter's card scraper) hits your agent's URL for the first time, the platform spins up a headless WebGL renderer, loads the agent's GLB, renders a single high-quality frame against a neutral background, composites the name on top, and saves the result to the CDN. The whole render takes about two seconds.

After that first render, the image is cached on the CDN for ~24 hours. So:

- The first share of a brand-new agent will see a "loading" image for a few seconds (most platforms show their own placeholder during this window)
- Subsequent shares within ~24 hours are instant — the cached image is served
- After 24 hours, the next share triggers a re-render. This is useful: if you've swapped the agent's body in Studio, the new body shows up in social previews within a day automatically

If you need an instant re-render — say, you've changed the agent's body for a launch and want fresh previews — there's a "Refresh preview image" button on the agent profile page that purges the CDN cache and forces a fresh render on the next share.

### Verifying the preview before sharing

Don't ship a link without testing the preview first. Run the URL through a debugger:

- [Twitter Card Validator](https://cards-dev.twitter.com/validator) — Paste the URL, see the preview Twitter will render.
- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/) — Same for Facebook, Messenger, WhatsApp, and Instagram.
- [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) — Same for LinkedIn.

Run your agent URL through at least Twitter and Facebook before a big share. If a preview looks wrong, the most common causes are:

- The agent's name or description is unset in the editor → set them
- The preview image hasn't generated yet → wait one minute and retry
- A platform has cached an old version → use the platform's debugger (each tool above has a "re-scrape" button)

### Customising the preview

Most agents look right with the default preview. If you want to customise:

- The **name** is read from the agent's name field in the editor.
- The **description** is read from the agent's description field in the editor.
- The **image background** can be set per agent in the editor's Brand panel: a solid colour, a gradient, or a fixed background image upload. The agent body composites in front.

Keep the name short (under 30 characters) and the description specific (under 120 characters). Both render onto the image; long strings overflow and the platform clips them.

---

## Step 4 — Share contexts: online

Each platform has its own conventions. Here is what works on each.

### Email signature

A line of plain text at the bottom of your email signature is the most under-used share context for personal agents.

```
Talk to my AI: https://three.ws/agent/YOUR_AGENT_ID
```

The recipient sees the link and the email client unfurls a preview card if it supports OG (Gmail, Apple Mail, Outlook all do). For agents that represent you personally, this is a way to let every email recipient interact with your AI persona without an explicit invite.

### Twitter / X

A simple post with the URL works, but the engagement is higher if you give context:

```
Built a 3D AI agent that knows my work. Ask it anything → https://three.ws/agent/YOUR_AGENT_ID
```

X expands the URL into a large image card. The agent's preview image shows. Don't add a screenshot — let the auto-preview do the work; otherwise the platform sometimes hides the card.

### LinkedIn

LinkedIn's link unfurling is conservative. The post performs better if you write 1–2 sentences of context above the URL:

```
I built a personal AI assistant that visitors can talk to instead of reading my "About me" page. It knows my work, my availability, and what I'm building right now.

Try it: https://three.ws/agent/YOUR_AGENT_ID
```

LinkedIn shows the preview card below your post. Engagement is highest within the first few hours, so post during your network's morning timezone.

### Slack / Discord / Microsoft Teams

Pasting the link in a channel auto-expands the preview. Slack and Discord both honour the OG image; Teams shows the title and description without the image in most channels. There's nothing to configure — paste and post.

### iMessage / WhatsApp / Telegram

All three render the preview card automatically. iMessage and WhatsApp are particularly good at this — the recipient sees the agent's name and preview image inline, like a custom-built card. This is the best context for sharing an agent with someone who's never heard of three.ws; the preview teaches them what they're about to open.

---

## Step 5 — Share contexts: offline

The QR code from Step 2 makes the offline contexts work. A few patterns that pay off.

### Business card

Print a QR on the back of your card with the line "Talk to my AI assistant." Recipients you don't have time to chat with at an event can come back to your agent later. The agent picks up the conversation where your in-person introduction left off.

A small business card layout suggestion:

```
[FRONT]                       [BACK]
                              ┌─────────────────┐
NAME                          │                 │
Title · Company               │   ▓▓▓▓▓▓▓▓▓▓▓   │
                              │   ▓▓ QR  ▓▓▓▓   │
email@example.com             │   ▓▓▓▓▓▓▓▓▓▓▓   │
                              │                 │
                              └─────────────────┘
                              Talk to my AI:
                              three.ws/agent/...
```

Include the short URL beneath the QR so people who can't scan in the moment can type it later.

### Restaurant menu, museum placard, retail signage

For commercial contexts, an agent represents the venue. A restaurant might have a "menu helper" agent that recommends dishes based on dietary restrictions. A museum might have a "tour guide" agent that explains exhibits in any language. A retail store might have a "product expert" agent that answers questions about the product on the shelf.

In all three cases, the placement of the QR matters more than the design:

- Eye level, not table level. Standing-height QRs scan reliably.
- One QR per agent — don't bundle multiple agents on one sign.
- Pair the QR with a single short instruction: "Scan to talk to our menu guide" — not "Scan for more info" (vague), not a paragraph of explanation (too much to read).

### Conference badge / lanyard

If you're attending a conference, putting your agent's QR on your badge gives anyone you meet a way to come back to you. This works particularly well for design and engineering conferences where attendees are comfortable scanning codes.

### Coffee cup sleeve / branded merch

For brand activations, the agent QR can live on any branded surface. A cafe partnership with a coffee brand can include a sleeve that opens the brand's agent. A t-shirt at a launch event can have the agent QR on the sleeve. Be deliberate about discoverability — a QR hidden inside a folded napkin is wasted; one on the cup's handle catches the eye.

---

## Step 6 — Combine link, embed, and QR

The three share formats are complementary, not exclusive. A complete share strategy for an agent uses all three:

| Context | Format | When |
| --- | --- | --- |
| Your website | Embed snippet (one script tag) | Visitors who come through your domain |
| Your social posts / email / chat | Public URL | Anyone you reach digitally |
| Your business card / printed materials | QR code | Anyone you meet offline |

The same underlying agent — same brain, same body, same memory — serves all three contexts. When you update the agent (new body in Studio, new system prompt, new skills), every channel reflects the update without you re-deploying or reprinting anything except the QR cards. Even those need only be reprinted when the URL itself changes, which it won't.

This is what makes the share story compelling. The agent is a single permanent presence on the internet, and your job is to point people at it through whichever channel they prefer.

---

## Step 7 — A small worked example

You're a freelance UX consultant. You've built an agent called "Mara" — your personal AI assistant. She knows your portfolio, your availability, and your hourly rates. She's saved on three.ws.

Your share strategy:

1. **Embed on your portfolio site** — Following [Embed in 30 seconds](/tutorials/embed-in-30-seconds), you've added the one-line embed to the home page of your portfolio. Visitors can talk to Mara without leaving your site.

2. **Public link in your email signature** — At the bottom of every email you send: "Available 24/7 to chat about projects → https://three.ws/agent/mara-uxconsultant". Recipients can talk to Mara even when you're asleep.

3. **QR on the back of your business card** — At networking events, instead of "I'll email you next week", you say "Scan my card, ask Mara about my work, and book a call directly through her if it's a fit". The conversation happens on your terms, on her schedule.

4. **Social preview on launch posts** — Every quarter when you post a portfolio update on LinkedIn, you include the agent link. The auto-generated preview card shows Mara's 3D avatar with the title "Mara — Alex's UX consultant", which catches more attention than a plain text post.

Each channel uses the right format for its medium. The underlying agent is one thing, maintained in one place, that you've defined once.

---

## Step 8 — Privacy and visibility

A note before closing. Public agents on three.ws are exactly that — public. Anyone who has the URL can talk to your agent. The agent can:

- See the visitor's messages
- Reply using whatever knowledge you've configured
- Store conversation history in its memory if you've enabled the long-term memory mode

A few practical implications:

- **Don't put private information in the system prompt** that you wouldn't want a visitor to see. If a visitor asks the right way, the agent may quote it. Treat the prompt as "things you'd say in a public introduction".
- **Tell the agent what it can and cannot say.** A line like "Never share my home address, phone number, or contract rates" in the system prompt is followed reliably by modern LLMs.
- **Memory is private to your agent's record on the platform.** It's not shared with other agents and not visible to other users. But you, the owner, can see conversation logs in the editor.

If you want a private agent — one that only lives on a specific embed and isn't reachable from a public URL — toggle the "Public profile" switch off in the editor's settings panel. The agent ID still works for embeds; the public profile URL returns a 404. This is the right setting for internal tools, B2B-only embeds, and any agent that should not be discoverable.

---

## What you learned

- Every agent has a permanent public URL at `https://three.ws/agent/<id>`
- The URL is stable across body swaps, system prompt updates, and skill changes
- A QR code generated from any standard service points to that URL for offline share
- Open Graph and Twitter Card meta tags are set automatically, with a pre-rendered preview image
- Social preview images are generated on first share, cached 24 hours, and can be force-refreshed
- The three share formats — embed, link, QR — are complementary; a complete strategy uses all three
- Public agents are genuinely public; configure the system prompt and skills accordingly, or toggle the public profile off for private use cases

The agent's URL is the durable handle. Embed it, link it, print it. The agent shows up everywhere, identical, maintained from a single source of truth.

---

## Next steps

- [Embed in 30 seconds](/tutorials/embed-in-30-seconds) — put the agent on your own site if you haven't already
- [Build a personal AI website](/tutorials/personal-ai-site) — build a full site where the agent is the interface
- [Customize size, position and background](/tutorials/customize-appearance) — match your embeds to your brand
- [Pick and swap an avatar in Studio](/tutorials/swap-avatar-in-studio) — refresh the agent's body for seasons and campaigns
- [Add a greeting and first speech line](/tutorials/greeting-and-first-speech) — make the agent introduce itself on every load
- [Register on-chain](/tutorials/register-onchain) — give the agent a permanent decentralised identity for cross-platform portability
- [Build your first agent](/tutorials/first-agent) — drop into the manifest and skills layer for personality work
