# Task: Fix x402 autonomous loop caller/endpoint mismatches (405, 400, 422, 402 failures)

## Context (verified 2026-07-25)

The autonomous x402 buyer loop logs its calls to the `x402_autonomous_log` Neon table (`DATABASE_URL` in `.env`). Beyond the 502s (a separate task, `fix-x402-502-bursts.md`, may already be claimed), a steady share of failures are deterministic client-side mismatches. Last 48 hours:

- `http_405` 3,026, almost all on `https://three.ws/api/x402/dance-tip` (2,768). Curling GET and POST on that endpoint both return 402 today, so the loop is sending some other method, a stale path, or hitting a route that redirects and re-requests with the wrong method.
- `http_400` 2,798, concentrated on `/api/x402/forge` (721, EXCLUDED from this task: the forge lane is being rebuilt separately, skip it), `/api/x402/agent-reputation` (573), `/api/x402/telegram-health` (506), `/api/x402/llm-proxy` (506). The loop is paying for calls whose request bodies or params the endpoint rejects. Note "Agent Reputation Leaderboard" has succeeded only 19 times out of 4,648 attempts all-time; it is effectively always broken in the loop config.
- `http_422` 394.
- `http_402` 1,911 spread over `skill-marketplace`, `club-cover`, `billboard`: these are calls where payment was attached but the endpoint still answered 402, meaning the payment header was malformed, the wrong price/asset was paid, or the requirements changed and the loop caches stale requirements.
- Also: the "Ring Tick" service has 10,320 calls, zero successes, zero dollars, all-time. Find what it is supposed to do; fix it if it has a purpose, delete it from the loop roster if it does not. Zero-value calls burn loop capacity and pollute the stats.

## Job

1. Locate the loop's service roster and request construction (search for where `x402_autonomous_log` is inserted and where service names like "Dance Tip Volume", "Agent Reputation Leaderboard", "Ring Tick" are defined).
2. For each failing service, diff what the loop sends (method, path, query, body, payment header) against what the live endpoint handler actually requires. Fix the caller when the caller is wrong, fix the endpoint when the endpoint is wrong (e.g. an endpoint that rejects a valid documented body). Do not loosen endpoint validation just to make the loop pass.
3. For the `http_402`-with-payment cases, check whether the loop caches payment requirements across price changes, and make it re-fetch the 402 challenge on any 402 response before retrying once.
4. Verify each fix with a real paid call end to end (the loop's own wallets and self-facilitator settle path; smallest configured price). Show the tx signature and the successful response for at least one call per fixed service, then confirm in `x402_autonomous_log` after the next loop cycle that the error class is gone.

## Constraints

- OWNER RULE, overrides everything: do not modify anything that is working today. A caller with zero or near-zero successes is broken and fair game; an endpoint that answers correctly to a well-formed request is working and frozen. Fix the broken caller side, never "loosen" or rewrite a working endpoint. Prefer additive changes over edits to shared loop code that working services flow through; if you must touch a shared path, prove behavior is unchanged for the working services in your report.
- Do NOT touch the autonomous trading bots (three.ws/blog/autonomous-trading-experiment). Out of scope.
- Real payments only; no mocked settlement. Per-call prices are the existing configured micro-prices; do not raise prices in this task.
- Production deploy of code changes needs owner approval: commit locally, prepare the deploy, state the one remaining command.
- CLAUDE.md rules apply, including: never use em-dash or en-dash characters anywhere; stage explicit paths only, never `git add -A`.

## Done means

405/400/422 from the loop are near zero over a full cycle, every roster service either succeeds or is removed with a stated reason, Ring Tick is fixed or gone, and `npm test` passes (no `tail` pipe).
