<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/voice</h1>

<p align="center"><strong>Give your avatar a voice — speech in, speech out, and lips that move. ASR, TTS, and Audio2Face lipsync in one import.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/voice"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/voice?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/voice"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/voice?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/voice?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/voice?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/voice` is the official client for the three.ws **voice loop** — the
> three endpoints that let an avatar hear, speak, and move its face in sync.
> `transcribe()` turns spoken audio into text (NVIDIA Riva ASR), `speak()` turns
> text into a voiced clip (NVIDIA Magpie TTS, ElevenLabs for cloned voices), and
> `lipsync()` turns that audio into a per-frame ARKit blendshape track (NVIDIA
> Audio2Face-3D) that drives the avatar's mouth and face. It wraps the live,
> auth-free `/api/asr`, `/api/tts/speak`, and `/api/a2f` endpoints. The visemes
> it produces are exactly what [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar)
> plays back on a loaded GLB — this is the voice half of a talking avatar.

## Why

A talking avatar needs three separate systems wired together: a recognizer to
hear the user, a synthesizer to give the avatar a voice, and a facial-animation
model so the mouth matches the words. Each is a different provider, a different
wire format, and a different failure mode. Hand-rolling that means juggling gRPC
audio encodings, WAV header parsing, sample-rate resampling, ARKit blendshape
ordering, and three sets of rate limits.

`@three-ws/voice` is that loop, done once:

- **One import, the whole loop.** `transcribe(audio)`, `speak(text)`,
  `lipsync(audio)` — hear, speak, and animate the face from three plain calls.
- **Free first.** All three lanes lead with NVIDIA NIM (Riva, Magpie,
  Audio2Face-3D) — no key, no wallet, no card on the free path.
- **Cross-browser by default.** Server-side Riva recognition replaces the
  Chrome/Edge-only `window.webkitSpeechRecognition`, so voice input works in
  Firefox and inside embeds too.
- **Lips that match the exact bytes.** `lipsync()` returns time-coded ARKit
  weights for the precise clip you'll play — drop them straight into
  [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar).

Every lane is purely additive on the platform: when a provider isn't configured,
the endpoint returns a clean `not_configured` state instead of crashing, and the
avatar falls back to in-browser recognition / amplitude lipsync.

## Install

```bash
npm install @three-ws/voice
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`).
To render the visemes on a GLB, add [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar).

## Quick start

Text to a voiced clip, no key:

```js
import { speak } from '@three-ws/voice';

const clip = await speak('Hi, I am your three.ws avatar.', { voice: 'nova' });
new Audio(clip.url).play(); // clip.url is an object URL for the synthesized audio
```

The full loop — hear the user, answer, animate the face:

```js
import { transcribe, speak, lipsync } from '@three-ws/voice';

// 1. Speech → text (record audio in the browser, send the bytes)
const { text } = await transcribe(audioBlob); // → "what's the weather like"

// 2. Text → speech (your agent decides the reply)
const reply = await speak(`You said: ${text}`, { voice: 'nova' });

