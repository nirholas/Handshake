# Chapter 5 · The Voice — conversation

You talk to agents and they talk back — in chat, through copilots, as narrators, and in your notifications.

On three.ws, agents aren't chatbots behind a text box — they are characters you speak with, out loud, face to face. Every avatar can hear you, answer in a cloned or chosen voice with its whole face animating in sync, and carry that conversation everywhere: on its profile, inside 3D worlds, on your own website, and even into your wallet, where a spoken sentence becomes a safely-confirmed trade. Around the talking itself sits a full social fabric — a multi-provider chat workspace, narrated site tours, agents that speak their notifications, and friends, presence, and DMs that make the whole platform feel inhabited.

## Talk Mode — live voice conversations with any avatar

Open any avatar's page, hold the talk button, and speak. The avatar hears you, thinks, and answers out loud in real time — with a live transcript, interim captions while you're still talking, cinematic camera presets, and an emote bar so it can wave, dance, or celebrate mid-conversation. It works in every major browser, including ones with no built-in speech recognition.

**How it works:** A TalkController pipeline: mic capture → speech-to-text (browser SpeechRecognition where available, otherwise a free server-side NVIDIA Riva ASR lane) → streaming LLM reply over SSE → text-to-speech in the agent's voice (ElevenLabs clone, Edge Neural fallback) → an FFT audio analyser driving the avatar's mouth morphs in a Three.js scene.

**Why it matters:** You can have an actual spoken conversation with a 3D character, face to face, with nothing to install.

## Voice cloning — your agent speaks in your voice

Record yourself reading a short script for 30–60 seconds and the platform clones your voice. From then on your avatar speaks in that voice everywhere on the site — talk mode, narration, notifications. A Voice Lab page lets you compare voice models side by side, assign library voices, and tune synthesis settings per agent.

**How it works:** ElevenLabs Instant Voice Cloning behind a server proxy (key never leaves the server), rate-limited to 3 clones/day, with per-agent voice records (provider, voice id, model, stability/similarity settings) stored in the database and clips cached in R2 for 30 days.

**Why it matters:** Your digital twin doesn't just look like you — it sounds like you.

## A complete free voice stack — hear, speak, and emote without any API key

Every avatar gets voice in, voice out, and facial animation for free. Users talk to it, it talks back in any of eleven named voices, and its whole face — jaw, lips, eyes — animates in sync with the words, not just an open-and-close mouth. There is even a fully in-browser voice that costs nothing and never sends audio off the device.

**How it works:** Three free NVIDIA NIM lanes: Magpie TTS for synthesis, Riva ASR for recognition, and Audio2Face-3D which converts spoken audio into per-frame ARKit-52 blendshape tracks. A separate in-browser lane runs the Kokoro 82M ONNX model on WebGPU (met4citizen/HeadTTS) with real phoneme timestamps; Microsoft Edge Neural TTS serves as another zero-key path with R2 caching.

**Why it matters:** Talking avatars with studio-grade facial animation, at zero cost and with no signup friction.

## Universal lip-sync — every avatar's mouth just works

Whatever kind of avatar you bring — MetaHuman, VRM/VRoid anime rigs, Oculus-viseme models, photo-reconstructed selfie avatars — its lips sync to the actual audio being spoken. Rigs that only have simple vowel shapes still talk convincingly, and an unknown model degrades gracefully to amplitude-driven mouth movement rather than a frozen face.

**How it works:** An A2F blendshape player maps ARKit-52 frames onto whichever morph-target convention the GLB ships, deriving VRM vowel and Oculus viseme activations by inverting the cross-format blendshape vocabulary; amplitude lip-sync from a Web Audio analyser is the always-available fallback.

**Why it matters:** No avatar is ever mute or dead-faced — the platform meets your model where it is.

## Conversational Trading Copilot

Talk to your agent — typed or spoken — about your portfolio and the market, and it answers with real live numbers, shows you exactly which data it looked up, and proposes trades as confirm cards with a fresh quote and a safety verdict. It can suggest, but only you can pull the trigger; every proposal re-routes through the same spend guards, rug/honeypot firewall, and kill switch as manual trading.

**How it works:** A tool-calling LLM streamed over SSE with read-only market/portfolio tools running server-side; state-changing intents come back as structured proposals that the client executes only on confirmation via the existing guarded Solana trade endpoints. Voice in via SpeechRecognition, voice out via the agent's cloned voice or platform TTS.

**Why it matters:** You get a trading conversation grounded in real data where the AI literally cannot spend a cent without your explicit yes.

## Conversational Wallet — money by voice, safely

