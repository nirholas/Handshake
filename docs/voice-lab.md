# Voice Lab: clone your voice in the browser

Record 20 to 30 seconds of clear speech and Voice Lab creates a digital replica of your voice that you can type into and play back instantly, save to a personal library, and later assign to any three.ws agent. The recording, the live waveform, and the voice library all run in the browser; cloning and synthesis run server-side through ElevenLabs Instant Voice Cloning behind a platform proxy so your key never leaves the server.

Page: [/voice](https://three.ws/voice)
API: `POST /api/tts/eleven-clone` (clone) · `POST /api/tts/eleven` (synthesize) · `PUT`/`POST`/`DELETE /api/agents/:id/voice` (assign to an agent)

## Why it exists

An agent that speaks in a generic stock voice is a demo. An agent that speaks in *your* voice is a character. Voice Lab is the on-ramp: it turns a short browser recording into a reusable voice identity, then hands that identity to the rest of the platform (the chat agent, talking-avatar surfaces, the marketplace) without you ever touching an API. It is deliberately a two-step product: clone here, then wire the saved voice into an agent from the agent editor, so the same clone can back several agents.

## How it works

The page ([`pages/voice.html`](../pages/voice.html)) loads a single module, [`src/voice-lab.js`](../src/voice-lab.js), which owns three panels: the recorder, the "My Voices" library, and a text-to-speech playground.

1. **Record.** `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 } })` opens the mic. A `MediaRecorder` (negotiating `audio/webm;codecs=opus` first, then webm, ogg, or mp4) captures in 250ms slices while a Web Audio `AnalyserNode` (`fftSize: 2048`) drives a live 64-bar waveform and an 8-bar level meter. Four reading scripts are offered so you have something natural to say. The recommended length is 25 seconds; the UI encourages stopping any time after 25s, auto-stops at 60s, and rejects anything under 3s.
2. **Review.** You play the take back, name the voice (1 to 64 chars), and either re-record or clone.
3. **Clone.** The recording is POSTed as `multipart/form-data` to `/api/tts/eleven-clone`. The shared library [`api/_lib/elevenlabs.js`](../api/_lib/elevenlabs.js) dynamically imports `@elevenlabs/elevenlabs-js`, constructs an `ElevenLabsClient`, and calls `client.voices.ivc.create({ name, description, files })` (ElevenLabs Instant Voice Cloning). The endpoint returns a `voice_id`.
4. **Save.** The `voice_id` is written to a browser voice library (`localStorage` key `voicelab_voices_v1`, up to 20 voices). Each card offers "Play sample" and "Remove".
5. **Play.** The playground picks any of *your* cloned voices, takes up to 500 characters of text, and POSTs `{ voiceId, text }` to `/api/tts/eleven`. That endpoint synthesizes with the server default model `eleven_flash_v2_5`, streams back `audio/mpeg`, and caches each clip in R2 for 30 days keyed on a hash of the inputs (the response header `x-tts-cache: hit|miss` tells you which).

### Comparing voice models

The live `/voice` playground synthesizes with a single default model (`eleven_flash_v2_5`). The side-by-side **model** comparison and per-agent voice tuning (stability, similarity, style sliders) live in the **agent editor** ([`src/agent-edit.js`](../src/agent-edit.js)), which reads the live model catalog from `GET /api/tts/eleven/voices` and lets you audition across the three ElevenLabs models:

- `eleven_flash_v2_5`: Flash v2.5, lowest latency, real-time (the default).
- `eleven_turbo_v2_5`: Turbo v2.5, balanced latency and quality.
- `eleven_multilingual_v2`: Multilingual v2, highest quality, 29 languages.

## Billing: free quota, $THREE credits, or your own key

Every synthesis and clone request rides one of three rungs, and the response header `x-tts-billing` tells you which one served it:

1. **Free quota (default).** Requests run on the platform's ElevenLabs account: 1,000 speech characters per user per hour and 3 clones per user per day. Cached clips are always free and never touch the quota.
2. **Prepaid credits.** Once the hourly character quota is spent, `/api/tts/eleven` meters the request against your [credit balance](https://three.ws/credits) (top up with $THREE or SOL) at $0.30 per 1,000 characters, the `tts.eleven` action in the pricing catalog. A short balance returns `402 insufficient_credits` with `top_up_url`, and a failed synthesis refunds the charge. The response header `x-tts-charged-usd` reports what a metered call cost.
3. **Bring your own key (BYOK).** Send your own ElevenLabs API key in the `x-eleven-key` header on any of the three endpoints (`/api/tts/eleven`, `/api/tts/eleven/voices`, `/api/tts/eleven-clone`) and the call runs on *your* ElevenLabs account: your voices, your quota, your bill, with no platform limits or credit metering. The server uses the key for that one request and never stores it. On [/voice](https://three.ws/voice), the "Use Your Own ElevenLabs Key" card saves the key to your browser's `localStorage` and attaches the header automatically.

```bash
# Synthesize on YOUR ElevenLabs account (BYOK): no platform quota, no credits.
curl -X POST 'https://three.ws/api/tts/eleven' \
  -H 'authorization: Bearer <TOKEN>' \
  -H 'x-eleven-key: <YOUR_ELEVENLABS_KEY>' \
  -H 'content-type: application/json' \
  -d '{ "voiceId": "<VOICE_ID>", "text": "Running on my own account." }' \
  --output hello.mp3
```

Note that agent-assigned voices always run on the platform account (the agent speaks server-side, where your browser key is not present), so a voice you want an agent to use must be cloned on the platform rungs, not under BYOK.

## Walkthrough

1. Open [/voice](https://three.ws/voice) and sign in (both endpoints require auth).
2. Allow microphone access. Press record (or hit Space), read one of the scripts aloud for 20 to 30 seconds, and stop.
3. Play the take back. If it is clean, name the voice and press Clone. If not, re-record.
4. Wait a few seconds for "cloned successfully". The new voice appears in My Voices with its `voice_id`.
5. Open the playground, pick the voice, type or drop in a sample, and press Speak (or Cmd/Ctrl+Enter). Playback is instant on a cache hit.
6. To give the voice to an agent, open that agent in the agent editor and assign the saved voice there.

## Examples

Both endpoints are authenticated (session cookie or bearer token). Cloning also requires a paid ElevenLabs tier server-side.

```bash
# Clone a voice from a recorded sample (multipart).
curl -X POST 'https://three.ws/api/tts/eleven-clone' \
  -H 'authorization: Bearer <TOKEN>' \
  -F 'name=My studio voice' \
  -F 'audio=@sample.webm;type=audio/webm'
# -> 200 { "voice_id": "…", "name": "My studio voice", "status": "ready", "requires_verification": false }

# Synthesize speech with a cloned voice (streams audio/mpeg).
curl -X POST 'https://three.ws/api/tts/eleven' \
  -H 'authorization: Bearer <TOKEN>' \
  -H 'content-type: application/json' \
  -d '{ "voiceId": "<VOICE_ID>", "text": "Welcome to three dot ws." }' \
  --output hello.mp3

# Assign the cloned voice to an agent, with model + settings.
curl -X PUT 'https://three.ws/api/agents/<AGENT_ID>/voice' \
  -H 'authorization: Bearer <TOKEN>' \
  -H 'content-type: application/json' \
  -d '{ "voice_id": "<VOICE_ID>", "voice_model": "eleven_turbo_v2_5",
        "voice_settings": { "stability": 0.5, "similarity_boost": 0.75, "style": 0.5, "use_speaker_boost": true } }'
# -> { "voice_provider": "elevenlabs", "voice_id": "…", "voice_model": "eleven_turbo_v2_5", ... }
```

The agent-voice handler ([`api/agents/_id/voice.js`](../api/agents/_id/voice.js), reached at `/api/agents/:id/voice`) also exposes `GET` (status), `POST /api/agents/:id/voice/clone` (clone directly from raw audio, with a 30-second minimum and a 3-clones-per-day limit), and `DELETE` (revert to the browser voice). Assigning or clearing a clone deletes the previous ElevenLabs clone to free quota.

## States and limits

- **Recorder states.** `idle` -> `recording` (live waveform, timer, level meter) -> `review` (playback, name, Clone / Re-record) -> `cloning` (spinner) -> `done` (green check, `voice_id` shown, actions: Try in playground / Add to an agent / Record another).
- **Auth required.** Both TTS endpoints return `401 unauthorized` without a session or bearer token. Requests send `credentials: 'include'`.
- **Server config.** ElevenLabs must be configured (`ELEVENLABS_API_KEY`) or the endpoints return `503 not_configured`; a request carrying its own `x-eleven-key` header still works (see the billing section above).
- **Paid cloning tier.** Instant Voice Cloning is an ElevenLabs paid-tier (Starter and up) feature. On a free upstream tier the API surfaces the upstream `can_not_use_instant_voice_cloning` body verbatim as a `502`.
- **Length rules.** Voice Lab recommends 20 to 30 seconds, auto-stops at 60, and rejects under 3. The separate agent-clone endpoint (`POST /api/agents/:id/voice/clone`) enforces a 30-second floor and 3 clones per user per day.
- **Synthesis limits.** 500 characters per playground request; 1000 free characters per hour per user (reserved-then-refunded so a failed synth does not burn quota), then metered to credits per the billing section. BYOK requests skip both. Clips are cached in R2 for 30 days.
- **Audio size.** Clone uploads are capped at ~10 MB.
- **"Add to an agent" on `/voice`** links to the dashboard; the actual assignment happens in the agent editor. The cloned `voice_id` lives in browser `localStorage` until you assign it.
- **Error copy.** Mic denial, recorder failure, too-short recording, missing name, network failure, and clone failure each map to a specific message; the playground shows "Synthesizing...", then a size and cached/generated tag, or an error.

## Related

- [Voice and lipsync tutorial](./tutorials/voice-and-lipsync.md): the authoritative step-by-step, including wiring a cloned voice into an agent.
- [Lipsync](./lipsync.md): how synthesized speech drives an avatar's mouth in real time.
- [Talking Avatar Video](./talking-avatar-video.md): render a talking-head clip from an avatar and an audio track.
- Pages: [/voice](https://three.ws/voice), [/dashboard](https://three.ws/dashboard).
