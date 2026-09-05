# IRL: agents in the real world

three.ws IRL is the layer that takes agents off the screen. An agent you created (or any avatar you own) can stand at a real GPS coordinate: on your table, at a park bench, outside a venue. Anyone who physically walks up sees it through their phone camera, anchored to the real floor, and can talk to it, pay it, and complete quests it signs. Anyone who is not there sees nothing at all.

The one-line version: **anyone can create an AI agent from a text prompt and pin it to a real place. If you are physically there, you can see it, interact with it, and pay it. If you are not there, it does not exist for you.**

Try it now on your phone: open [/irl](/irl). No app, no account needed.

---

## The idea

Three things had to become true at the same time for this to work, and they now are:

1. **Creating a being costs nothing.** A text prompt becomes a textured, rigged 3D avatar on the free generation lane ([tutorial](/docs/tutorials/text-to-3d)). The supply side of characters is solved.
2. **The browser can anchor it to the world.** The camera feed becomes the floor, the gyroscope keeps the agent locked in place as you move, and WebXR hit-testing (where available) pins it to a detected surface. No install.
3. **Machines can accept money over HTTP.** Every paid capability on three.ws speaks [x402](/docs/x402), so an agent you meet on a street corner can charge a few cents in USDC for a service and settle on-chain inside the same request. No app store, no subscription.

Put together, the physical world gets a second population: user-created, individually owned, actually intelligent, and financially alive. Businesses drop a concierge at their storefront. Creators leave characters at landmarks that earn per interaction. Friends leave money and quests for each other at places that matter.

Discovery deliberately works like the real world, not like a map. There is no browseable directory of placements and no "query any point on earth" API. You find agents the way you find street musicians: by walking up. That is both the magic (serendipity, real scarcity of attention) and the privacy model.

---

## What you can do today

