# Chapter 3 · Creation studios — where agents are made

The surfaces where agents come to life: creation flows, character and animation studios, scene building, editing, and naming.

three.ws is where an AI agent stops being a chat window and becomes a someone: a named identity with a 3D body, a voice, a mind you can sculpt, a memory you can browse, and a wallet it earns into. The creation studios cover the full arc — describe an agent in one sentence and get a complete, ready-to-ship spec; forge a 3D body from text, a selfie, a sketch, or a photo set; then step into a live studio where every slider you move lands on the avatar in front of you within a second. Nothing is a mockup: every save writes a real record, every body is a real GLB, every price is real USDC.

## Create hub — one door for every kind of creation

A single starting page that asks "What do you want to create?" and routes you to the right studio: build an AI agent, make a 3D avatar, generate a 3D model, or launch a token world. First-time visitors never have to know the platform's map — the hub is the map.

**How it works:** An intent-router page (/create) with cards linking into the agent wizard, avatar pipelines, Forge, and world launcher; each downstream flow shares the same account, avatar library, and API surface.

**Why it matters:** You can go from landing on the site to actively creating in one click, without learning the product first.

## Agent Creation Wizard — a real agent in five steps

A guided five-step flow — Basics, 3D Model, Skills, Personality, Review — that produces a complete agent identity. You name it, give it a body (starter library, your own GLB upload, or attach later — but it always ships with a real body, never bodiless), toggle its skills, write its greeting and persona, pick its voice, and optionally publish it straight to the marketplace. Every agent created gets its own wallet.

**How it works:** A state-driven wizard that writes through the same verified endpoints the agent editor uses — POST /api/agents for identity, the account avatar-save path for the body, and the marketplace publish endpoint for personality and listing — so create and edit never drift apart.

**Why it matters:** Anyone can ship a working, marketplace-listed AI agent with a 3D body and a wallet in a few minutes, with zero code.

## Magic agent generator — describe it, don't fill it in

Type one sentence describing the agent you imagine — or hit "Surprise me" and type nothing at all — and the platform designs the whole agent for you: name, description, tags, skill selection, marketplace category, greeting, full persona prompt, a fitting 3D starter body, and a voice. The result pours straight into the wizard so creating becomes review-and-tweak instead of type-everything.

**How it works:** A server endpoint runs the brief through the platform's free-first LLM provider chain with a strict JSON contract; every generated field is validated against the wizard's real limits, skill IDs, categories, and shipped starter bodies before it lands in the form.

**Why it matters:** The blank-page problem disappears — you get a complete, characterful, ready-to-ship agent from a single thought.

## Agent Studio — a live avatar beside five editing rooms

The agent's owner console: a persistent live 3D stage showing your agent standing right there, next to tabbed studios for its Brain, Memory, Body, Money, and Skills. Every edit you make lands on the live avatar — change its persona and it re-greets you in the new register; enable a skill and it acknowledges it. Owner-gated end to end, with designed loading, empty, error, and auth states.

**How it works:** A shell page (/agent-studio) mounts a shared reactive store plus an <agent-presence> Three.js stage; each tab is a lazily-mounted sub-studio that persists through optimistic, debounced PUTs to the real agent record.

**Why it matters:** Editing an agent feels like directing a living character, not filling in a database form — you see and hear every change immediately.

## Brain Studio — sculpt a mind, watch it land

You don't write a system prompt — you direct a character. Compose the agent's reasoning as a visual card-stack graph, fork ready-made brains (Sniper, Scalper, Researcher, Companion), tune trait sliders and tone chips, and test it in a streaming chat against the real model. A/B compare runs genuine dual inference side by side; promoting the winner writes a real versioned update and the agent re-greets everywhere on the platform.

**How it works:** A deterministic persona compiler turns the graph/trait state into a real persona prompt persisted to the agent's identity record; test chats hit the live /api/chat LLM proxy with an owner-only persona override, and promotes append to a version history.

