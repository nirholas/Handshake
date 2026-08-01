# 06. LLM lanes: retire the dead backstops, close the Claude gap, fix the metering lie

Read [00-INDEX.md](00-INDEX.md) first.

## What is wrong

Three separate defects wear one label ("LLM backstops are dead"). Treat them
separately.

**1. The paid backstops are unreachable.** `OPENAI_API_KEY` is set on the service
but the account returns `billing_not_active` 429s, so every OpenAI paid backstop is
out. The OpenRouter platform key burned its credit on paid-model routing. Traffic
survives on the free lanes (Groq, NIM) plus the Vertex Gemini credits anchor.

**2. The metering does not show it.** `llm-pricing` records OpenRouter spend as
**$0**, so the credit burn that killed the key was invisible right up until it was
gone. A cost lane that reports zero is worse than one that reports nothing.

**3. Claude reachability is split, and the docs describe the design instead of the
deployed state.** Verified against the live service:

- `/brain` (`api/brain/chat.js`) **does** reach Claude, through the OpenRouter
  mirrors (`anthropic/claude-*`), because `buildPrimary()` falls back to
  `spec.openrouterModel` when the native key is absent.
- Everything else (`api/chat.js`, `api/_lib/llm.js`, the embed proxy
  `api/llm/anthropic.js`) reaches Anthropic only via `api.anthropic.com` with
  `ANTHROPIC_API_KEY`, which is absent from `.env`, `.env.local`, and the
  `three-ws-api` service. Those paths get no Claude at all.
- Vertex Claude is off **and** unentitled: `VERTEX_CLAUDE_ENABLED=0`,
  `VERTEX_CLAUDE_PRIMARY=0`, and `rawPredict` returns 404 "project does not have
  access" for every Claude id in both `global` and `us-east5`. Flipping the flag
  alone would 404 every request.

## The work

1. **Make the free-lane path first-class, not a degradation.** Since paid lanes
   are out, the free chain carries production. Audit its failover for the same
   defect class found elsewhere in this repo: a fallback that only catches parse
   errors is bypassed exactly when the provider fails. Prove each rung is
   reachable with a test that simulates the rung above failing at the transport
   level, not just returning bad JSON.

2. **Fix the metering.** OpenRouter spend must be recorded at its real cost in
   `llm-pricing`. A lane whose cost cannot be determined should record `unknown`
   and raise, never `0`. Add a check that fails when any lane with non-zero
   traffic reports exactly zero cost over a window.

3. **Prepare the Claude key rollout so it is one command.** When
   `ANTHROPIC_API_KEY` arrives:
   ```sh
   gcloud run services update three-ws-api --region us-central1 \
     --project aerial-vehicle-466722-p5 --update-env-vars ANTHROPIC_API_KEY=...
   ```
   Never `--set-env-vars`. Fresh accounts start at **Tier 1** rate limits, so keep
   Claude off the x402 ring and any high-QPS lane; chat, brain, and reflection
   backstop traffic only until the tier grows. `claude-fable-5` requires 30-day
   data retention on the org and returns 400 under zero data retention.
   `claude-mythos-5` is deliberately kept out of the `/brain` menu.

4. **Correct the docs that describe Vertex Claude as the live credits-billed
   primary.** It is the design, not the deployed state. Any doc claiming Claude
   traffic bills to GCP credits today is wrong until Model Garden entitlement lands
   and `rawPredict` stops 404ing. Fix those lines in the same change.

5. **Flag, do not silently ship, the OpenRouter-mirror decision.** `api/chat.js`
   and `_lib/llm.js` have no OpenRouter mirror for Claude the way `/brain` does.
   Adding one would work immediately but draws real spend on the platform key for
   ordinary agent traffic. `isPaidModel()` in `_lib/chat-models.js` is the existing
   gate for exactly this shape. Implement it behind that gate, default off, and
   state the cost in your report.

## Owner actions (name them, do not wait on them)

- Reactivate OpenAI billing, or fund the OpenRouter key, or accept free-lane-only
  service.
- Accept Anthropic terms in Vertex Model Garden for project
  `aerial-vehicle-466722-p5` to bill Claude to the GCP credits. Then re-probe
  `rawPredict` and set `VERTEX_CLAUDE_ENABLED=1`; the Claude 5 ids are already in
  `VERTEX_ANTHROPIC_MODELS`.

## Verify

```sh
curl -s https://three.ws/api/healthz | python3 -c "import json,sys;print(json.load(sys.stdin)['subsystems']['degraded'])"
npm run gate
```

Probe each lane directly rather than trusting a config read: a set key is not a
working key, which is the entire lesson of defect 1.

## Definition of done

- [ ] Every free-lane rung proven reachable by a transport-level failure test.
- [ ] No lane with traffic reports exactly `$0`; a check fails if one does.
- [ ] The key-arrival path is a single documented command with rate-limit guidance.
- [ ] Every doc claiming Vertex Claude is live today is corrected.
- [ ] The OpenRouter-mirror option is implemented behind `isPaidModel()`, default
      off, with the cost stated.
- [ ] `npm run gate` green, `data/changelog.json` entry (tag: `infra`).
