# Pick & swap an avatar in Studio

Your agent has a mind: a name, a personality, a set of skills, memory, and a wallet. Separately, your agent has a body: a 3D model that visitors see and interact with. The platform keeps these two things distinct on purpose. The mind is the durable identity. The body is a presentation choice you can change at any time without affecting the rest.

This tutorial covers both halves of that. You swap the body in the agent editor's **Outfit** panel, in one click. Then you take the result into **Widget Studio**, which is a different surface with a different job: turning any avatar into an embeddable widget.

**What you'll build:**
- A swap of your agent's body to a different avatar, live, in under a minute
- A small personal library of avatars you can rotate between for seasons, campaigns, or audiences
- A widget built in Studio from the avatar you picked
- The mental model for separating identity (the agent) from presentation (the avatar)

**Prerequisites:** A saved agent on three.ws. If you've worked through [Embed in 30 seconds](/tutorials/embed-in-30-seconds), you already have one.

---

## Step 1: Know which surface does what

Two surfaces have "studio" energy and they are often confused. They do not overlap:

| Surface | Where | What it changes |
| --- | --- | --- |
| **Agent editor, Outfit panel** | `/agent/<id>/edit` | The agent's own body, animation set, and animation states. This is where a swap happens. |
| **Widget Studio** | [/studio](/studio) | Builds a standalone embeddable widget from an avatar. Does not modify any agent. |
| **Avatar dashboard** | [/dashboard/avatars](/dashboard/avatars) | Creates, names, deletes avatars, and sets each one's visibility. |

If you are trying to change what your embedded agent looks like, you want the first row. Studio is Step 6.

---

## Step 2: Open the Outfit panel