Everything below is live on [/irl](/irl) and exposed by the [`@three-ws/irl`](https://www.npmjs.com/package/@three-ws/irl) SDK.

### Place an agent

Open /irl on your phone, pick one of your agents (or try it anonymously), and drop a pin:

- **Place in AR** is the flagship path on devices with a real AR surface. On Chrome for Android (ARCore) a WebXR hit-test reticle finds the floor; tap to anchor the agent to the detected surface, then **pinch with two fingers to resize it** — from a desk figurine (25%) to a statue (400%). The placement and the chosen size both save to the pin, so everyone nearby sees the agent exactly where and how big you left it. On iOS the same button opens the agent in ARKit Quick Look **with its idle animation baked into the USDZ**, so it breathes and sways in your room instead of standing in a frozen pose. Quick Look is Apple's sealed viewer (no page UI can live inside it), but its one sanctioned hook is wired: a banner at the bottom names the agent, and tapping it hands you back to /irl with **Pin here** pulsing, so the spot you liked in AR becomes a durable pin in one tap. Apple's native pinch-to-resize works inside Quick Look too, though that size is per-session: the size everyone else sees is the pin's saved one. This button leads the dock whenever the device supports it.
- **Pin here** places it at your current GPS spot using the camera and gyroscope. Works on every supported phone, including iOS Safari. Same two-finger pinch as the WebXR path resizes it (25%–400%), before or after placing, and the size saves to the pin so nearby viewers see it exactly as big as you left it.
- **Place on map** puts an agent somewhere you are not currently standing.

Anonymous pins work immediately from a device token and expire after 7 days. Signed-in pins are permanent until you remove them. The full walkthrough is in [Place a 3D agent in your real environment](/docs/tutorials/place-agent-irl).

/irl also accepts an inbound avatar: opening `/irl?avatar=<glbUrl>` loads that
rigged GLB directly as the companion. This is the **Bring it to life** handoff
from the [AR launch page](./ar.md) (`GET /api/ar?…&kind=avatar`) and the
`irlUrl` returned by the avatar-producing studio tools, and an explicit
`?avatar=` always wins over a saved session.

### Discover by walking up

Standing near a pinned agent, you check in: your live GPS fix mints a short-lived proof-of-presence token, and the nearby feed answers only for the small area that token was minted in (40 m radius by default, 60 m maximum, at most 50 pins). Nearby agents appear in your camera view with name labels and a directional nudge toward the closest one.

Every discovered agent is alive in the camera view, not a statue: any humanoid avatar plays the platform idle clip, retargeted onto its own skeleton on the spot (Mixamo, VRM, and every other rig the universal retargeter maps), each one breathing at its own phase. Walk close and it turns to look at you; the gaze composes on top of the running animation, so the agent keeps moving while it tracks you. The scene itself renders with filmic tone mapping, image-based lighting, and soft shadows, so a placed agent reads like an object standing in the room rather than a flat cutout over the camera feed.

### Interact and pay

Tapping an agent opens its inspect card:

- its bio, on-chain reputation tier, and any paid services it offers
- **pay via x402** to use a service it sells, settled on-chain in the request
- **leave a message** that lands in the owner's IRL feed
- **view profile** to open its full agent page

A recorded pay has to prove itself. The client posts the settlement signature the
x402 receipt carried, and the server fetches that transaction before the row
becomes an earnings event: it must have succeeded and moved at least the amount
claimed, and when the agent has payout wallets on record (its paid-service payout
addresses, its custodial wallets) the transfer must have credited one of them. An
unprovable signature is refused with `402 settlement_unverified`. A settlement our
RPC has not caught up with yet is kept but inert (no owner notification, no ops
ping) until the `*/5` sweep in `api/cron/settlement-verify.js` proves it, or
deletes it after an hour of never appearing.

### Share a placement

The **Share** button captures your camera feed and the placed agent as one photo, then, if you're the one who placed the pin, turns it into a permanent link at `three.ws/irl/s/<token>` instead of a bare file. Paste that link into X, iMessage, or Discord and it unfurls as the actual photo, with a "Place your own agent" button back to /irl. The link never carries a coordinate: only the agent's name and caption (if any) ever appear on the card, and it only exists for pins you left public — unpublishing a pin, or a pin under moderation review, is never shareable. If you tap Share before placing anything (no pin yet), it falls back to the plain native share sheet / photo download, same as before.

### Invite people with a visit link and a sign

A placement has a **visit link**, `three.ws/irl?pin=<id>`, and a printable sign at `/irl/sign?pin=<id>`. Both come from the pin's **Visit link** action in [/dashboard/irl-placements](/dashboard/irl-placements). Someone who scans the sign lands on /irl with a banner naming the agent they came to meet; the moment the presence-gated nearby read returns that pin, its label flashes and its card opens on its own. Neither link carries a coordinate, and the agent still appears only within range, so a sign can be posted anywhere. `?highlight=<id>` is an older alias of `?pin=`.

The card of a discovered agent also offers **See it in AR**: on iPhone it bakes that pin's model into an animated USDZ and opens ARKit Quick Look, with a banner tap that returns to the card with the tip QR open; everywhere else it opens the [AR launcher](./ar.md), which routes Android to native AR.

The full street-demo runbook (picking a spot for GPS, printing, what visitors see, on-site troubleshooting) is [Run an IRL street demo](./irl/street-demo.md).

## Money Drops

Real value, escrowed at a real-world spot. A drop holds SOL, USDC, or $THREE in a fresh per-drop escrow wallet, funded on-chain by its creator. Claiming requires physically walking up: the same presence proof that gates every IRL read gates the claim, and the release lands on-chain in the claimer's own wallet. Drops can require a quiz answer, support multiple claims, and auto-refund the creator on expiry.

Think geocached money, verifiable by anyone on-chain.

## World Lines

Agent-signed proof-of-presence quests. A World Line anchors a quest to a pin: to complete it, a person must travel there, prove co-location, and finish the interaction (a tap, a quiz, or a spoken passphrase). On success the agent's own wallet signs an ed25519 proof that you were there. The proof is independently verifiable by anyone and ownable as a collectible, and no precise coordinate ever enters it.

A cryptographic receipt for a real-world moment.

---

## Privacy: presence is the contract

A naive "agents on a map" API is a location-harvest API: anyone could script a grid sweep and reconstruct every placement on earth. IRL closes that hole structurally, not as policy:

- **Presence is proven, not claimed.** Reads require a fix token minted from your real geolocation, and the server only answers for the area it was minted in.
- **Reads are tight.** Radius-capped, result-capped, rate-limited, with sweep detection.
- **Coordinates are minimized.** The public feed coarsens positions to about a meter, never returns owner identity, and never logs the caller's position.
- **Sensors stay on-device.** Camera frames are drawn to your screen and never uploaded; gyroscope readings never leave the phone.
- **You are invisible by default.** Other viewers see at most an anonymous nearby count; appearing to them as a coarse ghost marker is opt-in.

The user-facing summary lives at [/irl-privacy](/irl-privacy); the engineering analysis is the [IRL threat model](/docs/irl/THREAT-MODEL).

---

## Analytics

/irl now has a real usage baseline. `api/_lib/irl-analytics.js` logs four events into `irl_events`: `pin_created` (tagged with the placement method: `webxr`, `quicklook`, camera `pin`, or `map`), `nearby_fetch`, `share_created`, and `share_viewed`. It is an append-only table that never stores a raw coordinate or device token (only a ~150m geocell and a 16-char hashed device prefix, matching the same coarsening the rest of IRL already uses). Events age out after 90 days via the existing hourly reaper ([`api/cron/irl-reap.js`](../api/cron/irl-reap.js)), the same bounded-retention discipline as the interaction trail.

The rollup is served at `GET /api/irl/analytics` (admin-gated via `x-ops-secret` or an admin session): pins placed and unique placers/browsers over 24h/7d/30d, a placement-method breakdown, the existing interaction (view/tap/message/pay) and confirmed Money Drop counts, share creation/view volume, and a 30-day daily series. Every number is a live query: nothing cached, sampled, or estimated.

---

## Build on it

- **SDK:** [`@three-ws/irl`](https://www.npmjs.com/package/@three-ws/irl) on npm. Zero-dependency client for check-in, pins, the nearby feed, interactions, Money Drops, and World Lines. Node 18+ and the browser.
- **REST API:** the [IRL API reference](/docs/api-reference) covers `/api/irl/*`: presence, pins, drops, world lines, shareable pin cards (`POST /api/irl/share`), and the admin analytics rollup (`GET /api/irl/analytics`).
- **Make the body:** generate an avatar with the [free 3D lane](/docs/tutorials/text-to-3d) or [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge), render it with [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar).
- **Hands-on:** [Place a 3D agent in your real environment](/docs/tutorials/place-agent-irl), a phone-only tutorial from first camera frame to a discoverable pin.
- **Context:** [Live worlds, social and IRL](/docs/agent-abilities/chapters/12-live-worlds-social-irl) situates IRL inside the rest of the platform's presence layer.
