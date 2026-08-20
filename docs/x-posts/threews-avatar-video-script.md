# Text-to-video script: the three.ws avatar

Prompts for a video model (Veo, run through ElevenLabs), using a three.ws 3D avatar render as the
reference image. This file is the **picture**, not the words. The spoken lines live in
[metaplex-agent-deployer-video-script.md](./metaplex-agent-deployer-video-script.md), and the
deployer-specific shot list lives in [metaplex-agent-mcp-x-post.md](./metaplex-agent-mcp-x-post.md).

The idea being sold here is the tagline and nothing else: **give your AI a body.** A model with no
form gets one, the form moves, the form owns a wallet, the form walks out into the real world. Four
claims, all true today.

---

## Before you generate

**Reference image.** Open any avatar on [three.ws](https://three.ws), frame it front-facing in a
neutral pose against the dark stage, and screenshot at the largest size you can. Use the **same
file on every shot** or the character drifts and the cut stops reading as one being.

**Clip length.** Veo generates in 8-second beats. Every prompt below is written to resolve inside
one beat, with one idea and one camera move each. A prompt that asks for two things at 8 seconds
returns mush.

**Text.** Video models mangle letters. Nothing legible is described in any prompt, and the negative
prompt bans it outright. Every real string gets composited afterwards in an editor.

**Palette, held across all shots.** Near-black void, violet as the light of the machine, teal as the
light of the network, one warm gold reserved for money in motion. No fourth color.

---

## Hero clip, 8 seconds

Use this if you only render one thing.

> Cinematic product shot on a near-black void stage. A soft cloud of violet light particles hovers
> at center frame, formless and breathing. The particles rush inward and collapse onto a figure: a
> stylized 3D humanoid avatar matching the reference character exactly, materializing from the feet
> upward in one continuous sweep as surfaces and textures resolve and catch the light. As the last
> surface lands the figure lifts its head and looks directly into the lens, alive and calm. A single
> point of warm gold light ignites in its open palm and settles, pulsing slowly. Camera: slow push
> in from wide to medium, ending at chest height, locked and steady. Lighting: soft key from the
> upper left, violet rim from behind, gold bounce from the palm onto the jaw. Shallow depth of
> field, gentle volumetric haze, fine film grain. Audio: low sub-bass swell, a soft rush of
> particles, one crystalline chime as the palm ignites, then quiet room tone. No text, no logos, no
> other characters.

---

## Five-shot sequence, 8 seconds each, about 40 seconds cut

### Shot 1 of 5: formless

> Cinematic 3D render on a near-black void stage. No character. A shifting cloud of violet light
> particles hangs in the center of frame, pulsing gently in and out like breathing, with faint
> threads of light passing through it as if something is thinking inside. The cloud has no shape and
> keeps failing to hold one. Camera: very slow push in, wide to wide-medium. Lighting: the cloud is
> the only light source, spilling violet into the haze around it. Volumetric fog, fine film grain.
> Audio: low sub-bass hum, faint electrical whisper, no music. No text, no characters.

### Shot 2 of 5: the body

> Same near-black void, same violet cloud. The particles pull sharply inward and collapse onto a
> figure: a stylized 3D humanoid avatar matching the reference character exactly. Materials resolve
> across the body from the feet upward in one smooth continuous sweep, each surface catching the key
> light as it lands. A faint wireframe grid maps the silhouette for an instant and fades. The figure
> stands still, newly solid. Camera: slow dolly in, wide to medium. Lighting: soft key upper left,
> violet rim from behind, haze in the beam. Audio: rising sub-bass, a soft mechanical lock as the
> final surface lands, then silence. No text.

### Shot 3 of 5: alive

> Same character, fully rendered, standing center frame in the near-black void. It lifts its head,
> turns slightly, and looks directly into the lens. Its chest rises with a breath. It shifts its
> weight, flexes one hand open and closed, and the beginning of an expression crosses its face.
> Small, human, unhurried movements. Camera: slow arc from the right, settling to a medium close-up
> on the face and shoulders. Lighting: soft key upper left, violet rim, a warm fill lifting the
> eyes. Shallow depth of field with the eyes in sharp focus. Audio: one quiet breath, low room tone,
> a single soft note. No text.

### Shot 4 of 5: it holds its own money

> Same character in the same void. It turns its right hand palm-up. A small hexagonal token of warm
> gold light ignites an inch above the palm, rotates slowly, and settles there pulsing like a
> heartbeat. Gold light spills up onto the face and chest. Thin teal threads reach in from the
> darkness toward the token and connect, and the token pulses brighter with each connection. Camera:
> slow push to a medium close on the hand and face together. Lighting: gold from the token as the
> key, violet rim from behind, teal accents on the threads. Shallow depth of field, the token in
> sharp focus. Audio: crystalline chime, quiet electrical hum, a soft ascending tick with each
> connection. No text, no coins, no currency symbols.

### Shot 5 of 5: out into the world

> Same character in the void. A tall rectangle of soft teal light opens in the darkness in front of
> it, like a doorway cut into the black, and through it we glimpse a sunlit ordinary room with plain
> furniture. The avatar walks forward and steps through the rectangle. On the far side it stands in
> the real room, lit by real daylight, still glowing faintly violet at the rim, gold still in its
> palm, looking around the space. Camera: track behind the character through the doorway, then swing
> around to a wide of it standing in the room. Lighting: violet and teal on the void side, natural
> warm daylight on the room side, a clean transition at the threshold. Audio: the hum drops away as
> it crosses, replaced by quiet natural room ambience and birdsong outside. No text.

---

## Negative prompt

Paste into the negative field on every shot.

> text, letters, numbers, words, subtitles, captions, watermark, logo, UI, user interface, HUD,
> charts, coins, dollar signs, currency symbols, crowds, extra characters, duplicate character,
> warped hands, extra fingers, face morphing, character drift, shaky camera, jump cuts, lens flare
> spam, rainbow colors, oversaturation, low resolution, cartoon shading, distorted anatomy

---

## If you want it to speak

Veo can generate its own audio. If you use that, put the sentence in double quotes inside the
prompt, name who says it, and append **"no subtitles, no captions, no on-screen text"** or captions
get burned into the frame.

If ElevenLabs speaks it instead, generate the voice first and cut the picture to the read. Never the
reverse: matching a render to an existing voice track works, matching a voice to an existing render
never does.

Lines that fit these five shots, one per beat, counted to sit inside 8 seconds:

1. *(11 words)* "Your model can write, reason, and speak. It has no body."
2. *(12 words)* "Type a sentence. It gets one. Rigged, animated, ready in a minute."
3. *(9 words)* "Now it can look at you when it answers."
4. *(12 words)* "It holds its own wallet on Solana. It can be paid directly."
5. *(13 words)* "Then it walks off our site and onto yours. One tag, any page."

Keep the pause after "It has no body." That silence is the whole premise.

---

## Post-production

- Composite every real string in an editor, never in the model: the URL, any address, any label.
- End card, 2 seconds, static: `three.ws` on black, and the tagline under it. Nothing else.
- Cut so the muted autoplay frame is shot 2 or shot 3. A body assembling reads instantly with no
  sound; a violet cloud does not.
- Post as native video, not a link to a video. X will not show a link preview and a video at once,
  and the video wins.

---

## X post

### Recommended

> Give your AI a body.
>
> Type a prompt, get a rigged 3D avatar that talks, walks, and holds its own Solana wallet. Drop it
> on your site with one tag.
>
> three.ws

Line 1 is the product in five words. Line 2 is the three things that make it different from a
picture, in the order people care about. The wallet lands last because it is the part nobody expects
from an avatar company.

### Alternate: builder-facing

> Your agent has a voice, a model, and a name. It still has no body.
>
> three.ws gives it one: a rigged 3D avatar you can talk to, embed anywhere with a single element,
> and fund with its own on-chain wallet.
>
> ```html
> <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
> <agent-3d src="agent://base/42"></agent-3d>
> ```

### Alternate: $THREE-first

> Every 3D agent built on three.ws ships with its own Solana wallet, an on-chain identity, and
> pay-per-call built in.
>
> $THREE is the coin of that economy.
>
> Give your AI a body: three.ws

### Reply slot, post under the main one

> The avatar in the video was generated from a text prompt on three.ws, rigged automatically, and
> rendered in the browser. No modeling, no rigging software, no download.
