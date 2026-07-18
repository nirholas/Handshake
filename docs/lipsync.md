# Lipsync: real-time mouth animation from speech

Two browser demos show the same idea from two angles: drive a 3D avatar's mouth from speech, live, with no server-side video rendering. `/lipsync` types a phrase, synthesizes it, and animates the mouth as the audio plays. `/lipsync/mic` opens your microphone and moves the mouth in real time as you talk. Both render the same avatar and both compute visemes frame-by-frame in the browser, feeding the avatar's `viseme_*` morph targets.

Page: [/lipsync](https://three.ws/lipsync) (TTS-driven) · [/lipsync/mic](https://three.ws/lipsync/mic) (microphone-driven)
API: `POST /api/tts/speak` (used only by the TTS demo)

## Why it exists

Lipsync is the difference between an avatar that speaks and a mannequin with audio playing near it. These demos are the reference implementations for the two lipsync paths the platform runs everywhere else: a viseme string from a phoneme-aware analyzer, and a frequency-band heuristic that works with nothing but an audio stream. Seeing both side by side makes the trade-off explicit, and each demo is a self-contained, copyable example of wiring an analyzer to morph targets on a glTF avatar.

Both demos load the same rig, [`public/avatars/default.glb`](../public/avatars/default.glb), which carries Oculus-style viseme morph targets (`viseme_aa`, `viseme_E`, `viseme_O`, and so on). There is no server-side audio analysis in either demo; everything happens on the client.

## How it works

### TTS demo (`/lipsync`)

Served from [`public/demos/lipsync-tts.html`](../public/demos/lipsync-tts.html). Flow: type a phrase, POST it to the TTS endpoint, receive an audio blob, play it through an `Audio` element, and let the third-party [`wawa-lipsync`](https://www.npmjs.com/package/wawa-lipsync) package (pinned `^0.0.2`) analyze the playing audio each frame.

1. The page imports `three`, `GLTFLoader`, `OrbitControls`, and `{ Lipsync } from 'wawa-lipsync'`, and constructs `const lipsync = new Lipsync()`.
2. On Speak it POSTs `{ text, voice, speed, format: 'mp3' }` to `/api/tts/speak`. The Voice dropdown offers nova (default), alloy, echo, fable, onyx, shimmer, ash, coral, sage; Speed offers 0.8x, 1.0x, 1.2x, 1.5x.
3. The returned bytes become an object URL on a `new Audio()` (`crossOrigin: 'anonymous'`), then `lipsync.connectAudio(audioEl)` (src set before connect, as wawa requires).
4. In the render loop, while playing, it calls `lipsync.processAudio()` and reads `lipsync.viseme` (one of `sil, aa, PP, FF, TH, DD, kk, CH, SS, nn, RR, ou`). A `VISEME_MAP` translates that code to the avatar's morph name (for example `aa -> viseme_aa`, `CH -> viseme_CH`, `ou -> viseme_O`, `sil -> null`).
5. Each frame every viseme weight is reset to 0, the active viseme's morph is targeted to 1.0, and the actual `morphTargetInfluences` are lerped toward the target (factor 0.5) so the mouth eases instead of snapping. A live viseme meter mirrors the current code.

`wawa-lipsync` computes visemes from per-band energies, band deltas, overall volume, and spectral centroid (`computeVisemeScores` plus temporal smoothing in `adjustScoresForConsistency`), exposing the winner as `.viseme`.

### Microphone demo (`/lipsync/mic`)

Served from [`public/demos/lipsync-mic.html`](../public/demos/lipsync-mic.html). This demo does **not** use wawa-lipsync. It imports the in-house analyzer [`src/lip-sync-analyser.js`](../src/lip-sync-analyser.js) (`LipSyncAnalyser`), the same viseme pipeline that drives streamed TTS in the live chat, sourced from your mic instead.

1. Start calls `getUserMedia({ audio: true })`, creates an `AudioContext`, wires `createMediaStreamSource(stream)` into an `AnalyserNode` (`fftSize: 256`, `smoothingTimeConstant: 0.7`). The analyzer node is deliberately not connected to `destination`, so your mic does not echo through the speakers.
2. `new LipSyncAnalyser()` is `connect()`-ed to that node, and each frame `analyser.sample()` returns a `{ viseme_name: weight }` map that is written straight to the avatar's `morphTargetInfluences` and a 9-bar meter.
3. The analyzer is a frequency-band heuristic: low band (0 to 500 Hz) drives open vowels (`viseme_aa`, `viseme_O`), the mid band (500 Hz to 2 kHz) drives mid vowels and nasals (`viseme_E`, `viseme_I`, `viseme_nn`), the high band (2 to 8 kHz) drives sibilants and fricatives (`viseme_SS`, `viseme_FF`, `viseme_CH`), and an amplitude dip drives a bilabial closure (`viseme_PP`). A silence gate below 0.15 overall amplitude eases everything to rest; otherwise weights EMA toward target (factor 0.25). `getAmplitude()` also exposes a smoothed 0..1 level so a rig with no viseme morphs can drive a single `jawOpen`/`mouthOpen` morph instead.
4. This demo registers the meshopt decoder before loading, because server-baked and Forge GLBs can ship `EXT_meshopt_compression`.

## Walkthrough

1. Open [/lipsync](https://three.ws/lipsync). Edit the text, pick a voice and speed, and press Speak. Watch the mouth move as the audio plays; the viseme meter shows the live code. Press Stop to interrupt.
2. Open [/lipsync/mic](https://three.ws/lipsync/mic) and press Start. Allow microphone access, then talk or sing. The mouth and the 9-bar meter follow your voice. Press Stop to release the mic and reset the mouth.

## Examples

Only the TTS demo hits an API. `/api/tts/speak` returns audio bytes you can decode and analyze exactly as the demo does.

```bash
# Synthesize speech to an MP3 file (the same call the /lipsync demo makes).
curl -X POST 'https://three.ws/api/tts/speak' \
  -H 'content-type: application/json' \
  -d '{ "text": "Welcome to three dot ws.", "voice": "nova", "speed": 1.0, "format": "mp3" }' \
  --output speech.mp3
```

```js
// Minimal browser lipsync loop with wawa-lipsync, mirroring the /lipsync demo.
import { Lipsync } from 'wawa-lipsync';
const lipsync = new Lipsync();
const res = await fetch('/api/tts/speak', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Hello from three dot ws', voice: 'nova', format: 'mp3' }),
});
const audio = new Audio(URL.createObjectURL(await res.blob()));
audio.crossOrigin = 'anonymous';
lipsync.connectAudio(audio);
audio.play();
function tick() {
  if (!audio.paused) { lipsync.processAudio(); console.log(lipsync.viseme); }
  requestAnimationFrame(tick);
}
tick();
```

`POST /api/tts/speak` ([`api/tts/speak.js`](../api/tts/speak.js)) prefers the free NVIDIA NIM Magpie TTS lane when configured and falls back to OpenAI as a paid backstop. Body: `{ text, voice?, model?, format?, language?, speed? }`. `text` is required (max 4096 chars), `voice` defaults to `nova`, `format` defaults to `mp3`, `speed` clamps 0.5 to 2.0. It is rate-limited per user or per IP.

## States and limits

- **TTS demo errors.** A persistent, actionable banner with a Retry button covers network failure, `429` rate limit, `>=500` service errors, `400` bad text, audio playback failure, and blocked autoplay ("needs a click").
- **Mic demo permissions.** `getUserMedia` failures map by `DOMException.name`: `NotAllowedError`/`SecurityError` -> "Microphone blocked", `NotFoundError`/`OverconstrainedError` -> "No microphone found", `NotReadableError` -> "Microphone is busy", with a "Try again" button.
- **Morph naming.** The avatar uses Oculus-style `viseme_*` targets, not ARKit blendshape names. On load each demo logs how many of the expected viseme morphs it wired.
- **No TTS on the mic demo.** It analyzes live audio only; no network call.
- **Two different analyzers.** The TTS demo uses the third-party `wawa-lipsync` phoneme-style analyzer; the mic demo uses the in-house frequency-band `LipSyncAnalyser`. They map slightly different viseme sets.

## Related

- [Voice Lab](./voice-lab.md): clone a voice and synthesize it, the audio these demos animate.
- [Voice and lipsync tutorial](./tutorials/voice-and-lipsync.md): the full walkthrough, including wiring visemes to an agent body.
- [Talking Avatar Video](./talking-avatar-video.md): the server-rendered alternative for exporting a talking-head clip.
- [Animations](./animations.md): the runtime clip registry that plays alongside lipsync.
- Pages: [/lipsync](https://three.ws/lipsync), [/lipsync/mic](https://three.ws/lipsync/mic).
