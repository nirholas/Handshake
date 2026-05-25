# Task 16 — Walk Page: Two-Way Voice Chat with the Avatar

## Priority: HIGH

## Objective
Let the user hold a button (push-to-talk) and have a real voice conversation with their walking avatar. The avatar listens (mic → STT), thinks (LLM), speaks (TTS), animates lip-sync, and uses gestures from task 14 to react.

## Scope
- New module: `src/walk-voice-chat.js`
- Mic capture:
  - `navigator.mediaDevices.getUserMedia({ audio: true })`
  - Push-to-talk: hold `T` (desktop) or large mic button on mobile
  - Visual: pulsing ring around mic button while recording; waveform showing input level
- STT:
  - Use existing transcription endpoint if one exists in `api/` (search for `whisper`, `transcribe`, `stt`); if not, build `api/voice/transcribe.js` using OpenAI Whisper API (key from env `OPENAI_API_KEY`)
  - Upload recorded blob, get transcript back
- LLM:
  - POST to existing chat endpoint (search `api/chat/` and `api/agents/`) with the transcript and avatar's persona/system prompt (the avatar's `meta.persona` from `/api/avatars/<id>`)
  - Receive response text (stream if endpoint supports SSE)
- TTS + bubble:
  - Feed response into `walk.say(response, { voice: true, gesture: 'talking' })` from task 15
- Lip sync (best-effort):
  - If the avatar has visemes/blendshapes (Wolf3D / RPM-style), use audio amplitude → jaw open mapping
  - Use Web Audio `AnalyserNode` on the playing TTS audio to drive `viseme_aa` blendshape
- Conversation memory:
  - Keep last 10 turns in `walk-voice-chat.js` state
  - Send full context to LLM each turn

## Definition of Done
- Hold `T`, say "What's your name?" → avatar speaks back with a real LLM-generated response, lips move, talking gesture plays
- Conversation maintains context across multiple turns
- No mocks: real STT, real LLM, real TTS
- Mic permission errors handled gracefully with a real CTA to fix permissions

## Rules
Complete 100%. No stubs. No fake data. Real APIs throughout — Whisper, the chat backend, the TTS endpoint. Verify in a real browser with mic permission.