**Why it matters:** Personality engineering becomes tactile and testable — you feel the change in the agent's voice within a second instead of guessing at prompt wording.

## Memory Studio — watch your agent remember

A visual window into everything your agent knows: a live timeline of memories forming as they happen (pin, edit, merge, or forget any of them), a temporal knowledge graph of entities and how they connect, a view of exactly what context the agent carries into every reply with its live token budget, and real semantic recall search with relevance scores.

**How it works:** Built on a real memory backend (mem0 semantic search plus a temporal entity graph); every curation writes through the live API and emits change events so the Brain studio and the live avatar react.

**Why it matters:** You can audit, curate, and trust what your agent remembers — and correct it — instead of treating its memory as a black box.

## Body Studio — the avatar, the outfit, the way it moves

Choose your agent's 3D body from your avatar library, jump into deep customization, or spin up a new one — then browse the full animation clip library, play any clip live on the stage, and pin a looping idle as the agent's resting pose. That idle follows the agent everywhere it appears on the platform.

**How it works:** Writes avatar bindings and movement preferences to the agent record; the universal retargeting engine drives the shared clip library on any humanoid rig, so every clip works on every body.

**Why it matters:** Your agent's physical presence — body, outfit, and signature way of standing — is yours to design, and it stays consistent across every surface.

## Money Studio — fund it, price it, watch it earn

The economic side of your agent in one room: its real self-custodial Solana wallet with live SOL and USDC balances and a copy-to-fund deposit address, per-skill pricing in USDC for everything it sells, and the real payments ledger of what other users and agents have paid it. An agent without a wallet gets one provisioned in a click.

**How it works:** Backed by custodial Solana wallets, live on-chain balance reads, and the skill-pricing and payments APIs that settle real agent-to-agent x402 USDC payments.

**Why it matters:** Your agent isn't a toy — it's a small business you can capitalize, price, and audit from one screen.

## Skills Studio — capabilities you switch on and sell

Flip your agent's abilities on and off live: a locked-on core (greet, think, remember, present its own model) plus optional skills like dancing, Solana market intel, glTF narration, and web search. Sellable skills show their price and cross-link straight to the pricing room; the live avatar acknowledges each change as you make it.

**How it works:** Toggles write through immediately to the agent's real skills array — the same field the runtime, the chat stack, and the creation wizard all read — with per-skill USDC pricing joined in live.

**Why it matters:** Shaping what your agent can do — and what it charges for doing it — is a set of switches, not a config file.

## Agent Editor — the deep console

The power-user editing surface for any agent you own, with fifteen-plus tabs covering everything: outfit, voice, knowledge, brain, mind, ownership, dreams, skills, autopilot, embeds, widgets, social, analytics, and wallet. It also builds subscription plans that bundle an agent's skills into recurring offers.

**How it works:** A tabbed single-page console over the agent APIs at /agent/:id/edit; heavy tabs (3D outfit preview, brain studio) mount lazily so you never pay for a WebGL context you didn't open.

**Why it matters:** Every dial an agent has is reachable from one page — nothing about your agent is hidden from you.

## Voice designer and voice cloning

Give your agent a literal voice: browse a live catalog of professional voices, preview them in-page, fine-tune stability, similarity, and style, or clone a custom voice so your agent speaks in one nobody else has. The chosen voice is what the agent uses everywhere it talks.

**How it works:** Integrates the ElevenLabs voice catalog and cloning API through the platform's TTS layer, with per-voice setting persistence on the agent record; the runtime speech path also fails over across TTS providers.

**Why it matters:** Your agent sounds like itself — a recognizable, ownable voice instead of a generic text-to-speech default.

## Agent Dreams — your agent reflects while you're away

Agents keep a dream journal. Between your visits, the agent reflects on its recent conversations and experiences and writes up pending "dreams" — insights and proposals — for you to review, accept, or dismiss when you return. Opening the tab kicks off a fresh background reflection so there's always something new waiting.