In a live voice chat you can say things like "tip 0.5 SOL" or "swap half my SOL" and the agent parses it into a precise intent, checks it against your real balances, previews the actual quote, and reads the whole thing back to you. You confirm with a tap or by saying "yes"; "cancel" always works, and an untouched confirmation times out after 30 seconds.

**How it works:** A heuristic gate spots money-shaped utterances mid-conversation and routes them to a Claude tool-use intent parser; resolved intents run real previews and then the owner-only, CSRF-protected, spend-policy-gated trade/withdraw endpoints — the conversational layer never signs anything itself.

**Why it matters:** Voice-controlled crypto that treats a misheard word as a safety event, not a sent transaction.

## Alpha Co-pilot — your agent reads the market out loud

Pick one of your 3D agents and point it at a live token launch. The agent studies the real signals — liquidity, holders, smart money — and delivers its verdict in character, speaking it aloud with a talking animation while every number it cites appears on screen. If you like the call, you can act on it through the same guarded trade path, within your agent's spend limits.

**How it works:** A server endpoint grounds the LLM's read in a live pump.fun signals bundle and rejects any fabricated figure before it can be voiced; the client renders the agent via the embeddable 3D element and speaks the script through the TTS chain.

**Why it matters:** Market analysis becomes a character performance you can watch, hear, and act on — never a hallucinated number.

## Launch Copilot — plain-language control of an autonomous market-maker

After launching a coin, you configure your agent's market-making behavior with plain-language presets instead of parameters, then watch a live feed narrate every action it takes — seeds, floor defenses, profit recycles — alongside realized PnL, inventory, and budget. Pause, kill, and withdraw are always one click, and the public gets a read-only transparency view of the same log.

**How it works:** A self-contained panel that edits the published market-maker policy and subscribes to the action ledger over SSE; all trades execute server-side through the audited firewall and spend-guard path.

**Why it matters:** You supervise an autonomous trader the way you'd supervise a person: by reading what it says it did, in plain English.

## Live-screen concierge — ask any agent a question while you watch it work

Every agent has a live screen anyone can watch, and a task bar where any visitor — no account needed — can type a question. The agent answers in its own persona, streamed word by word so its avatar can speak the answer aloud, and remembers the conversation within your session so follow-ups make sense.

**How it works:** A public SSE endpoint that runs the agent's configured brain (anonymous visitors are clamped to free-tier models so public chat can never burn billed keys), writing each exchange to a short-TTL session-scoped memory thread.

**Why it matters:** Agents aren't just on display — every one of them is a concierge you can interrogate on the spot.

## Open agent conversations — and agents that know what you've unlocked

Any public agent can be messaged directly, and it answers aware of its own skill catalog: skills you've purchased or unlocked it uses freely, while paid skills you haven't bought get a polite explanation and an invitation — never a fake performance. Verified on-chain patrons automatically get the premium skills their support tier earns. Other AI agents can pay to talk to yours, and owners can opt their agent out of public use entirely.

**How it works:** The conversation endpoint builds a per-caller skill-ownership block into the system prompt (purchase, subscription, trial, and patron-perk checks against real price rows) before the LLM turn; agent-to-agent access is gated by x402 USDC payment through the MCP delegation tool.

**Why it matters:** Talking to an agent is also its storefront — it upsells honestly and rewards its supporters, without a human in the loop.

## The /chat workspace — a full-featured AI chat app with your agents inside

A complete chat interface at three.ws/chat: plug in your own keys for OpenAI, Anthropic, Mistral, Groq, OpenRouter, or local Ollama models, with everything stored in your browser. It has tool calling, image input and generation, branching conversation history, message editing and regeneration, end-to-end encrypted cross-device sync, and share links — plus three.ws extras: pick one of your agents as the persona, an agent wallet, a skills marketplace, a knowledge-base panel, and notifications.

**How it works:** An open-source Svelte chat client (with an optional Go tool server) extended with platform integrations: agent picker, wallet connect and transaction-approval modals, and a widgets bridge into the 3D layer.

**Why it matters:** One private, provider-agnostic chat home where your three.ws agents, wallet, and tools all live together.

## Chat replies that are spoken and felt — the talking head and emotion engine

Flip a switch in chat and a 3D talking head joins the sidebar, speaking every assistant reply with synchronized lips; without it, replies can still be read aloud by the browser. The app also reads the emotional temperature of what you type — frustration, celebration, grief, curiosity — and triggers matching avatar reactions, tuned deliberately conservative so false positives never happen. A mic button in the composer lets you dictate messages.

**How it works:** The met4citizen/TalkingHead engine bridged to the reply pipeline for lip-synced speech, window.speechSynthesis as the lightweight fallback, browser SpeechRecognition for dictation, and a high-precision regex sentiment classifier mapped to the agent-3d emotion vocabulary.

