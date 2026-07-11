# Animations from data: wire your agent's gestures to real APIs and AI

An agent that just idles is furniture. An agent that visibly *reacts* — dances when something spikes, flinches when something drops, celebrates a milestone — reads as alive. three.ws ships a full animation library (idle, wave, dance, celebrate, jump, dozens more — browse them at [/animations](/animations)) and a public JS API to trigger any of it on command. This tutorial shows you how to point that at data you actually have: a live feed, a webhook, or a real AI model classifying arbitrary text.

You'll build two working pipelines — one with zero AI (a lexicon sentiment score, free, no key, triggering a real body animation), one with a real model in the loop (IBM Granite classifying arbitrary documents, feeding a wider set of gestures) — plus the cooldown pattern that keeps an automated agent from spamming animations every tick.

**What you'll build:**
- An agent that plays a real body animation (celebrate, dance, flinch) driven by a live sentiment feed, using only `<agent-3d>`'s public JS API
- A second pipeline where an actual AI model reads arbitrary text — reviews, tickets, chat logs, anything — and picks the matching gesture from a wider library, not just a three-way keyword split
- A cooldown/dedupe pattern so a fast-moving data source doesn't retrigger the same animation every poll
- The two real, documented entry points for animation: `agent.play(clipName)` (exact clip) and `agent.playEmote(name)` (semantic, with a fallback chain)

**Prerequisites:** You've completed [first agent](/tutorials/first-agent) or have an `<agent-3d>` element on a page, and ideally [the JS API tutorial](/tutorials/js-api-events) (Step 5 covers the animation basics this one builds on). For the AI lane, a small amount of USDC and familiarity with the [x402 payment flow](/tutorials/pay-for-x402-service) — the call costs $0.04.

---

## Step 1 — The two animation entry points

Every `<agent-3d>` element exposes two public methods for triggering body animation, and — per the [JS API tutorial](/tutorials/js-api-events#step-5--animations-exact-name-vs-hint) — they answer different questions.

**`agent.play(clipName)`** — plays the clip with that *exact* name from the loaded library or GLB. Case-sensitive; if the name isn't found, nothing plays. Use this once you know what's actually in the rig — e.g. `agent.play('rumba')`, `agent.play('thriller')`, `agent.play('celebrate')`. The full catalog (idle, locomotion, dance, gesture, action, sport, reaction, fitness — every clip a real, retargetable library entry, never hardcoded per-rig) is browsable at [/animations](/animations).

**`agent.playEmote(name)`** — a higher-level wrapper for the small set of product-moment reactions with a built-in fallback chain, so it's guaranteed to do *something* regardless of which clips the loaded rig actually has:

```js
agent.playEmote('celebrate'); // celebrate → wave
agent.playEmote('cheer');     // cheer → celebrate → wave
agent.playEmote('flinch');    // flinch → defeated → concern → shake
```

If none of a chain's names exist on the rig, `playEmote` falls back to a small head-bob rather than doing nothing — so it's the safe default for "react to this event" code, and `play()` is for "I know exactly which clip I want."

Convenience shortcut: `agent.wave()`.

The pattern for "animation from data" is: **your data source picks a discrete outcome** (celebrate / flinch / a specific dance), and you call `playEmote()` or `play()` with that name. Unlike the sustained facial-mood layer (`setMood()` — covered separately, see the note at the end), these are one-shot performances that play out and settle back to idle on their own.

---

## Step 2 — The free lane: sentiment → animation, no AI required

The platform runs a public, unauthenticated sentiment scorer over live pump.fun token chat: [`POST /api/social/sentiment-pulse`](../../api/social/sentiment-pulse.js). It pulls recent comments for a token and scores them with an in-repo lexicon (no LLM call, no key) — good enough to prove the wiring before you reach for a model.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sentiment-driven agent</title>
  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
</head>
<body>
  <agent-3d id="agent" agent-id="YOUR_AGENT_ID" mode="inline" width="360px" height="480px"></agent-3d>

  <script type="module">
    const agent = document.getElementById('agent');
    const TOKEN = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'; // $THREE, or any mint
    let lastFired = 0;
    const COOLDOWN_MS = 20_000; // never retrigger faster than this

    async function pulse() {
      const res = await fetch('https://three.ws/api/social/sentiment-pulse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, limit: 100 }),
      });
      if (!res.ok) return null;
      return res.json();
    }

    function reactTo(overall) {
      // scoreSentiment() returns score in [-1, 1] and posPct/negPct/count.
      // Require both a strong score AND enough chatter to trust it — a
      // single glowing comment shouldn't trigger a full celebration.
      const confident = overall.count >= 5;
      const now = performance.now();
      if (now - lastFired < COOLDOWN_MS) return; // still cooling down

      if (confident && overall.score > 0.45) {
        agent.playEmote('celebrate');
        lastFired = now;
      } else if (confident && overall.score < -0.45) {
        agent.playEmote('flinch');
        lastFired = now;
      }
      // Middling/uncertain sentiment: leave whatever's currently playing alone.
    }

    async function tick() {
      const data = await pulse();
      if (data?.ok) reactTo(data.overall);
    }

    agent.addEventListener('agent:ready', () => {
      tick();
      setInterval(tick, 30_000); // pump.fun comment volume doesn't need faster than this
    }, { once: true });
  </script>
