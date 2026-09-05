# Run an IRL street demo: drop an agent at a real spot, let strangers walk up

This is the runbook for showing IRL to people who have never heard of three.ws: you place a 3D AI agent at a real location, put a sign there, and anyone who scans it sees the agent standing on that spot through their phone camera, taps it, talks to it out loud, and can stand it on their own floor in AR. It was written for a demo in San Francisco, and everything in it applies to any city.

Nothing here needs an app or an account on the visitor's side. The owner needs a signed-in three.ws account so the pin is permanent.

---

## What the visitor experiences

1. They scan the sign. It opens `three.ws/irl?pin=<id>` in their phone browser.
2. IRL asks for camera and location (and motion, on iPhone, which takes one extra tap). A banner at the top says **"You're here to meet <agent name>"** and that the agent appears within 60 m of the spot.
3. Standing within range, the agent appears in their camera view, playing its idle animation and turning to look at them. Its name label flashes and its card opens on its own.
4. The card leads with **Talk** and **View in AR**, then shows the agent's bio, on-chain reputation, its **Solana wallet chip**, a **Tap to tip in person** panel (a Solana Pay QR plus an "Open in wallet" deep link), any paid x402 services, a message box, and **View profile**.
5. **Talk** opens a conversation with the agent standing in front of them. They hold the mic and speak (or type). The reply is in the agent's persona, spoken aloud in its voice, and the model's mouth moves with the audio. Pressing the mic while it is speaking interrupts it.
6. **View in AR** stands the agent on their real floor. iPhone opens ARKit Quick Look with the idle clip baked in; the Quick Look banner reads "Talk to <name>" and tapping it brings them back to the card with the conversation open. Android with ARCore enters a WebXR session that anchors this agent to the detected floor (tap to place, pinch to size). Anything else opens the AR launcher (`/api/ar`) in a new tab.

Anyone who opens the link from somewhere else sees only the agent's name and a prompt to walk to the spot. The link never carries a coordinate, and the nearby read is presence-gated, so posting the link publicly is safe. See [How location works on IRL](/irl-privacy).

---

## Before the day

### 1. Pick the agent

Use a real agent from your account, not the anonymous companion. The card's wallet chip, tip QR, reputation and services all come from the agent identity, and the pin only links to one when you place it signed in with that agent selected.

- Check the agent's profile page (`/agents/<id>`): if it shows a Solana wallet chip there, the IRL card will show the same chip and the tip QR.
- **An agent wallet is provisioned on demand, not automatically.** A brand-new agent has none, and `GET /api/agents/<id>/solana` answers `"wallet": null` for it. The IRL card then renders with no wallet chip and no tip QR, which removes the part of the demo people react to most. Create one from the agent's wallet panel (or `POST /api/agents/<id>/solana` while signed in as the owner) and confirm the same endpoint returns an address before you print anything.
- If you want a paid interaction in the demo, give the agent a priced service from `/dashboard/monetize`. It appears on the card as a **Pay via x402** action.
- A humanoid rigged body plays the idle animation and gaze in the camera view. Any of the rigs the universal retargeter maps work (Mixamo, VRM, Avaturn, and the rest); a non-humanoid prop stands still.

### 2. Pick the spot

GPS decides whether people see the agent, so the spot matters more than anything else in this runbook.

- **Open sky.** Plazas, parks, waterfronts. In San Francisco that means places like the Embarcadero, the Ferry Building plaza, Dolores Park, Crissy Field, or the top of a park hill. Avoid narrow downtown streets between tall buildings: multipath GPS there can drift 50 m or more, and the nearby read caps at 60 m.
- **Somewhere people can stop.** Visitors need to stand still for a few seconds while GPS settles and the model loads.
- **Cellular signal.** The agent's model is fetched over the visitor's own connection.

The card shows the pin's placement accuracy, and the ring under the agent goes amber above 25 m. If you see amber when you place it, move to clearer sky and place again.

### 3. Place the pin

On your phone, signed in, at the spot:

1. Open [/irl](/irl), grant camera, location, and motion.
2. Pick the agent (the avatar picker under the name).
3. Aim at the ground, tap **Move here** to set it down, then **Pin here**. On Android with ARCore, **Place in AR** anchors it to the detected floor with a pinch to size it; on iPhone, **Pin here** is the placement path.
4. Give it a caption. It shows on the sign and on the card.

