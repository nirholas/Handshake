# src/voice

Voice and talk-mode stack: everything that lets a three.ws avatar listen, speak, and move its face while doing it. Mic capture, speech-to-text, lipsync, ARKit blendshape mapping, NVIDIA Audio2Face playback, the full-screen talk overlay, prompt dictation, and in-place voice cloning.

## Why this exists

An avatar that only rotates in a viewer is a model. An avatar you can hold a live conversation with is a product. This directory is the client side of that loop:

```
user mic ─▶ STT (Web Speech API, or MicCapture + POST /api/asr on Riva)
                │
                ▼
        /api/chat (SSE stream)
                │
                ▼
   /api/tts/eleven (cloned voice)  /  /api/tts/edge (fallback)
                │
                ▼
      audio element + AnalyserNode
                │
                ▼
  LipsyncDriver (amplitude)  or  A2FPlayer (Audio2Face blendshape track)
                │
                ▼
     AvatarMouthTarget ─▶ morph weights / jaw bone on the loaded GLB
```

Every wire is real: the GLB renders through three.js, replies stream from `/api/chat`, audio synthesizes through the existing TTS proxies, and mouth motion comes from the FFT of the actual playback audio (or a per-frame ARKit track from [api/_lib/a2f-nvidia.js](../../api/_lib/a2f-nvidia.js)). No canned animations pretending to be lipsync.

No rig allowlist, same policy as the skeleton pipeline: `AvatarMouthTarget` and `A2FPlayer` scan whatever morph convention the GLB ships (ARKit 52, VRM vowels, Oculus visemes, generic `Mouth_Open` names) and drive what they find. A rig with no face morphs falls back to a jaw bone, then a subtle head-motion fallback. Never a frozen face.

## Modules

