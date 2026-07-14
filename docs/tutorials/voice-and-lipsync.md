# Give your agent a voice with synchronized lipsync

By the end of this tutorial your agent will **speak out loud** with a mouth that moves in time with the words — a real voice, real audio, and real-time viseme animation, all rendered in the browser. You'll pick or clone a voice in the [Voice Lab](/voice), see exactly how visemes drive an avatar's mouth in the two [/lipsync](/lipsync) labs, then wire voice into a live agent.

Along the way you'll understand why three.ws extracts visemes from the audio itself (no per-word timing service), how the same pipeline handles both TTS playback and a raw microphone, and what happens on avatars that have no viseme morphs at all.

**Prerequisites:** a three.ws account with at least one agent ([create one](/create)), a browser with Web Audio + WebGL (any modern desktop browser), and a microphone if you want to clone a voice or try the mic lab. No code is required for the labs; the live-agent step assumes light JavaScript familiarity.

---

## What you're building

```
Agent generates a reply
        ↓   POST /api/tts/speak  (or /api/tts/eleven for a cloned voice)
Audio plays through a Web Audio AnalyserNode
        ↓   LipSyncAnalyser samples the frequency spectrum every frame
Per-viseme weights → avatar morph targets
        ↓
The avatar's mouth animates in sync with the speech — frame by frame, in WebGL
```

The mouth is not driven by a script or a timing file. The avatar listens to its own audio and shapes its mouth from what it hears, so any voice — a built-in one, a cloned one, even a live mic — drives the same animation path.

This tutorial covers the full chain: **choose a voice → understand visemes → wire voice into a live agent.**

---

## How lipsync works (two minutes of theory)

A **viseme** is the visual shape a mouth makes for a sound — the open jaw of "aa", the lip-press of "PP", the teeth-and-tongue of "SS". On a 3D avatar each viseme is a **morph target** (a blendshape) you can dial from 0 to 1.

three.ws uses the Oculus/ARKit viseme naming. The analyser ([`src/lip-sync-analyser.js`](../../src/lip-sync-analyser.js)) drives nine of them:

```js
export const VISEMES = [
  'viseme_aa', 'viseme_O', 'viseme_E', 'viseme_I', 'viseme_nn',
  'viseme_SS', 'viseme_FF', 'viseme_CH', 'viseme_PP',
];
```

Rather than rely on a server returning phoneme timestamps, the analyser reads the **audio's frequency spectrum** in real time through a Web Audio `AnalyserNode` and maps energy bands to mouth shapes:

| Frequency band | Drives | Why |
|---|---|---|
| Low (0–500 Hz) | `viseme_aa`, `viseme_O` | open vowels carry low-frequency energy |
| Mid (500–2k Hz) | `viseme_E`, `viseme_I`, `viseme_nn` | mid vowels and nasals |
| High (2k–8k Hz) | `viseme_SS`, `viseme_FF`, `viseme_CH` | sibilants and fricatives are bright |
| Amplitude dip | `viseme_PP` | a bilabial closure is a momentary silence |

Weights are smoothed with an exponential moving average so the mouth eases between shapes instead of snapping, and everything drops toward zero when the audio falls below a silence threshold. Because it's pure spectral analysis, **the audio never leaves the browser** and there's no per-word timing data to fetch or fall out of sync.

One important fallback: not every avatar has viseme morphs. The runtime detects this per avatar and picks a mode — `visemes` when ARKit viseme morphs exist, `jaw` when only `jawOpen` exists (it drives the jaw straight from the smoothed amplitude via `getAmplitude()`), and `none` when the rig has no mouth morphs at all. A face without visemes still opens and closes its jaw to the voice rather than sitting frozen.

---

## Step 1: Choose a built-in voice

The fastest path to a talking agent is a built-in TTS voice. The catalog lives in one place ([`api/_lib/tts-voices.js`](../../api/_lib/tts-voices.js)) so every picker and the synthesizer agree on what exists:

| id | character |
|---|---|
| `nova` | Bright and energetic — the default companion voice |
| `alloy` | Neutral and balanced |
| `ash` | Warm and expressive |
| `ballad` | Soft and lyrical |
| `coral` | Friendly and upbeat |
| `echo` | Calm and measured |
| `fable` | Expressive storyteller |
| `onyx` | Deep and authoritative |
| `sage` | Gentle and thoughtful |
| `shimmer` | Light and airy |
| `verse` | Dynamic and conversational |

The default is `nova`. These are synthesized by `POST /api/tts/speak` ([`api/tts/speak.js`](../../api/tts/speak.js)), which tries the free NVIDIA NIM Magpie lane first and falls back to the OpenAI `/v1/audio/speech` endpoint. You don't choose the provider — you choose the voice id, and the endpoint renders it on whichever lane is configured.

You can hear all of these immediately in the next step.

---

## Step 2: Hear visemes drive the mouth (TTS lab)

Open the **TTS-driven lipsync** lab at [/lipsync](/lipsync). This is the clearest way to see the whole pipeline at once.

1. Type a sentence in **Text to speak**.
2. Pick a **Voice** (`nova`, `alloy`, `echo`, `fable`, `onyx`, `shimmer`, `ash`, `coral`, or `sage`) and a **Speed** (0.8×, 1.0×, 1.2×, or 1.5×).
3. Click **Speak**.

What happens under the hood:

- The page `POST`s `{ text, voice, speed, format: 'mp3' }` to `/api/tts/speak` and gets back an audio clip.
- The clip plays through an `<audio>` element, and the [`wawa-lipsync`](https://www.npmjs.com/package/wawa-lipsync) library analyses it frame by frame, emitting a viseme code each tick.
- The page maps that code onto the avatar's Oculus-named morph targets:

```js
const VISEME_MAP = {
  aa: 'viseme_aa',  PP: 'viseme_PP',  FF: 'viseme_FF',
  TH: 'viseme_E',   DD: 'viseme_E',   kk: 'viseme_E',
  CH: 'viseme_CH',  SS: 'viseme_SS',  nn: 'viseme_nn',
  RR: 'viseme_O',   ou: 'viseme_O',   sil: null,
};
```

The **Visemes (live)** panel on the right shows which morph is firing each instant, and the log reports how many viseme morphs were wired on the loaded avatar (`N/N viseme morphs wired`). Watch the bars light up as the avatar talks — that's the morph target system being driven in real time.

> The TTS lab uses `wawa-lipsync`, which emits a discrete viseme code per frame. The live agent and the mic lab use the platform's own `LipSyncAnalyser`, which blends weighted bands. Both end at the same place — viseme morph targets — but the spectral analyser produces softer, overlapping shapes.

---

## Step 3: Verify the analyser with your own voice (mic lab)

To see the **exact analyser** that powers live agent speech, open the **audio-driven lipsync** lab at [/lipsync/mic](/lipsync/mic) and feed it your microphone instead of TTS.

1. Click **Start mic** and allow microphone access.
2. Speak. The nine-bar meter and the per-viseme readout update every frame, and the avatar's mouth tracks your voice.
3. Click **Stop** to release the mic and reset the morphs to zero.

This page wires the real pipeline directly:

- `getUserMedia({ audio: true })` → an `AudioContext` with an `AnalyserNode` (`fftSize = 256`, `smoothingTimeConstant = 0.7`).
- A `LipSyncAnalyser` ([`src/lip-sync-analyser.js`](../../src/lip-sync-analyser.js)) reads that node. Each frame it calls `analyser.sample()`, which returns the nine viseme weights, and applies them straight to the avatar: `mesh.morphTargetInfluences[index] = weight`.
- The mic node is deliberately **not** connected to the speakers, so you don't hear yourself echo.

Your audio never leaves the browser — analysis is `AnalyserNode` + `requestAnimationFrame`, nothing more. This is the same `LipSyncAnalyser` the live chat connects to its TTS output, so whatever mouth shapes you see here are what your agents will produce.

---

## Step 4: Clone your own voice (optional)

If you want your agent to speak in *your* voice instead of a built-in one, use the [Voice Lab](/voice). Cloning runs through ElevenLabs Instant Voice Cloning.

1. Open [/voice](/voice).
2. Read one of the suggested scripts aloud (or speak naturally) while recording. **20–30 seconds** is the recommended length; recording auto-stops at 60 seconds, and anything under 3 seconds is rejected. A live waveform and level meter show your input as you go.
3. Stop, then **review** the playback.
4. Give the voice a **name** (1–64 characters) and click **Clone**. The page uploads the sample to `POST /api/tts/eleven-clone` ([`api/tts/eleven-clone.js`](../../api/tts/eleven-clone.js)) as `multipart/form-data`.
5. On success you get a `voice_id`, and the voice is saved to your library (stored in `localStorage`, up to 20 voices).

**Test it in the playground.** Pick the cloned voice, type a sample line, and click Speak. The playground calls `POST /api/tts/eleven` ([`api/tts/eleven.js`](../../api/tts/eleven.js)) with `{ voiceId, text }`, which proxies ElevenLabs and caches the clip for 30 days (the hint shows `cached` vs `generated`). Default model is `eleven_flash_v2_5`; requests are capped at 500 characters and rate-limited to 1000 characters per hour per user.

> Instant Voice Cloning is a **paid-tier ElevenLabs feature** (Starter and up). If the server's account is on the free tier, the clone call returns the upstream error verbatim in the status line (e.g. a `can_not_use_instant_voice_cloning` message). Built-in voices in Step 1 have no such requirement.

Note the `voice_id` — you'll use it to give an agent the cloned voice in the next step.

---

## Step 5: Wire voice into a live agent

Now connect a voice to an agent so it speaks during conversation, with the mouth driven automatically.

The agent runtime ships two TTS providers that expose a shared `analyserNode`: `ElevenLabsTTS` ([`src/runtime/speech.js`](../../src/runtime/speech.js)) for cloned/ElevenLabs voices, and a neural TTS provider ([`src/runtime/neural-tts.js`](../../src/runtime/neural-tts.js)) that speaks the built-in catalog through `/api/tts/speak`. Whichever one an agent uses, the avatar wiring is identical.

The connection happens through two hooks the runtime sets on the TTS instance (see [`src/app.js`](../../src/app.js) and [`src/element.js`](../../src/element.js)):

```js
tts.onStart = () => {
  // Connect the avatar's LipSyncAnalyser to the TTS audio the moment it plays.
  if (tts.analyserNode) avatar.connectLipSync(tts.analyserNode);
};
tts.onEnd = () => {
  // Tear down lipsync so the mouth lerps back to neutral when speech ends.
  avatar.disconnectLipSync();
};
```

`connectLipSync(audioSource)` ([`src/agent-avatar.js`](../../src/agent-avatar.js)) builds a fresh `LipSyncAnalyser` on the TTS `AnalyserNode`; every render frame the avatar samples it and writes viseme weights (or, on a viseme-less rig, drives `jawOpen` from the amplitude). `disconnectLipSync()` zeroes the viseme and `jawOpen`/`mouthOpen` morphs so the face eases back to rest instead of freezing on the last shape mid-word.

For a cloned voice, construct the ElevenLabs provider with the `voice_id` from Step 4:

```js
import { ElevenLabsTTS } from './runtime/speech.js';

const tts = new ElevenLabsTTS({
  voiceId: 'your-cloned-voice-id',     // from /api/tts/eleven-clone
  modelId: 'eleven_flash_v2_5',        // default
  proxyURL: '/api/tts/eleven',         // keeps the API key server-side
  stability: 0.5,
  similarityBoost: 0.75,
  useSpeakerBoost: true,
});
```

When the agent speaks, `tts.speak(text)` plays the clip; `onStart` fires on the audio's `playing` event and wires lipsync; `onEnd` tears it down. You don't touch morph targets yourself — binding the provider is enough.

---

## Step 6: Spatial audio (optional polish)

If your agent lives in a 3D scene rather than a flat panel, route its voice through a positional audio source so the sound comes from where the avatar stands. `AgentAvatar.setTTS(tts)` ([`src/agent-avatar.js`](../../src/agent-avatar.js)) binds the provider, and when a `THREE.PositionalAudio` is attached it forwards it to `ElevenLabsTTS.setPositionalAudio()`. The voice then attenuates with distance and pans with the avatar's position — the groundwork the [real-time voice preview](/blog/real-time-voice-interaction) describes for headset/WebXR deployment, where the agent's voice should come from the avatar in space.

This is opt-in: a flat embed plays voice normally without it.

---

## Troubleshooting

- **No sound, `503 not_configured` from `/api/tts/speak`** — no TTS provider is set on the server (neither `NVIDIA_API_KEY` nor `OPENAI_API_KEY`). Built-in voices need at least one lane configured.
- **`429` / "TTS rate limit exceeded"** — `/api/tts/speak` budgets per user (or per IP when anonymous), and `/api/tts/eleven` caps at 1000 characters/hour per user. Sign in for the higher limit, or wait for the hourly bucket to reset.
- **Clone fails with a quota / verification message** — Instant Voice Cloning is an ElevenLabs paid-tier feature. The endpoint passes the upstream body through so you see the exact reason (e.g. `can_not_use_instant_voice_cloning`). Use a built-in voice instead, or upgrade the ElevenLabs plan.
- **Clone rejected as too short** — the recorder requires at least 3 seconds; aim for the recommended 20–30 seconds for a usable clone.
- **Mic lab does nothing / "Microphone blocked"** — mic capture needs a secure (https) context and granted permission. The lab maps each failure to a designed state: blocked (allow access in the address bar), no device found, or mic busy (another app is using it). Fix and click **Try again**.
- **Avatar talks but the mouth doesn't move** — the loaded avatar has no viseme morphs. Check the TTS lab's log for `0/9 viseme morphs wired`. The runtime falls back to `jawOpen` if that morph exists, and to no mouth motion if the rig has none. Use an ARKit/Oculus-blendshaped avatar for full visemes.
- **Mouth freezes open after speech ends** — lipsync wasn't torn down. The runtime calls `disconnectLipSync()` from `tts.onEnd`; if you wire TTS manually, make sure that hook is set.
- **Cloned voice in the playground says `generated` every time** — the R2 cache keys on `voiceId + text + modelId + voice_settings`. Identical requests return `cached`; any change to text or settings is a fresh synthesis.

---

## Recap

You gave an agent a synchronized voice end to end:

- **Choose a voice** — eleven built-in voices in [`api/_lib/tts-voices.js`](../../api/_lib/tts-voices.js), synthesized by `POST /api/tts/speak` (free NVIDIA lane, OpenAI backstop), default `nova`.
- **Clone a voice** — record in the [Voice Lab](/voice), clone via `/api/tts/eleven-clone` (ElevenLabs IVC), play back via `/api/tts/eleven` with a 30-day cache.
- **Understand visemes** — the [TTS lab](/lipsync) and [mic lab](/lipsync/mic) show nine viseme morphs driven from the audio spectrum by [`src/lip-sync-analyser.js`](../../src/lip-sync-analyser.js) — no per-word timing, all in-browser.
- **Wire it live** — a runtime TTS provider exposes an `analyserNode`; `tts.onStart` calls `avatar.connectLipSync()` and `tts.onEnd` calls `disconnectLipSync()`, so the mouth follows the speech and returns to rest automatically — falling back to `jawOpen` on rigs without viseme morphs.

The leverage is that the avatar drives its mouth from the *audio it actually plays*, so a built-in voice, a cloned voice, and a live mic all flow through one analyser. Start with a built-in voice in the [TTS lab](/lipsync), then bring your own through the [Voice Lab](/voice).

## See also

- [Voice Lab](/voice) — record, clone, and test a voice
- [TTS-driven lipsync lab](/lipsync) — type text, watch visemes fire
- [Audio-driven lipsync lab](/lipsync/mic) — verify the analyser with your mic
- [Real-time voice interaction preview](/blog/real-time-voice-interaction) — the full listen-reason-speak pipeline and where AR/VR fits
- [Build a custom skill](/docs/tutorials/custom-skill) — `ctx.speak()` lets a skill make the agent talk mid-tool