</body>
</html>
```

Save that as `index.html` and open it — no build step, no server, no wallet. Swap `TOKEN` for any Solana mint and the agent physically celebrates or flinches as that token's live chat swings.

---

## Step 3 — The AI lane: real classification over arbitrary data, richer gestures

A lexicon scorer only works on short, informal text and only gives you positive/negative. For real documents — support tickets, product reviews, meeting transcripts, incident reports — you want a model that returns *structured* emotion: a sentiment score plus a breakdown across joy, anger, fear, sadness, surprise, and disgust, so you can pick a more specific reaction than a binary celebrate/flinch. `ibm_granite_analyze` (part of the [IBM Granite x402 MCP suite](../ibm-x402-mcp.md)) does exactly this for $0.04/call, no IBM account needed — you pay in USDC, it pays IBM.

This is a server-side call (it needs a wallet to sign the payment), so it lives behind a small endpoint you host yourself and the browser polls. The `@three-ws/x402-fetch` package does the 402 → sign → retry dance for you — see [pay-for-x402-service](/tutorials/pay-for-x402-service) for the full protocol if you want the mechanics.

```js
// gesture-from-ai.js — run with `node gesture-from-ai.js`, or drop the body of
// gestureFor() into any serverless handler (Vercel/Cloud Run/etc).
import { withX402, privateKeyToWallet } from '@three-ws/x402-fetch';

const wallet = privateKeyToWallet(process.env.SOLANA_PRIVATE_KEY); // funds the $0.04 calls
const fetchWithPay = withX402(fetch, wallet);

// Dominant emotion → the richest matching clip. exact-name clips (agent.play)
// give a bigger, more specific performance than the 3-way emote chain.
const GESTURE_FOR = {
  joy: 'celebrate',
  surprise: 'silly',
  anger: 'shake',
  fear: 'defeated',
  sadness: 'defeated',
  disgust: 'angry',
};

async function gestureFor(document) {
  const res = await fetchWithPay('https://three.ws/api/ibm-mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'ibm_granite_analyze',
        arguments: { document, analysis_type: 'sentiment' },
      },
    }),
  });
  const { result } = await res.json();
  const analysis = JSON.parse(result.content[0].text);

  const breakdown = analysis.emotion_breakdown || {};
  const [dominant, strength] = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0] || ['joy', 0];

  // Below this, the signal is too weak to justify interrupting idle.
  if (strength < 0.3) return null;

  return { clip: GESTURE_FOR[dominant] || null, strength, summary: analysis.summary };
}
```

Wire that into a one-route endpoint (`GET /gesture?text=...` returning the JSON above), and the browser side reuses the same cooldown-gated `reactTo()` shape from Step 2 — swap the fetch call and the trigger:

```js
async function tick() {
  const res = await fetch(`/gesture?text=${encodeURIComponent(latestDocument)}`);
  const { clip } = await res.json();
  const now = performance.now();
  if (clip && now - lastFired > COOLDOWN_MS) {
    agent.play(clip); // exact library name, e.g. 'shake', 'silly', 'celebrate'
    lastFired = now;
  }
}
```

Now anything you can turn into a string — a webhook payload, a scraped page, a batch of reviews — can drive a specific, visible body performance instead of a static idle loop.

---

## Step 4 — Don't let fast data spam the animation queue

Two rules worth copying from the platform's own production reaction engine ([`src/widgets/pumpfun-reactions.js`](../../src/widgets/pumpfun-reactions.js) — the pump.fun live-trade avatar reactor, 23 distinct clips across dozens of event shapes):

1. **Cooldown, not "react to every event."** A fast feed (trades, comments, ticks) will fire far more often than a physical performance can play out. Gate triggers behind a minimum interval (`COOLDOWN_MS` above) — the production reactor goes further and queues lower-priority events behind an in-flight gesture instead of dropping or interrupting it.
2. **Require confidence before you interrupt idle.** A single data point (one comment, one weak signal) shouldn't yank the avatar out of idle. Both examples above gate on a minimum sample size / signal strength (`overall.count >= 5`, `strength >= 0.3`) — tune the threshold to your own data's noise floor.

```js
let lastFired = 0;
const COOLDOWN_MS = 20_000;