| Module | Exports | What it does |
| --- | --- | --- |
| [talk-mode.js](talk-mode.js) | `openTalkMode({ avatar, systemPromptFn })`, `closeTalkMode()` | The full-screen talk overlay opened from `/avatars/:id`. Self-contained: builds the DOM, mounts a `TalkScene`, wires hold-to-talk to a `TalkController`, renders the live transcript, emote bar, camera framing button, and the owner-only voice-clone button. Single instance; closes on Escape or the close button. |
| [talk-controller.js](talk-controller.js) | `TalkController` | Orchestrates the voice loop: STT (Web Speech API, or the Riva lane via `MicCapture` + `POST /api/asr` in browsers without it), streams the reply from `/api/chat`, synthesizes via `/api/tts/eleven` (agent's cloned `voice_id`) or `/api/tts/edge`, and feeds the playback audio into the lipsync path. Owns an `AvatarMouthTarget`, not the scene. |
| [talk-scene.js](talk-scene.js) | `TalkScene` | Minimal three.js renderer for talk mode (model-viewer does not expose its internal scene, and lipsync needs per-frame morph access). Mounts on demand, loads the GLB, applies cinematic lighting, unmounts cleanly. |
| [talk-emotes.js](talk-emotes.js) | `TalkEmotes`, `TALK_EMOTE_BAR` | Curated emote bar for the overlay. Wraps [src/animation-manager.js](../animation-manager.js) with manifest fetch and lazy clip loading; the bone-name track filter makes clips safe on any rig. |
| [home-voice.js](home-voice.js) | `HomeVoiceLoop`, `STATES`, `STATE_ORDER`, `classifyConfirmation(text)`, `isConfirmationToken(text)`, `normalizeTranscript(text)`, `normalizePendingConfirmation(structured)`, `permissionRecovery(ua)`, `readConsent()`, `capText(v, max)` | The hands-free loop for a connected home: one `getUserMedia` shared by the VAD, the wake word and the capture; twelve states; full-duplex barge-in that cuts playback about 110 ms after the user starts talking; a continuation window so a pause after the wake word does not truncate the command; and the spoken confirmation grammar, which accepts the token `confirm` and refuses every general affirmative by name. Never touches the DOM. Nothing about listening is imported until `enable()` runs. |
| [home-voice-ui.js](home-voice-ui.js) | `HomeVoicePanel` | The face of that loop, styled by [public/home-voice.css](../../public/home-voice.css): the opt-in explanation, a listening indicator driven by the live `MediaStreamTrack` rather than by a flag, one-tap mute that really stops the track, the wake-word picker, the confirmation card with the entity shown by name and id, and the measured latency legs against their budgets. |
| [vad.js](vad.js) | `VoiceActivityDetector`, `float32ToWav(samples, rate)`, `now()`, `VAD_FRAME_SAMPLES`, `VAD_SAMPLE_RATE`, `DEFAULT_REDEMPTION_MS` | silero-vad v5 (MIT) through `@ricky0123/vad-web`, lazily imported, reading a stream and an `AudioContext` the caller already owns so the loop never opens a second microphone. Surfaces every 512-sample 16 kHz frame, which is exactly what the wake word needs, and endpoints an utterance on 352 ms of trailing silence. |
| [wake-word.js](wake-word.js) | `WakeWordDetector`, `decideWake(input)`, `DEFAULT_THRESHOLD`, `WARMUP_MS` | openWakeWord v0.5.1 (Apache-2.0) run on onnxruntime-web against models committed under [public/models/voice/wake-word/](../../public/models/voice/wake-word): melspectrogram, embedding, then one classifier, one score per 80 ms. Primed with two seconds of silence at load so it is not deaf on arrival, and suppressed outright while the agent is speaking, which is what stops it waking on its own voice. |
| [wake-words.js](wake-words.js) | `WAKE_WORDS`, `DEFAULT_WAKE_WORD`, `wakeWordById(id)` | The four phrases and the honest note on each. Separate from the detector so the panel can render its picker without pulling onnxruntime into a page where listening has not been turned on. |
| [mic-capture.js](mic-capture.js) | `MicCapture` | Cross-browser raw-PCM mic capture for the NVIDIA Riva ASR lane (MediaRecorder's WebM/Opus is rejected by Riva). AudioWorklet with ScriptProcessor fallback, live RMS level for the mic meter, 16 kHz mono WAV output via `snapshotWav()` (interim) and `stop()` (final). This is why Firefox, which lacks `SpeechRecognition`, still gets voice input. |
| [lipsync-driver.js](lipsync-driver.js) | `LipsyncDriver`, `computeShape(bins, gain)`, `tapAudioElement(audioEl, context)` | Amplitude lipsync: reads an `AnalyserNode` each frame, derives `{ open, wide, round }` from band energy (no viseme timestamps needed for streaming TTS), smooths, and pushes into a mouth target. |
| [arkit-blendshapes.js](arkit-blendshapes.js) | `ARKIT_NAMES`, `ARKIT_GROUPS`, `VRM_TO_ARKIT`, `OCULUS_TO_ARKIT`, `PHONEME_TO_ARKIT`, `canonicalARKitName(name)`, `indexARKitMorphs(morphDict)`, `coverageOf(arkitIndex)`, `resolveShape(name)`, `blendShapes(...inputs)` | Pure data + helpers: the canonical ARKit 52-blendshape vocabulary and the cross-format maps (VRM, Oculus visemes, phonemes). No DOM, no three.js, no async. Everything that touches a loaded GLB imports from here. |
| [a2f-player.js](a2f-player.js) | `A2FPlayer`, `deriveExpressionWeight(arkitFrame, components)` | Plays an Audio2Face-3D blendshape track (`{ fps, blendShapeNames, frames }`) against a loaded GLB, sampled by the audio element's `currentTime`. Drives ARKit-named morphs directly and derives VRM/Oculus vowel shapes from the ARKit frame, so monolithic-vowel rigs still lipsync. Unknown conventions degrade to no coverage and the caller falls back to `LipsyncDriver`. Also used outside talk mode by [src/avatar-embed.js](../avatar-embed.js) and [src/agent-screen-anchor.js](../agent-screen-anchor.js). |
| [avatar-morph-target.js](avatar-morph-target.js) | `AvatarMouthTarget` | Adapter between a lipsync source and the GLB: scans the `Object3D` for mouth morphs (ARKit, VRM, generic names) and a jaw bone, translates `{ open, wide, round }` into morph weights and bone rotation. Safe to drive before the model attaches. |
| [camera-presets.js](camera-presets.js) | `CAMERA_PRESETS`, `PRESET_LABELS`, `computeFraming({ box, preset, aspectRatio })`, `nextPreset(current)` | Pure-math camera framing (`full`, `half`, `headshot`) from a bounding box. No three.js imports, unit-testable, portable to any renderer. |
| [prompt-dictation.js](prompt-dictation.js) | `mountPromptDictation(container, textarea, opts)` | Reusable "speak instead of type" mic button for any generation-prompt textarea (Forge, Scene Studio, sketch guidance). Same STT strategy as the talk loop; renders nothing when no STT path exists in the browser, so there is never a dead affordance. |
| [voice-setup.js](voice-setup.js) | `VoiceSetup`, `MIN_SAMPLE_SECONDS`, `MAX_SAMPLE_BYTES`, `audioDuration(file)`, `formatSeconds(n)`, `formatBytes(n)` | The one place a voice sample is captured and bound. Records from the mic or accepts an audio upload, validates length/size/type before anything leaves the browser, resolves which ElevenLabs credential is available (your saved key, the platform key, or neither) and renders inline key entry when neither is, then POSTs to `/api/agents/:id/voice/clone`. `bind: 'now'` clones immediately for an existing agent; `bind: 'later'` holds the sample so [/create-agent](../../pages/create-agent.html) can bind it the moment the agent exists. |
| [voice-clone-modal.js](voice-clone-modal.js) | `openVoiceCloneModal({ agentId, agentName, onClose })`, `closeVoiceCloneModal()` | Modal shell around [voice-setup.js](voice-setup.js) so the owner can clone their voice without leaving talk mode. |
| [avatar-snapshot.js](avatar-snapshot.js) | `captureSnapshotBlob(talkScene)`, `uploadAvatarSnapshot({ avatarId, scene })`, `SNAPSHOT_CONSTANTS` | Grabs a JPEG poster from the live WebGL canvas and pushes it through the existing presign-thumbnail plus auto-tag flow. |
| [wallet-intent.js](wallet-intent.js) | `WalletIntentController`, `isWalletCommand(text)` | Conversational wallet layer inside talk mode: a heuristic gate routes money-shaped utterances to `/api/agents/:id/solana/intent`, resolves amounts against real balances, previews the trade, and requires an explicit confirm (tap or "yes") before calling the same owner-only, spend-policy-gated trade/withdraw endpoints the wallet HUD uses. Nothing signs on its own path. |
| [eleven-key.js](eleven-key.js) | `getElevenKey()`, `setElevenKey(key)`, `clearElevenKey()`, `withElevenKey(headers)`, `maskElevenKey(key)` | Browser-only store for a user's own ElevenLabs API key (BYOK). The key lives in `localStorage` and rides voice requests as the `x-eleven-key` header; the server resolves it per request and never stores it, so BYOK calls run on the user's own ElevenLabs account. |
| [voice-browser.js](voice-browser.js) | `mountVoiceBrowser({ root, onSelect, onCatalog })`, `statusLine(message)`, `readLaneError(response)` | The multi-provider voice grid on [/voice](../../pages/voice.html). Reads `GET /api/tts/catalog` (Microsoft Edge, Gemini, NVIDIA, OpenAI, ElevenLabs in one shape) plus `GET /api/tts/eleven/library` for the public ElevenLabs Voice Library, and previews through `POST /api/tts/synthesize` so what you hear is what an agent will render. Search, language filter, provider pills with their billing rung, and a relevance order that puts the visitor's own language first and round-robins the providers. `onSelect` hands the pick to the playground; `onCatalog` hands the provider metadata over so the playground can show a model select and a style-direction field only where the lane supports them. Every nothing-to-show state carries its own way out: a failed catalog read offers Try again, a filter that matched nothing offers Clear filters, and a preview whose failure names the lane rather than the clip (`lane_unavailable`, `invalid_key`, `not_configured`, or any `503`) triggers a cache-skipping catalog re-read, so those voices leave the grid while the reason stays on screen. `statusLine` is the guard that keeps a vendor's multi-line error body out of a one-line status; `readLaneError` pulls out the written sentence plus whether the lane itself is down. |

## Install / use

Nothing to install; these are plain ES modules bundled by Vite. Import from a sibling under `src/` and run the dev server:

```
npm run dev
# open http://localhost:3000/avatars/<id> and press Talk
```

Server-side counterparts (already deployed, no setup needed in the client): [api/asr.js](../../api/asr.js) (Riva ASR), [api/tts/](../../api/tts) (`edge.js`, `eleven.js`, `speak.js`, `voices.js`, `eleven-clone.js`), and [api/_lib/a2f-nvidia.js](../../api/_lib/a2f-nvidia.js) (Audio2Face). The reusable server package lives at [packages/voice/](../../packages/voice).

## Example

The real entry point, as wired in [src/avatar-page.js](../avatar-page.js) (talk-mode entry section):

```js
import { openTalkMode } from './voice/talk-mode.js';

// Opens the live-voice overlay: three.js renderer + lipsync + push-to-talk.
// Implementation lives in src/voice/talk-mode.js so this page only needs the
// click handler and a system-prompt provider.
function enterTalkMode() {
	if (!avatar) return;
	openTalkMode({ avatar, systemPromptFn: buildSystemContext });
}
```

`avatar` is the decorated record from `GET /api/avatars/:id` (needs `model_url`, or a `glbBlob` for in-memory previews; see `openVoicePreview` in [src/create-review-features.js](../create-review-features.js)). `systemPromptFn` returns the system prompt string for `/api/chat`. The returned session handle can be closed programmatically, or the user closes it with the close button or Escape.

## Consumers

- [pages/voice-home.html](../../pages/voice-home.html) + [src/voice-home.js](../voice-home.js): `/voice/home`, the hands-free surface for a connected house. See [docs/home-voice.md](../../docs/home-voice.md).
- [src/avatar-page.js](../avatar-page.js): Talk button on `/avatars/:id`.
- [src/create-review-features.js](../create-review-features.js): voice preview of a just-generated avatar before saving.
- [src/forge-studio/talk-launch.js](../forge-studio/talk-launch.js) and [src/forge-studio/forge.js](../forge-studio/forge.js): talk launch plus dictation on the Forge prompt fields.
- [src/create-prompt.js](../create-prompt.js): dictation on the create-page prompt.
- [src/avatar-embed.js](../avatar-embed.js), [src/agent-screen-anchor.js](../agent-screen-anchor.js): `A2FPlayer` outside talk mode.
- [apps-sdk/embodiment/](../../apps-sdk/embodiment): the embodiment stage reuses the lipsync cores (see the Embodiment row in [STRUCTURE.md](../../STRUCTURE.md)).

## Tests

```
npm test
```

Covered by [tests/a2f-player.test.js](../../tests/a2f-player.test.js), [tests/arkit-blendshapes.test.js](../../tests/arkit-blendshapes.test.js), [tests/lipsync-driver.test.js](../../tests/lipsync-driver.test.js), [tests/camera-presets.test.js](../../tests/camera-presets.test.js), [tests/talk-emotes.test.js](../../tests/talk-emotes.test.js), [tests/conversational-wallet-intent.test.js](../../tests/conversational-wallet-intent.test.js), and [tests/home-voice.test.js](../../tests/home-voice.test.js).

The hands-free loop also has a browser proof that runs the real models against real speech in a real Chromium:

```
npx vite --port 3457
node scripts/check-home-voice.mjs --port 3457
```