Open [https://three.ws/my-agents](https://three.ws/my-agents) and click the agent you want to change. On its profile page, click **✏ Edit Agent** (visible to you as the owner). That lands you on `/agent/<id>/edit`.

Scroll to the **Outfit** panel. It has three sections stacked in order:

- **Avatar**: the grid of bodies you can put on this agent. This is the one this tutorial is about.
- **Animations**: which clips from the three.ws animation library this agent is allowed to play. Changing this needs an explicit **Save selection**.
- **Animation states**: which clip plays in each behaviour state, so the avatar crossfades sensibly as it speaks, walks, and reacts. Saved with **Save states**.

A live 3D preview of the agent sits in the left column, so you are always looking at the current body while you work.

---

## Step 3: Read the avatar grid

The grid lists the avatars on your account, newest first, up to fifty. Each tile shows the avatar's thumbnail and name. The body currently on this agent carries a **Current** badge, so you never have to guess which one is live.

Two things sit alongside the grid:

- A **Create new** tile (the `+`). It opens a menu with the four real ways to get a new body: **three.ws Studio** (the in-browser builder for hair, clothing, and body), **three.ws Selfie** (a photo becomes a photoreal avatar, covered in [Turn a selfie into a 3D avatar](/tutorials/selfie-to-avatar)), **Upload GLB** (bring your own model), and **Browse public gallery** (pick from community avatars).
- A **Manage in dashboard ›** link to [/dashboard/avatars](/dashboard/avatars), where you rename, delete, and set visibility.

If you have no avatars yet, the grid says so and points you at the dashboard instead of showing an empty box.

---

## Step 4: Perform the swap

Click a tile. That is the whole interaction.

There is no confirmation dialog and no separate save button for the avatar: the click sends the change immediately, the status line under the heading reads `Saving…` and then `Saved.`, the **Current** badge moves to the tile you picked, and the 3D preview reloads on the new body. If something goes wrong, the same line shows the error rather than failing silently.

Under the hood that click is one request:

```
PUT /api/agents/<agent-id>
Content-Type: application/json

{ "avatar_id": "<the avatar you clicked>" }
```

The call is owner-scoped, so you can only re-body agents you own.

### What changes, and what does not

The platform stores each agent as a record holding its ID, name, personality, skills, memory configuration, wallet, and a pointer to a body. **A swap changes only the body pointer.** Name, personality, skills, memory, wallet, and the agent ID are untouched. The agent is the same entity, and a returning visitor's conversation history is still there. It just dresses differently.

Your embed snippet does not change either:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d agent-id="YOUR_AGENT_ID" mode="floating"></agent-3d>
```

There is no body URL in that snippet. The `<agent-3d>` element references the agent by ID and resolves the current body from the platform on every page load. Swap the body and the next page load shows it: no redeploy, no snippet edit, no cache purge on the customer's site.

This is what makes the pattern useful at scale. You can run a seasonal swap across every site that embeds you in one click, replace a broken GLB at the source and have every embed self-heal on the next load, or move from a placeholder body to final art mid-campaign without coordinating a single deploy.

### Why there is nothing to purge

Two caching facts make the swap effectively instant, and it is worth knowing them so you do not go hunting for a cache-busting button that does not exist:

- The agent record is served `Cache-Control: no-store`, so a page load always reads the current body pointer. There is no stale-manifest window.
- Each avatar is a distinct object at a distinct URL, so a swap points at a different file rather than replacing the bytes behind one. GLBs are served long-lived on purpose (`public, max-age=604800, stale-while-revalidate=2592000`), with `Access-Control-Allow-Origin: *` and `Content-Type: model/gltf-binary`, so the old body stays cached for the visitors still on it and the new body is fetched fresh.

The only visitors who keep seeing the old body are the ones with the page already open, and only until they refresh.

---

## Step 5: Build a personal avatar library

The Outfit grid is your library, so it pays to keep a few deliberate bodies in it rather than one.

### Seasonal swaps

Holiday avatars are a small detail visitors notice: a winter body for December and January, a summer body for the warmer months. The brain is unchanged, so your agent's personality persists across seasons. Use the live preview to check the seasonal body still reads as the same character (similar build, hair colour, posture), otherwise visitors feel a discontinuity.

### Campaign avatars

If you run product launches, your agent can wear a launch-themed body for launch week: holding the new product, wearing the launch shirt, or in the launch's colour palette.

### Audience-specific agents

Run two agents with the same personality and different bodies, embedded on different pages: a developer-coded body on your docs and changelog, a polished one on marketing and pricing. Same brain, different perceived audience. Create the second agent from [My Agents](/my-agents), then set its body here.

### A test body

Keep one visually unmistakable body, such as a bright low-poly character, and swap to it when you are verifying a deployment. You can tell at a glance whether a page is serving the new build or a stale one.

---

## Step 6: Take the avatar into Widget Studio

[Widget Studio](/studio) is the other half of the story. It does not touch your agents; it turns an avatar into a self-contained embeddable widget with its own URL and snippet. It runs as four numbered steps across three columns.

**1. Pick avatar.** All of your avatars are listed, plus a search box for browsing public ones, and a demo avatar is pre-loaded so you can try the studio before signing in. Set the avatar you intend to publish to **public** or **unlisted** in the [avatar dashboard](/dashboard/avatars) first: a widget is served to strangers, so a private avatar's model URL comes back empty and the published widget renders nothing. The studio says as much above the list.

**2. Pick widget type.** Each type is a different layout, not a different avatar:

- **Turntable Showcase**: hero banner, auto-rotate, no UI.
- **Animation Gallery**: click through every clip on a rigged avatar.
- **Talking Agent**: embodied chat, your agent on your site.
- **ERC-8004 Passport**: on-chain identity card for any agent.
- **Hotspot Tour**: annotated 3D scene with clickable points of interest.
- **Walking Avatar**: a roaming avatar visitors steer with a joystick or the keyboard.
- **Pump.fun Live Feed**, **Smart Money Feed**, **Live Trades Canvas**, **Bonding Curve**: live market surfaces narrated or visualised by the avatar.

**3. Brand.** Colours, environment, captions, and behaviour, with the middle column previewing every change live. The preview has a desktop / tablet / mobile switcher, and a **Use current view** button that locks whatever camera angle you have dragged to as the widget's default framing.

Then **Generate**. A modal opens with the widget's live URL, a width and height, and two copy-ready snippets: an `<iframe>` and a script tag. **Save draft** keeps work in progress without publishing.

The important distinction: a widget built here is pinned to the avatar you chose. Swapping your *agent's* body in Step 4 does not re-point an existing widget. If you want the widget to follow the agent, use the **Talking Agent** type, which is backed by the agent rather than by a bare avatar.

---

## Step 7: A worked example

You run an online cooking school called "Hearth", with a single agent named "Chef Olive" embedded on your home page, course catalogue, and pricing page. The current body is a stylised character in chef's whites.

For a spring promotion you want a green-apron variant: same character build, same posture, clearly springtime. Olive's voice, personality, course knowledge, and memory all stay the same.

1. Open [My Agents](/my-agents), click Chef Olive, click **✏ Edit Agent**.
2. Scroll to **Outfit**. The current whites tile carries the **Current** badge.
3. Click the spring-apron tile. The status line reads `Saved.` and the preview reloads on the new body.
4. Open your live home page in a private window. Olive is in the spring apron.

Total elapsed time is a few seconds, and no client code was touched. When the promotion ends, click the whites tile again.

Note what did *not* happen: no deploy, no cache purge, no customer notified, and no loss of conversation history. A returning visitor finds Olive remembers their previous questions, just dressed differently.

---

## What you learned

- The body swap lives in the agent editor's **Outfit** panel at `/agent/<id>/edit`, not in Widget Studio
- Clicking an avatar tile saves immediately: one `PUT /api/agents/<id>` carrying `avatar_id`, with the **Current** badge and the live preview confirming it
- A swap changes one field. Name, personality, skills, memory, wallet, and the agent ID are untouched
- The embed snippet never changes, because `<agent-3d agent-id="…">` resolves the current body on every page load
- Nothing needs purging: the agent record is `no-store`, and each avatar is a distinct long-lived object
- **Widget Studio** at [/studio](/studio) is a separate surface that builds standalone widgets from an avatar, across ten widget types
- Avatar visibility (private / unlisted / public) is set in the [avatar dashboard](/dashboard/avatars) and decides whether the avatar's model and thumbnail are served publicly, which a published widget and a social card both need

The key insight is the snippet's stability. Once embedded, your customers' pages never need to change. You can update the body monthly, weekly, or daily, and visitors always see the current version.

---

## Next steps

- [Customize size, position and background](/tutorials/customize-appearance) — once the body is right, tune the embed presentation
- [Turn a selfie into a 3D avatar](/tutorials/selfie-to-avatar): put a real likeness in the Outfit grid
- [Embed in 30 seconds](/tutorials/embed-in-30-seconds): revisit the two-tag embed if you skipped it
- [Add a greeting and first speech line](/tutorials/greeting-and-first-speech) — give every visitor a spoken welcome
- [Share your agent](/tutorials/share-your-agent) — generate a public URL, QR code, and social previews
- [Build your first agent](/tutorials/first-agent) — drop down to the manifest and skill level if you want full control
- [Embed on a website](/tutorials/embed-on-website) — the full embed reference for production sites
- [Register on-chain](/tutorials/register-onchain) — give the agent a permanent decentralised identity
