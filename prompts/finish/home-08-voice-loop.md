# 08. The browser voice loop: wake word, barge-in, latency

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[04](home-04-agent-tools.md) and [06](home-06-3d-home-scene.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
wc -l src/voice/talk-mode.js src/voice/mic-capture.js src/voice/talk-controller.js
curl -s localhost:3000/api/asr | head -c 300              # the ASR lane and whether it is configured
ls api/tts/                                               # speak.js, synthesize.js, voices.js
grep -rn "openWakeWord\|silero\|vad" src/ package.json | head
```

`api/asr.js` runs on NVIDIA NIM Riva and reports `configured` on a GET. Read that before
assuming anything about the speech lane.

## What this order owns

Hands-free operation of the house from a browser that is already open: a wake word, always-on
listening the user actually consented to, barge-in, and a latency budget tight enough that
speaking is faster than reaching for a phone. It reuses `src/voice/` rather than building a
second voice stack.

It does **not** own being a Home Assistant satellite; that is order 09.

## The pipeline

```
mic → VAD (silero-vad) → wake word (openWakeWord) → capture → ASR (/api/asr)
    → agent turn (api/chat.js with the order 04 home tools) → TTS (/api/tts/speak)
    → lip sync (src/voice/lipsync-driver.js) → the 3D agent speaks
```

Both models are permissively licensed and run in the browser:
[silero-vad](https://github.com/snakers4/silero-vad) (MIT) and
[openWakeWord](https://github.com/dscripka/openWakeWord) (Apache-2.0). Follow the CLAUDE.md
open-source rule: use them, do not write a detector. Load them lazily; nothing about wake-word
detection may run before the user turns it on.

## The latency budget (measure every leg, report every number)

| Leg | Budget | Note |
|---|---|---|
| Wake word detection | under 200 ms from the end of the word | this is what makes it feel alive |
| End-of-speech detection | under 400 ms of trailing silence | longer feels broken, shorter clips people |
| ASR round trip | under 900 ms for a short utterance | measure against the real lane, not a local model |
| Agent turn to first tool call | under 1.2 s | |
| Action to observed device change | under 700 ms | mostly Home Assistant's own latency |
| First audible response | under 1.8 s from end of speech | the number a user actually feels |

If a leg misses, report the measured number rather than hiding it. A published honest budget is
worth more than a passed invented one.

## Barge-in

The agent must stop talking the instant the user starts. Full duplex: playback and capture run
together, the VAD runs during playback, and detected speech cancels the current utterance,
truncates the TTS stream, and starts a new capture. Echo cancellation via `getUserMedia`
constraints (`echoCancellation`, `noiseSuppression`, `autoGainControl`), and a self-trigger guard
so the agent's own voice cannot wake it.

## Consent, privacy and the microphone

This is the part that decides whether anyone trusts the product.

- Always-on listening is **off by default** and requires an explicit, informed opt-in that says
  what is processed locally and what leaves the device.
- Wake-word detection is local. Audio leaves the device only after the wake word, and only for
  the utterance.
- A permanent, unmissable listening indicator whenever the mic is live, in the page and in the
  3D scene. It is never hidden, never subtle, and never removable by a setting.
- One-tap mute that physically stops capture, not a flag that hides the indicator.
- Nothing is retained: no utterance audio is stored server-side beyond the request. If a
  transcript is kept for the conversation, say so and let it be cleared. Order 15 owns retention;
  this order must not create a data class it did not declare.
- Recovery from a denied permission is designed, not a dead end.

## Confirmation in voice (the dangerous part)

Order 04's protocol crosses into speech here, and this is where it can go wrong.

- A guarded action is spoken back in full before it is confirmed: "This will unlock the front
  door. Say confirm to continue." Never "OK?" and never a yes/no on an unnamed action.
- The confirmation grammar is a narrow, explicit token, not a general affirmative. A background
  "yeah" in a conversation must not unlock a door.
- The confirmation is bound to the minted `confirmationId` from order 04, expires with it, and is
  single use.
- The 3D scene shows the pending entity while the confirmation is outstanding (order 06 state 8),
  so the user sees what they are agreeing to. **Voice alone never satisfies a guarded action on a
  device with no display.** On a screenless surface, a guarded action is refused with a clear
  reason and an offer to confirm on the phone.
- ASR is not reliable enough to be the only gate on a door. Say that out loud in the code comment.

## Every state

1. Off (the default), with the opt-in explained.
2. Permission not yet granted.
3. Permission denied: recovery instructions per browser.
4. Idle and listening for the wake word.
5. Woken and capturing.
6. Thinking.
7. Speaking (with barge-in armed).
8. Barged in.
9. Confirmation pending, spoken and shown.
10. ASR unavailable (`configured: false`, or the lane is down): the whole voice path degrades to
    text with an honest reason, and never pretends to listen.
11. Muted.
12. Error.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Lazy-loaded VAD and wake word, with the models served from our own origin. | `src/voice/wake-word.js`, `src/voice/vad.js` |
| 2 | The full-duplex loop with barge-in, on top of `src/voice/mic-capture.js`. | `src/voice/home-voice.js` |
| 3 | The consent flow, the indicator and mute. | same, plus styles |
| 4 | The home turn: wiring the order 04 tools into the voice path with the spoken confirmation grammar. | same |
| 5 | Latency instrumentation, emitting every leg. | same |
| 6 | All twelve states. | as above |
| 7 | Tests: the confirmation grammar (a general "yeah" must not confirm), the self-trigger guard, the degraded path. | `tests/home-voice.test.js` |

## Definition of done

- [ ] A recorded run: wake word, "turn the kitchen light off", the real light goes off, the agent says what it did. Report every leg's measured latency against the budget table.
- [ ] A recorded barge-in: the agent is speaking, the user talks, playback stops within 200 ms.
- [ ] A recorded guarded action: the full sentence is spoken, the scene shows the entity, an ambient "yeah" does **not** confirm, the explicit token does, and the real door unlocks.
- [ ] The self-trigger proof: the agent says its own wake word and does not wake itself.
- [ ] The listening indicator is visible in every frame where the mic is live. Prove it with a frame sample.
- [ ] Mute stops capture at the track level (`track.readyState`), not at a flag. Prove it.
- [ ] `configured: false` on `/api/asr` degrades to state 10 with an honest message and no fake listening.
- [ ] Nothing about wake-word detection loads before opt-in. Prove it with the network tab on a cold load.
- [ ] Screenshots of all twelve states.
- [ ] `npx vitest run tests/home-voice.test.js` passes.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| The ASR lane is unconfigured locally | `curl /api/asr` reports it. Build against the real lane where a key exists; where it does not, build the full path and prove state 10 works. Never mock the transcript. |
| Wake-word accuracy is poor for a chosen phrase | openWakeWord ships pre-trained models. Pick from what exists before training anything, and let the user choose among them. |
| Barge-in triggers on the agent's own voice | That is the self-trigger guard, and it is required, not optional. Echo cancellation plus a playback-aware gate. |
| Someone proposes letting voice alone confirm an unlock on a screenless device | Refuse, and keep the refusal in the code with its reason. ASR is not a gate on a door. |
| Latency misses a budget line | Report the real number. Then optimize the worst leg and re-measure. Do not quietly widen the budget. |
| Always-on listening feels like a privacy problem | It is one, which is why it is off by default, locally gated, indicated permanently, and mutable in one tap. Build all four before shipping any of it. |

## Report format

1. The three recordings (happy path, barge-in, guarded confirmation) with the leg-by-leg latency table.
2. The self-trigger and mute proofs.
3. The cold-load network tab proving nothing loads before opt-in.
4. The twelve state screenshots.
5. Test output.
6. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-08-voice-loop.md

Never delete it on a partial.
