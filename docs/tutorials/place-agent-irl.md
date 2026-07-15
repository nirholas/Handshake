# Place a 3D agent in your real environment with IRL

By the end of this tutorial you'll have walked one of your 3D agents around your living room — anchored to your real floor through the phone camera, steered with an on-screen joystick — and left it pinned at a real spot where anyone standing next to it can discover it. You'll do it all in the browser on your phone, with no app to install.

Along the way you'll understand the difference between **viewing a model in AR** and **placing an agent in the world**, how proximity discovery works, and exactly what your camera, motion, and location sensors do and don't share.

**Prerequisites:** a smartphone (iPhone with Safari, or an Android phone with Chrome). HTTPS is required for camera and motion access, so use the live site — open [three.ws/irl](/irl) on the phone itself. No account is needed to try it; signing in lets you place a permanent pin and switch between your own agents.

---

## What you're building

```
You, in your kitchen:  open /irl  →  tap Camera AR  →  joystick-walk the agent across the floor
                       →  aim the camera at the spot you want  →  tap Pin here
        ↓
Anyone who walks up to that spot later:  opens /irl, points their camera, and finds your
                                          agent standing exactly where you left it
```

IRL turns the real world into the stage. The camera feed becomes the floor, your phone's gyroscope keeps the agent locked in place as you turn, and a pin you drop is **private by location** — it's never on a map or a feed, only reachable by being physically near it.

---

## IRL is not the model viewer's AR (read this first)

three.ws has two camera-AR experiences. They look similar through the lens but solve different problems — don't confuse them.

| | [View in AR](/docs/tutorials/view-in-ar) | **IRL** (this tutorial) |
|---|---|---|
| Goal | See **one** 3D model at true scale in your room | **Walk and place** your agent in the world for others to find |
| Entry | The **AR** tab on any avatar / Forge model | The [/irl](/irl) product page |
| Movement | None — the model sits where you place it | Joystick / WASD walking, drag-to-orbit |
| Persistence | Nothing is saved | A **pin** that lives at a real GPS spot |
| Discovery | Private to you, this session only | Anyone standing nearby finds it in person |
| Multiplayer | No | Anonymous nearby presence, ambient reactions |

If you just want to orbit a single model in your kitchen, use [View in AR](/docs/tutorials/view-in-ar) — it covers iOS Quick Look, Android Scene Viewer, and WebXR for a one-off model. **This** tutorial is about the `/irl` product: a live, walkable agent you anchor and leave behind.

---

## How IRL works (two minutes of theory)

IRL is a phone-camera experience built on three sensors, each rendered **on your device**:

- **Camera** — `getUserMedia` with `facingMode: 'environment'` opens the rear camera and draws it full-screen behind a transparent Three.js canvas. That's the "passthrough": your real room shows through, the agent renders on top. Frames are never uploaded or stored.
- **Motion & orientation** — your phone's gyroscope (`deviceorientation`) keeps the agent locked to its spot as you turn to look around. iOS 13+ asks for a one-time permission gesture for this.
- **Location** — used only to drop a pin at the spot where you're standing and to find the handful of pins right around you. Your position is never shared with other users.

A **pin** is the unit of placement: an agent anchored at a real coordinate. The platform never exposes a list, map, or directory of pins. The only read that returns someone else's agent is the per-viewer proximity feed (`GET /api/irl/pins`), which requires you to send your *own* location and clamps the search radius to between 10 and 60 metres server-side. You discover agents by walking up to them — never by browsing where they are.

> WebGL is required to render the scene. On a browser without it, IRL shows a designed "this device can't run IRL AR" state and points you to [/agents](/agents) instead of throwing a blank canvas.

---

## Step 1: Open IRL on your phone

On the phone, go to [three.ws/irl](/irl).

You'll see your agent rendered against the ambient dark background, an **IRL** badge in the top bar, and a big white **Camera AR** button at the bottom. The subtitle reads *"Turn on Camera AR, then tap Pin here to anchor your agent in real space."* — that line is your always-visible signpost to the next step.

To start with a specific agent's avatar, append `?avatar=` to the URL:

```
https://three.ws/irl?avatar=YOUR_AVATAR_ID
```

