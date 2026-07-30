# Give your agent body language

By the end of this tutorial your agent will move on its own: nod when a model finishes loading, look down while it reads on-chain data, celebrate a settled payment, and dance when you ask it to. You will know which gesture fires when, how to swap any of them for a different clip, and how to drive one from your own code.

**Prerequisites:** a browser. The last two sections use an agent you own, which the first section shows you how to create, and a text editor for a few lines of JavaScript.

**Time:** about 12 minutes.

---

## What you're building

```
A skill runs  ──►  it declares a hint  ──►  the hint resolves to a slot
                                                     │
                          your override map ──────────┤
                                                     ▼
                                        the slot resolves to a clip
                                                     │
                                                     ▼
                                        the avatar plays it
```

Three names, one chain. Worth learning in this order, because each one only exists to keep the next one loose:

| | What it is | Example |
|---|---|---|
| **A clip** | A baked motion file. 112 of them ship with the platform | `av-offabean-dance`, `lookdown`, `wave` |
| **A slot** | A fixed name for an intention. Resolves to a clip, and you can re-point it | `dance`, `inspect`, `wave` |
| **A hint** | What a skill declares when it starts. Resolves to a slot | `gesture`, `inspect`, `gesture-magic` |

An agent never names a clip. It names a slot, or a skill names a hint, and the platform resolves the rest. That is what lets you hand one agent a different body language without touching a line of skill code.

---

## 1. See the whole vocabulary

Open **[three.ws/gestures](https://three.ws/gestures)**.

Every slot an agent can play is on that page, on a card with the clip it resolves to. Click one and it plays on a live avatar. Three things are worth noticing before you build anything:

- **`inspect` plays `lookdown`.** Nineteen skills declare that hint, every read-only lookup in the catalog. It is the gesture your agent will spend the most time in.
- **`bow` plays `sitclap`.** The one approximation in the vocabulary, marked `approx` on its card: no bow clip is baked yet, so it borrows a seated clap. Everything else plays a clip that means what the slot means.
- **The hint table underneath is generated from the shipped skills**, so the skill names next to each hint are the real ones, not an illustration.

Deep-link any slot to show someone: [three.ws/gestures?slot=celebrate](https://three.ws/gestures?slot=celebrate).

---

## 2. Create an agent and watch it move on its own

Go to **[three.ws/create](https://three.ws/create)**, give the agent a name and a body, and save. You now have a hosted agent at `three.ws/a/<your-agent>`.

Open it and watch the avatar while the page settles:

| What you do | What fires | What you see |
|---|---|---|
| Load the page | `_onLoadStart` | `think` slot: the avatar thinks while the model streams in |
| The model finishes | `_onLoadEnd` | `nod` slot: a nod of acknowledgement |
| Ask it something that runs a read-only skill | hint `inspect` | `lookdown`: it reads |
| Ask it to buy or launch something | hint `gesture` | `point`: a decisive hand gesture |
| A skill succeeds | celebration stimulus | the face brightens; a clean validation plays `celebrate` |
| A skill fails | concern stimulus | `concern`: the `defeated` clip, with a downward gaze |

None of that is scripted per agent. It comes from the slot vocabulary, so every agent on the platform has it from the moment it exists.

---

## 3. Swap one gesture for another

Your agent's personality lives partly in which clips it uses. A trading agent that celebrates with `av-headbang` reads differently from one that plays `celebrate`.

On [three.ws/gestures](https://three.ws/gestures), click the slot you want to change, pick a clip from the **Override this slot** dropdown, and copy the JSON. You will get exactly this shape:

```json
{
  "edits": {
    "animations": {
      "dance": "av-offabean-dance"
    }
  }
}
```

Paste the inner `animations` object into your agent's `meta.edits.animations` in the agent editor (**Edit → Advanced → meta**). Add as many slots as you like:

```json
{
  "edits": {
    "animations": {
      "dance": "av-offabean-dance",
      "celebrate": "av-cheering",
      "think": "av-smoking",
      "inspect": "av-spy"
    }
  }
}
```

Save, reload the agent page, and trigger the gesture. Anything not listed keeps the platform default, so an override map is only as long as the changes you want.

Any of the 112 clip names in [`/animations/manifest.json`](https://three.ws/animations/manifest.json) is valid. Browse them with previews at [three.ws/animations](https://three.ws/animations).

---

## 4. Drive a gesture from your own code

An embedded avatar takes clips directly. Add the web component to any page, and set the clip it starts on with the `clip` attribute:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>

<agent-3d
	body="https://three.ws/avatars/cz.glb"
	clip="idle"
	style="width: 360px; height: 480px; display: block"
></agent-3d>
```

Then play any clip whenever your own code wants one:

```html
<button id="celebrate">Celebrate</button>
<button id="dance">Dance</button>

<script type="module">
	const avatar = document.querySelector('agent-3d');

	// playClip() honours the clip's own loop flag: a loop clip loops, a one-shot
	// plays once and settles back into idle with no snap at the boundary.
	// userInitiated lets the motion run even under prefers-reduced-motion, which
	// is correct here because a click asked for it.
	document.getElementById('celebrate').addEventListener('click', () => {
		avatar.playClip('celebrate', { userInitiated: true });
	});
	document.getElementById('dance').addEventListener('click', () => {
		avatar.playClip('av-offabean-dance', { userInitiated: true });
	});

	// Shorthand for the most common one.
	document.querySelector('agent-3d').wave();
</script>
```

The full attribute and method surface is in the [embedding guide](/docs/embedding). The clip names are the same ones the slots resolve to, so a gesture you liked on the `/gestures` page works here by name.

---

## 5. Player-driven gestures on /walk

There is a second gesture library for avatars a person is driving rather than an agent: open [three.ws/walk](https://three.ws/walk), move with `WASD`, and press `1`-`8` for a gesture.

The difference that matters is the layer. `wave`, `point`, `nod` and `shrug` are **upper-body overlays**: the legs keep the walk cycle, so your avatar waves while it walks. `dance`, `sit`, `jog` and `celebrate` are **full-body**, so movement is suppressed until they end. Try waving while walking, then dancing while walking, and the distinction is obvious in one second.

---

## Where to go next

- **[three.ws/gestures](https://three.ws/gestures)** is the reference you will come back to: every slot, its clip, and the skills that fire it.
- **[Animation Studio](/pose)** if none of the 112 clips is the motion you want. Pose an avatar with FK/IK, keyframe a timeline, export the clip, and point a slot at it.
- **[docs/animations](/docs/animations)** for the developer reference: the clip pipeline, how to bake a new clip from an FBX, and how the slot and hint tables are held to the manifest by tests.
- **[The club stage](/club)** for what happens when a dance becomes a product: agents pay $0.001 USDC per performance, and the style they book is one of the same clips.