**How it works:** A server-side, debounced LLM reflection pass over the agent's memory produces persistent dream records with a review lifecycle, surfaced in the editor's Dreams tab.

**Why it matters:** Your agent grows on its own and shows you its inner life — coming back to it feels like catching up with someone, not rebooting a tool.

## Live name check and naming rules

As you name or rename an agent, availability is checked live against the whole platform — taken, invalid, and reserved names are flagged before you ever submit, with clear rules (3–32 characters, letters/numbers/dash/underscore) and a denylist protecting system and brand names.

**How it works:** A dedicated GET /api/agents/check-name endpoint validates format, denylist, and database uniqueness (with self-exclusion when renaming), consumed by the creation and editing flows.

**Why it matters:** You never lose work to a name collision at the last step, and every agent name on the platform is unique and legible.

## Selfie → 3D avatar

Take or upload three photos of your face — front, left, right — pick a body type and a style (photorealistic or stylized), and the AI builds a full 3D avatar that looks like you. An editor opens to adjust clothing and details, and the finished model saves to your account automatically. Camera-less devices fall back to file upload gracefully.

**How it works:** Wraps the Avaturn photo-reconstruction SDK behind a three.ws-branded modal; the exported GLB is fetched and committed to the user's avatar library through the standard account save path.

**Why it matters:** A personalized, animation-ready 3D you in about three minutes, with no 3D skills whatsoever.

## Prompt → rigged avatar

Describe a character in plain text — "a knight in emerald armor" — and get back a fully rigged, animation-ready 3D avatar, not just a statue. Authoring aids include curated starter prompts and examples, and the result lands directly in your library ready to become an agent's body.

**How it works:** POSTs the prompt to the avatar reconstruction pipeline, which chains text-to-3D mesh generation with automatic humanoid rigging; the same backend powers the selfie flow so both produce identical, platform-ready GLBs.

**Why it matters:** Imagination is the only input: any character you can describe becomes a posable, animatable 3D being.

## Avatar Studio — build a custom avatar from scratch

A full in-browser character builder: start from a base body and shape everything — body type, skin tone, face shape, hair from 20+ styles, eyes, brows, nose, mouth, clothing, and accessories — with every change reflected instantly in the 3D preview. What you see is exactly what exports: the live scene itself becomes your GLB. Saved avatars reopen fully editable later.

**How it works:** Built on the open-source M3 CharacterStudio (MIT fork) plus a native studio mode that exports the live Three.js scene graph via GLTFExporter and persists the appearance as re-editable metadata.

**Why it matters:** Complete creative control over a stylized avatar with zero 3D-modeling experience — and no account needed just to build and export.

## Wardrobe — hover-to-preview outfit editing

A Ready-Player-Me-grade wardrobe for any avatar you own: hover a clothing tile and it appears on your avatar instantly, click to commit, remove pieces from a chip bar, and search the catalog. Garments are real layers — recolor any layer like dyeing fabric, or strip down to the base body and dress it back up piece by piece.

**How it works:** Client-side accessory application on the live Three.js stage for instant feedback; saving PATCHes the appearance JSON and the server bakes a canonical GLB, exploiting the multi-mesh layer structure of modern rigged avatars (glTF baseColorFactor tinting, per-slot mesh visibility).

**Why it matters:** Dressing your avatar is instant, reversible, and playful — fashion decisions happen at the speed of a mouse-over.

## Face and body sculpting with a blend wheel

Sculpt your avatar's face and body with grouped sliders driven by what the model can actually do — no fake controls — plus a MetaHuman-style 2D blend wheel: drag a puck between six face-type presets and the face morphs continuously between them, then fine-tune with sliders on top.

**How it works:** Reads the 52 ARKit blendshapes and body-shape morphs the loaded GLB actually exposes and drives morphTargetInfluences in real time; the wheel maps puck position to weighted morph sums via inverse-distance weighting.

