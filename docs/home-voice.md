# The browser voice loop: wake word, barge-in, and a confirmation a "yeah" cannot satisfy

**Status:** shipped. Live at [`/voice/home`](https://three.ws/voice/home) and mountable on any
surface that wants it. **Last measured against the tree:** 2026-09-03.

Hands-free is the only interface that works when you are carrying groceries into a dark kitchen.
This is the part of [three.ws Home](./smart-home.md) that lets you say "turn the kitchen light
off" to a browser that is already open, and get the light and an answer without touching
anything.

It is deliberately not a satellite. Being a Home Assistant Wyoming satellite is a separate
surface with a separate protocol; this is the loop that runs in a tab, on a laptop, a tablet in
the hall, or a wall display.

---

## The pipeline

```
mic ─▶ silero VAD ─▶ openWakeWord ─▶ capture ─▶ /api/asr
    ─▶ agent turn (/api/chat, with the home tools)
    ─▶ /api/tts/speak ─▶ playback ─▶ LipsyncDriver ─▶ the 3D agent speaks
```

One microphone opens, and one only. The voice-activity detector, the wake word and the utterance
capture all read the same `MediaStream`, because three `getUserMedia` calls would mean three
things to remember to stop, and mute has to stop everything that exists.

| Piece | Where | What it is |
|---|---|---|
| Voice activity and endpointing | [`src/voice/vad.js`](../src/voice/vad.js) | [silero-vad](https://github.com/snakers4/silero-vad) (MIT) through `@ricky0123/vad-web`, v5, 512-sample frames at 16 kHz |
| Wake word | [`src/voice/wake-word.js`](../src/voice/wake-word.js) | [openWakeWord](https://github.com/dscripka/openWakeWord) v0.5.1 (Apache-2.0) run on onnxruntime-web |
| The catalog of phrases | [`src/voice/wake-words.js`](../src/voice/wake-words.js) | Four pre-trained phrases, and why each one |
| The loop and its twelve states | [`src/voice/home-voice.js`](../src/voice/home-voice.js) | Consent, capture, barge-in, the confirmation grammar, the latency instrumentation |
| The panel | [`src/voice/home-voice-ui.js`](../src/voice/home-voice-ui.js) | The indicator, mute, the confirmation card |
| The proof | [`scripts/check-home-voice.mjs`](../scripts/check-home-voice.mjs) | A real Chromium, a real microphone stream, the real speech lanes |

We wrote no detector and trained no model. Both models are permissively licensed, both run on the
listener's own machine, and both are served from three.ws itself rather than a CDN: on an
always-on microphone feature, a third-party fetch on the audio path would put a stranger's server
in the room.

---

## What leaves your device, and what does not

This is the part that decides whether anyone trusts the feature, so it is stated before anything
else.

- **Always-on listening is off by default.** Opting in is explicit, and the panel explains what
  is processed locally and what is uploaded before it asks.
- **The wake word never leaves the device.** The melspectrogram, the embedding and the
  classifier all run in your tab, over ring buffers holding under two seconds of audio that is
  continuously overwritten.
- **Only the utterance after the wake word is uploaded**, and only to be transcribed.
- **Nothing is retained.** `/api/asr` holds the clip for the request and no longer. Retention of
  anything else is covered by [Home privacy and retention](./home-privacy.md); this loop creates
  no data class of its own.
- **The indicator cannot be turned off.** Whenever a microphone track is live, the panel shows
  it, and the indicator reads the `MediaStreamTrack`, not a flag the state machine could get
  wrong.
- **Mute stops capture at the device.** It calls `track.stop()`, so `track.readyState` reads
  `ended` and the browser's own recording indicator goes out. Unmuting acquires a new track,
  because a stopped one cannot be restarted.

Turning it off in the panel revokes the consent record as well, so the next visit starts from
off.

---

## The confirmation, and why a general "yes" does not count

Home Assistant's own `HassTurnOff` intent performs an **unlock** on a lock. That single fact is
why [the gate](./home-security.md) exists, and it is why this loop treats a spoken confirmation
as the most dangerous thing it does.

When a turn produces a guarded action, the server mints a confirmation and the loop:

1. **Speaks the whole action** before asking anything: "This will unlock the Front Door. Say
   confirm to continue, or cancel to leave it alone." Never "OK?", and never a yes/no about an
   action that was not named.
2. **Shows the entity on screen** while the confirmation is open, by friendly name and by entity
   id, with the time left running down.
3. **Accepts one narrow token.** `confirm`, `confirm it`, `confirm that`, `yes confirm` and their
   nearest relatives. `yes`, `yeah`, `sure`, `ok`, `go ahead`, `absolutely` and every other
   general affirmative are refused by name, because a general affirmative is exactly what a
   recognizer produces from somebody else's conversation in the same room.
4. **Refuses the token buried in a sentence.** "Can you confirm the kitchen light is off" does
   not unlock anything.
5. **Redeems by id alone.** `POST /api/home/:id/confirm` with `{ confirmation_id }` and a CSRF
   token, from a signed-in session. The action was frozen server-side when the confirmation was
   minted, so a confirmation for one lock cannot be pointed at another, and there is no field
   the client could send that would set `confirmed`.
6. **Refuses outright on a device with no screen.** A screenless surface is told so and offered
   the phone instead. Speech recognition is not reliable enough to be the only gate on a door,
   and that sentence is in the code next to the refusal.

An utterance that is neither the token nor a cancellation closes the confirmation and is treated
as the new request it looks like. That direction is the safe one: the worst case is that the user
has to ask again.

---

## The wake word

Four pre-trained phrases ship, and the user picks one:

| Phrase | Why you would choose it |
|---|---|
| Hey Jarvis | The default. Two syllables and an uncommon name, so it survives a noisy kitchen best. |
| Hey Mycroft | The Mycroft project phrase. Rare enough in conversation to seldom misfire. |
| Alexa | Only if no Echo is in earshot: it will wake both. |
| Hey Rhasspy | The Rhasspy phrase, and the smallest model of the four. |

We offer a choice among phrases that already exist rather than training one of our own. A custom
phrase trained on synthetic speech would be measurably worse than these, and on an always-on
microphone the user pays for that in false wakes.

**The agent cannot wake itself.** While it is speaking, detection is suppressed outright: a
perfect score changes nothing, and the ring buffers are cleared when the guard lifts so the tail
of its own sentence cannot score afterwards. Verified with the agent saying its own wake word at
a score of 0.99 and waking zero times.

**A pause is not an ending.** People say "Hey Jarvis" and then pause before the command. A
segment that closes is held open for another 450 ms, and speech inside that window continues the
same utterance instead of starting a new one. Transcription of what was heard so far starts
immediately, so the pause costs a spare call to a free lane and never costs the user their
sentence.

---

## The latency budget

Every leg is measured live in the panel while you use it. These are the numbers from
`scripts/check-home-voice.mjs` running against the production speech lanes from a Codespace, which
is a worse network position than a real user's:

| Leg | Budget | Measured | Note |
|---|---|---|---|
| Wake word detection | 200 ms | 8 to 16 ms | Inference only. The model needs about 140 ms of audio context past the end of the word before it crosses threshold, measured offline. |
| End of speech | 400 ms | 343 to 369 ms | 11 silero frames of trailing silence, plus the frame the decision is made on. |
| Transcription round trip | 900 ms | 684 to 1810 ms | Misses from here. The path is Codespace to Cloud Run to NVIDIA Riva; a browser near the region is materially closer. |
| Agent turn to first tool call | 1200 ms | measured live, varies by provider | The `home_tool` frame arrives ahead of the model's closing sentence. |
| Action to device change | 700 ms | needs a connected house | Mostly Home Assistant's own latency. |
| Playback stops after you interrupt | 200 ms | 104 to 125 ms | Four consecutive frames above a high speech probability. |

The transcription leg is the one that misses, and the number above is the real one. It is not
widened here to make the table green.

---

## Barge-in

Playback and capture run together, the VAD runs during playback, and speech cuts the agent off:
the audio stops, whatever synthesis is still in flight is aborted, and the interrupting utterance
becomes the next request without needing a second wake word.

Interruption needs four consecutive frames (128 ms) above a high speech probability, not one
frame at the idle threshold. One frame would fire on the agent's own voice leaking past echo
cancellation on a laptop speaker at volume, and an agent that interrupts itself is worse than one
that cannot be interrupted. Echo cancellation, noise suppression and automatic gain control are
all requested on the capture stream.

---

## The twelve states

Every one is designed, and the gallery at the bottom of [`/voice/home`](https://three.ws/voice/home)
renders all of them as real panels.

| State | What it means |
|---|---|
| `off` | The default. Listening has never been turned on. |
| `permission-pending` | The browser is asking, and the user has not answered. |
| `permission-denied` | Refused. The panel names the actual control to change, per browser, and offers a retry. |
| `idle` | Live, listening for the wake word, uploading nothing. |
| `capturing` | Woken, capturing one utterance. |
| `thinking` | Transcribed, and the agent is deciding. |
| `speaking` | Answering, with barge-in armed. |
| `barged-in` | The user interrupted and playback was cut. |
| `confirm-pending` | A guarded action is waiting for the spoken token. |
| `unavailable` | Speech recognition is not configured in this deployment. The loop says so and never pretends to listen. |
| `muted` | Capture is stopped at the track. |
| `error` | Something failed in a way the user has to know about, with a way back. |

---

## Using it on your own surface

The loop never touches the DOM, so a host renders it however it wants. `/home/:id` mounts the same
component over the live 3D house.

```js
import { HomeVoiceLoop } from '/src/voice/home-voice.js';
import { HomeVoicePanel } from '/src/voice/home-voice-ui.js';

const loop = new HomeVoiceLoop({
  homeId: '<your home connection id>',   // optional: without one, the loop still runs
  surface: 'display',                     // 'screenless' refuses guarded actions outright
  mouthTarget,                            // optional: drives an avatar's mouth from the reply
  onLatency: (leg, ms) => console.log(leg, ms),
});

new HomeVoicePanel({ mount: document.getElementById('voice'), loop });

// Nothing about listening is downloaded until this pair runs.
await loop.probeAsr();     // safe before consent: uploads nothing, opens no microphone
```

The panel owns the opt-in, so a host that mounts it does not have to build the consent flow.
A host that wants its own UI calls `loop.grantConsent()` and `loop.enable()` itself, and must
render the indicator and a mute control: `loop.micLive` and `loop.trackStates()` are the honest
sources, and `loop.mute()` really stops the tracks.

Both stylesheets the panel needs are one file: `<link rel="stylesheet" href="/home-voice.css">`.

---

## Running the proof

```bash
npx vite --port 3457                       # /api proxies to production
node scripts/check-home-voice.mjs --port 3457
```

Thirty-four assertions across ten scenarios, in a real Chromium with a real microphone stream fed
from speech the platform's own TTS lane synthesized. It writes the measured legs and a frame of
each of the twelve states to `.cache/home-voice/`. Add `--headed` to watch it.

Set `AUDIT_EMAIL` and `AUDIT_PASSWORD` (the QA account already in `.env`) to run against the
signed-in rate limits rather than the tighter anonymous ones.

The unit tests cover the parts that must not be wrong without a browser:

```bash
npx vitest run tests/home-voice.test.js
```

---

## Where the models come from

`public/models/voice/wake-word/` holds six committed ONNX files from the openWakeWord v0.5.1
release: the shared melspectrogram and embedding stages, plus one classifier per phrase. They are
committed as bytes rather than downloaded during a build, because a build that reaches out to
GitHub is a build that fails when GitHub does.

`public/models/voice/runtime/` is staged from `node_modules` by
[`scripts/copy-voice-models.mjs`](../scripts/copy-voice-models.mjs) on every install and every
build, exactly the way the Draco decoders are. It holds the silero model, its AudioWorklet, and
the onnxruntime-web wasm. It is gitignored: the lockfile pins those versions, so committing them
would only let the two drift.

---

## Related

- [three.ws Home](./smart-home.md): the whole plan, and what a connection is
- [Home security](./home-security.md): the gate this loop speaks for
- [Home privacy and retention](./home-privacy.md): what is stored and for how long
- [Households](./home-households.md): who in a house may approve an unlock
- [three.ws Drive](./carplay.md): the same agent, voice-first, in a car
