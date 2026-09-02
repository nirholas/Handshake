---
venue: NVIDIA Developer Forums (community showcase)
account: three.ws (official)
suggested_title: "A digital human in a browser tab: streaming Audio2Face-3D onto whatever rig the visitor brought"
description: "How three.ws drives real-time facial animation on a WebGL avatar from NVIDIA Audio2Face-3D over NVCF gRPC, with Magpie TTS in front and Riva ASR behind it, and how we map an ARKit-52 blendshape track onto VRM and Oculus rigs that were never built for it. Measured latencies from production."
tags: [ace, audio2face, riva, magpie, nim, digital-humans, webgl, inception]
canonical: https://three.ws/docs/nvidia-forum-browser-digital-human.md
status: draft, owner approval required before posting (external-channel gate in CLAUDE.md)
---

# A digital human in a browser tab

I run [three.ws](https://three.ws). You type a sentence, a rigged 3D character appears, and then it talks to you. I have written here twice before: once about [Nemotron in front of the text-to-3D generator](https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445), once about [NIM driving a 100-language i18n pipeline](https://forums.developer.nvidia.com/t/how-three-ws-translates-a-web-app-into-100-languages-with-nvidia-nim-an-llm-powered-i18n-pipeline/377379). This one is about the face.

Audio2Face-3D is usually shown inside Unreal or Omniverse Kit, driving a character somebody built on purpose. We run it in a browser tab, with no install and no engine, driving a character the visitor generated ninety seconds earlier from a text prompt. That second constraint turned out to be the whole problem: the avatar's rig is not ours, and we do not get to pick its blendshape convention.

Live, no signup: [three.ws/demos/audio2face](https://three.ws/demos/audio2face). Everything below is checkable in the [open-source repository](https://github.com/nirholas/three.ws).

## The loop

Three NVIDIA-hosted models on one face, all reached with one `nvapi-` key:

- **Riva ASR** takes the visitor's microphone audio and returns text ([api/_lib/asr-nvidia.js](https://github.com/nirholas/three.ws/blob/main/api/_lib/asr-nvidia.js)).
- **Nemotron**, through the NIM APIs, writes the reply, with NemoGuard content safety on any publicly reachable agent.
- **Magpie TTS multilingual** speaks it, nine languages, personas held constant across languages so a character keeps its voice when it switches ([api/_lib/tts-nvidia.js](https://github.com/nirholas/three.ws/blob/main/api/_lib/tts-nvidia.js)).
- **Audio2Face-3D** turns that exact audio into a per-frame blendshape track ([api/_lib/a2f-nvidia.js](https://github.com/nirholas/three.ws/blob/main/api/_lib/a2f-nvidia.js)).

All four are NVCF gRPC functions on `grpc.nvcf.nvidia.com:443`, selected by a `function-id` metadata entry with the key as a bearer `authorization` entry. Magpie has no REST surface at all, so gRPC is not a preference here, it is the only door.

One wrinkle worth passing on if you are calling NVCF from a serverless runtime: our `api/` handlers are esbuild-bundled in place, so a `.proto` file does not reliably exist on the filesystem at call time. We vendor the ACE and Riva protos and load them from a generated JSON descriptor instead. Three separate descriptors, because the ASR, TTS, and A2F services do not share one.

## The audio contract, and the resampling trap

A2F-3D is trained on 16 kHz mono 16-bit PCM. Magpie emits 44.1 kHz. So the server decodes the WAV, downmixes to mono by averaging (summing gives you a free 6 dB of clipping), and resamples to 16 kHz with linear interpolation. Speech feature extraction does not need a windowed-sinc kernel to hold formant cues, and we could not hear or measure a difference in the resulting track.

The trap is what you play back. It is tempting to hand the browser the 16 kHz copy you already made, because it is right there. Do not: the visitor then hears a downsampled voice for no reason. A2F returns time codes in **seconds from clip start**, independent of the sample rate it consumed, so the browser plays the original 44.1 kHz Magpie audio and samples the track by the audio element's `currentTime`. The lips track the real voice, not the copy you fed the model.

The service is a bidirectional stream (`nvidia_ace.services.a2f_controller.v1.A2FControllerService/ProcessAudioStream`): client sends an audio header, PCM chunks, and an end-of-audio marker; server sends an animation header carrying the ordered blendshape names, then animation-data frames. 30 inferences per second of audio, so 30 fps out.

## Measured, against production, today

One line of speech, 4.64 seconds of audio, from the public endpoint:

| Path | Round trip |
|---|---|
| Audio in, animation out (`POST /api/a2f` with a WAV) | 1.29 s, 1.31 s, 2.26 s |
| Text in, speech and animation out (Magpie then A2F, one call) | 1.88 s, 3.35 s, 3.41 s |

So A2F-3D animates a 4.6 second clip in roughly a third of its duration, and Magpie adds around 0.6 to 1.1 seconds on top. The returned track is 140 frames at 30 fps carrying **55** blendshape weights: the ARKit-52 set plus three tongue shapes. Sixty seconds of audio is our hard ceiling per request, which is about 1.9 MB of PCM and 1800 frames, generous for a line of avatar dialogue and small enough that one request cannot pin a serverless instance.

## The part nobody warns you about: the visitor's rig

Our avatars come from a text prompt, a photo, or a GLB the visitor uploaded from somewhere else entirely. That means the face we have to drive might expose ARKit-52 morphs, or VRoid's vowel shapes, or Meta's `viseme_*` set, or nothing usable at all. A2F speaks ARKit. Half of the web does not.

We had already solved the same shape of problem for skeletons: [glb-canonicalize.js](https://github.com/nirholas/three.ws/blob/main/src/glb-canonicalize.js) maps Mixamo, Avaturn, Unreal, VRM, Daz, MakeHuman and plain `.L` bone conventions onto one canonical rig so the animation library retargets onto anything humanoid. The face version lives in [src/voice/arkit-blendshapes.js](https://github.com/nirholas/three.ws/blob/main/src/voice/arkit-blendshapes.js) and [src/voice/a2f-player.js](https://github.com/nirholas/three.ws/blob/main/src/voice/a2f-player.js), and it runs in two modes per mesh:

**Direct.** The morph name canonicalizes to an ARKit shape (`jawOpen`, `JawOpen`, `jaw_open`, and the RPM, Avaturn, and MetaHuman spellings all land on the same canonical name). The A2F weight is written straight to it.

**Derived.** The mesh only has monolithic expressions: VRM's `Aa`, `Ih`, `Ou`, `Ee`, `Oh`, or Oculus's `viseme_PP`, `viseme_FF`, `viseme_CH`. We hold a forward map from each of those to its ARKit components (20 VRM entries, 15 Oculus entries), and at playback we run that map **backwards**: an expression's activation is the normalized sum of the ARKit weights it is made of, taken from the A2F frame. A rig that only knows five vowels still lip-syncs, because the vowel is reconstructed out of the ARKit frame rather than looked up from a phoneme we never received.

Two details that only show up once you run this on real uploads:

1. If a mesh already has direct mouth coverage, do not also drive its vowel morphs. Both fire, both open the jaw, and the lips visibly overshoot. We check for direct mouth or jaw coverage first and skip the derived pass on that mesh.
2. A2F gives you 30 fps and a browser paints at 60 or 120. Interpolate between frames by the audio clock rather than holding the last frame, or the mouth reads as stepped at exactly the moment a viewer is looking at it.

And there is no allowlist. A rig we cannot map is reported as "no coverage" and the caller falls back to in-browser amplitude lipsync. A face that moves approximately is worth a great deal more than a face frozen in bind pose, and the failure has to be graceful because we cannot audit every GLB on the internet in advance.

## Operational notes

**Function ids rotate, and they fail closed.** Our A2F default used to be the "James" id from NVIDIA's own sample client. It stopped resolving with `NOT_FOUND: Function ... not found for account`, and the whole lipsync lane started returning 502. The fix is not clever, it is procedural: keep a `--list` script that enumerates `GET api.nvcf.nvidia.com/v2/nvcf/functions` so you can see which ids your key actually resolves, pin the constant, and allow a per-deployment override env var. Riva ASR we never pin at all, because which hosted recognizer a deployment wants genuinely varies (Parakeet CTC, RNN-T, Canary), and an unset id reports the lane as absent instead of guessing one.

**One error vocabulary across all three lanes.** gRPC status codes are normalized numerically (not by importing the grpc-js constants) into `invalid_key`, `rate_limited`, `invalid_argument`, `timeout`, `provider_unreachable`, `provider_error`, `not_configured`, identically in the ASR, TTS, and A2F modules. When a face stops moving at 2 a.m. you want to know whether the key died or the deadline blew, from the same field name in all three.

**The lane is additive by construction.** With no `NVIDIA_API_KEY` set, the avatar still speaks and still moves its mouth, just with the amplitude fallback. Nothing in the product hard-depends on the A2F path, which is what made it safe to ship at all.

## Why the browser mattered

The reason to do this in WebGL instead of an engine is distribution. Our whole embed surface is one script tag: `<agent-3d>` on any page, and the avatar on that page listens with Riva, thinks with Nemotron, speaks with Magpie, and moves its face from Audio2Face-3D. No plugin, no download, no runtime for the site owner to install. The bodies themselves come off our own NVIDIA GPU fleet on Cloud Run, mostly L4s with one RTX PRO 6000 Blackwell for the heavy image-to-3D lane, which I wrote about separately.

Happy to go deeper on any of it, particularly the derived-blendshape path, which I have not seen written up anywhere and which took the longest to get right. three.ws is an NVIDIA Inception member.
