# Task: Root-cause and fix the x402 autonomous loop 502 bursts

## Context (verified 2026-07-25)

The autonomous x402 buyer loop (user agent `threews-x402-autonomous/1.0`) fails 69% of its calls all-time. The dominant error is `http_502`: 67,770 all-time, 20,030 in the last 48 hours, and it is still happening (last spike 09:00 to 11:00 UTC today at roughly 500 per hour).

Hard data already gathered, do not re-derive it:

- Failure breakdown lives in the `x402_autonomous_log` Neon table (`DATABASE_URL` in `.env`), column `error_msg`. Top offenders last 48h: `http_502` 20,030; `http_405` 3,026; `http_400` 2,798; `sponsor_sol_floor` 2,527; `http_402` 1,911.
- The 502s hit many different `/api/x402/*` endpoints (crypto-intel, analytics, skill-marketplace, spend-session, did, cross-chain, notify, wallet-connect, feed-health, `/api/x402/d/coin/...`, `/api/mcp`), so it is not one broken handler.
- The same endpoints return correct 402 challenges when curled manually outside the burst window, so this is load-correlated, not a hard outage.
- During the 10:00 UTC hour today the loop's own traffic mix on Cloud Run was: 501x 402 (good), 365x 502, 62x 405, 56x 400, 8x 422, 5x 200, 2x 404, 1x 503.
- Cloud Run 502 log entries carry NO textPayload (no app-level error), latencies range 0.3s to 8.6s. Startup probes succeed; no OOM or exit signatures found in the last 48h. A burst of new instance startups happened at 10:40 UTC while 502s were flowing.
- Cloud Run config for `three-ws-api` (region `us-central1`, project `aerial-vehicle-466722-p5`): containerConcurrency 160, minScale 2, maxScale 100, cpu-throttling on, startup-cpu-boost on, VPC connector `three-ws-vpc` with private-ranges-only egress.
- Separate but possibly related: the Redis cache layer is flapping. App logs show repeated `[cache] redis GET/SET failed, using memory fallback: upstash 500 SRH: Unable to connect to the Redis server` and timeout variants. A failing cache makes every request slower and heavier, which can amplify burst saturation.

## Job

1. Find the 502 mechanism. Likely candidates to check, in order: the loop hammering the service through the public LB/CDN in tight bursts and hitting per-instance connection resets; in-process handler crashes that kill in-flight requests without logging; LB backend timeout mismatch (Cloud Run request timeout vs LB timeout); the Node server (`server/index.mjs`) closing keep-alive sockets under load (classic Node keepAliveTimeout < LB idle timeout bug, which produces exactly this signature: intermittent 502s at the LB with no app logs). Check `server/index.mjs` for `keepAliveTimeout` and `headersTimeout` settings; Google Front End reuses connections and needs server keepAliveTimeout above the LB's 600s idle default, or at minimum above 61s. This is the most probable root cause given the evidence.
2. Fix it properly (no retries-as-bandaid; fix the mechanism, then add sane retry with backoff in the loop caller as defense in depth if it does not already exist).
3. Fix the Redis/SRH cache failures too: find where the Upstash/SRH endpoint is configured (Cloud Run env), verify whether the SRH proxy is dead or misconfigured, and either restore it or point the cache at a working Redis (Memorystore on the existing VPC connector is pre-approved GCP spend). Memory fallback must remain as the last resort, not the steady state.
4. Verify: re-run or wait for the next loop cycle and show the 502 count for a full loop window dropping to near zero (`x402_autonomous_log` query by `ts` and Cloud Run request logs). Manual curl checks are not sufficient evidence; the failure only shows under burst load.

## Constraints

- OWNER RULE, overrides everything: do not modify anything that is working today. Free lanes, paid endpoints that settle correctly, the forge, the gallery, all of it is frozen. Only touch provably-broken paths, and prefer additive changes (new module, new config) over edits to shared working code. If a fix seems to require changing a working path, stop and flag it in your report instead of doing it. Server tuning (keep-alive timeouts, cache backend) counts as fixing a broken path only if you first prove the current values are causing the 502s.
- Do NOT touch the autonomous trading bots (the arms described at three.ws/blog/autonomous-trading-experiment). They are out of scope.
- Do not reduce loop volume to make the errors go away; the point is that the platform sustains the load.
- Config-only `gcloud run services update` changes are pre-approved. Use `--update-env-vars`, never `--set-env-vars`.
- A production deploy of code changes needs owner approval: commit locally, prepare the deploy, and state the one command left to run.
- CLAUDE.md rules apply, including: never use em-dash or en-dash characters anywhere, changelog entry only if user-visible, stage explicit paths only.

## Done means

502s from the autonomous loop during a full burst window are near zero, the cache layer reports healthy, the root cause is stated in one paragraph in your report, and tests pass (`npm test`, no `tail` pipe).
