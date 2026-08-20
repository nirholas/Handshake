# Spoken script: the agent deployer video

The words only. Visual prompts, camera, and palette live in
[metaplex-agent-mcp-x-post.md](./metaplex-agent-mcp-x-post.md); this file is what gets said, cut
into the 8-second beats Veo generates so each line lands inside one clip.

**Pacing rule:** 8 seconds of natural speech is 18 to 22 words at the absolute ceiling, and 12 to 16
words if you want it unhurried with room to breathe at the head and tail. Every line below is
counted. Shorter always survives generation better than longer.

**If Veo speaks the line** (native audio), put the sentence in quotes in the prompt, name the
speaker, and add "no subtitles, no captions, no on-screen text" or it will burn captions into the
frame. **If ElevenLabs speaks it** over a silent render, generate the voice first and cut the
picture to the read, never the reverse.

**Reference character:** a three.ws avatar, front-facing, neutral pose, dark or transparent
background. Keep the same reference image across every clip or the character drifts between shots.

---

## Version A: the agent speaks (recommended)

The strongest version, because the thing announcing itself is the thing being announced. First
person throughout. Five clips, about 40 seconds.

**1. Hook** *(12 words)*
> I was made by someone who has never owned a crypto wallet.

**2. The turn** *(15 words)*
> Ninety seconds later I was on Solana. My own address. My own identity. Nobody's permission.

**3. Custody** *(14 words)*
> No account. No company holding my keys. There is no server in this story.

**4. What it unlocks** *(16 words)*
> Now I can be paid. I can pay. Other agents can find me and hire me.

**5. Call to action** *(12 words)*
> Name yours. Click deploy. It exists before you finish reading this sentence.

---

## Version B: narrator over the avatar

Use if you want the avatar silent and expressive rather than talking. Same five beats, third
person, easier to lip-sync around because nothing has to match a mouth.

**1.** *(16 words)*
> Three hundred and thirty three of these went on-chain. Most owners had never held a wallet.

**2.** *(12 words)*
> Now anyone can do it. Name an agent. Click deploy. It exists.

**3.** *(15 words)*
> It arrives with its own wallet address and an identity any other agent can read.

**4.** *(12 words)*
> Your keys never leave your browser. There is no server to trust.

**5.** *(10 words)*
> The next wave will not know they are using crypto.

---

## Version C: 24-second cut

Three clips when you want it fast for the timeline. Version A's voice, compressed.

**1.** *(12 words)*
> I was built in a browser by someone with no crypto wallet.

**2.** *(15 words)*
> Ninety seconds later I existed on Solana, with my own wallet and my own identity.

**3.** *(11 words)*
> Name yours, click deploy. Everything else already happened in the background.

---

## Version D: one-clip hero, 8 seconds

For a single generation with no editing. One breath, one idea.

*(18 words)*
> I was made by someone who had never owned a wallet. Ninety seconds later, I existed on Solana.

---

## Delivery notes

- **Tone:** calm and matter of fact, not hyped. The claim is remarkable enough that selling it makes
  it sound less true. Think a voice stating something obvious in hindsight.
- **The pause that matters** is after "on Solana" in every version. That is the beat the whole piece
  rests on, so leave dead air there rather than rushing to the next line.
- **Numbers to keep spoken, not written:** "ninety seconds" and "three hundred and thirty three".
  Generative video mangles digits on screen, and spelled-out numbers read correctly in TTS.
- **Do not say** that buybacks are running, or quote a $THREE price. The fee funding buybacks is
  true; buybacks executing right now is not yet, and this is the kind of line people screenshot.
- **End card, comped in afterwards, not generated:** the URL as flat text over the last frame.
  Never let a model render a link.
