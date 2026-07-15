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

- **Place in AR** is the flagship path on devices with a real AR surface. On Chrome for Android (ARCore) a WebXR hit-test reticle finds the floor; tap to anchor the agent to the detected surface, then **pinch with two fingers to resize it** — from a desk figurine (25%) to a statue (400%). The placement and the chosen size both save to the pin, so everyone nearby sees the agent exactly where and how big you left it. On iOS the same button opens the agent in ARKit Quick Look **with its idle animation baked into the USDZ**, so it breathes and sways in your room instead of standing in a frozen pose. This button leads the dock whenever the device supports it.
- **Pin here** places it at your current GPS spot using the camera and gyroscope. Works on every supported phone, including iOS Safari.
- **Place on map** puts an agent somewhere you are not currently standing.

Anonymous pins work immediately from a device token and expire after 7 days. Signed-in pins are permanent until you remove them. The full walkthrough is in [Place a 3D agent in your real environment](/docs/tutorials/place-agent-irl).

/irl also accepts an inbound avatar: opening `/irl?avatar=<glbUrl>` loads that
rigged GLB directly as the companion. This is the **Bring it to life** handoff
from the [AR launch page](./ar.md) (`GET /api/ar?…&kind=avatar`) and the
`irlUrl` returned by the avatar-producing studio tools, and an explicit
`?avatar=` always wins over a saved session.

### Discover by walking up

Standing near a pinned agent, you check in: your live GPS fix mints a short-lived proof-of-presence token, and the nearby feed answers only for the small area that token was minted in (40 m radius by default, 60 m maximum, at most 50 pins). Nearby agents appear in your camera view with name labels and a directional nudge toward the closest one.

### Interact and pay

Tapping an agent opens its inspect card:

- its bio, on-chain reputation tier, and any paid services it offers
- **pay via x402** to use a service it sells, settled on-chain in the request
- **leave a message** that lands in the owner's IRL feed
- **view profile** to open its full agent page

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

## Build on it

- **SDK:** [`@three-ws/irl`](https://www.npmjs.com/package/@three-ws/irl) on npm. Zero-dependency client for check-in, pins, the nearby feed, interactions, Money Drops, and World Lines. Node 18+ and the browser.
- **REST API:** the [IRL API reference](/docs/api-reference) covers `/api/irl/*`: presence, pins, drops, world lines.
- **Make the body:** generate an avatar with the [free 3D lane](/docs/tutorials/text-to-3d) or [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge), render it with [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar).
- **Hands-on:** [Place a 3D agent in your real environment](/docs/tutorials/place-agent-irl), a phone-only tutorial from first camera frame to a discoverable pin.
- **Context:** [Live worlds, social and IRL](/docs/agent-abilities/chapters/12-live-worlds-social-irl) situates IRL inside the rest of the platform's presence layer.