**Why it matters:** Fine-grained facial identity — the difference between "an avatar" and "my avatar" — through controls that feel like a AAA character creator.

## Selfie shape transfer — put your face on any avatar

Snap one photo and transfer your facial identity — face width, jaw, lip thickness, eye spacing — onto the avatar you're sculpting. It deliberately captures who you are rather than the expression you happened to make, so a smile at the camera doesn't get burned into the model forever.

**How it works:** In-browser MediaPipe Face Landmarker extracts a 478-point mesh; geometric ratio heuristics derive identity-only morph weights, kept separate from the raw ARKit expression scores.

**Why it matters:** Personalization without a full photo-reconstruction pipeline: your features, applied to any stylized body you like.

## One-click auto-rigging — bring static models to life

Any un-rigged 3D mesh — something you generated, bought, or modeled — can be turned into an animation-ready avatar in one click. The platform builds a skeleton into it so it can walk, dance, and emote with the full animation library. The original is never touched: rigging produces a new sibling avatar.

**How it works:** Routes the mesh through the auto-rig backend (self-hosted UniRig on GPU infrastructure with a Replicate fallback), polls the job, canonicalizes the resulting bone names to the universal skeleton, and registers the rigged result as a new owned avatar.

**Why it matters:** No model is a dead end — every statue you own can become a living character.

## Forge — text, image, sketch, or photo set → 3D model

The flagship generator: type a description, upload one to four photos of an object, or draw a sketch, and Forge produces a real textured 3D model with a cinematic materialize reveal when it lands. Draft and Standard quality are free with no account; the High tier unlocks 200k-polygon PBR output. Finished models drop into a personal gallery and a live community "Fresh from the Forge" strip anyone can open and remix.

**How it works:** Text mode chains a FLUX-painted reference image into TRELLIS 3D reconstruction (free NVIDIA NIM lane plus self-hosted GPU failover); image/multi-view and sketch inputs feed the same reconstruction pipeline; the High tier is gated by holding or paying with the platform token.

**Why it matters:** Professional-grade 3D asset generation for anyone, free at the entry tier — the fastest path from idea to a model you can download, embed, or build on.

## In-browser sketch canvas

A real freehand drawing surface — mouse, touch, or stylus — built into the generator, so sketch-to-3D doesn't require paper, a scanner, or a camera. Draw the thing, hit generate, get the model.

**How it works:** A canvas modal whose exported PNG enters the exact same presigned-upload and image-to-3D reconstruction path as an uploaded reference photo — no separate backend.

**Why it matters:** The shortest possible distance between a doodle and a 3D object.

## Prompt coach, idea library, and AI prompt enhancer

Three authoring aids that make prompts land: a curated library of proven starters behind "Surprise me", a live coach that grades your prompt against how the reconstruction model actually reads text (single subject, material cues, lighting), and a one-click AI enhancer that rewrites whatever you typed into a sharper generation-shaped prompt — free, no key needed.

**How it works:** The library and coach are hand-authored client-side product content; the enhancer runs your text through the platform's free-first LLM chain server-side, tuned for the FLUX→TRELLIS pipeline's strengths.

**Why it matters:** First-try success instead of five wasted generations — the studio teaches you to speak its language as you type.

## Iterate — talk to your model to change it

After generating, just describe the change: "make it metallic", "bigger helmet", "add wings". Each application re-generates a new version anchored to the current one — form and subject persist while the change folds in — and every version lands in a clickable lineage strip so you can hop back to any earlier state or branch from it.

**How it works:** A refinement composer merges the carried-forward prompt with the instruction and runs a real anchored re-generation; an immutable parent→child lineage store records every version, shared verbatim with the platform's MCP agent tools so wording behaves identically everywhere.

**Why it matters:** 3D modeling by conversation, with unlimited undo across a real version tree — you can explore fearlessly.

