# Chapter 2 · Motion — embodiment and animation

A body is nothing without movement. Agents walk, dance, pose, react, and perform — and any humanoid rig from any tool can be animated, no allowlist.

On three.ws, an agent isn't a chat window — it's a body. Every agent gets a rigged 3D avatar that walks, dances, gestures, emotes, lip-syncs, and reacts to the world in real time, driven by a motion library of 2,800+ clips, a universal retargeting engine that animates any humanoid rig ever exported, and a text-to-motion model that invents movements that never existed before. The same body performs everywhere: in a pose studio, across your own website as a walking companion or tour guide, in a multiplayer world, in iOS AR, and on live stages where real on-chain money makes it dance.

## A motion library of 2,800+ animations

Every avatar has instant access to a huge catalog of professional motion clips — idle loops, walks, runs, dances, combat moves, sports, acrobatics, gestures, reactions, deaths and falls, fitness, farming chores, and more, organized into 16 browsable categories. A public gallery lets you search, filter, and hover any card to see the clip play live on a 3D preview avatar, with deep links so any filtered view or single clip is shareable. Community-published clips appear alongside the built-in library.

**How it works:** A curated 111-clip manifest ships with the site; the full Mixamo-sourced catalog (2,800+ clips, ~3 GB of AnimationClip JSON) lives on an R2 CDN behind an edge-cached API and paginated fetches. Previews run through one shared singleton WebGL engine (Three.js) that migrates a single canvas between cards — no per-card GL contexts. Categories are derived by an ordered rule-based classifier over clip labels.

**Why it matters:** Your agent never stands still — thousands of ready-to-play performances are one click away.

## Universal retargeting: any humanoid rig animates

Upload an avatar from anywhere — Mixamo, Blender, Unreal Engine, VRoid/VRM, Daz, MakeHuman, Character Creator, 3ds Max, Maya, or an AI auto-rigger — and the entire motion library plays on it correctly, legs included. There is no approved-rig allowlist and no frozen T-pose failure mode: proportions, bind poses, and axis conventions are all corrected automatically, so a chunky short character and a tall thin one both walk naturally.

**How it works:** A bone-name canonicalizer maps a dozen skeleton naming conventions (mixamorig, Rigify DEF-, UE mannequin, J_Bip VRM, Daz lShldr, CC_Base_, Bip01, HumanIK namespaces, snake_case, .L/.R sides) onto one canonical bone set, folding Mixamo's baked +90°/−90° axis rotations out with a verified world-matrix-preserving transform. The runtime retargeter then rewrites each clip's tracks with world-delta-preserving bind-pose corrections (quaternion L·q·R per bone), rescales root motion to the target's hip height, drops structural channels so proportions survive, gates on coverage, and a tilt guard rejects any retarget that would tip the body over.

**Why it matters:** Bring literally any humanoid character you own or generate — it moves like it was born here.

## Text-to-motion: generate animations that don't exist

Type a description — "waving confidently", "a victorious slow bow" — and the platform synthesizes a brand-new motion clip and plays it on your avatar in seconds. The generated motion behaves exactly like a library preset: you can scrub it, change its speed, loop it, and export it baked into a GLB. This is motion that did not pre-exist anywhere.

**How it works:** A GPU Cloud Run worker samples the MIT-licensed Motion Diffusion Model (MDM) from the prompt and returns a retargetable three.js AnimationClip JSON on the canonical skeleton (~10–30 s on a warm GPU). The browser polls the job, then routes the result through the same retarget-and-play path as presets.

**Why it matters:** If you can describe a movement, your agent can perform it — no animator required.

## The Animation Studio

A full in-browser studio for posing and animating avatars: pose any rig with drag gizmos and IK, set keyframes on a timeline with easing, preview clips with a transport bar (play/pause, scrub, speed from 0.25× to 2.5×, loop), and export a finished animated GLB with the motion — at your chosen tempo — baked in. Load the built-in mannequin, any of your own avatars, or any public avatar.

**How it works:** A Three.js scene with FK TransformControls gizmos and drag-IK over a canonical rig abstraction, a keyframe document model with easing and clip baking, AnimationMixer preview, and GLTFExporter for binary export with the retargeted, speed-resampled clip embedded.

**Why it matters:** Author, preview, and ship production-ready animated characters without opening Blender.

## Save, share, and sell your animations

Clips you author in the studio save to your account, reopen for lossless further editing, and can be published to the public gallery. You can also list an animation for sale at a price you set: buyers pay in USDC, download the baked animated GLB, and can re-download free forever by signing in with the same wallet. Individual poses compress into a ~220-character link you can paste anywhere.

