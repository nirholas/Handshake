# Share & embed your agent

Once your agent is live, you have three ways to put it in front of people. None of them require code.

---

## Option 1 — Share the link

Every agent gets a public URL: `https://three.ws/agents/<id>`

Paste it anywhere:

- Share it directly with someone and they can chat with your agent in their browser
- Post it on X, Discord, or Slack — the platform sends a rich preview (title, avatar thumbnail, description) automatically
- Add it to your bio, your email signature, or a QR code

No install, no sign-up required for the visitor — they just open the link and start talking.

---

## Option 2 — Embed on a website (iframe)

The easiest way to put your agent inside another page. Go to [Widget Studio](/studio), find your agent, and click **Get embed code**. You'll get a snippet like:

```html
<iframe
  src="https://three.ws/w/<widget-id>"
  width="400"
  height="600"
  frameborder="0"
  allow="microphone"
></iframe>
```

Copy and paste this into any page that accepts HTML — including Notion, Webflow, Framer, Squarespace, WordPress, and Shopify. The agent appears inside the iframe with its own chat UI, voice button, and 3D rendering.

**Widget types you can embed via iframe:**

| Widget | Best for |
|---|---|
| **Turntable Showcase** | An auto-rotating 3D model with no UI. The type Widget Studio starts you on |
| **Animation Gallery** | Clicking through every clip on a rigged avatar |
| **Talking Agent** | Full chat, voice, and 3D avatar: your agent embodied on your site |
| **ERC-8004 Passport** | An on-chain identity card for any agent |
| **Hotspot Tour** | An annotated 3D scene with clickable points of interest |
| **Pump.fun Live Feed** | A Solana agent narrating live launch claims and graduations |
| **Smart Money Feed** | Live buy and sell activity from KOL and whale wallets for a token |
| **Live Trades Canvas** | A particle visualization of live buy/sell trades for a token |
| **Bonding Curve** | Live graduation progress and the bonding-curve climb for a token |
| **Walking Avatar** | A roaming 3D avatar visitors steer around your page with a joystick or the keyboard |

---

## Option 3 — Web component (for developers)

If you manage the HTML of your page directly, the `<agent-3d>` custom element gives you more control than an iframe:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d agent-id="<your-agent-id>"></agent-3d>
```

The element renders inline (no iframe boundary), supports keyboard navigation, and exposes a JavaScript API so you can drive the agent programmatically. See the [Embedding guide](./embedding.md) for the full attribute reference and event list.

---

## Just the avatar, nothing else

If all you want on the page is the 3D avatar, without chat, voice, or any widget UI, [Avatar Artifact](./avatar-artifact.md) is a one-line iframe:

```html
<iframe src="https://three.ws/avatar-artifact?agent=<your-agent-id>" width="100%" height="600" style="border:0" loading="lazy" title="Avatar Artifact"></iframe>
```

It renders your agent's avatar, follows the visitor's cursor, and links back to the profile. Open the page itself and click **Copy embed** to get the snippet already pointed at your agent.

---

## Controlling who can embed your agent

By default, your agent can be embedded anywhere. If you want to restrict it to specific domains:

1. Open your agent's edit page
2. Under the **Embed policy** settings, add the domains that are allowed (e.g. `yoursite.com`)
3. Save — any embed on a non-listed domain will render an error placeholder instead

---

## Sharing on social platforms

Paste your agent's URL (`https://three.ws/agents/<id>`) into:

- **X / Twitter** — renders a card with the avatar poster image, name, and description
- **Discord** — embeds as an oEmbed rich preview
- **Slack** — unfurls with the name and description
- **LinkedIn** — shows the Open Graph image and title

To customize the preview image, change the agent's thumbnail in the editor.

---

## What's next

- **Make your agent smarter** → [Skills system](./skills.md)
- **Understand the technical embed options** → [Embedding guide](./embedding.md)
- **Payment and crypto questions** → [Do I need crypto?](./do-i-need-crypto.md)
- **Give it a permanent on-chain address** → [Register on-chain](./tutorials/register-onchain.md)
