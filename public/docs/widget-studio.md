# Widget Studio Guide

Widget Studio is the no-code builder for creating embeddable 3D widgets. Pick an avatar, choose a widget type, configure your brand settings, and get a one-line embed snippet — no code required.

**Access Widget Studio:** [three.wsstudio](https://three.ws/studio)

---

## What you can build

Five widget types are available in the Studio:

| Type | What it does | Best for |
|------|-------------|----------|
| **Turntable Showcase** | Auto-rotating display, no UI chrome | Product pages, portfolio hero banners |
| **Animation Gallery** | Browse and play every animation clip | Showcasing a rigged character's full motion library |
| **Talking Agent** | Embedded AI chat with a 3D avatar | Customer support, interactive demos |
| **ERC-8004 Passport** | On-chain identity card for an agent | Blockchain-verified agent profiles |
| **Hotspot Tour** | Annotated 3D scene with clickable points of interest | Product tours, educational walkthroughs |

> **Note:** Animation Gallery, Talking Agent, and Hotspot Tour are currently marked "coming soon" in the Studio UI — you can save their configurations now, and the live runtime will activate when those features ship.

---

## Getting started

### Sign in first

Widget Studio requires an account. When you open the Studio without signing in, you'll see a sign-in prompt in the center of the page.

1. Click **Sign in →**
2. Complete authentication
3. The three-column Studio layout appears

### Create a new widget from scratch

1. Go to [three.wsstudio](https://three.ws/studio)
2. Sign in if prompted
3. The Studio opens with the default type (Turntable Showcase) pre-selected
4. Follow the three steps described below

### Start from an existing widget

To use another widget as a starting point, add `?template=<widget-id>` to the Studio URL. The Studio loads that widget's type and config with a new name ("Copy of …"). You'll still need to select your own avatar.

To edit a widget you've already saved, go to **Dashboard → Widgets**, click the widget, then **Edit**. The Studio opens with `?edit=<widget-id>` and everything pre-filled.

---

## Step-by-step walkthrough

The Studio has three columns: **Pick avatar + widget type** (left), **Live preview** (center), and **Brand & config** (right).

### Step 1 — Pick your avatar

The left column shows your saved avatars as thumbnail cards. Click any card to select it — a highlight appears and the live preview updates immediately.

> *See the screenshot below: the avatar list shows thumbnail cards; the selected avatar has a purple outline.*

If you have no avatars yet, you'll see a link to upload one from the Dashboard. Avatars are GLB files stored in your account.

If you're starting from a model URL rather than a saved avatar (for example, from a public GLB link), you can pass `?model=<url>` in the Studio URL to pre-select it.

### Step 2 — Pick a widget type

Below the avatar list, the type grid shows five cards. Each card displays an icon, name, and one-line description. Types marked **Coming soon** can still be configured and saved — their live preview placeholder says the runtime isn't active yet.

Click a type card to select it. The right column's type-specific fields update immediately.

### Step 3 — Configure brand and settings

The right column has a **Brand** panel with a form. Changes here update the live preview in real time.

**Fields available for all widget types:**

- **Name** — internal label for your widget (shown in the Dashboard). Required.
- **Background** — canvas background color (color picker, default `#0a0a0a`)
- **Accent** — used for buttons and interactive highlights (default `#8b5cf6`, purple)
- **Caption** — optional short text shown beneath the widget (up to 280 characters)
- **Show controls** — toggle the orbit/rotate controls visible to visitors
- **Auto-rotate** — whether the model spins automatically on load
- **Environment** — HDR lighting preset: **None**, **Neutral** (default), **Venice sunset**, or **Footprint court**
- **Public widget** — when checked, anyone with the URL can load the widget; uncheck to keep it private

**Turntable-specific fields:**

- **Rotation speed** — how fast the model spins (0–10, default 0.5)

**Passport-specific fields:**

The Passport widget pulls live on-chain data. You'll need:

- **Chain** — which blockchain to query (e.g., `base-sepolia`, `base`, `ethereum`)
- **Agent ID** — the on-chain token ID for the agent
- **Wallet address** — the `0x...` wallet address of the agent owner
- **Layout** — portrait, landscape, or badge
- **Show reputation / Show recent feedback** — toggle those sections on the card

For other widget types (Animation Gallery, Talking Agent, Hotspot Tour), type-specific fields will appear when those runtimes ship.

### Capture current camera view

While viewing the live preview, you can orbit the model to the angle you want visitors to see first. Click **Use current view** (above the preview) to save that camera position into the widget config. This sets the `cameraPosition` field.

---

## Saving and publishing

At the bottom of the right column, two buttons control what happens to your widget:

- **Save draft** — saves the widget to your account with the current settings. The widget is not publicly accessible until you generate an embed.
- **Generate embed** — saves the widget (or updates it if editing) and opens the embed modal.

If something is wrong with your form (e.g. the Name field is empty), an error message appears below the buttons.

### The embed modal

After clicking **Generate embed**, a modal slides up titled "Your widget is live."

> *See the screenshot below: the modal shows a live preview iframe, a shareable URL field, and two embed snippet text areas.*

The modal contains:

**Shareable URL** — a `/w/<id>` link you can paste anywhere. Social platforms and CMSes render a rich preview card from this URL.

**iframe snippet** — the recommended embed for most sites:

```html
<iframe
  src="https://three.ws/widget#widget=wdgt_abc123&kiosk=true"
  width="600"
  height="600"
  style="border:0;border-radius:12px;max-width:100%"
  allow="autoplay; xr-spatial-tracking; clipboard-write"
  loading="lazy"
></iframe>
```

**Script-tag embed** (under a disclosure triangle) — auto-resizes to fit its container:

```html
<script async src="https://three.ws/embed.js" data-widget="wdgt_abc123"></script>
```

Click **Copy** next to either snippet. The code is ready to paste immediately.

---

## Embedding in popular platforms

Once you have a widget URL (`https://three.ws/w/<id>`), paste it into:

- **Notion** — paste the URL on its own line, press Enter. Notion detects the oEmbed endpoint and turns it into a live viewer automatically.
- **Substack** — use an embed block and paste the URL.
- **Ghost CMS** — use an HTML card or an oEmbed block and paste the URL.
- **WordPress** — in the Gutenberg editor, add an Embed block and paste the URL.
- **Anywhere else** — use the iframe snippet directly.

The oEmbed protocol handles the conversion automatically — no plugin needed.

---

## Managing your widgets

Go to [three.wsdashboard](https://three.ws/dashboard) and click the **Widgets** tab.

From the dashboard you can:

- See all your widgets with preview thumbnails and impression counts
- Click a widget to open its detail view
- Edit settings (opens Studio with the widget pre-loaded)
- Copy the embed code again
- Change visibility (public vs. private)
- Delete a widget

### Analytics

Every widget tracks impressions automatically. Select a widget in the Dashboard and open the **Analytics** tab to see:

- Total impressions (views)
- Unique visitors
- Country breakdown
- Referring sites (hostname only — no full URLs are logged)

Chat message content from Talking Agent widgets is never logged.

---

## Widget gallery

Public widgets are listed at [three.wswidgets](https://three.ws/widgets). Browse the gallery to find inspiration, discover what other creators have built, and copy embed snippets for any listed widget.

Filter by widget type, search by name, or sort by popularity or recency.

---

## Troubleshooting

**Preview is blank after picking an avatar**

The model URL must be accessible from the browser. If your avatar's visibility is set to **Private**, the preview can't load the GLB. Change the avatar visibility to **Unlisted** or **Public** in the Dashboard, then reload the Studio.

**"Couldn't load avatars"**

Your session may have expired. Reload the page — if the sign-in prompt appears, sign in again.

**Type-specific fields are missing**

Only Turntable and Passport show extra fields today. Animation Gallery, Talking Agent, and Hotspot Tour display a "coming soon" banner in place of their fields. You can still save a config for these types.

**Can't save — button does nothing**

Check that the **Name** field is filled in. The form requires a name before saving.

**Widget preview in the embed modal looks different from the Studio preview**

The embed modal shows the same widget at the default iframe dimensions. If you sized the Studio preview differently using the drag handle, the modal resets to the standard size.

**Passport widget shows no data**

Verify that the Chain, Agent ID, and Wallet address are all set correctly. The Agent ID must be a numeric token ID (not a name). The chain must match where the agent is registered.

---

## Default embed sizes

These are the recommended iframe dimensions by widget type, matching the defaults in the runtime:

| Widget type | Width | Height |
|-------------|-------|--------|
| Turntable | 600 | 600 |
| Animation Gallery | 720 | 720 |
| Talking Agent | 420 | 600 |
| ERC-8004 Passport | 480 | 560 |
| Hotspot Tour | 800 | 600 |

You can override these freely in the iframe `width` and `height` attributes. Add `max-width:100%` in the `style` attribute to make the widget responsive on mobile.

---

## Next steps

- [Widgets reference](./widgets.md) — technical details, postMessage API, CSP config, and oEmbed spec
- [Web component](./web-component.md) — the `<agent-3d>` custom element for developer integrations
- [Embedding guide](./embedding.md) — advanced embedding patterns and iframe options