// 3. Speech → ARKit visemes for the exact clip you'll play
const face = await lipsync(reply.blob);
//   face.blendShapeNames → ["eyeBlinkLeft", "jawOpen", …] (ARKit-52)
//   face.frames → [{ t: 0.0, w: [...] }, { t: 0.033, w: [...] }, …] at 30 fps
```

One-shot: synthesize **and** animate in a single call (server speaks the text
with Magpie, then animates that exact audio):

```js
const { audio, animation } = await say('Welcome back.', { voice: 'nova' });
// audio.url → play it · animation.frames → drive the face, perfectly aligned
```

## API

### `transcribe(audio, options?) → Promise<Transcript>`

Speech → text on the free NVIDIA Riva ASR lane. Wraps `POST /api/asr`. `audio`
is a `Blob`, `ArrayBuffer`, or `Uint8Array`; the SDK reads the encoding from the
blob's MIME type (or `options.format`).

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `format` | `'wav' \| 'pcm' \| 'flac' \| 'ogg'` | from MIME | Audio encoding. WebM/Opus must be decoded to PCM/WAV client-side first. |
| `language` | `string` | `'en-US'` | BCP-47 language code. |
| `sampleRate` | `number` | `16000` | Required for raw `pcm`; WAV carries its own rate in the header. |
| `words` | `boolean` | `false` | Return word-level timestamps. |
| `model` | `string` | — | Override the Riva model name. |
| `signal` | `AbortSignal` | — | Cancel an in-flight request. |

**Returns** `Transcript`

| Field | Type | Notes |
|---|---|---|
| `text` | `string` | The recognized utterance. |
| `confidence` | `number` | Mean confidence across results (0–1). |
| `language` | `string` | Detected language code. |
| `model` | `string` | Model that produced the transcript. |
| `durationSec` | `number` | Seconds of audio processed. |
| `words` | `{ word, startMs, endMs, confidence }[]` | Present only when `words: true`. |

### `speak(text, options?) → Promise<Clip>`

Text → a voiced audio clip. Wraps `POST /api/tts/speak` (NVIDIA Magpie free
lane; OpenAI is the paid backstop). Returns the complete audio as a `Blob` plus
a ready-to-play object `url`.

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `voice` | `string` | `'nova'` | One of the [voice catalog](#voices) ids. |
| `format` | `'mp3' \| 'wav' \| 'opus' \| 'aac' \| 'flac' \| 'pcm'` | `'mp3'` | Output container. Magpie emits PCM, so non-`pcm` requests are served as WAV. |
| `language` | `string` | `'en-US'` | BCP-47 language code. |
| `speed` | `number` | `1.0` | Clamped to 0.5–2.0 (paid backstop only). |
| `model` | `string` | — | `tts-1`, `tts-1-hd`, or `gpt-4o-mini-tts` (backstop). |
| `signal` | `AbortSignal` | — | Cancel an in-flight request. |

**Returns** `Clip`: `{ blob, url, contentType, voice, format, model }`. The
`x-tts-voice` / `x-tts-model` / `x-tts-format` response headers always describe
the bytes actually sent.

> `text` is capped at 4096 characters per call.

### `lipsync(audio, options?) → Promise<FaceTrack>`

Speech → a per-frame ARKit blendshape track. Wraps `POST /api/a2f` with audio
(NVIDIA Audio2Face-3D). `audio` is a `Blob` / `ArrayBuffer` of `wav` or `pcm`.
The track's time codes are in **seconds from clip start**, so play the original
audio and sample the track by the audio element's `currentTime`.

**Returns** `FaceTrack`

| Field | Type | Notes |
|---|---|---|
| `fps` | `number` | Frame cadence (30 fps native). |
| `blendShapeNames` | `string[]` | ARKit-52 names, the order `frames[i].w` follows. |
| `frames` | `{ t, w }[]` | `t` = seconds from start, `w` = weights (0–1) in `blendShapeNames` order. |
| `frameCount` | `number` | Number of frames. |
| `durationSec` | `number` | Clip length in seconds. |

### `say(text, options?) → Promise<{ audio, animation }>`

One-shot text → speech → face. Wraps `POST /api/a2f` with `{ text, voice,
language }`: the server synthesizes with Magpie, animates that exact clip, and
returns both. `audio` is `{ url, blob, contentType, format, voiceName }`;
`animation` is the same shape as `FaceTrack`. Use this when latency matters more
than picking your own TTS — one round trip instead of two.

### `voices() → Promise<VoiceCatalog>`

Fetch the live voice catalog (`GET /api/tts/voices`) — ids, names, descriptions,
which synthesis lanes are configured. Render a picker before the user commits.

### Capability probes

Each lane answers a `GET` probe so a UI can decide whether to use the server lane
or its in-browser fallback without sniffing the browser:

- `GET /api/asr` → `{ configured, encodings, sampleRate }`
- `GET /api/a2f` → `{ configured, canSynthesize, model, fps, blendshapeFormat: 'arkit', sampleRate, accepts }`

## Voices

`speak()` and `say()` accept these ids (full catalog is live at `voices()`):

| id | Voice | id | Voice |
|---|---|---|---|
| `nova` *(default)* | Bright, energetic | `echo` | Calm, measured |
| `alloy` | Neutral, balanced | `fable` | Expressive storyteller |
| `ash` | Warm, expressive | `onyx` | Deep, authoritative |
| `ballad` | Soft, lyrical | `sage` | Gentle, thoughtful |
| `coral` | Friendly, upbeat | `shimmer` | Light, airy |
| `verse` | Dynamic, conversational | | |

The same id renders on either lane: the free Magpie lane maps each to a persona,
the paid backstop uses the id directly.

## How it works

Three NVIDIA NIM models on one face, closing the loop user → avatar → user:

```
  user speaks                                 avatar speaks
       │                                            ▲
       ▼                                            │
  ┌──────────┐   POST /api/asr            POST /api/tts/speak ┌──────────┐
  │ microphone│ ───────────────▶  text  ──────────────────▶  │  speaker │
  └──────────┘   Riva ASR (free)   │     Magpie TTS (free)    └──────────┘
                                   │     ElevenLabs (cloned)        ▲
                                   ▼                                │
                         agent / app logic        audio ───────────┘
                                                    │
                                          POST /api/a2f (Audio2Face-3D, free)
                                                    │
                                                    ▼
                                ARKit-52 blendshape track  ──▶  @three-ws/avatar
                                  { fps, blendShapeNames, frames:[{t,w}] }   (lips move)
