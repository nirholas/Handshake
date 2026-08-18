# Ask the Experts: Nemotron Open Family (Nemotron Labs live on X)

Two messages to post into the live chat of NVIDIA's "What's New in the Nemotron Open
Family" stream (@NVIDIAAI): one from the official account, one from the founder account.
Both are built on things we can prove, so a panelist can check us mid-stream and find a
real deployment, a published write-up on NVIDIA's own forums, and Inception membership.

Nothing on a live stream is literally guaranteed. What follows maximizes the odds, and
the reason is simple: these are not "what is Nemotron" questions from a stranger. They
are production questions from a company already shipping on the models, carrying a
number the panel will want to repeat.

## Post 1: @trythreews (official)

Send this one first. It carries the Inception credential and the one product ask we
actually want answered.

> We're an NVIDIA Inception startup running nemotron-nano-12b-v2-vl as the input gate in
> front of our text-to-3D pipeline. Any plans for guaranteed structured / JSON decoding
> on the NIM chat models? Half our small-model work is coaxing rigid JSON out of them.

Why this gets answered:

- It is a **roadmap question a panel can answer**, not an opinion prompt. Guided decoding
  is a real feature area with a real status.
- It is **framed as a user who already shipped**, which is the framing NVIDIA's own
  developer-relations people are on the stream to find.
- The Inception line is one clause, up front, not a pitch. It qualifies us and then gets
  out of the way.
- It contains no link, so it is not filtered and it is easy to read aloud.

Backup, if post 1 gets skipped and the chat moves on:

> NVIDIA Inception member here: Nemotron Nano VL gates every generation on our
> text-to-3D platform because of its image-token footprint. Does Nemotron 3 Nano keep
> that footprint, or does the hybrid MoE change the math?

## Post 2: @nichxbt (founder)

Send this five to ten minutes after post 1, never simultaneously. Different account,
different angle, no repetition of the Inception line: this one is engineer to engineer.

> We picked nemotron-nano-12b-v2-vl on an axis no leaderboard tracks: about 281 prompt
> tokens for a small reference image, vs about 1,600 for a 90B-class vision model on the
> identical image. Was that token efficiency a deliberate design target?

Why this gets answered:

- It hands the panel a **compliment with a measurement attached**. Teams love hearing
  their model won on an axis they were not benchmarked on, and it is the kind of line a
  host repeats on air.
- It is answerable in one sentence by anyone who worked on the model.
- It reads as a person, not a brand, which is what a founder account is for.

Backup for the founder account:

> What is the smallest Nemotron you would trust as the input guardrail in front of an
> expensive GPU job? Ours answers in 1-2 seconds and saves a 20-second generation. Does
> Nemotron 3 Nano move that floor?

## The self-reply, once either gets answered

Do not put a link in the first message. Post it as a reply to your own message the moment
a panelist engages:

> Wrote the whole thing up on the NVIDIA Developer Forums:
> https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445

That link is the closer. It is a published Nemotron case study on NVIDIA's own property,
which converts "someone in the chat" into "a member with a citable story", and it gives
whoever runs @NVIDIAAI something safe to amplify afterwards.

## What we can prove if asked

Every claim in the two posts is sourced, so a follow-up question cannot catch us out:

| Claim | Source |
|---|---|
| NVIDIA Inception member, accepted July 2026 | [nvidia-inception.md](./nvidia-inception.md) |
| `nvidia/nemotron-nano-12b-v2-vl` gates every photo-to-3D generation, 1-2s | [nvidia-nemotron-spotlight.md](./nvidia-nemotron-spotlight.md), `api/_lib/forge-image-validate.js` |
| ~281 image prompt tokens vs ~1,600 for a 90B-class VLM | [nvidia-nemotron-spotlight.md](./nvidia-nemotron-spotlight.md) |
| Published Nemotron write-up on the NVIDIA Developer Forums | [forums.developer.nvidia.com](https://forums.developer.nvidia.com/t/how-nemotron-made-three-ws-text-to-3d-pipeline-usable/376445) |
| `nvidia-nemotron-nano-9b-v2` used for reasoning turns, NemoGuard at ~340 ms median | [nvidia-nemotron-spotlight.md](./nvidia-nemotron-spotlight.md) |

The two other standing asks from that write-up (the hosted TRELLIS image-input
restriction and the 77-character TRELLIS prompt cap) are TRELLIS questions, not Nemotron
questions. Do not spend a Nemotron panel's attention on them; they belong in the NIM or
TRELLIS channel.

## Posting rules for this stream

- One question per message. Two questions in one line get half-answered.
- Keep it near 200 characters. Long messages get skipped on air.
- Lead with the constraint or the number, never with what we sell.
- Do not post the same question from both accounts. It reads as brigading and both get
  ignored.
- Tag `@NVIDIAAI`. There is no verified dedicated Inception handle on X, so write
  "NVIDIA Inception" as words rather than inventing a mention.
- If a panelist answers, reply once with thanks and the forum link. Do not stack
  follow-ups in the same breath.
- Reply directly to the live post. A quote tweet sits outside the thread the host is
  reading from; save the quote tweet for after they engage.
- Post early, while the stream is live. Read-out-loud questions get picked in the first
  third, once the queue is still short enough to skim.
- If neither post is answered on air, ask the same question in our existing forum thread.
  The Nemotron team reads the developer forums, and a written answer there outlives a
  live mention.

## If the panel is on architecture and design

Segment-matched questions. A question that lands on the topic already on screen gets read
far more often than a good question that arrives out of order, so switch to these while
architecture is up and hold the roadmap questions for later.

### Official account, architecture segment

> At 3.6B active of 31.6B, batch-1 latency still pays to read every expert. For a
> single-call guardrail sitting in front of an expensive GPU job, is Nano MoE or a dense
> small model the better design?

197 characters. This is the sharpest architecture question we can ask honestly, because it
is our actual deployment shape: the input gate runs one call per generation, concurrency
one, latency-bound rather than throughput-bound. Sparse MoE pays off on batched serving
and buys much less at batch 1, and an architecture panel knows that. Asking it as a design
tradeoff rather than a complaint is what makes it answerable on air.

### Founder account, architecture segment

> On the hybrid Mamba-Transformer split: how many attention layers do you keep in
> Nemotron 3 Nano, and was that ratio tuned for 1M-context KV cost or for recall quality?

167 characters. The hybrid backbone is the family's signature design choice and the reason
the 1M context fits in 24.6 GB at all. Asking which objective set the ratio invites the
architecture answer they came to give.

### Two more, if the segment runs long

> What in the VL design gets a small reference image down to ~281 prompt tokens: patch
> tiling, a token compressor, or the projector? We picked the model on that axis.

Pairs with the founder post already drafted above, and turns our measurement into a
design question about the vision tower rather than a repeat of the same compliment.

> Does expert routing stay stable under constrained JSON decoding, or does forcing a
> grammar push tokens to experts the router would not have picked? We run rigid JSON on
> every call.

This one bridges architecture and the structured-decoding ask in post 1, so it works as
the follow-up if the official post gets answered while architecture is still on screen.

## Background on the family, for the follow-up

If they engage and there is room for a second question, these are grounded in the family
as it stands: Nemotron 3 Nano at 31.6B total / 3.6B active with 1M context in 24.6 GB,
Super at 120.6B / 12.7B, Ultra at 550B / 55B, all with open weights, data, and recipes,
plus a reported trillion-parameter Nemotron 4 in training.

- Time-to-first-token for Nano on an L4 when the same GPU is also feeding a render loop.
- KV cache cost at full 1M context on a 24 GB card, and retrieval accuracy at 1M vs 128k.
- Whether the openness bar (weights plus data plus recipes) holds at Nemotron 4 scale.