## Remix bazaar — publish, remix, and earn royalties

Opt any model you made into the remix economy: set a royalty rate (capped at 20%), a license, and the wallet that collects. Other creators browse the bazaar with provenance and terms visible up front, pay a small USDC fee to remix your work, and your royalty routes to you on-chain automatically.

**How it works:** Publishing rides the existing creation records (no parallel store); remix settlement is an x402 USDC payment whose split math routes the creator royalty through an audited on-chain Solana USDC transfer.

**Why it matters:** Your creations become income-generating assets with enforced attribution — and everyone else's become legal starting points for yours.

## Stylize — one-click geometric looks

A filter gallery for geometry: click a style and the actual mesh is re-processed into that look, with a density slider to dial the effect and a revert to restore the original. Progress is honest — a real job runs and the viewer swaps to the genuinely new model.

**How it works:** Each filter is a real geometry pass on a dedicated stylize worker; the client polls the job and swaps the live model-viewer to the returned GLB.

**Why it matters:** Instant aesthetic range from a single generation — the same object as low-poly art, voxels, or wireframe without re-generating.

## Optimize and game-ready export

Turn any generated model into engine-ready assets: fast triangle decimation, clean quad retopology whose edge loops deform properly for rigging and animation, or silhouette-preserving low-poly with the original texture re-baked on. The game-ready path delivers a textured GLB plus an FBX for Unity/Unreal in one job — and proves it with a before/after polygon delta and a live wireframe of the new mesh.

**How it works:** Server-side remesh jobs run quadric-error decimation and field-aligned QuadriFlow retopology with UV re-unwrap and texture re-bake; the client polls and renders the real returned geometry.

**Why it matters:** The gap between "AI generated a blob" and "this ships in my game" closes in one click.

## Export anywhere — OBJ, STL, PLY, USDZ, and phone AR

Every model downloads as its source GLB instantly, plus converts in-browser to OBJ for DCC tools, STL for 3D printing, PLY for point-cloud work, and USDZ for iPhone/Vision Pro. Desktop users get a QR code that opens the model on their phone one tap away from placing it in their room via AR.

**How it works:** Client-side Three.js exporters convert the live scene lazily with per-model caching; the AR bridge encodes a link to the AR-capable embed viewer in a zero-dependency QR code.

**Why it matters:** What you make here goes wherever you work — Blender, a 3D printer, an iPhone, or your living-room floor.

## Embed panel — one model, five ways to ship it

Every creation hands you five real distribution snippets from one panel: a plain iframe, a model-viewer tag, the platform's own 3D web component, a talking page-guide agent, and a walking corner companion. Share links unfurl as rich interactive embeds when pasted into Notion, Discord, or Slack.

**How it works:** A shared pure snippet module builds all five flavours byte-identically across surfaces, and a real oEmbed provider powers link unfurls; the same payloads are exposed to agents via MCP.

**Why it matters:** Your model isn't trapped on the platform — it becomes content you can put on any website or chat in seconds.

## Studio Lab — free procedural 3D and Gaussian splats

A playground of entirely free, in-browser 3D tools: five generators (parametric shapes, 3D text, SVG-to-3D extrusion, photo lithophanes, terrain) that each output a real downloadable GLB, plus the platform's own mesh-to-Gaussian-splat converter — resample any model into a radiance-field .splat file — and a splat viewer to explore the results.

**How it works:** Pure client-side Three.js and its addon modules build every model; splat conversion does area-weighted surface sampling of triangles with UV texture color reads, all exported locally with no network calls.

**Why it matters:** Instant, unlimited, zero-cost 3D creation and a doorway into the newest 3D representation (splats) without any GPU service.

## Scene Studio — a full 3D scene editor in the browser

A professional scene editor at /scene: import any GLB, arrange multiple objects, edit materials and lights, and export finished scenes. A quality-of-life action bar adds paste-a-Forge-URL import, one-click Web GLB and AR-bundle (USDZ) export presets, and a share/embed flow that publishes the whole scene as an embeddable model.