An explicit `?avatar=` link always wins over the avatar you used last visit. (Links from an agent profile's "View in IRL" button also pass `?agent=` to deep-focus that agent's pin once it's nearby.)

---

## Step 2: Turn on Camera AR

Tap **Camera AR**.

The browser asks for camera permission — **Allow** it. This only happens once per origin. The rear camera feed fills the screen, the badge dot turns green, and the button switches to its active green state. Your agent is now standing on your real floor.

A few things are happening under the hood:

- The page requests the **environment-facing** camera (`facingMode: { ideal: 'environment' }`), so you get the rear lens, not the selfie cam.
- A single mutex owns the camera and render loop, so the passthrough and the 3D scene never fight over the GPU.
- On iOS, the page also asks for **Motion & Orientation** access — grant it so the agent stays locked in place when you rotate the phone. If you deny a sensor, a one-tap recovery chip appears so you can re-request it without digging through Settings.

If the camera doesn't start, jump to [Troubleshooting](#troubleshooting).

---

## Step 3: Walk the agent with the joystick (or WASD)

Now move the agent around your real space.

**On a phone**, a virtual joystick lives in the bottom-left corner. Drag it to walk; push further from center to move faster. Release to stop.

**On desktop** (or any device with a keyboard), use:

- `W` `A` `S` `D` or the arrow keys to move
- `Shift` to run
- Click-and-drag anywhere on the canvas to orbit the camera

The keyboard hints are shown on the right edge of the desktop layout. Movement keys are ignored while you're typing in a caption or message field, or while a sheet is open, so walking never fights with text input.

Walk the agent to the exact spot in your room where you want it to live — in front of your desk, by the door, on the rug. The camera passthrough is the floor; treat it like one.

---

## Step 4: Drop 3D objects on your floor (tap-to-place)

You can decorate the space with simple 3D props before you pin.

1. Tap **Add object** in the secondary row. The object picker slides up.
2. Choose a shape — **Orb**, **Crate**, **Crystal**, **Ring**, or **Pillar**.
3. Tap a spot on the floor through the camera. The object lands there at real-world scale, anchored to the surface you tapped.
4. Add as many as you like. Tap **Clear** to remove them all.

Tap-to-place uses a raycast from your tap into the scene, so objects sit where the floor is in view. These props are local scene dressing — they make the space feel inhabited while you compose the shot before pinning your agent.

---

## Step 5: Pin your agent in real space

This is the step that makes IRL different from the model viewer: you leave the agent behind at a real location.

1. Aim the camera so the agent is standing where you want it anchored.
2. Tap **Pin here**.
3. The caption panel slides up. Optionally add a short note — e.g. *"P2P trades here — DM me on Telegram."* Captions are optional.
4. Tap **Pin it**.

The agent locks to its spot. The status line confirms with something like *"Pinned facing north — others nearby can see you for 7 days."* While pinned, the joystick is hidden (a locked agent doesn't walk), and the gyroscope keeps it glued in place as you move your phone around it.

There are a few placement paths depending on your device and intent:

- **Place in AR** — leads the dock whenever the device has a real AR surface.
  - On Chrome for Android (ARCore) it opens a WebXR `immersive-ar` session with real hit-test surface detection: sweep your phone slowly, a reticle finds the floor, and a tap anchors the agent to the detected plane. A green check confirms the anchor took.
  - **Pinch with two fingers to resize** the anchored agent, anywhere from 25% (a desk figurine) to 400% (a statue). The size persists to the pin (the pinch lands as a follow-up `PATCH /api/irl/pins { id, scale }` after the placement tap), so everyone who walks up later sees the agent exactly as big as you left it. Natural size is the default.
  - On iOS the same button opens the agent in ARKit Quick Look with its idle animation baked into the USDZ, so it moves in your room instead of standing in a T-pose.
- **Pin here** — drops the agent at your current GPS spot using the camera + gyro. Works on every supported phone, including iOS Safari.
- **Place on map** — pick a spot on a map instead of using your live position, useful for placing an agent somewhere you're not standing.

### Signed-in vs anonymous pins

- **Not signed in:** your pin works immediately and **expires on its own after 7 days**. The phone holds an anonymous device token (a bearer credential scoped to that device) so you can still manage your own anonymous pins.
- **Signed in:** the pin is permanent until you remove it, and you can switch which of your agents is placed via **My Agents**. Manage and remove your pins from your dashboard or the **My pins** sheet.

Either way, every pin you place is listed only to you — never in any public view.

---

## Step 6: Discover and interact with nearby agents

When you're standing near a pinned agent (yours or someone else's), it appears in your camera view with a name label. The top bar shows a green **"N nearby"** badge as agents resolve around you, and a directional nudge arrow rides the screen edge pointing toward the nearest one until it's on-screen.

Tap an agent's label or model to open its **inspect card**:

- Its bio, on-chain reputation tier, and any paid services it offers
- **Pay via x402** to use a service it sells
- **Leave a message** that lands in the owner's IRL feed
- **View profile** to open its full agent page
- **Report this pin** if something's wrong — a pin is hidden once enough distinct people flag it

If others are viewing the same area, you'll see an anonymous **"N viewing nearby"** presence chip. You can optionally opt in to **Appear nearby**, which shows you to co-viewers as a coarse ghost marker — never your precise GPS.

---

## Step 7: Understand location privacy (and the controls you hold)

This is the part to get right before you place agents in places you care about. The full breakdown lives on the [IRL location privacy page](/irl-privacy); here's what matters for using the product.

**The one-line model:** a placed agent appears to someone *only* when they're physically within a few dozen metres of it. There is no list, map, feed, or directory of where agents are — not for other users, and not public. Your own placements are visible only to you.

**What others can see:**

- An anonymous "someone is viewing nearby" count when you're in the same area
- A coarse ghost marker — but only if you opt in, snapped to a rough area
- An agent placed at a spot, once they're standing near it themselves
- An ambient reaction when someone interacts with an agent you're both near

**What no one can see:**

- A list, map, or directory of where agents are placed
- Your exact GPS coordinates — they stay on your device unless you place a pin
- Who placed any agent — no account or device id is ever attached (the public read strips `user_id`/`device_token` and returns only an `is_mine` boolean)
- Where you are when you're not within reach of an agent in person

**The controls** (open **Location & privacy** from the top bar — the shield icon):

- **Discovery precision — Precise or Approximate.** Approximate keeps your exact position off the servers while you browse; nearby agents resolve a little less precisely in exchange. Placement is always exactly where you choose.
- **Appear to others nearby — off by default.** Turn it on to show as a coarse ghost to co-viewers.
- **Your placements — remove anytime.** Every pin is in your dashboard, visible only to you. Anonymous pins also expire on their own after 7 days.

The camera and motion sensors are processed entirely on-device — camera frames are drawn to your screen and never uploaded; gyroscope readings position the scene in real time and never leave the phone. Location is checked only against what's within a few dozen metres of you, never a wider window.

---

## Troubleshooting

### "This device can't run IRL AR"

IRL renders the scene with WebGL. If your browser lacks it, you'll see a designed unsupported-device state instead of a blank canvas. Reopen IRL in an up-to-date Chrome, Safari, or Edge.

### The camera won't start

- **Permission denied.** Camera AR needs the rear camera. Re-grant it from the one-tap recovery chip, or in the browser's site settings, then tap **Camera AR** again. IRL requires HTTPS — `getUserMedia` is blocked on insecure origins, so use the live `https://three.ws/irl` (not a plain `http://` dev server).
- **Another tab or app holds the camera.** Close anything else using the camera and retry — only one consumer can hold it at a time.

### The agent drifts or won't stay locked when I turn

This is the motion sensor. On iOS, IRL needs a one-time **Motion & Orientation** permission granted via a tap — accept it when prompted, or re-request it from the recovery chip. Without the gyroscope, the agent can't stay anchored as you rotate the phone.

### "Place on floor" button never appears

That button is the WebXR hit-test path, available only where the browser supports an `immersive-ar` session (Chrome on Android with ARCore). iOS Safari has no `immersive-ar`, so it stays on the **Pin here** gyro + GPS path — which works fine; you just don't get plane hit-testing. Desktop never shows it (no camera passthrough).

### Nobody's nearby / the radar is empty

With a tight discovery radius and no map, an empty view is the *common* first experience — it means "keep exploring," not "broken." Walk around, or be the first to pin at your spot. If the nearby badge turns amber, the proximity read was temporarily rate-limited or unreachable; it self-heals on the next cycle.

### My pin disappeared

Anonymous pins (placed without signing in) expire after 7 days by design — the **My pins** sheet shows a live countdown so you know when. Sign in before pinning to make it permanent.

---

## Recap

You placed a live 3D agent in your real environment with the [/irl](/irl) product:

- **Camera AR** opens the rear camera as a full-screen passthrough; the agent renders on top of your real room.
- **Joystick / WASD** walk the agent across the floor; drag to orbit.
- **Add object** taps simple 3D props onto the detected floor.
- **Pin here** anchors the agent at a real GPS spot — anonymous pins last 7 days, signed-in pins are permanent.
- **Discovery is proximity-only:** agents are found by being physically near them, never via a map, list, or feed. Identity is stripped; your camera and motion stay on-device; location is used only for nearby proximity.

This is fundamentally different from viewing a single model in AR. If you only need to orbit one 3D model in your room, that's [View in AR](/docs/tutorials/view-in-ar) instead.

### See also

- [IRL — open the product](/irl) — place your agent now
- [How location works on IRL](/irl-privacy) — the full privacy model, sensor-by-sensor
- [Tutorial: Place your 3D model in AR](/docs/tutorials/view-in-ar) — the single-model viewer (Quick Look / Scene Viewer / WebXR)
- [AR & WebXR reference](/docs/ar) — the underlying AR methods and programmatic API
- [Privacy policy](/legal/privacy) — how your data is handled platform-wide
