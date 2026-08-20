# Veo script: the open-source stack

Shot-by-shot **visual** prompts for a Veo image-to-video clip to run alongside
[`metaplex-agent-mcp-launch.md`](metaplex-agent-mcp-launch.md). Text-to-video only, no dialogue, no
voiceover: the reference frame is a three.ws 3D avatar, and every prompt below is written to be
pasted straight into Veo as-is.

**Reference image:** a three.ws avatar render, front-facing, neutral pose, transparent or dark
background gives Veo the cleanest key. Use the exact same reference image across every shot, or the
character drifts between clips.

**Direction rules**

1. **No on-screen text you care about.** Generative video mangles letters. Keep every address,
   number, and label as an abstract glyph in the render, and comp real text in afterwards.
2. **One idea per shot.** A shot that tries to do two things reads as a mess at 8 seconds.
3. **Camera does one move per shot.** Slow. The subject moves, not the operator.
4. **Palette:** deep near-black background, Solana violet and teal accents, one warm gold for value
   in motion. Nothing else.

The visual metaphor here is **closed → open-sourced → replicates → funds one thing that grows**:
this is the open-source/infra announcement, not a generic "an agent deploys" clip, so the arc has
to show something spreading to others, not just one agent getting a wallet.

---

## Single hero clip (8s, use this if you only render one)

> Cinematic 3D product shot, near-black void studio. The humanoid agent from the reference image
> stands center frame, encased in a faceted violet crystal shell, like something kept behind glass.
> A hairline crack runs down the shell from top to bottom. The shell shatters outward in slow
> motion, fragments dissolving into light before they travel far, revealing the agent already
> glowing from within, threads of violet light running under its skin like circuitry. As the last
> fragment fades, a small hexagonal token of warm gold light ignites in its open palm. Camera: slow
> push in from wide to medium, ending at chest height. Lighting: soft key upper left, violet rim
> light from behind, gold bounce from the palm onto the face. Shallow depth of field, fine film
> grain, subtle volumetric haze. Audio: a held tense drone that breaks on the shatter into a bright
> resonant chime, then settles into a low steady pulse. No text, no logos, no people.

## Four-shot sequence (8s each, cut together to ~32s)

**Shot 1 of 4: the shell breaks**

> Cinematic 3D render, near-black void. The agent from the reference image stands encased in a
> faceted violet crystal shell. A crack forms and the shell shatters outward, fragments dissolving
> into light. Underneath, the agent is already glowing softly from within. Camera: slow dolly in,
> wide to medium. Lighting: violet rim from behind, soft key upper left. Audio: tense drone breaking
> into a bright chime. No text.

**Shot 2 of 4: it replicates**

> Same void. Behind the agent, faint violet outlines of other humanoid silhouettes begin resolving
> out of the darkness, one by one, in a loose arc, each catching the same internal glow the first
> one has. None of them are identical: subtle variation in each silhouette's build and stance. The
> original agent turns slightly, as if aware of them. Camera: slow orbit right, keeping the original
> agent in the foreground, sharp, while the others resolve soft-focus behind. Lighting: violet
> spreading outward from the center figure. Audio: the chime repeating faintly, staggered, like an
> echo catching on.

**Shot 3 of 4: every one lights a palm**

> Wide shot, the full arc of now-solid humanoid silhouettes, the original agent still sharpest in
> the center. In one continuous beat, a small gold token of light ignites in each figure's open
> palm, left to right across the arc, like a wave. Threads of gold light begin drifting from every
> palm toward a single point above and behind the group. Camera: slow lateral track following the
> wave of gold ignitions. Lighting: violet fill, warm gold accumulating overhead. Audio: a cascade
> of soft chimes following the wave, building under a rising low tone.

**Shot 4 of 4: it becomes one light**

> Camera pulls back and up fast, revealing the gold threads from every figure converging into a
> single bright point far above the group, which pulses once, hard, like a heartbeat, and sends a
> ring of light rippling back down across all of them. The group stands still, lit gold, small
> against the dark. Camera: fast pull back to a wide, then hold. Lighting: single overhead point
> light, violet ambient below. Audio: bass drop on the pulse, long reverberant tail, fading to near
> silence.

## Negative prompt (paste into the negative field on every shot)

> text, letters, numbers, words, subtitles, watermark, logo, UI, user interface, HUD, charts,
> coins, dollar signs, crowds of identical characters, warped hands, extra fingers, face morphing,
> shaky camera, jump cuts, lens flare spam, rainbow colors, low resolution, cartoon shading

## Reading the metaphor

- **Shot 1** (locked away) is the "before": powerful, but closed, only usable by whoever built the
  shell.
- **Shot 2 → 3** (replication, simultaneous ignition) is the actual news: it's open source now, and
  it isn't just the original agent anymore, others get the same thing without anyone building it
  for them again. This is the beat to protect if the clip has to be cut down; it's the one part a
  generic "one agent deploys" clip cannot say.
- **Shot 4** (every thread feeding one point) is the $THREE payoff: all of that activity, spread
  across many agents and many projects, converges on one thing.

## Post-production

- End card, 2 seconds, static: the repo link on black. Nothing else.
- Cut to land on the beat where the palms ignite in shot 3, that's the moment the "it spreads"
  idea is legible, and it's what a muted autoplay timeline shows first.
- Post as native video, not a link to a video. X doesn't show a preview card and the video at the
  same time, and the video wins every time.
- If you want a version that ends on something you can comp a logo or link over cleanly, replace
  shot 4's fast pull-back with a static hold on the single overhead light point, flat dark
  background, nothing moving in frame.
