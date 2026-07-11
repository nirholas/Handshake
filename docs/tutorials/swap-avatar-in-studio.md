# Pick & swap an avatar in Studio

Your agent has a mind: a name, a personality, a set of skills, memory, and a wallet. Separately, your agent has a body: a 3D model that visitors see and interact with. The platform keeps these two things distinct on purpose. The mind is the durable identity. The body is a presentation choice that you can change at any time without affecting the rest.

Widget Studio is where you make that choice. You open it, browse the gallery, preview the candidate bodies on top of your agent's actual brain, and pick the one you want live. The snippet you've already embedded on your customer's site does not change. The next time the page loads, the new body is what visitors see.

This tutorial walks through the full Studio flow, explains what changes server-side versus snippet-side when you swap, and shows you how to maintain a small library of swappable bodies for the same agent.

**What you'll build:**
- A working understanding of how Studio fits between editor and embed
- A swap of your agent's body to a different avatar, live, in under five minutes
- A small personal library of avatars you can rotate between for seasons, campaigns, or audiences
- The mental model for separating identity (the agent) from presentation (the avatar)

**Prerequisites:** A saved agent on three.ws. If you've worked through [Embed in 30 seconds](/tutorials/embed-in-30-seconds), you already have one.

---

## Step 1 — Open Widget Studio

