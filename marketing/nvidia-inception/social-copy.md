# NVIDIA Inception: social copy

Paste-ready posts for the announcement that never went out. Membership was
accepted July 2026 and [announcement-coverage.md](../../docs/announcement-coverage.md)
shows the `/nvidia` surface with an empty "announced on X" column, while `/openai`
has a real post behind it. This file closes that gap.

Strategy, priorities, and every other NVIDIA surface:
[docs/nvidia-visibility-map.md](../../docs/nvidia-visibility-map.md).

**Posting is owner-gated.** Everything here is drafted and ready; none of it has
been posted.

---

## The rules these posts follow

Read before editing anything below. Getting these wrong on a post that tags
NVIDIA is worse than not posting.

1. **"NVIDIA Inception member." Never "NVIDIA partner."** Inception is a startup
   program. No "backed by NVIDIA", no "partnered with NVIDIA", no implied
   investment or endorsement. This is the same rule the site footer badge and
   [docs/partners.md](../../docs/partners.md) already enforce.
2. **Tag by topic, not by reach.** `@NVIDIAAIDev` for digital humans and
   developer work, NVIDIA for Startups on LinkedIn for the membership itself.
   Blasting `@NVIDIA` on a developer story gets ignored. The full topic-to-account
   table is in the visibility map.
3. **`#NVIDIAInception` on every post.** It is the tag NVIDIA's social team
   monitors, and it is how a member post becomes a resharable one.
4. **Use the official badge.** [public/marks/nvidia-inception-badge.svg](../../public/marks/nvidia-inception-badge.svg),
   unmodified. Do not recolor, crop, or place it on a busy background.
5. **No coin.** These posts are about GPUs and digital humans. The token has no
   place in a thread aimed at NVIDIA's developer audience.
6. **Every number must be current.** The GPU fleet count changes. Recount with the
   command in the visibility map before posting anything that quotes it.

## One post, if you post only one

X, `@trythreews`, with the badge image attached.

> three.ws is an NVIDIA Inception member.
>
> Every 3D generation lane we run is on NVIDIA silicon: a self-hosted Cloud Run
> fleet of L4s plus one RTX PRO 6000 Blackwell behind text-to-3D, auto-rigging,
> and motion, and NVIDIA-hosted models behind chat, vision, embeddings, safety,
> and speech.
>
> Type a prompt, get a rigged 3D avatar, free, no account:
> three.ws/forge
>
> #NVIDIAInception

Attach: the badge SVG rendered to PNG, or a 10-second screen capture of a forge
generation finishing.

## X thread (the version that earns replies)

Post 1 is the post above. Then:

**2/**
> The part that surprised people: it runs in a browser tab. No plugin, no install,
> no upload to a server you don't control.

**3/**
> Voice and face are NVIDIA end to end. Riva ASR listens, Nemotron reasons, Magpie
> speaks, and Audio2Face-3D drives ARKit-52 blendshapes on the avatar in real time.
>
> Most Audio2Face work lives in Unreal or Omniverse. This is in a tab:
> three.ws/demos/audio2face

**4/**
> We wrote up the parts that were genuinely hard on the NVIDIA Developer Forums.
>
> How small Nemotron models became the validator layer in front of TRELLIS,
> taking generations to 12-13s with ~340ms safety latency:
> forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445

**5/**
> And the GPU engineering itself: memory ceilings on 24GB L4s, sm_120 kernel builds
> for Blackwell, and the regional quota fights nobody warns you about.
>
> three.ws/blog/image-to-3d-on-nvidia-l4-and-blackwell
>
> cc @NVIDIAAIDev

## LinkedIn

Tag **NVIDIA for Startups**. Longer form works better here than on X.

> three.ws is now a member of NVIDIA Inception.
>
> We build the 3D layer for AI agents: type a sentence, get a textured, rigged
> avatar that can talk and be embedded on any website with one HTML tag. The free
> tier needs no account.
>
> The reason Inception matters to us is not the badge, it is that GPU capacity is
> the single hardest constraint on how good generation can get. Every
> compute-bound path we run is already NVIDIA: a self-hosted Cloud Run GPU fleet
> on L4s and one RTX PRO 6000 Blackwell behind text-to-3D, image-to-3D,
> auto-rigging and motion generation, plus NVIDIA-hosted models behind agent
> reasoning, vision, embeddings, content safety, and speech.
>
> The piece I am most proud of is the digital human. NVIDIA Riva handles speech in
> and out, Nemotron does the reasoning, and Audio2Face-3D drives the facial
> blendshapes, all rendering in a browser tab with nothing installed. Most
> Audio2Face implementations live inside a game engine. Getting one to run on the
> open web took a while and we wrote up how.
>
> Inception is a startup program rather than a partnership, and NVIDIA does not
> endorse what we build. It does give us the capacity and the technical access to
> keep making generation faster and better, which is the whole job.
>
> Try it: three.ws/forge
>
> #NVIDIAInception

## The Audio2Face clip (highest-value standalone post)

This is the most differentiated asset on the platform and it deserves its own post
rather than being buried in a thread.

Capture a 15-second screen recording at `/demos/audio2face`: audio in, face
lip-syncing, browser chrome visible so it is obvious there is no game engine.

> Audio2Face-3D running in a browser tab.
>
> Audio goes in, NVIDIA Audio2Face-3D returns an ARKit-52 blendshape stream, and
> we map it onto whatever morph convention the avatar happens to ship (ARKit, VRM
> vowels, Oculus visemes) at runtime.
>
> No install, no game engine, no plugin.
>
> three.ws/demos/audio2face
>
> #NVIDIAInception @NVIDIAAIDev

## Telegram, holders channel

Shorter, no hashtags, no tagging.

> three.ws is an NVIDIA Inception member. Every 3D generation lane on the platform
> runs on NVIDIA GPUs, and the program is how we scale that past the free tier
> without giving up the free-first design. What runs where: three.ws/nvidia

## After posting

1. Fill in the `/nvidia` row in [announcement-coverage.md](../../docs/announcement-coverage.md)
   with the post URL and date, the way the `/openai` row is filled in.
2. Add the post URL as `source_url` on the `2026-07-18-nvidia-inception-public`
   event in [data/timeline.json](../../data/timeline.json), which is currently
   `null`.
3. While you are in that file: `2026-07-18-jensen-huang` records an interaction
   from NVIDIA's CEO and also has a `null` source. If that link can be recovered
   from account history, it is the most valuable citation this company owns.
   Archive it to `web.archive.org` once found.