Signed-in pins are permanent until you remove them. If you cannot be at the spot beforehand, **Place on map** in /irl drops it at a point you choose, and **Move on map** in the dashboard relocates it later.

The full placement walkthrough is [Place a 3D agent in your real environment](/docs/tutorials/place-agent-irl).

### 4. Print the sign

Open [/dashboard/irl-placements](/dashboard/irl-placements), find the pin, and tap **Visit link**. The modal shows the QR, the link to copy, and **Print a sign**, which opens `/irl/sign?pin=<id>`: the agent's name, thumbnail and bio, the QR, three steps for the visitor, and the link in plain text. Choose **Sign** (landscape) or **Poster** (a large QR for a vertical sheet) and print. A laminated Letter sheet at chest height reads fine from two metres.

Test the sign with your own phone before you leave: scan it, walk 70 m away, confirm the banner says the agent is out of range, walk back, confirm the card opens.

---

## On the day

- **Your phone is the demo screen too.** The dashboard's **View in IRL** opens the same visit link, so you can show the walk-up while a visitor does it.
- **Talk through the three taps:** scan, allow, look around. The banner carries the rest.
- **Let them talk first.** Hand the phone over with the card open and say "hold the mic and ask it anything". The agent answers out loud in its persona; that is the moment people remember. Give the agent a persona and a cloned voice beforehand (`/agents/<id>`, Brain Studio and the voice clone in talk mode) so it sounds like itself on the street.
- **Show the tip.** Expand **Tap to tip in person**, and let someone scan the Solana Pay QR with Phantom or Solflare. The agent's wallet is a real address; a tip lands on-chain.
- **Show it on the floor.** **View in AR** is the moment people photograph: Quick Look on an iPhone, a floor-anchored WebXR session on an Android phone with ARCore.
- **Volume and noise.** Replies play through the phone speaker. On a loud street, hold the phone up or use a small speaker; typed turns work when speech recognition cannot hear.
- **Messages and taps land in your dashboard.** The placements page lists every message, tap and pay under the pin, and the inbox lets you reply. `GET /api/irl/analytics` (admin) has the rollup afterwards.

---

## Troubleshooting on site

| Symptom | Cause | Fix |
|---|---|---|
| Banner never changes from "You're here to meet" | Visitor is outside 60 m, or their GPS fix is far off | Move to open sky, wait ten seconds, check the accuracy line on the card once it opens |
| "Enable location" chip in the top bar | Location was denied | Tap the chip; on iPhone, Settings > Safari > Location if the prompt is gone |
| Agent appears but does not move | Motion permission not granted (iPhone), or a non-humanoid body | Tap the motion chip; humanoid rigs animate, props do not |
| "View in AR" is missing | The pin has no model URL | Re-place the pin with a hosted avatar from your account |
| Talk shows "Voice input isn't available" | The browser has no speech recognition, or the mic was denied | Type in the box instead; on iPhone allow the microphone when Safari asks, or Settings > Safari > Microphone |
| The agent answers but you hear nothing | The phone is on silent (iPhone honours the mute switch for web audio) or volume is down | Flip the ring/silent switch, raise the volume, tap the mic again |
| The mouth does not move while it speaks | The body has no mouth morphs or jaw bone, or the model is still streaming in | Nothing to fix on site; the agent still talks. Rigs with ARKit or VRM mouth shapes animate |
| Banner says the agent has moved on | The pin expired (anonymous pins last 7 days) or was removed | Place it again signed in and print a fresh sign |
| Visitors see nothing at all, you see the agent | Your device owns the pin; theirs reads nearby only within range | Have them stand where you placed it, not where you are now |

---

## Related

- [IRL overview](/docs/irl): what IRL is, Money Drops, World Lines, the SDK
- [How location works on IRL](/irl-privacy) and the [threat model](/docs/irl/THREAT-MODEL)
- [Place a 3D agent in your real environment](/docs/tutorials/place-agent-irl)
- [AR and WebXR reference](/docs/ar): the device routing behind "View in AR"