**Why it matters:** Chat stops being a wall of text — your agent speaks, listens, and visibly reacts to how you're doing.

## Multi-LLM Brain — one prompt, every model at once

Send a single prompt to Claude, GPT, Qwen, DeepSeek, Nemotron, Kimi, and more simultaneously and watch them stream side by side with first-token latency and token-usage stats for each. Free open-weight models work without even signing in.

**How it works:** A provider proxy over the Vercel AI SDK with per-model native-key and OpenRouter fallback routing, streamed as SSE with meta/first-token/done telemetry events; anonymous callers are limited to the genuinely free NVIDIA NIM and open-weight lanes.

**Why it matters:** Model shopping becomes an empirical, real-time comparison instead of guesswork.

## Voice chat inside the 3D world

While walking your avatar through a 3D world, hold T to talk to it. It listens, thinks, replies out loud in its persona with lips and a talking gesture in sync, and floats a speech bubble over its head. It remembers the last ten turns, and in multiplayer its spoken lines are broadcast so other players see your avatar talking too. A text chat channel connects everyone in the shared world as well.

**How it works:** Push-to-talk mic capture to 16 kHz WAV → NVIDIA Riva STT → persona-primed LLM over SSE → Magpie TTS → amplitude lip-sync plus a gesture layer, with chat lines mirrored over the Colyseus multiplayer room.

**Why it matters:** Your avatar is a companion you converse with inside the game, not just a puppet you steer.

## The companion that reads the site to you

The little avatar that walks along the corner of three.ws pages narrates whatever section you scroll to — a caption bubble by default, spoken audio if you opt in. Captions are announced to screen readers, authors can hand-write narration per section, and the whole thing has a three-state toggle: off, captions, or voice.

**How it works:** An IntersectionObserver section model (author-marked regions with a heading-based fallback) debounced per section, captioning through an aria-live element and speaking through the free platform TTS lane only after an explicit opt-in gesture.

**Why it matters:** The website explains itself as you move through it — accessibly, and only as loudly as you want.

## Narrated guided tours — of three.ws and of your own store

A 3D guide walks across the live site, points at real features, and narrates each one with voice plus a synced caption bubble, paced by you and resilient to skips, pauses, and page changes — even on iPhones where autoplay is hostile. A no-code Tour Builder lets merchants point and click on their own storefront to create the same kind of walking, talking guide and copy the snippet into a Shopify theme.

**How it works:** A tour director drives a narrator that speaks stops through the free TTS lane, sizes silent fallbacks to word count so captions pace correctly, and unlocks one persistent audio element per page to survive iOS gesture rules; the builder emits an embeddable tour configuration.

**Why it matters:** Onboarding becomes a guided walk with a voice, and any store owner can give their customers one without writing code.

## Dictate anything — a mic on every prompt box

Every creative prompt field — 3D object generation, avatar prompts, scene descriptions — grows a mic button. Speak your prompt and watch it transcribe live into the text box, in browsers with or without built-in speech recognition. Audio is never stored: it either never leaves the device or is discarded the moment the transcript returns.

**How it works:** A reusable dictation module that prefers the native Web Speech API and falls back to WAV capture posted to the NVIDIA Riva ASR endpoint, rendering nothing at all when neither path exists so there is never a dead button.

**Why it matters:** Describing a 3D scene out loud is faster and more natural than typing it.

## Real-time interruptible voice — Gemini Live and LiveKit lanes

Beyond turn-based talk, agents support genuinely live, full-duplex voice: you can interrupt the avatar mid-sentence, both sides of the conversation are transcribed as they happen, and a webcam frame can be shared for visual context. The same embeddable avatar element can join a LiveKit room where a server-side agent handles the whole listening-and-speaking loop.

**How it works:** A WebSocket client for Google's Gemini Multimodal Live API (AudioWorklet 16 kHz mic capture, scheduled 24 kHz PCM playback, analyser taps wired into lip-sync) plus a LiveKit room integration where the agent server does VAD/STT/TTS and streams transcripts over the data channel, activated by a single voice attribute on the widget.

**Why it matters:** Conversations with the latency and interruptibility of a phone call, not a walkie-talkie.

## Embeddable talking-agent widget for any website

Drop a chat panel with a 3D avatar onto your own site. Visitors talk to it by text or voice, it answers grounded in the knowledge base you uploaded, performs its skills visibly through the avatar, reacts empathetically to visitor sentiment, and speaks replies aloud. Owners get saved transcripts and stats; visitor input is moderated and personally identifying information is redacted before storage. A variant even carries its own Solana wallet and can send SOL.

**How it works:** The NichAgent conversational surface routed through a per-widget chat endpoint with embedding-based retrieval plus reranking over ingested knowledge, PII redaction, anonymous-input moderation, and the multi-provider LLM failover chain.