Go to [https://three.ws/studio](https://three.ws/studio). Sign in if you're not already.

Studio opens with a split layout. On the left is your agent — already loaded, animating, ready. On the right is the avatar gallery: a grid of 3D bodies the platform hosts, your own uploads, and any community-published avatars you can use freely.

If you have more than one agent in your account, there's an agent selector at the top of the left panel. Pick the one you want to modify; the rest of the page updates to show that agent's current body.

> The studio is genuinely a "studio" rather than a settings page. You can spend ten minutes in here just trying bodies on, the same way you'd browse outfits in a fitting room. Nothing is final until you save.

---

## Step 2 — Understand the gallery's structure

The avatar gallery has a few visible sections worth knowing about. They control what shows up when you search and where new avatars come from over time.

### Platform avatars

The default tab. These are bodies the three.ws team curates: a balanced set of styles (realistic, stylised, abstract), gender presentations, ethnicities, and aesthetic moods. They're stored on the platform's CDN, optimised for fast load, and tested for animation compatibility — every animation in the standard library plays correctly on every platform avatar.

You can filter by:

- **Style** — realistic, stylised, low-poly, geometric, abstract
- **Use case** — support, hero, mascot, narrator, professional
- **Polygon count** — useful if you're embedding on a low-end-device-heavy site

Click any tile to preview the avatar on your agent — the left panel updates in real time, and your agent's actual greeting and idle animations play on the new body.

### Your uploads

If you've ever uploaded a GLB through the editor or the upload flow, those files appear here under "Your avatars". The platform stores them on its CDN with the right CORS headers so the embed loader can fetch them from anywhere.

If you haven't uploaded anything yet, this section is empty and the studio shows a hint pointing to the upload flow. Custom uploads are covered in their own tutorial — for this one, we stick with platform and community avatars.

### Community avatars

Avatars that other three.ws users have published as freely usable. This section grows over time. Each tile shows the creator's handle and a license note (most community avatars are CC-BY or CC0). Click the creator handle to see their full set.

---

## Step 3 — Preview before committing

This is the single most important habit to form when working with Widget Studio: preview every candidate body fully before saving. Click on each candidate and let it run for at least twenty seconds in the preview panel. You'll notice things you'd otherwise miss.

The preview panel runs your agent's actual configuration on the new body. So you see:

- How the avatar holds its head while idle
- How it gestures when speaking
- How the wave clip looks (try clicking "Wave" in the preview controls)
- How the talk-mouth animation reads — some stylised characters have very expressive mouth shapes, others almost none
- Whether the lighting in the scene flatters this particular model

A few practical checks that pay off:

- **Wave test** — Every avatar should be able to wave. If the wave looks broken (arm goes through the chest, hand stays at the side), the avatar's rig is incomplete; pick a different one.
- **Talk test** — Type a sentence into the preview chat input. The avatar should move its mouth and gesture lightly. If it doesn't, the talk animation isn't bound; pick a different one.
- **Idle test** — Watch the avatar for twenty seconds with no input. The idle should feel natural, not robotic. Notice the breathing, the small head turns, the weight shifts.

When something feels right, you'll know — the preview panel feels like a real conversation rather than a mannequin.

---

## Step 4 — What happens when you swap

This is the part most people get wrong on their first try, and the part the studio is most useful for clarifying. Here is what changes — and, just as importantly, what does *not* change — when you save a new body.

### Server-side: the agent record updates

The platform stores each agent as a record. The record has:

- An agent ID (permanent, never changes)
- A name
- A personality / system prompt
- A skills list
- A memory configuration
- A wallet
- And a pointer to a body — that pointer is a URL of a GLB file

When you save a new body in Studio, the only field that changes in that record is the body URL. Everything else — name, personality, skills, memory, wallet, the ID — stays exactly as it was. The agent is the same entity. It just dresses differently.

### Snippet-side: nothing changes

This is the crucial property. Your embed snippet is:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d agent-id="YOUR_AGENT_ID" mode="floating"></agent-3d>
```

There is no body URL in this snippet. The `<agent-3d>` element references the agent by its ID, and the embed runtime fetches the current body URL from the platform every time a visitor loads the page. When you swap the body in Studio, the next page load returns the new body. The customer site doesn't need to be re-deployed, the snippet doesn't need to be edited, the cached HTML on Cloudflare doesn't need to be purged.

This is by design and it's worth pausing on, because it changes how you operate at scale. You can:

- Run a seasonal avatar swap across hundreds of customer sites in one click
- A/B test two different bodies for the same brain across two agent IDs without touching any client code
- Replace a corrupted GLB at the source and have every embed self-heal on next page load
- Move from a placeholder avatar to a final-art avatar mid-campaign without coordinating a single deploy

Once the snippet is in place, the body lives entirely in the platform's control.

### What about cached GLBs?

The platform serves GLBs with reasonable cache headers — typically a few hours of freshness, then revalidate. When you save a swap in Studio, visitors who already have the page open keep the old body until they refresh. Visitors who arrive after the swap get the new body within at most an hour or two (and usually immediately, because most CDN edges revalidate on every miss).

If you need an instant swap — say, you're fixing a visibly broken avatar for an important demo — the platform exposes a "Bust cache" button in Studio's save dialog. Use it sparingly; it forces every CDN edge to refetch.

---

## Step 5 — Perform a swap

Time to do the thing. With the studio open and your agent loaded:

1. **Pick a candidate.** Browse the gallery, click an avatar that matches the mood you want.
2. **Preview thoroughly.** Use the controls under the preview panel — Wave, Idle, Greet, Talk — and try at least the first three.
3. **Click Save** in the preview panel's footer. A confirmation dialog appears with two options: **Save** (default cache behaviour, fast and free) or **Save and bust cache** (instant propagation, use only when needed).
4. **Click Save.** The platform updates the agent record. The dialog closes.
5. **Open your embedded page in a new tab.** The new body appears.

That's the whole flow. In practice, on a real connection, a swap takes about ten seconds from click to live.

---

## Step 6 — Build a personal avatar library

Studio is not just for one-off swaps; it's also where you maintain a small library of bodies you cycle between for different contexts. A few patterns that pay off.

### Seasonal swaps

Holiday avatars are a small detail that visitors notice. A "winter outfit" body for December and January, a "summer / outdoor" body for the warmer months, a "back to school" body in September. The brain is unchanged — your agent's personality persists across seasons. Only the appearance shifts. Use Studio's preview to make sure the seasonal avatar still feels like the same character (similar build, hair colour, posture); otherwise visitors will feel a discontinuity.

### Campaign avatars

If you run product launches, your agent can wear a launch-themed body for the launch week. Examples: a body holding the new product, a body wearing the launch t-shirt, a body in the launch's colour palette.

### Audience-specific avatars

You can run two agents with the same brain and different bodies, embedded on different pages:

- `agent_dev_id` — wears a developer-coded body, embedded on your docs and changelog
- `agent_sales_id` — wears a polished body, embedded on your marketing and pricing pages

Both agents have the same personality, the same memory, the same skills. Only the body — and therefore the perceived audience — differs. The split is set up by duplicating the agent in My Agents at [https://three.ws/my-agents](https://three.ws/my-agents) and then using Studio to pick the right body for each clone.

### Test bodies

It's useful to keep one "test" body in your library — something visually distinct, like a bright-coloured low-poly character — that you swap to when you're verifying a deployment. You can tell at a glance whether the page is showing the test body (deployment worked, cache busted, embed is live) or the production body (it's serving stale).

---

## Step 7 — How the platform serves avatars

A short technical note for engineers, in case it matters for your stack.

Every platform avatar and every user upload is stored in the three.ws CDN, served from edge nodes globally. The URL format is approximately:

```
https://three.ws/cdn/avatars/<hash>.glb
```

The hash is a content-addressable digest, which means the same GLB always has the same URL, and uploading a new version generates a new URL. The agent record stores the current URL; Studio updates that pointer when you swap.

Headers served on every GLB:

- `Access-Control-Allow-Origin: *` — so the embed loader can fetch the file from any customer domain
- `Cache-Control: public, max-age=86400, must-revalidate` — one-day freshness with revalidation
- `Content-Type: model/gltf-binary` — correct MIME type for GLB

Files are not gzipped (GLBs are already binary-packed and don't benefit) but textures inside the GLB are compressed using KTX2 / Basis when present.

The "Bust cache" save option in Studio sends a purge signal to the edge network, which clears the cached object on every edge node usually within ten seconds.

This matters in two cases:

- You're embedding on a customer site with a strict CSP. Add `https://three.ws` to `connect-src` and you're done.
- You're embedding on a site behind a corporate proxy that strips `Access-Control-Allow-Origin`. The proxy needs to be configured to let three.ws responses through unmodified.

---

## Step 8 — A worked example

Let's run through a realistic scenario end to end.

Imagine you're running an online cooking school called "Hearth". You have a single agent named "Chef Olive" — friendly, knowledgeable, helps visitors pick the right course. Your agent is embedded on three pages: the home page, the course catalogue, and the pricing page. The current avatar is a stylised character in chef's whites — clean, professional, on-brand.

For your spring promotion, you want to swap the avatar to one wearing a green apron with a fresh-greens basket — same character build, same posture, same hair, but a clearly springtime variant. The agent's voice, personality, course knowledge, and memory of past conversations all stay the same.

Here's the flow:

1. Open [https://three.ws/studio](https://three.ws/studio). Select Chef Olive in the agent selector.
2. In the gallery, type "chef" in the search box. A handful of chef-style avatars surface, including the current production one.
3. Click the spring-apron candidate. The preview panel updates. Chef Olive — same voice, same greeting — appears in the new body.
4. Run the previews: wave, idle, talk. They all read well.
5. Click **Save**. Choose normal save (no cache bust — your spring campaign isn't time-critical).
6. Open the live home page in a private window. Chef Olive appears in the spring apron.

Visitors who land on the page during the next hour see the new body. Past conversation history is unchanged — a returning visitor who chats again finds Olive remembers their previous questions, just dressed differently for the season.

When the promotion ends, you return to Studio, swap back to the original whites, and save. The agent is back in its everyday outfit. No client code touched. No customer notified. No deploy run.

---

## Step 9 — When to use Studio versus the full editor

A small clarification, because new users often conflate the two surfaces.

The **editor** at [https://three.ws/create](https://three.ws/create) is where you set the agent's identity: name, personality, skills, memory, wallet, voice. It's a designer surface for the brain.

**Studio** at [https://three.ws/studio](https://three.ws/studio) is where you tune the agent's appearance: the body and the embed presentation. It's a designer surface for the visual layer.

There is some overlap — Studio shows you which body is currently set, and the editor shows you a preview of the agent — but the principle is: brain in editor, body in studio. If you find yourself trying to write a system prompt in Studio or pick a body from the editor, you've taken the long way; switch surfaces and the right controls appear.

---

## What you learned

- Widget Studio at [https://three.ws/studio](https://three.ws/studio) is the home for swapping an agent's body
- The platform separates the agent (mind, identity, wallet, memory) from the avatar (3D body, presentation)
- A swap updates one field on the server-side agent record and changes nothing about the embed snippet on customer sites
- Cache propagation is automatic within an hour, or instant with the "Bust cache" option
- A small personal library of avatars — seasonal, campaign, audience-specific, test — pays off for any agent you run beyond a single use case
- Avatars are served from the three.ws CDN with the right CORS and cache headers for embed use

The key insight is the snippet's stability. Once embedded, your customers' pages never need to change. You can update the body monthly, weekly, daily — visitors always see the current version, and the integration on the customer site keeps working without re-deploys.

---

## Next steps

- [Customize size, position and background](/tutorials/customize-appearance) — once the body is right, tune the embed presentation
- [Embed in 30 seconds](/tutorials/embed-in-30-seconds) — revisit the one-line embed if you skipped it
- [Add a greeting and first speech line](/tutorials/greeting-and-first-speech) — give every visitor a spoken welcome
- [Share your agent](/tutorials/share-your-agent) — generate a public URL, QR code, and social previews
- [Build your first agent](/tutorials/first-agent) — drop down to the manifest and skill level if you want full control
- [Embed on a website](/tutorials/embed-on-website) — the full embed reference for production sites
- [Register on-chain](/tutorials/register-onchain) — give the agent a permanent decentralised identity