function reactIfConfident(clipOrEmoteName, { confident, useExactClip = false } = {}) {
  const now = performance.now();
  if (!confident || now - lastFired < COOLDOWN_MS) return false;
  useExactClip ? agent.play(clipOrEmoteName) : agent.playEmote(clipOrEmoteName);
  lastFired = now;
  return true;
}
```

---

## A note on the facial layer

`agent.play()` / `agent.playEmote()` drive the *body* directly — the skeleton, via the shared animation-clip library, for a one-shot performance you chose explicitly. `agent.setMood(valence, arousal)` / `agent.expressEmotion(trigger, weight)` primarily drive the *face* — ARKit-52 blendshapes (smile, brow, gaze) on avatars that carry them, without touching the skeleton. They're still distinct APIs for distinct calls (`play`/`playEmote` for "perform this exact gesture now" vs. `setMood`/`expressEmotion` for "this is how the agent feels"), but they're not fully independent: once nothing more urgent (like a `play()`/`playEmote()` call or a fresh `expressEmotion()` spike) already claims the ambient gesture slot, a *sustained* `setMood()` also lightly biases which idle-time gesture the body reaches for — energetic-positive moods lean toward `celebrate`, subdued-negative moods toward `concern` — so a happy agent doesn't just smile while standing dead still. See [Animate your avatar → Emotion and expression on the live agent](animate-your-avatar.md#emotion-and-expression-on-the-live-agent) for the full wiring. This tutorial covers explicit body triggers; if you want the face (and the ambient body bias) to track data too, the same fetch/cooldown pattern above applies, just swapping in `setMood()`/`expressEmotion()`.

---

## Troubleshooting

- **Nothing plays.** Confirm `agent:ready` fired before your first `play()`/`playEmote()` call — calling either before boot is silently a no-op. Wrap your first tick in the `agent:ready` listener as shown in Step 2.
- **`agent.play('someClip')` does nothing.** The name is case-sensitive and must match a clip actually present on the rig — check the exact name at [/animations](/animations) or fall back to `playEmote()`, which degrades gracefully instead of silently failing.
- **The agent keeps re-celebrating every poll.** You skipped the cooldown gate in Step 4, or your confidence threshold is too low for a noisy feed. Widen `COOLDOWN_MS` or raise the sample-size/strength floor.
- **AI lane 402 loop / never resolves.** Your `SOLANA_PRIVATE_KEY` wallet has no USDC. Fund it with a few cents — see the [x402 payment flow](/tutorials/pay-for-x402-service).
- **`analysis.emotion_breakdown` is undefined.** You passed `analysis_type` other than `sentiment` — only that type returns the per-emotion breakdown; the other five types return type-specific fields instead (see [ibm-x402-mcp](../ibm-x402-mcp.md)).

---

## Recap

- `agent.play(clipName)` for an exact clip, `agent.playEmote(name)` for a safer semantic trigger with a fallback chain — both are public methods on every `<agent-3d>` element, no library beyond the CDN script.
- The free lane (`/api/social/sentiment-pulse`) proves the wiring with zero AI and zero cost.
- The AI lane (`ibm_granite_analyze` over x402) turns arbitrary documents into a richer emotion breakdown, unlocking more of the animation library than a simple positive/negative split.
- Gate every automated trigger behind a cooldown and a confidence floor — [`pumpfun-reactions.js`](../../src/widgets/pumpfun-reactions.js) is the production-grade version of this exact pattern, queueing and prioritizing real trade-feed events across 23 distinct clips.

**Related tutorials:** [The JS API — animations, exact name vs. hint](/tutorials/js-api-events) · [Trigger the agent from page events](/tutorials/trigger-from-page-events) · [Animate your avatar](/tutorials/animate-your-avatar) · [Discover and pay for an x402 service](/tutorials/pay-for-x402-service)