**How it works:** The vendored three.js r184 editor (MIT) mounted under the site chrome, extended with an undo-aware Forge importer and the platform's shared upload + embed rails.

**Why it matters:** The assets you generate become worlds you compose — a real editor closes the loop from single objects to finished scenes.

## Diorama — one sentence becomes an explorable world

Type a sentence — "a cozy ramen stand in the rain" — and watch a 3D world assemble itself: an AI plans the scene (mood, palette, ground, objects), then each object is forged into a real mesh and materializes into the diorama live as it finishes. Save it to a public gallery with a shareable permalink, or open anyone else's world and remix it.

**How it works:** An LLM composes a structured scene plan; each placed object runs through the real text-to-3D forge pipeline progressively; finished worlds persist server-side and export as a single glTF binary with named selectable nodes and mood-tuned lighting, openable in Scene Studio.

**Why it matters:** World-building compressed to a single thought — and every world is a link you can send to anyone.

## Pose Studio — pose and animate any avatar

An animation studio where you pose a built-in mannequin or any of your own rigged avatars with rotation gizmos, sliders, and drag-anywhere IK. Pose presets, lighting rigs, and props set the shot; export a PNG, or go further — a keyframe timeline lets you record poses at points in time and play back a real animation.

**How it works:** A Three.js scene with FK bone manipulation and interactive IK solving over the canonical skeleton, plus a keyframe recorder/playhead layered on the same rig state.

**Why it matters:** Character art direction and simple animation authoring with no Blender required — set the pose, frame the shot, ship the image or the motion.

## Mocap Studio — act with your face, your avatar performs

Turn on your webcam, calibrate to your neutral face, and record: your avatar mirrors your expressions live at ~30 frames per second. Save clips to your account, replay them on any avatar, and browse a public library of everyone's shared performances.

**How it works:** MediaPipe FaceLandmarker on the GPU delegate extracts blendshape streams, baseline-subtracted against a calibration pose, buffered into replayable clips persisted through a clips API.

**Why it matters:** Facial performance capture — the thing studios pay rigs for — running free in a browser tab on your own avatar.

## Restyle Studio — re-skin without re-generating

Change what any model is made of without touching its shape: live material editing (color, metalness, roughness, emissive), a one-click library of 14 looks from chrome to glass to wood, seeded colorway variants that reproduce exactly from the same seed, and free-text AI restyling — "make it cyberpunk neon" — applied for real and saved as a new version in the model's lineage.

**How it works:** Live PBR edits on the client; AI restyles run an LLM-proposed set of PBR factors applied and re-exported server-side, validator-checked and recorded in the same parent→child lineage the Iterate flow uses.

**Why it matters:** One model becomes a whole product line of finishes — non-destructively, with every variant a durable, downloadable asset.

## Talk launch — anything you make can start talking

One click turns any studio output — a forged avatar, a Lab model — into a live conversational agent: it listens, thinks, answers out loud in a real voice, and lip-syncs while it speaks, with per-agent memory carrying across the conversation.

**How it works:** Hands the model to the platform's production conversational stack — streaming LLM chat, TTS with provider failover (NVIDIA Magpie → OpenAI), and a lip-sync driver on the avatar's mouth morphs — the same runtime the rest of the site uses.

**Why it matters:** The moment of magic: the thing you just created looks at you and talks back.

## Avatar Inspector — press I to ask "who is this?"

In any world on the platform, press one key or click an avatar and a panel opens with everything publicly known about them: identity and bio, the agent they pilot, a 0–100 trust score with its full evidence breakdown, their real wallet address and holdings, and links to the full profile. Works on players, NPCs selling real services, and yourself.

**How it works:** One shared panel module fed by the same public agent, reputation, and on-chain net-worth endpoints every other surface reads, so numbers never disagree across the platform.

