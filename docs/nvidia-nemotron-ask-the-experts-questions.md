# Ask the Experts: Nemotron Open Family (Nemotron Labs live on X)

Questions for three.ws to drop into the live chat of NVIDIA's "What's New in the
Nemotron Open Family" stream (@NVIDIAAI). Ordered by what actually helps this platform
and by how likely a panel is to read it out.

## What the panel is fielding

Public state of the family as of this stream:

| Model | Params (total / active) | Notes |
|---|---|---|
| Nemotron 3 Nano | 31.6B / 3.6B | 1M token context, 24.6 GB, consumer-GPU class |
| Nemotron 3 Super | 120.6B / 12.7B | GTC, March 2026 |
| Nemotron 3 Ultra | 550B / 55B | June 2026 |
| Nemotron 4 | ~1T, in training | reported for late 2026 |

The family ships open weights, open training data, and open recipes (roughly 10T tokens
of released datasets), with a hybrid mixture-of-experts architecture aimed at agentic
work. Every question below is written against that, not against generic "what is an LLM"
framing, because the read-out-loud questions are the specific ones.

## Rules for posting into a live chat

- One question per message. Two questions in one line get half-answered.
- Under about 200 characters. Long messages are skipped on air.
- Lead with the constraint, not with our product. "3.6B active on an L4" is a hook;
  "we built a 3D avatar platform" is an ad and gets skipped.
- Post from the three.ws handle, ask the follow-up only after they answer the first.

## The questions

### 1. Interactive latency next to a render loop (best single ask)

> Nemotron 3 Nano at 3.6B active: what time-to-first-token are you seeing on an L4 when
> the GPU is also feeding a real-time render loop? Any guidance on sharing one GPU
> between inference and graphics?

Why it lands: it is a hardware question with a number in it, it is the exact thing our
GPU workers do, and nobody else in the chat will ask it. This is the one to post first.

### 2. Tool calling under an agentic harness

> For agentic use: how does Nemotron 3 hold up on strict JSON schema adherence over long
> multi-tool runs, and is there a reasoning-budget control to keep tool latency bounded?

Why it lands: "agentic AI" is the family's own positioning, so they have prepared
material, and schema adherence is what actually decides whether an agent runtime can use
a model in production.

### 3. What 1M context costs in memory

> The 1M context on Nano is the headline. What does the KV cache cost at 1M on a single
> 24 GB card, and what retrieval accuracy do you measure at full length vs 128k?

Why it lands: it is a friendly but real question. Long-context claims usually degrade,
and asking for the honest curve reads as a builder, not a critic.

### 4. Fine-tuning on a narrow domain without losing the agentic behavior

> With the open recipes out there: what is the recommended way to fine-tune Nano on a
> narrow domain corpus without degrading the tool-calling behavior you post-trained in?

Why it lands: this is the question every team that adopts an open model hits in week
two, and the open-recipe release is exactly what makes it answerable on air.

### 5. Quantization floor for consumer hardware

> Where does quality actually break down on Nano: FP8, NVFP4, lower? Which quantization
> do you ship as the recommended default for consumer GPUs?

Why it lands: it converts the "24.6 GB fits consumer hardware" claim into something a
builder can plan capacity against.

### 6. Vision and 3D

> Anything in the Nemotron VL line aimed at 3D assets, so a model can look at a rendered
> mesh and judge topology or texture quality? Curious how it lines up with Cosmos.

Why it lands: this is our lane (text to 3D, rigging, avatar QA), and it invites them to
talk about physical AI, which they like talking about.

### 7. Serving stack on day one

> Which serving path do you consider first-class for Nemotron 3: TensorRT-LLM, vLLM, or
> SGLang? Where does the hybrid MoE architecture need a version bump to run right?

Why it lands: hybrid architectures routinely land ahead of runtime support, and knowing
which runtime is blessed saves a deployment week.

### 8. What stays open in Nemotron 4

> With Nemotron 4 reported at trillion scale: does the same openness bar hold there,
> weights plus data plus recipes, or does the tier change with size?

Why it lands: it is the forward-looking question of the stream, and it is a fair one to
ask a team whose whole pitch is openness. Post it late, near the end.

### 9. The accuracy follow-up

The chat already asked "how do you increase the accuracy?" and that question is too
broad to get a useful answer. A sharper version, posted as a follow-up:

> Following the accuracy question: for a narrow domain, what moves the needle more in
> your experience, more post-training data or more reasoning tokens at inference?

Why it lands: it rescues a question the panel already saw, which makes it likely to be
picked up, and the answer is genuinely useful to us.

## If we only get one message in

Post question 1. It is specific, it has numbers, it is a hardware question at a hardware
company, and the answer directly informs how we size the GPU workers.