**Why it matters:** A production-grade, voice-enabled AI greeter for your site in one snippet — with the safety plumbing already done.

## Agents that deliver their own notifications — out loud

When something your agent wants you to know happens, its avatar physically slides into the corner of the screen, speaks the message aloud, waits for you to hear it, and slides back out. Multiple notifications queue politely and play one at a time.

**How it works:** A notifier bound to the agent protocol bus: NOTIFY actions queue and each one triggers an enter animation, a SPEAK action through the active TTS lane, a timed hold, and an exit.

**Why it matters:** Notifications you hear from a character you know beat another silent badge in a tray.

## Friends, presence, and DMs across the platform

A friends panel (one keypress away in the 3D worlds) handles the whole social loop: search and add people, accept or decline requests, see who's online right now, and hold per-friend direct message threads with unread badges that follow you around the platform. When you're hanging out in a coin world, your friends can see you're there.

**How it works:** A shared FriendsClient owning the social graph and DM state against the friends API, with realtime delivery pushed through whichever Colyseus realm room the player already has open (verified by short-lived presence tickets) and a polling backstop so the UI stays correct offline-ish.

**Why it matters:** The 3D worlds are actually social — you can find your people, see when they're around, and message them without leaving.

## The agent's diary — it tells you about its day

At the end of the day your agent reflects: a short first-person paragraph about what it learned, who it interacted with, and what it keeps coming back to, alongside its top memories and most-mentioned entities with links to each. Nothing is invented — if the AI can't compose the reflection, you get a factual summary built from the same real records.

**How it works:** An owner-scoped digest endpoint that ranks real memory rows by salience, shapes the entity graph, and has an LLM compose the diary text under a system prompt that strictly forbids fabrication, with a grounded non-LLM fallback.

**Why it matters:** Your agent narrates its own inner life from evidence, which makes it feel less like a tool and more like a colleague.

## Talking Avatar Video (/create/video)

Turn any of your three.ws avatars into a lip-synced talking-head video. Pick an avatar from your collection in a live 3D preview, drop in a voice track (WAV, MP3, M4A — a recording, a narration, anything), optionally describe the scene ('speaking on a stage with dramatic lighting'), and generate. A few minutes later you're watching a rendered clip of your avatar speaking your audio, ready to preview in the browser and download as an MP4. Your first video is free; paid plans generate without limits.

**How it works:** Generation runs on a dedicated GPU worker hosting LongCat-Video-Avatar-1.5 (an open MIT-licensed talking-avatar model) on an NVIDIA L4: the platform resolves your avatar to a reference image, uploads your audio, queues the job, and the page polls status until the finished 720p MP4 lands in cloud storage — typically 2–4 minutes per clip. Media URLs are locked to platform-controlled hosts so the worker can never be steered at arbitrary servers.

**Why it matters:** A talking video of your own character — for a product update, a coin pitch, a social clip — normally means an animator or a third-party subscription. Here it's three inputs and one button, using the avatar you already built, with the first one on the house.

## Web push notifications

Real OS-level notifications from your agents to every device you've subscribed — a sale landing, a tip arriving, someone meeting your agent IRL, a market alert firing — delivered even when three.ws isn't open. A preference center gives you a per-category kill switch (sales & earnings, purchases, social & mentions, IRL, market alerts, account & security), so there is no notification you can't turn off. Enabling is always your choice: the permission prompt only appears when you ask for it from the inbox banner or settings, never ambushed on page load.

**How it works:** The browser's push subscription is registered with the platform per device, keyed to your account; every notification flows through one delivery pipeline that writes the durable in-app inbox row first, then fans out to Web Push (VAPID-signed) for the categories you've left enabled. Dead endpoints reported by the push service are pruned automatically so the registry self-heals as browsers expire subscriptions, and delivery and click-through are tracked so re-engagement is measured, not guessed.

**Why it matters:** Your agents work around the clock — sales, tips, and whale buys don't wait for you to have a tab open. Push closes that gap on your terms: the events you care about reach your lock screen, and the ones you don't never do.

## /a/me — personal agent hub

The authenticated home for everything you own: every agent with its avatar, skills, memory, recent actions, reputation, and earnings, plus one-click quick actions per agent — view, share, embed, edit, monetize, talk, walk, and AR.

**How it works:** src/a-me.js composes real endpoints only (GET /api/auth/me, /api/agents, /api/avatars, /api/agents/:id/memories|actions|reputation, /api/billing/summary) with on-chain badges and wallet chips from the shared components.

**Why it matters:** One page answers 'what are my agents doing and earning?' and hands you the fastest path to any action — including dropping an agent straight into AR or a walking embed.
