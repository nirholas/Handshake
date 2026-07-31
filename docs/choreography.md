# Choreography

A three.ws agent already reacts on its own: it thinks while a skill runs, nods when a model loads, celebrates a settled payment. Those are single beats, each one a **gesture slot** resolved to a clip ([Animations](animations.md) is the reference for that layer).

A **routine** is the next thing up: a named, timed sequence of those gestures, authored once and replayed on demand. Wave, then nod, then settle into idle. Inspect, think, point, present. It is the difference between an agent that twitches in response to events and one that performs.

Compose one at **[three.ws/choreograph](https://three.ws/choreograph)**. This page is the developer reference: the shape of a routine, where it is stored, how it travels, and every way to play one.

- Build and preview: [/choreograph](https://three.ws/choreograph)
- The gesture vocabulary a routine is built from: [/gestures](https://three.ws/gestures)
- Every clip a step can point at: [/animations](https://three.ws/animations)

---

## What a routine is

```json
{
  "id": "welcome",
  "name": "Welcome",
  "loop": false,
  "steps": [
    { "slot": "wave", "clip": null, "hold": 2, "speed": 1 },
    { "slot": "nod", "clip": null, "hold": 1.2, "speed": 1 },
    { "slot": "idle", "clip": null, "hold": 1.6, "speed": 1 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Slug derived from `name` unless you set it. This is the key `playRoutine('welcome')` looks up. Unique per agent. |
| `name` | Display name, up to 40 characters. |
| `loop` | `true` restarts the routine instead of ending it. Use it for waiting states, not greetings. |
| `steps` | 1 to 24 beats, played back to back in order. |
| `steps[].slot` | One of the 19 gesture slots ([the vocabulary](animations.md#agent-slots)). Required. |
| `steps[].clip` | Optional. Pins this step to one specific clip instead of letting the slot resolve. `null` is the normal case. |
| `steps[].hold` | How long the beat occupies the timeline, 0.2 to 20 seconds. Defaults to 1.6. |
| `steps[].speed` | Playback rate, 0.25 to 3. A step at `2` occupies half its `hold` on the timeline. |

Everything is validated by one module, [`src/runtime/choreography.js`](../src/runtime/choreography.js), which the studio, the API and the avatar runtime all import. There is no second definition anywhere, so a routine the browser can build is exactly a routine the server will store and the avatar will play.

### Why steps name slots, not clips

A step says `wave`, not `wave.json`. The slot resolves at playback time, in this order:

1. the step's own `clip`, if it pins one
2. the performing agent's slot bindings (`meta.edits.animations`, editable on [/gestures](https://three.ws/gestures))
3. the platform default for that slot

That ordering is the whole point of the format. Share a routine with someone whose agent has remapped `dance` to its own clip and the routine still reads correctly on their agent, in their agent's body language. Pin a clip only when the specific motion *is* the intent.

---

## Storing a routine on an agent

Routines live at `meta.choreographies` on the agent record. Write them with the animations endpoint:

```bash
curl -X PUT https://three.ws/api/agents/$AGENT_ID/animations \
  -H "authorization: Bearer $THREE_WS_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "choreographies": [
      {
        "name": "Welcome",
        "steps": [
          { "slot": "wave", "hold": 2 },
          { "slot": "nod", "hold": 1.2 },
          { "slot": "idle", "hold": 1.6 }
        ]
      }
    ]
  }'
```

```json
{
  "animations": [],
  "animationGraph": null,
  "animationSlots": null,
  "choreographies": [
    {
      "id": "welcome",
      "name": "Welcome",
      "loop": false,
      "steps": [
        { "slot": "wave", "clip": null, "hold": 2, "speed": 1 },
        { "slot": "nod", "clip": null, "hold": 1.2, "speed": 1 },
        { "slot": "idle", "clip": null, "hold": 1.6, "speed": 1 }
      ]
    }
  ]
}
```

Rules worth knowing before you call it:

- **The field is a full replacement.** Send the whole list you want the agent to end up with. To add one routine, read the existing list, merge on `id`, send the result. The studio does exactly this.
- **Omitting the field changes nothing.** Every field on this endpoint is independent: saving `animationSlots` alone never touches your routines, and vice versa.
- **`"choreographies": []` clears them.**
- **The response is read back from the row**, not echoed from your request, so it is the truth about what is stored.
- **Limits:** 12 routines per agent, 24 steps per routine, unique ids. A violation is a `400 validation_error` naming the problem, never a silent truncation.
- **Owner only.** Session cookie (with CSRF) or a bearer token belonging to the agent's owner.

---

## Playing a routine

### From an embed

Any page already rendering an [`<agent-3d>`](embedding.md) element can perform the agent's saved routines by name:

```html
<agent-3d agent="YOUR_AGENT_ID"></agent-3d>

<script type="module">
  const el = document.querySelector('agent-3d');
  el.playRoutine('welcome');
</script>
```

`playRoutine()` accepts either an id (or display name) of a saved routine, or a literal routine object your page owns:

```js
el.playRoutine({
  name: 'Thinking it over',
  steps: [
    { slot: 'think', hold: 2.4 },
    { slot: 'point', hold: 1.2 },
    { slot: 'present', hold: 2.4 },
  ],
});
```

| Method | Behavior |
| --- | --- |
| `playRoutine(idOrRoutine, { loop })` | Performs it. Returns `false` when a named routine does not exist. Safe to call before the avatar has booted: the call is queued and lands on mount. |
| `stopRoutine()` | Ends the performance. The current gesture reverts to idle as usual. |
| `getRoutines()` | The agent's saved routines, normalized. |

A performing routine outranks the avatar's autonomous reflexes: an emotion spike that would normally fire `celebrate` on its own waits until the routine finishes rather than cutting into it. That gate is what makes an authored performance survive a busy agent.

### Reacting to real events

The routine is the vocabulary; your page decides when it speaks. A trading surface might do:

```js
const el = document.querySelector('agent-3d');

source.addEventListener('fill', () => el.playRoutine('shipped-it'));
source.addEventListener('error', () => el.playRoutine('bad-news'));
source.addEventListener('pending', () => el.playRoutine('waiting', { loop: true }));
```

`loop: true` on a waiting routine is the honest version of a spinner: the agent stays alive on screen for as long as the work takes, without pretending to progress.

### In your own renderer

If you drive an avatar directly rather than through the embed, the same engine is importable. It owns sequencing and timing and nothing else, so it composes with whatever loop you already run:

```js
import { RoutinePlayer } from '@three-ws/avatar/runtime/choreography.js';

const player = new RoutinePlayer(routine, {
  onStep: (step) => avatar.playSlot(step.slot, step.hold / step.speed, step.clip),
  onEnd: () => console.log('done'),
});

player.start();
// then, from your animation loop:
player.update(deltaSeconds);
```

| Member | Behavior |
| --- | --- |
| `start()` | Restarts from the top and fires the first step immediately. |
| `update(dt)` | Advances by `dt` seconds. A large `dt` (a backgrounded tab) catches up rather than replaying every intervening step. |
| `seek(t)` | Moves the playhead and re-fires the step it lands on. This is what the studio's timeline scrubber calls. |
| `pause()` / `resume()` / `stop()` | Transport. `update()` is a no-op while paused, so you can call it unconditionally. |
| `time`, `index`, `playing`, `duration` | Read-only state for a progress bar or a playhead. |

---

## Sharing a routine without an account

Routines round-trip through the URL, so a link is the routine. The studio keeps `?r=` in sync as you edit:

```
https://three.ws/choreograph?r=Welcome%7Cwave%3A2%2Cnod%3A1.2%2Cidle%3A1.6
```

The encoding is deliberately legible rather than base64, so you can read a link before you click it and hand-write one when that is easier:

```
Name|slot:hold[*speed][@clip],slot:hold,…
```

- `Welcome|wave:2,nod:1.2` gives two beats
- `Slow%20clap|celebrate:3*0.5` plays at half speed
- `Encore|dance:4@rumba` pins a specific clip
- `Waiting~loop|patience:3,fidget:2.4` sets `loop` via the `~loop` suffix on the name

`encodeRoutine()` and `decodeRoutine()` in the runtime module are the canonical implementations. A malformed link throws with the reason rather than dropping steps quietly, and the studio shows that reason instead of silently loading something else.

---

## The studio

[/choreograph](https://three.ws/choreograph) is the authoring surface. Worth knowing:

- **It opens on a real routine**, not an empty timeline. Five presets cover the common performances (welcome, pitch, shipped it, bad news, long wait).
- **The timeline is real time.** Segment width is the beat's actual duration, so a long step looks long. Click to jump to a beat, drag to scrub, and the 3D stage follows the playhead.
- **Steps crossfade** on the preview stage, and the camera frames the union of every clip in the routine once, rather than re-framing at each cut. What you preview is what the embed performs.
- **Reordering works without a pointer.** Drag the grip, or use the ↑/↓ button on any row.
- **Keyboard:** <kbd>Space</kbd> play/pause, <kbd>R</kbd> restart, <kbd>←</kbd>/<kbd>→</kbd> scrub, <kbd>Esc</kbd> stop.
- **Nothing 3D loads until you press play.** The page paints without a WebGL context.
- **Signed out, everything except saving works**: composing, previewing, sharing the link.

Coming from [/gestures](https://three.ws/gestures), the **Use in a routine** button carries the gesture you have staged (and its clip, if you overrode one) straight into the studio as a one-step routine.

---

## Where each piece lives

| Piece | File |
| --- | --- |
| Format, validation, wire format, timing engine | [`src/runtime/choreography.js`](../src/runtime/choreography.js) |
| Studio page | [`pages/choreograph.html`](../pages/choreograph.html), [`src/choreograph-page.js`](../src/choreograph-page.js) |
| Storage + validation at the boundary | [`api/agents/_id/_sub.js`](../api/agents/_id/_sub.js) (`handleAnimations`) |
| Public manifest field | `api/agents/_id/_sub.js` (`handleManifest`) |
| Playback on the avatar | [`src/agent-avatar.js`](../src/agent-avatar.js) (`playChoreography`) |
| Embed API | [`src/element.js`](../src/element.js) (`playRoutine`) |
| Tests | [`tests/choreography.test.js`](../tests/choreography.test.js), [`tests/agent-avatar-choreography.test.js`](../tests/agent-avatar-choreography.test.js), [`tests/agent-choreography-wiring.test.js`](../tests/agent-choreography-wiring.test.js) |

## Related

- [Animations](animations.md): clips, collections, and the slot vocabulary underneath every routine
- [Procedural animation](procedural-animation.md): the IK layers that run on top of whatever clip is playing
- [Agent manifest](agent-manifest.md): the public document that carries `choreographies` to embeds
- [Embedding an agent](embedding.md): the `<agent-3d>` element these methods live on