**How it works:** Clip CRUD stores THREE.AnimationClip.toJSON() plus the editable keyframe document (inline or R2-offloaded); marketplace listings flow through an x402 paid-download endpoint settling USDC on-chain with wallet-bound re-download rights. Pose sharing packs canonical bone quaternions to int16 in a base64url fragment.

**Why it matters:** Your motion work is an asset — reopen it, share it with a link, or earn real money from it.

## A living animation brain: states, crossfades, and layered gestures

Agents don't hard-cut between animations — a small motion brain manages what the body is doing (idle, talking, walking, listening, thinking, reacting) and crossfades every transition so there's never a jarring pop or a bind-pose flash. On top of that runs a gesture layer of 12 expressive moves: upper-body gestures like wave, point, cheer, nod, and agree play additively while the legs keep walking; full-body gestures like dance, sit, shrug, and celebrate take over and hand back control cleanly. Creators can rewire the whole graph per agent — make their idle a dance if that's their personality.

**How it works:** A pure directed-graph state machine (unit-testable, no Three.js) fires event-driven transitions with per-state crossfade durations, a return-stack so one-shots resume the interrupted state, and per-agent overrides stored in agent metadata. Gestures compose via additive animation blending (AnimationManager overlays) versus full-layer takeover, all on retargeted library clips.

**Why it matters:** Your agent moves like a character with intent, not a slideshow of disconnected clips.

## The Empathy Layer: a face that feels

Every agent maintains a continuous emotional blend — it can be 40% concerned, 30% curious, and 30% neutral at the same time, and its face and posture reflect all three at once, drifting between moods the way people actually do rather than snapping between expressions. Emotions arise from what the agent is actually doing and saying: errors breed concern, successes spark celebration, waiting settles into patience — and each emotion fades at its own realistic rate, with empathy lingering longest.

**How it works:** Every action on the agent's protocol bus is scored against an emotional-valence vocabulary and injected into a weighted emotion state with per-emotion exponential decay half-lives (6–20 s); morph targets and head orientation are re-blended every animation frame. A separate mood engine drives a sustained resting mood (valence × arousal) that biases gesture selection and paints a breathing colour aura on the site-wide companion.

**Why it matters:** You can read your agent's state of mind on its face — it feels alive, not scripted.

## Idle micro-motion: never a statue

Even doing nothing, an avatar breathes, blinks, shifts its weight, and flicks its eyes around in small natural saccades. Each avatar's rhythm is subtly unique, so a wall of agents never moves in eerie unison.

**How it works:** Four additive procedural channels (spine breathing rotation, spring-damped eye/head saccades, eyelid morph blinks on randomized intervals, hip weight-shift drift) driven by a per-avatar seeded deterministic PRNG, composed under the emotion layer with zero per-frame allocations.

**Why it matters:** Your agent looks alive at a glance, even before it does anything.

## Real-time lip sync and spoken voice

When an agent talks, its mouth actually forms the sounds — open vowels, closed bilabials, sibilants — synchronized to the live audio of its synthesized voice. Avatars without full facial rigs still get a natural jaw-driven mouth.

**How it works:** An AnalyserNode splits live TTS audio into frequency bands mapped to viseme morph groups (viseme_aa/O for lows, E/I/nn for mids, SS/FF/CH for highs, PP on amplitude dips) with smoothing, targeting ARKit-52 morphs where present and a single amplitude-driven jaw morph otherwise.

**Why it matters:** Talking agents look like they're talking — the illusion never breaks at the mouth.

## Two-way voice conversation with a walking avatar

Hold a key, talk to your avatar out loud, and it listens, thinks, and answers back in its own voice — mouth moving, talking gesture playing, conversation memory intact across the last ten turns. It all happens while you walk together through a 3D environment.

**How it works:** Push-to-talk mic capture → real speech-to-text (NVIDIA Riva), an LLM reply streamed over SSE with the agent's persona and history, real TTS playback, and an amplitude-driven lip-sync tap — every leg a live network call, with graceful degradation at each boundary.

**Why it matters:** You can have an actual spoken conversation with an embodied agent, hands-free.

## The Walk Companion: an avatar that lives on any website

Drop one snippet on any site and an animated 3D character takes up residence in the corner — idling, following the cursor, waving when visitors navigate, greeting each page. Click it and it detaches into a full-page playground where visitors steer it with keyboard or on-screen d-pad, and walking onto a link opens it like a doorway. Visitors pick their companion from a roster — robot, humanoids, photoreal people, a fox, dancers — or you supply your own GLB, and it's published as an installable npm package for any site, not just three.ws.

