# Examples: @three-ws/voice

| File | What it shows | Run |
|---|---|---|
| [`voice-loop.mjs`](voice-loop.mjs) | The whole loop against the live endpoints: probe both lanes, `speak()` text into a WAV, `lipsync()` that WAV into ARKit visemes, `transcribe()` it back to text, then `say()` for the one-round-trip path. | `node examples/voice-loop.mjs` |

Run it from the package directory:

```bash
cd packages/voice
node examples/voice-loop.mjs
```

No key, no wallet, nothing to install: all three lanes lead with free NVIDIA NIM
models (Magpie TTS, Audio2Face-3D, Riva ASR). Expected output:

```
asr lane:     configured=true encodings=wav/pcm/flac/ogg
lipsync lane: configured=true model=audio2face-3d 30 fps arkit
voices:       11 (nova, alloy, ash, ballad, …)

speak("The quick brown fox jumps over the lazy dog.")
  208940 bytes of audio/wav from magpie-tts-multilingual (voice Magpie-Multilingual.EN-US.Aria)

lipsync(clip)
  72 frames @ 30 fps over 2.37s
  55 blendshapes; JawOpen peaks at 0.506 (the mouth actually opens)

transcribe(clip)
  "The quick brown fox jumps over the lazy dog."
  9 word timings, 2.37s of audio, model riva-asr

say("Welcome back.")
  77868 bytes of audio/wav (Magpie-Multilingual.EN-US.Aria)
  + 27 aligned face frames @ 30 fps
```

Byte counts and the JawOpen peak move run to run (TTS is not deterministic); the
shape does not.

Two knobs:

```bash
TEXT="give the avatar different words" node examples/voice-loop.mjs
SAVE_WAV=out.wav node examples/voice-loop.mjs      # also write the synthesized clip
```

If a lane's provider key is not set on the deployment you point at, the probe
reports `configured=false` and the call raises a typed `ThreeWsError` with code
`not_configured` rather than crashing, which is the signal to fall back to
in-browser recognition or amplitude lipsync.