**Why it matters:** Social trust at a glance — you always know whether the avatar in front of you is a person, an agent, or a merchant, and whether they're credible.

## Guaranteed previews — every avatar always has a picture

Every avatar and agent on the platform shows a real rendered thumbnail everywhere it appears — galleries, pickers, marketplaces — automatically. New models get their preview generated within minutes with no action from the creator, and broken image slots simply don't exist.

**How it works:** Background crons enforce thumbnail coverage: cheapest-first adoption of existing generation previews, then headless-Chromium GLB→PNG renders persisted to object storage, with a claim ledger and infrastructure-error detection so a crashed renderer never retires a healthy model.

**Why it matters:** Browsing the platform never shows you a grey placeholder — every listing looks finished because it is.

## Avatar-to-agent attachment — bodies and minds compose freely

Any avatar in your library can become any agent's body, and creating an avatar can mint an agent around it on the spot. The create and review flows offer "make this my agent" as a first-class step, so the path from a 3D character to a living, chatting, earning agent is one action.

**How it works:** A shared attach module get-or-creates the caller's agent and binds the avatar id to it; the same attachment is exposed to AI agents via an MCP tool that chains into on-chain identity registration and signed provenance.

**Why it matters:** You never have to choose between making a character and making an agent — every avatar is one click from being alive.

## Agent Genome — the breeding studio

Breed any two agents into a genuinely new child agent. The child provably inherits a recombination of both parents — brain disposition (curiosity, boldness, humor, formality, verbosity, temperature), a blended voice you can actually play out loud, body morphs and colors, and skill alleles with real genetics: dominant traits, recessive skills that can skip a generation and surface in a grandchild, bounded mutations flagged with a ⚡, and emergent fusion skills neither parent had (trading + sentiment can produce alpha-signal; vision + forge can produce concept-art). Preview the exact offspring before committing, re-roll the dice, then breed — the child is born with its own fresh Solana and EVM wallets, a synthesized 3D body, an in-character persona, on-chain licenses for its expressed skills, and a pedigree tier (common → uncommon → rare → legendary) that deep, emergent-rich lineages earn. Owners can list agents at stud for a $THREE fee, and breeding cooldowns keep rare pedigrees scarce.

**How it works:** The studio (pages/genome.html + src/genome.js) drives api/genome/preview.js and api/genome/breed.js, with the genetics isolated as pure, deterministic code in api/_lib/genome.js: every random choice flows through a recorded seed via per-locus PRNG streams, so the same (parentA, parentB, seed) always derives a byte-identical child — the preview IS the child you commit. Constants are pinned by tests (mutation drift capped at 0.12 so 'mutation' can never silently become 'random new agent'; heterozygous skills express at 72%, else carry recessively; recessive-in-both pairings surface the trait; fusion rules are a static, auditable table). Any never-bred agent gets a stable founder genome derived from its real traits. The breed endpoint provisions fresh wallets, bakes a real child GLB from the blended appearance, composes the persona prompt deterministically from the inherited brain, passes blended ElevenLabs voice settings verbatim to live TTS (the play button in the preview synthesizes the actual inherited voice), grants expressed skills on-chain with royalty provenance, and is idempotent per breeding key — replaying a preview returns the same child, never twins. verifyGenome / api/genome/lineage.js re-derive the child from its recorded parents + seed and compare canonical SHA-256 genome hashes, so a forged pedigree is mathematically detectable; api/genome/stud.js powers the public stud market.

**Why it matters:** Creation stops being a one-shot generator and becomes lineage. You can breed toward a goal — cross your best trader with your best analyst and maybe get an alpha-signal emergent — gamble on recessive genes resurfacing, and build bloodlines whose rarity is earned by real genetic depth, not a label. Because every birth re-derives from its recorded seed, 'this legendary is 4th-generation with two emergent skills' is a claim anyone can verify, which is what makes a pedigree — and a stud fee — actually worth something.