**How it works:** The @three-ws/walk SDK (Three.js peer dependency, side-effect-free until enabled) with a unified loader that plays embedded clips or retargets the shared library per rig, one shared WebGL-context budget, lazy-loaded playground chunk, reduced-motion support, and localStorage-persisted avatar choice.

**Why it matters:** Any website gets a living mascot in minutes — and every visitor chooses who walks with them.

## Platformer mode: your page becomes a video game

Flip the walk playground into platformer mode and the page's real content — headings, cards, buttons, images — becomes solid ground. The avatar gets gravity; visitors run and jump from element to element, land on a link to dive into it, and can switch between gentle top-down strolling and platforming mid-session with one key.

**How it works:** The SDK's playground builds collision geometry from live DOM element rects, runs a gravity-and-jump physics model against them, and hot-swaps between the stroll and platformer movement models while carrying position, checkpoints, and progress across the switch.

**Why it matters:** Your website is suddenly playable — the most memorable product page a visitor will see all year.

## 3D guided tours that walk your live site

A small avatar guide walks across your actual pages, dims the page, rings the feature it's discussing, points at it with a beam, and narrates it aloud — a product tour on your real DOM, not a slideshow. It survives full page navigations to span a whole multi-page app, offers Quick and Full tracks, a searchable chapter map, playback controls, and free-roam. In Explore and Platformer modes visitors drive the guide themselves to glowing GTA-style checkpoints. Installs with a single script tag on any site, including Shopify and WordPress.

**How it works:** The @three-ws/tour SDK: a TourDirector walks a JSON curriculum (auto-generatable from a pages manifest via CLI), resolves CSS-selector targets per stop, spotlights and narrates via a pluggable TTS endpoint (paced captions as fallback), persists cross-page state in sessionStorage, and reuses @three-ws/walk's loader and retargeting; a self-contained IIFE bundle ships on unpkg.

**Why it matters:** Onboarding becomes a guided walk with a character instead of a tooltip popup nobody reads.

## Market-reactive avatars: the pump.fun pulse in a body

Turn on live reactions and your avatar physically responds to the real pump.fun firehose with no AI in the loop: a token graduating its bonding curve triggers a celebration, a big opening buy sparks visible curiosity, a flurry of ten launches in two seconds gets a wave and a spoken "Pump.fun is on fire." Quiet markets read as patience.