```

- **ASR** — Riva offline `Recognize` over NVCF gRPC. Browsers can't all produce
  the same codec, so the cross-browser default is raw 16-bit PCM (or WAV, whose
  header is parsed to LINEAR_PCM). Needs `NVIDIA_API_KEY` + `NVIDIA_ASR_FUNCTION_ID`.
- **TTS** — Magpie leads (free, gRPC); OpenAI `/v1/audio/speech` is the paid
  last-resort backstop. The clip is fully buffered before a byte ships, so a
  Magpie failure fails over cleanly.
- **Lipsync** — Audio2Face-3D bidirectional streaming. Audio is downmixed to
  mono and resampled to 16 kHz, then streamed; the server streams back the
  ordered ARKit names followed by per-frame weights at 30 fps. Works out of the
  box with just `NVIDIA_API_KEY` (a stable published model id; override with
  `NVIDIA_A2F_FUNCTION_ID`).

A2F emits ARKit-52 names; [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar)
maps them onto whatever convention the loaded GLB exposes (ARKit / RPM / VRM /
Oculus), so the same track drives any avatar.

## Pricing

The three NVIDIA NIM lanes are **free** (credit-metered, no payment). The lanes
are metered to bound abuse: signed-in callers get a per-user budget, anonymous
callers a tighter per-IP one — exceeding it returns `429`. The OpenAI TTS
backstop and ElevenLabs cloned voices are paid provider lanes used only when
configured; the free Magpie lane covers the default voices end to end.

## Errors & edge cases

Each call rejects with a typed `ThreeWsError` carrying a `code` that mirrors the
endpoint's response:

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `not_configured` | 503 | The lane's provider key isn't set on the server. | Fall back to in-browser recognition / amplitude lipsync. |
| `unsupported_media_type` | 415 | Audio Content-Type the lane can't accept (e.g. WebM/Opus). | Decode to PCM/WAV client-side first. |
| `bad_request` | 400 | Missing audio/text, or `text` over 4096 chars. | Fix the input. |
| `payload_too_large` | 413 | Audio exceeds the 8 MB limit. | Send a shorter clip. |
| `rate_limited` | 429 | Per-user / per-IP budget exceeded. | Honour `retryAfter`; sign in for a higher limit. |
| `invalid_argument` | 400 | Provider rejected the encoding / rate / language. | Check `format` + `sampleRate`. |
| `provider_error` / `upstream_error` | 502 | Upstream provider failed. | Retry. |
| `timeout` | 504 | Audio2Face exceeded its deadline. | Send a shorter clip and retry. |

Every state is designed: an unconfigured lane returns `not_configured` (not a
crash), so the client keeps its existing browser path. A2F's text path
additionally needs Magpie TTS — without it, `say()` returns `not_configured` and
you pass pre-synthesized audio to `lipsync()` instead.

## Examples

**Browser voice loop → animated avatar.** Record, transcribe, answer, and drive
the face on a loaded GLB:

```js
import { transcribe, say } from '@three-ws/voice';

const heard = await transcribe(recordedBlob);            // user speech → text
const { audio, animation } = await say(reply(heard.text)); // reply → voice + face

const el = document.createElement('audio');
el.src = audio.url;
el.play();
// sample `animation.frames` by el.currentTime and apply to the avatar's
// morph targets — @three-ws/avatar does this mapping for you.
```

**Node — synthesize a narration clip to a file:**

```js
import { writeFile } from 'node:fs/promises';
import { speak } from '@three-ws/voice';

const clip = await speak('The only coin is $THREE.', { voice: 'onyx', format: 'wav' });
await writeFile('line.wav', Buffer.from(await clip.blob.arrayBuffer()));
```

**Agent — caption an audio clip (word-level timestamps):**

```js
const { text, words } = await transcribe(clip, { words: true });
for (const w of words) console.log(`${(w.startMs / 1000).toFixed(2)}s  ${w.word}`);
```

## Related

- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — render a GLB and play these visemes as real lipsync.
- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — generate and auto-rig the GLB this voice loop speaks through.
- [`@three-ws/react`](https://www.npmjs.com/package/@three-ws/react) — React bindings for the three.ws avatar runtime.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
