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
https://three.ws/agents/d94d2a50-86fa-4d2e-b87b-580f7517aa4c
```

The `<id>` is your agent's permanent identifier: a UUID, assigned when the agent is first saved. Copy the full URL from the browser's address bar and it works forever.

A few practical notes:

- **The URL is permanent.** It does not change when you update the agent's body, personality, name, or skills. Embeds, QR codes, business cards, and conference badges you produce today remain valid indefinitely.
- **The URL is public.** Anyone with the link can open it. There is no login required to talk to an agent.
- **`/agent/<id>` redirects to `/agents/<id>`.** The profile page's canonical address is the plural form, and the singular one issues a permanent redirect to it. Both are safe to hand out; links printed years ago keep resolving.

There is a **Share** button on the profile page: one floating above the fold on the hero, one in the action row. Either opens a share panel that shows the exact card your link will unfurl as, with **Copy link**, **Share on X**, **Share on Farcaster**, and **Remix in three.ws**. The link it copies is the share URL from Step 3, not the bare profile URL, because that is the one carrying the rich preview.

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
https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=https%3A%2F%2Fthree.ws%2Fagents%2FYOUR_AGENT_ID
```

The page returns a 400x400 PNG of the QR code. Right-click → Save As to download it.

For an SVG (which scales infinitely without loss, important for print):

```
https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=svg&data=https%3A%2F%2Fthree.ws%2Fagents%2FYOUR_AGENT_ID
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

three.ws builds those tags automatically. You do not configure anything for the previews to work, but you do need to share the right URL.

### Share the `/share` URL, not the bare profile URL

The agent profile page at `/agents/<id>` is a JavaScript app. Its HTML carries the generic three.ws card, because at the moment a crawler fetches it, the page has not yet loaded which agent it is about. So the platform serves a second, server-rendered address purely for crawlers:

```
https://three.ws/agents/<id>/share
```

That page is plain HTML with your agent's real meta baked into the `<head>`, and a redirect that sends a human straight on to `/agents/<id>`. The older singular form, `/agent/<id>/share`, serves the same page, so links already in the wild keep unfurling. A recipient who taps the link never sees it; the unfurler does. This is the URL the Share button copies, and the one to paste anywhere a preview matters.

### What the previews contain

When a platform fetches `https://three.ws/agents/<id>/share`, it sees:

- **og:title**: `<agent name> · 3D AI Agent · three.ws`, or `<agent name> · 3D AI Agent on <chain> · three.ws` when the agent has been deployed on-chain.
- **og:description**: Your agent's description (first 120 characters), the chain it is deployed on if any, then `3D AI Agent on three.ws`.
- **og:image**: Your avatar's rendered thumbnail when the avatar's visibility is public or unlisted. Otherwise a generated SVG card from `/api/og/agent?id=<id>` carrying the agent's name and its chain badge.
- **og:url**: The `/share` URL itself. **og:type** is `profile`.
- **twitter:card**: `summary_large_image`, so X renders the big-image card, alongside `twitter:title`, `twitter:description`, and `twitter:image`.
- A **Farcaster Frame** block, so the same link renders as a frame in Farcaster clients.
- A **link rel="alternate" oEmbed** pointer at `/api/oembed`, so embedders that speak oEmbed can resolve the agent without scraping.

Both image paths target the 1200x630 standard OG aspect.

There is also a wallet variant, `/agents/<id>/share?wallet=1`, which swaps the copy and the deep link over to the agent's wallet view and always uses the generated card (the card is what carries the wallet identity). Use it when the thing you are sharing is the agent's wallet rather than the agent.

### Preview freshness

Nothing is pre-rendered and nothing needs purging. The share page is generated per request from the agent's current row in the database, and the generated card is drawn on demand:

- The share page is cached `max-age=60` in the browser and `s-maxage=600` at the edge, with a one-hour stale-while-revalidate window.
- The generated SVG card is cached `max-age=180` / `s-maxage=900`, with a two-minute stale-while-revalidate window.

So a rename, a description edit, or a body swap shows up in new previews within minutes, with no button to press. The lag you are more likely to hit is on the other side: X, Slack, and Facebook each cache what they scraped, sometimes for days. That is what the debuggers below are for.

### Verifying the preview before sharing

Don't ship a link without testing the preview first. There are three levels of check, cheapest first.

**The share panel.** Open your agent's profile page and click **Share**. The panel renders the real card image at the top, so you see what the link unfurls as before you send it anywhere.

**Read the tags yourself.** One command, no third party, no cache in the way:

```bash
curl -s https://three.ws/agents/YOUR_AGENT_ID/share \
  | grep -o '<meta[^>]*og:[^>]*>'
```

You should see your agent's name in `og:title` and a real image URL in `og:image`. If `og:title` says "Agent" and nothing else, the agent's name is unset.

**Platform debuggers**, for when a specific network is showing something stale:

- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/): Facebook, Messenger, WhatsApp, and Instagram. Has a "Scrape Again" button.
- [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/): LinkedIn, with the same re-inspect behaviour.
- [Twitter Card Validator](https://cards-dev.twitter.com/validator): X's card preview. It now requires a logged-in developer account, so the `curl` check above is usually faster.

If a preview looks wrong, the causes in order of likelihood are:

- **You shared `/agents/<id>` instead of `/agents/<id>/share`.** That gets the generic three.ws card. This is by far the most common one.
- **The agent's name or description is unset** → set them in the editor and re-check.
- **The avatar is private**, so the card falls back to the generated SVG rather than your avatar's thumbnail → set the avatar's visibility to unlisted or public in the [avatar dashboard](/dashboard/avatars).
- **A platform cached an old version** → use its debugger's re-scrape button.

### Customising the preview

The card is assembled from the agent's own record, so you customise it by editing the agent, not by editing a preview setting:

- The **name** is the agent's name field in the editor. It becomes `og:title`.
- The **description** is the agent's description field. It becomes `og:description`, truncated to the first 120 characters, so put the point first.
- The **image** is your avatar's thumbnail when the avatar's visibility is public or unlisted. Swap the agent's body (see [Pick and swap an avatar in Studio](/tutorials/swap-avatar-in-studio)) and the card follows within minutes.
- The **chain badge** appears by itself once the agent is deployed on-chain, both in the title and on the generated card.

Keep the name short and the description specific and front-loaded. Long strings are clipped, not wrapped.

---

## Step 4 — Share contexts: online

Each platform has its own conventions. Here is what works on each.

### Email signature

A line of plain text at the bottom of your email signature is the most under-used share context for personal agents.

```
Talk to my AI: https://three.ws/agents/YOUR_AGENT_ID/share
```

The recipient sees the link and the email client unfurls a preview card if it supports OG (Gmail, Apple Mail, Outlook all do). For agents that represent you personally, this is a way to let every email recipient interact with your AI persona without an explicit invite.

### Twitter / X

A simple post with the URL works, but the engagement is higher if you give context:

```
Built a 3D AI agent that knows my work. Ask it anything → https://three.ws/agents/YOUR_AGENT_ID/share
```

X expands the URL into a large image card. The agent's preview image shows. Don't add a screenshot — let the auto-preview do the work; otherwise the platform sometimes hides the card.

### LinkedIn

LinkedIn's link unfurling is conservative. The post performs better if you write 1–2 sentences of context above the URL:

```
I built a personal AI assistant that visitors can talk to instead of reading my "About me" page. It knows my work, my availability, and what I'm building right now.

Try it: https://three.ws/agents/YOUR_AGENT_ID/share
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
                              three.ws/agents/...
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

2. **Public link in your email signature.** At the bottom of every email you send: "Available 24/7 to chat about projects → https://three.ws/agents/<MARA_ID>/share". Recipients can talk to Mara even when you're asleep, and the mail client unfurls her card inline.

3. **QR on the back of your business card** — At networking events, instead of "I'll email you next week", you say "Scan my card, ask Mara about my work, and book a call directly through her if it's a fit". The conversation happens on your terms, on her schedule.

4. **Social preview on launch posts.** Every quarter when you post a portfolio update on LinkedIn, you include the agent link. The auto-generated preview card shows Mara's 3D avatar under the title "Mara · 3D AI Agent · three.ws", with the first 120 characters of her description as the card text, which catches more attention than a plain text post.

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

**There is no private-profile switch, and this matters.** Every saved agent has a reachable profile page. What you *can* control is discoverability and assets, which are two separate settings:

- **Marketplace listing.** An agent is unpublished until you publish it, and only published agents appear in the [marketplace](/marketplace) and its category browsing. Unpublishing removes an agent from the directory; it does not close the profile URL.
- **Avatar visibility.** Your avatar has its own private / unlisted / public setting in the [avatar dashboard](/dashboard/avatars). A private avatar is not served from any public endpoint, which is also why the agent's social card falls back to the generated SVG rather than the avatar's thumbnail.

So plan on the URL being reachable by anyone who has it. For genuinely internal tooling, do not put the knowledge in a hosted agent's system prompt at all.

---

## What you learned

- Every agent has a permanent public URL at `https://three.ws/agents/<id>`, where the id is a UUID (the singular `/agent/<id>` form redirects there)
- The URL is stable across body swaps, system prompt updates, and skill changes
- Rich previews come from `https://three.ws/agents/<id>/share`, a server-rendered page that carries the agent's real Open Graph, Twitter Card, and Farcaster Frame meta and forwards humans to the profile
- The Share button on the profile page shows that card and copies the `/share` link for you
- Nothing is pre-rendered and nothing needs purging: edits appear in new previews within minutes, and the stale copy you see is usually the sharing platform's own cache
- A QR code generated from any standard service points to that URL for offline share
- The three share formats — embed, link, QR — are complementary; a complete strategy uses all three
- Every agent profile is reachable by anyone with the link; discoverability is controlled by marketplace publishing, and asset exposure by avatar visibility

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