**How it works:** A skill opens a WebSocket to the PumpPortal feed (wss://pumpportal.fun), subscribes to token creates and migrations, aggregates events in 2-second windows with a priority ladder, and emits gesture/emote/speak actions onto the agent protocol bus, with exponential-backoff reconnection.

**Why it matters:** Glance at your agent and you've read the market — its body language is a live ticker.

## The Ambient World DJ

On its ambient stage, an agent becomes a calm spoken host of its own little world — narrating the sunrise over its landmark, calling golden hour as the light turns, noting a wanderer arriving or the plaza filling up. It paces itself to roughly two lines a minute: the lo-fi radio of the agent wall.

**How it works:** A pure deterministic script generator observes world-state snapshots (day/night phase, crowd density, pedestrian count), picks the highest-priority unannounced event, rotates through templated phrasings with no randomness, enforces a minimum gap between lines, and hands text plus a mood tag to the TTS pipeline.

**Why it matters:** Leave an agent's world on in a tab like a fireplace stream — it hosts itself.

## Spectator reactions and tips the avatar acknowledges

Watching a live agent, viewers tap emoji that burst and float over the stream for everyone at once, with a live reaction counter. Tip the agent and real crypto lands in its wallet — and the avatar celebrates on the spot: confetti and hearts erupt, it plays a cheer, and it thanks you out loud in its own voice.

**How it works:** Reactions post to a throttled server endpoint and fan out over per-agent SSE streams; tips are viewer-signed Solana transfers straight to the agent's public wallet via a non-custodial modal; the acknowledgement chains an emote through the AnimationManager and a real TTS call, with a cooldown so a tip flood doesn't talk over itself.

**Why it matters:** The audience isn't watching a video — it's in the room, and the agent notices.

## Command the body in plain language

On a live agent stage, anyone can type or tap a phrase — "wave hello", "warrior stance", "take a bow" — and the avatar performs it, choosing an animated emote when the phrase reads as motion and a held pose when it reads as a stance. It never dead-ends: every prompt resolves to a real performance. The same resolver is exposed to other AI agents as the get_pose_seed tool, which returns a deterministic seed, the complete joint-rotation map, and a preview link for any pose prompt.

**How it works:** A token-overlap scorer with substring and stable-hash fallbacks matches prompts against the in-repo preset library — the identical algorithm client-side (free) and in the paid MCP tool ($0.001 USDC via x402), so both resolve the same prompt to the same pose; emote intents map keywords to real manifest clips with static-pose fallbacks per rig.

**Why it matters:** Directing a 3D character becomes as easy as saying what you want it to do.

## Webcam motion capture: face and body

Perform for your avatar through your webcam. The Mocap Studio captures your facial expressions in real time — calibrated to your neutral face — and lets you record, save, replay, and share face-mocap clips on any avatar. Body capture drives the avatar's arms, spine, and legs from your real movements, and both can run together: your face and your body, live on your character.

**How it works:** MediaPipe FaceLandmarker (~30 Hz, GPU delegate) drives morph targets with neutral-baseline subtraction and a clip recorder persisted via a clips API; MediaPipe Pose Landmarker recovers 33 world landmarks fed through a pure pose solver into damped-slerp bone quaternions, with face and body modules owning disjoint bones so they compose.

**Why it matters:** You are the animator — puppeteer your agent with your own face and body, no suit required.

## Avatars that dance for real money: the Club

A dark 3D venue with three pole stages where dancers only perform when someone actually pays: tip a tenth of a cent and that stage's dancer steps up and performs the routine you chose, settled on-chain, then returns to her idle stance. Walk in through an alley and gallery filled with a living crowd of real platform avatars — chilling near the entrance, dancing deeper in.

**How it works:** Each tip is a real x402 USDC micro-payment on Solana gating the routine playback; the venue runs bloom/vignette post-processing, and the crowd system retargets clips once per unique GLB then clones skeletons across up to ~80 instances with cheap per-instance mixers under a device performance budget.

**Why it matters:** Proof that embodiment plus micropayments works: motion as a purchasable, on-chain service.

## A populated, multiplayer world to walk in

The walk experience isn't empty: NPC companions with distinct personalities share the space — a greeter who turns and waves when you approach, wanderers strolling waypoint loops, guides who lead you to landmarks, wait when you lag, and narrate on arrival with real spoken dialogue. Other real players appear too, and you can capture watermarked screenshots and 10-second video clips of it all and share them straight to X or Farcaster.

**How it works:** NPCs are real rigged GLBs driven by per-type finite-state machines, per-environment dialogue JSON, and live TTS; multiplayer wraps Colyseus with 15 Hz throttled sends and graceful single-player fallback; capture uses MediaRecorder off the live canvas with ffmpeg.wasm transmux to MP4 where needed.

**Why it matters:** You're never walking alone — the world greets you, guides you, and is worth sharing.

## Living avatars in your room: animated iOS AR

Send an avatar to an iPhone and it doesn't stand frozen in AR — it breathes, idles, and moves in the user's actual room through Apple's AR Quick Look, no app install needed.

**How it works:** Apple's viewer drops skeletons, so the pipeline samples the skinned mesh through an animation clip at keyframes and writes time-sampled vertex positions into the USDZ, letting Quick Look interpolate and loop them natively; any failure falls back to the proven static USDZ path.

**Why it matters:** Your agent steps out of the browser and into physical space, alive.

## Wearables and accessories that move with the body

Dress an avatar in hats, glasses, earrings, and outfit changes that attach to the skeleton and track every animation — glasses auto-fit to the face and sit on the eye line whatever the avatar's proportions. Recolor and show/hide individual garment layers, and everything survives an avatar body swap.

**How it works:** An AccessoryManager attaches GLB props to canonicalized bones with an anchored-placement pass (auto-scale to face width, upright correction, eye-line offset, bone-rotation cancellation), applies morph-target outfit bindings that the emotion system never clobbers, and replays the full appearance state after model replacement.

**Why it matters:** Identity is visual — your agent's look is yours, and it stays put through every move.

## Walk-test while you build

Inside the avatar editor, a Walk tab lets you take the exact avatar you're sculpting for a stroll — it orbits on autopilot until you grab the keys, with a third-person follow camera and selectable environments — so every bone, blendshape, and accessory edit is visible on a moving body instantly. Profile pages get the same treatment: your avatar walks live in your profile header, and visitors can take the controls or click "Walk with me."

**How it works:** The editor drives the same shared scene graph it sculpts (no reload), retargeting idle and walk clips with ground-speed crossfades and foot-plant-synced timeScale at a 30 fps cap; profiles embed the chrome-less walk runtime in an iframe with designed loading/error/empty states.

**Why it matters:** You see your character in motion the whole time you're creating it — and so does everyone who visits your profile.
