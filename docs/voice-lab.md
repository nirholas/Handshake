# Voice Lab: every voice on the platform, plus your own

Voice Lab is where an agent gets its voice. Two paths lead there, and both end in the same playground:

- **Pick one.** Browse every ready-made voice across five providers in one grid: Microsoft Edge (free, the live Microsoft neural-voice list, hundreds of voices across 100+ locales), Google Gemini (30 prompt-directable voices on the platform's Google credits), NVIDIA Magpie (free, multilingual), OpenAI (11 voices), and ElevenLabs (your account's voices, plus the several-thousand-voice public Voice Library). `GET /api/tts/catalog` reports the exact `total` and a per-provider `counts` breakdown for the deployment you are talking to; nothing here is a hardcoded snapshot.
- **Make your own.** Record 20 to 30 seconds of clear speech and Voice Lab clones it into a reusable voice identity you can type into, save, and assign to any agent.

The recording, the live waveform, the browser, and the saved-voice library all run in the browser; synthesis and cloning run server-side so no provider key ever reaches the page.

Page: [/voice](https://three.ws/voice)
API: `GET /api/tts/catalog` (every voice) · `POST /api/tts/synthesize` (speak on any lane) · `GET`/`POST /api/tts/eleven/library` (public Voice Library) · `POST /api/tts/eleven-clone` (clone) · `PUT`/`POST`/`DELETE /api/agents/:id/voice` (assign to an agent)

## Why it exists

An agent that speaks in a generic stock voice is a demo. An agent that speaks in a voice you chose deliberately, or in *your* voice, is a character. Voice Lab is the on-ramp for both: it turns every synthesis lane the platform can reach into one searchable grid, and it turns a short browser recording into a voice identity. It then hands whichever you picked to the rest of the platform (the chat agent, talking-avatar surfaces, the marketplace) without you ever touching a provider API.

## The providers

| Provider | Voices | Cost to you | Notes |
| --- | --- | --- | --- |
| Microsoft Edge | the live Microsoft list | Free | No key, no account, works signed out. The default lane. |
| Google Gemini | 30 prebuilt | Free | Runs on the platform's Google Cloud credits. Takes a natural-language **direction** ("say it like a bedtime story"). |
| NVIDIA Magpie | 11 personas | Free | The real-time avatar lane, 9 languages. |
| OpenAI | 11 | Credits | `gpt-4o-mini-tts` also takes a direction. |
| ElevenLabs | your account + the public library | Credits or BYOK | The only lane that can clone your voice. |

The `providers` array from `GET /api/tts/catalog` is the source of truth: it reports, per lane, whether this deployment can actually serve it and why not when it cannot, which models it offers, and whether it accepts a direction. The picker renders unavailable lanes with their reason rather than hiding them: the lane pill stays fully legible (a greyed billing badge and a not-allowed cursor carry the state, never a faded label) and its `aria-label` reads the lane name plus the reason, so a screen reader hears what to do about it.

### The ElevenLabs Voice Library

The **ElevenLabs Library** tab searches the public catalog ElevenLabs users share (thousands of voices, filterable by accent, age, gender, and use case). A shared voice cannot be synthesized directly: press "Add to my voices" and it is copied into the account behind the request (yours under BYOK, the platform's otherwise), which returns a normal `voice_id` usable everywhere else on the platform.

## How it works

The page ([`pages/voice.html`](../pages/voice.html)) loads [`src/voice-lab.js`](../src/voice-lab.js), which owns the recorder, the "My Voices" library, and the playground, and mounts [`src/voice/voice-browser.js`](../src/voice/voice-browser.js) for the multi-provider grid. Server-side, [`api/_lib/voice-providers.js`](../api/_lib/voice-providers.js) is the one registry describing every lane and the one function that renders text on any of them.

**Browsing and picking.** The grid loads `GET /api/tts/catalog`, which fetches every lane's catalog in parallel; a lane that is slow or down degrades to empty with a reason instead of blanking the grid. Search matches name, id, locale, and every label; the language filter is built from the locales actually present. "Preview" plays a shared voice's own sample clip when it has one (free, no synthesis) and otherwise renders one short line through `/api/tts/synthesize`. "Use this voice" pushes the pick into the playground.

1. **Record.** `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 } })` opens the mic. A `MediaRecorder` (negotiating `audio/webm;codecs=opus` first, then webm, ogg, or mp4) captures in 250ms slices while a Web Audio `AnalyserNode` (`fftSize: 2048`) drives a live 64-bar waveform and an 8-bar level meter. Four reading scripts are offered so you have something natural to say. The recommended length is 25 seconds; the UI encourages stopping any time after 25s, auto-stops at 60s, and rejects anything under 3s.
2. **Review.** You play the take back, name the voice (1 to 64 chars), and either re-record or clone.
3. **Clone.** The recording is POSTed as `multipart/form-data` to `/api/tts/eleven-clone`. The shared library [`api/_lib/elevenlabs.js`](../api/_lib/elevenlabs.js) dynamically imports `@elevenlabs/elevenlabs-js`, constructs an `ElevenLabsClient`, and calls `client.voices.ivc.create({ name, description, files })` (ElevenLabs Instant Voice Cloning). The endpoint returns a `voice_id`.
4. **Save.** The `voice_id` is written to a browser voice library (`localStorage` key `voicelab_voices_v1`, up to 20 voices). Each card offers "Play sample" and "Remove".
5. **Play.** The playground takes any voice (cloned or picked from the browser), up to 1,000 characters of text, an optional model, an optional direction, and a speed, and POSTs them to `/api/tts/synthesize`. Options are keyed `<provider>:<voiceId>` so a cloned ElevenLabs voice, a free Edge voice, and a Gemini prebuilt can never collide. The model select and the direction field appear only for lanes that have them. Every clip is cached in R2 keyed on a hash of the full request (provider, voice, text, model, direction, speed, and settings), so an identical request is served from storage with no upstream call and no charge. The response header `x-tts-cache: hit|miss` tells you which path served you.

### Comparing voice models

The playground's **Model** select is populated from whichever lane the current voice belongs to:

- ElevenLabs: `eleven_flash_v2_5` (lowest latency, the default), `eleven_turbo_v2_5` (balanced), `eleven_multilingual_v2` (highest quality, 29 languages).
- Gemini: `gemini-2.5-flash-preview-tts` (fast, the default) and `gemini-2.5-pro-preview-tts` (follows longer directions).
- OpenAI: `gpt-4o-mini-tts` (steerable, the default), `tts-1` (lowest latency), `tts-1-hd` (highest fidelity).
- Edge and NVIDIA have a single model each, so the select is hidden.

Per-agent voice tuning (stability, similarity, style sliders) still lives in the **agent editor** ([`src/agent-edit.js`](../src/agent-edit.js)).

## Billing: free lanes, $THREE credits, or your own key

Free means free, and vendor-billed means metered: no request the platform would be invoiced for is given away. The response header `x-tts-billing` reports which rung served every call:

0. **Free (`free` / `gcp`).** Edge and NVIDIA cost the platform nothing (Edge is keyless; NVIDIA runs on its free NIM tier), and Gemini runs on the platform's Google Cloud credits under the standing owner-approved spend. All three are served without charge and Edge, Gemini, and NVIDIA all work **signed out**.
1. **Prepaid credits (default for OpenAI and ElevenLabs).** Requests on the platform's vendor accounts are metered against your [credit balance](https://three.ws/credits) (top up with $THREE or SOL): $0.30 per 1,000 spoken characters on ElevenLabs (`tts.eleven`), $0.03 per 1,000 on OpenAI (`tts.openai`), and $0.50 per voice clone (`voice.clone`, with the $THREE holder-tier discount applied). A short balance returns `402 insufficient_credits` with `top_up_url`, and a failed synthesis or clone refunds the charge. The response header `x-tts-charged-usd` reports what a metered call cost.
2. **Bring your own key (BYOK).** Send your own ElevenLabs API key in the `x-eleven-key` header on any ElevenLabs-touching endpoint (`/api/tts/synthesize`, `/api/tts/eleven`, `/api/tts/eleven/voices`, `/api/tts/eleven/library`, `/api/tts/eleven-clone`) and the call runs on *your* ElevenLabs account: your voices, your quota, your bill, with no platform charges. The server uses the key for that one request and never stores it. On [/voice](https://three.ws/voice), the "Use Your Own ElevenLabs Key" card saves the key to your browser's `localStorage` and attaches the header automatically.
3. **Cache hits.** Clips already synthesized (same voice, text, model, and settings) are served from R2 with no upstream call and no charge (`x-tts-billing: cached`). The cache is checked before metering, so a repeat line never spends credits twice.

```bash
# Every voice on the platform, in one shape. Works signed out (free lanes only).
curl -s 'https://three.ws/api/tts/catalog?provider=edge&language=ja&limit=5'

# Speak on the free Edge lane: no key, no account, no charge.
curl -X POST 'https://three.ws/api/tts/synthesize' \
  -H 'content-type: application/json' \
  -d '{ "provider": "edge", "voiceId": "en-GB-SoniaNeural", "text": "Free, keyless, and real." }' \
  --output edge.mp3

# Speak on Gemini with a style direction, on the platform Google credits.
curl -X POST 'https://three.ws/api/tts/synthesize' \
  -H 'content-type: application/json' \
  -d '{ "provider": "gemini", "voiceId": "Sulafat", "text": "Your agent is live.",
        "direction": "Warm and unhurried, like sharing good news" }' \
  --output gemini.wav

# Search the public ElevenLabs Voice Library, then copy one into your account.
curl -s 'https://three.ws/api/tts/eleven/library?q=narrator&gender=female' \
  -H 'authorization: Bearer <TOKEN>' -H 'x-eleven-key: <YOUR_ELEVENLABS_KEY>'
curl -X POST 'https://three.ws/api/tts/eleven/library' \
  -H 'authorization: Bearer <TOKEN>' -H 'x-eleven-key: <YOUR_ELEVENLABS_KEY>' \
  -H 'content-type: application/json' \
  -d '{ "publicUserId": "<PUBLIC_OWNER_ID>", "voiceId": "<SHARED_VOICE_ID>", "name": "Narrator" }'

# Synthesize on YOUR ElevenLabs account (BYOK): no platform quota, no credits.
curl -X POST 'https://three.ws/api/tts/eleven' \
  -H 'authorization: Bearer <TOKEN>' \
  -H 'x-eleven-key: <YOUR_ELEVENLABS_KEY>' \
  -H 'content-type: application/json' \
  -d '{ "voiceId": "<VOICE_ID>", "text": "Running on my own account." }' \
  --output hello.mp3
```

Agent-assigned voices have their own rung. When an agent's voice was bound with the owner's saved ElevenLabs key (`agent_identities.voice_key_source = 'owner'`, set by `PUT /api/agents/:id/voice`), `/api/tts/eleven` with that `agentId` serves the clip on the owner's account (`x-tts-billing: agent_byok`), including to signed-out visitors on the chat and embed surfaces, rate-limited per IP; the requested `voiceId` must be the agent's own bound voice, so the credential can never be borrowed to synthesize anything else. An agent bound on the platform key speaks on the `credits` rung instead, and the agent lane falls back to that cleanly when the owner's key is absent. Your browser-side `x-eleven-key` is never involved in agent speech, so a voice an agent should use must be cloned either on the platform rungs or with the key you have saved to your account, not with a key that only lives in `localStorage`.

## Walkthrough

1. Open [/voice](https://three.ws/voice). Browsing and the free lanes work signed out; cloning and the metered lanes need an account.
2. Search the grid ("Sonia", "Japanese", "narrator"), press **Preview** on anything that looks right, and **Use this voice** on the winner. It lands in the playground, where you can type your own line, add a direction on a lane that takes one, and adjust speed. To make your own voice instead, continue below.
3. Allow microphone access. Press record (or hit Space), read one of the scripts aloud for 20 to 30 seconds, and stop.
4. Play the take back. If it is clean, name the voice and press Clone. If not, re-record.
5. Wait a few seconds for "cloned successfully". The new voice appears in My Voices with its `voice_id`.
6. Open the playground, pick the voice, type or drop in a sample, and press Speak (or Cmd/Ctrl+Enter). Playback is instant on a cache hit.
7. To give the voice to an agent, open that agent in the agent editor and assign the saved voice there.

## Examples

The free lanes need no auth at all. Everything else takes a session cookie or bearer token, and cloning additionally requires a paid ElevenLabs tier server-side.

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
- **Auth.** The free lanes (Edge, Gemini, NVIDIA) serve anonymous callers on `/api/tts/synthesize` and `/api/tts/catalog`, rate-limited per IP. The metered lanes (OpenAI, ElevenLabs), cloning, and the Voice Library return `401 unauthorized` without a session or bearer token.
- **Server config.** ElevenLabs must be configured (`ELEVENLABS_API_KEY`) or the endpoints return `503 not_configured`; a request carrying its own `x-eleven-key` header still works (see the billing section above). `/api/tts/eleven-clone` checks who is asking first, so a signed-out caller gets `401` and never a reading of what this deployment has configured.
- **A rejected key reads as a key problem.** When ElevenLabs turns down the key on a request, `/api/tts/eleven/voices` and both `/api/tts/eleven/library` methods answer `401 invalid_key` rather than `502`, so the UI can prompt for a new key instead of retrying. A rejected *platform* key still reads as `503 not_configured`, because that one is ours to fix.
- **Voice ids are checked against the lane.** `POST /api/tts/synthesize` rejects a `voiceId` the chosen lane does not publish with `400 validation_error`, naming the id and the catalog URL to pick from, before anything is metered. It is never quietly swapped for the lane default (omit `voiceId` if that is what you want). ElevenLabs, whose catalog grows at runtime, reports an unknown id as a `400` from upstream instead.
- **Paid cloning tier.** Instant Voice Cloning is an ElevenLabs paid-tier (Starter and up) feature. On a free upstream tier the API surfaces the upstream `can_not_use_instant_voice_cloning` body verbatim as a `502`.
- **Length rules.** Voice Lab recommends 20 to 30 seconds, auto-stops at 60, and rejects under 3. The separate agent-clone endpoint (`POST /api/agents/:id/voice/clone`) enforces a 30-second floor. Platform-key clones on both endpoints are capped at 3 per user per day (an abuse guard on the shared account's limited clone slots) and each is charged per the billing section; BYOK clones on `/api/tts/eleven-clone` skip the cap.
- **Synthesis limits.** 1,000 characters per `/api/tts/synthesize` request (500 on the older `/api/tts/eleven`); every platform-key request is metered to credits per the billing section (charged before synthesis, refunded on failure). BYOK requests are unmetered by the platform. Clips are cached in R2 and cache hits are not charged.
- **Audio size.** Clone uploads are capped at ~10 MB.
- **"Add to an agent" on `/voice`** links to the dashboard; the actual assignment happens in the agent editor. The cloned `voice_id` lives in browser `localStorage` until you assign it.
- **Error copy.** Mic denial, recorder failure, too-short recording, missing name, network failure, and clone failure each map to a specific message; the playground shows "Synthesizing...", then a size, a cached/generated tag, and the billing rung that served it, or an error. A lane's upstream failure is tagged with a code (`invalid_key`, `rate_limited`, `content_blocked`, `provider_unreachable`) that `/api/tts/synthesize` maps to a truthful HTTP status rather than a blanket 502. The message the picker renders is a written sentence, never the vendor's raw body: that ships alongside it in `detail` for debugging.
- **A lane that goes down leaves the menu.** Configuration presence is not health, so what the last real synthesis learned decides what the catalog offers. A lane the provider refuses (expired key, billing hold upstream) is reported `available: false` with the reason for a few minutes, its voices drop out of the picker, and a synthesis aimed at it answers `503 lane_unavailable` with `retry_with: ["edge", "nvidia"]` rather than failing slowly again. The Voice Lab re-reads the catalog the moment a preview hits that 503, so the grid stops offering voices nobody can render while the explanation stays on screen. The window expires on its own and any successful call clears it, so recovery needs no deploy. Your own `x-eleven-key` is never gated by the platform key's outage.
- **Catalog freshness.** The Edge catalog is fetched live from Microsoft and cached 6 hours per instance; the ElevenLabs account catalog 5 minutes. Nothing is a hardcoded snapshot, so a voice Microsoft or ElevenLabs adds shows up on its own. The ElevenLabs voice-list and voice-delete calls go through the shared `fetchUpstream` with a 10 s deadline and two attempts, so a slow upstream degrades the lane to empty-with-a-reason instead of holding the catalog request open.

## Related

- [Voice and lipsync tutorial](./tutorials/voice-and-lipsync.md): the authoritative step-by-step, including wiring a cloned voice into an agent.
- [Lipsync](./lipsync.md): how synthesized speech drives an avatar's mouth in real time.
- [Talking Avatar Video](./talking-avatar-video.md): render a talking-head clip from an avatar and an audio track.
- Pages: [/voice](https://three.ws/voice), [/dashboard](https://three.ws/dashboard).
