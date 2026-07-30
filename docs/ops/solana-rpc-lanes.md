# Solana RPC lanes: diagnosis, capability, and failover

Every Solana read and every x402 settle in production goes through one rotating
endpoint chain built by `solanaRpcEndpoints()` in
[api/\_lib/solana/connection.js](../../api/_lib/solana/connection.js). When that chain
misbehaves the symptoms are never a clean outage: intermittent 502/503/504 on on-chain
routes, `broadcast_failed` settles, holder gates that refuse a real holder, and a settle
rate that sags without any wallet actually being empty.

This runbook is the whole-tier view. For the single log signature see the `rpc_lanes`
section of [production-log-triage.md](production-log-triage.md); for the money side see
the settle-floor and dispersion notes in the same file.

## Diagnose the whole tier in one sweep

Do this before theorising. Probe **every** configured lane with a **metered** method:

```sh
gcloud run services describe three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --format=json \
| jq -r '.spec.template.spec.containers[0].env[]
         | select(.name|test("SOLANA_RPC_URL|SOLANA_RPC_FALLBACK|SOLANA_RPC_FALLBACKS|SOLANA_RPC_LAST_RESORT"))
         | .value' \
| tr ',' '\n' | sed '/^$/d' | while read -r url; do
    printf '%s  ' "$(printf '%s' "$url" | sed -E 's#(api[-_]key=|/v2/)[A-Za-z0-9_-]+#\1***#g')"
    curl -s --max-time 10 "$url" -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW"]}' \
    | head -c 160; echo
  done
```

**Never probe with `getHealth`.** It is unmetered and returns `ok` on an endpoint whose
plan is hard-exhausted, which is exactly how a dead tier reads as healthy.

Exhaustion is worded differently by every provider, and the wording is what the breaker
classifies on:

| Provider | Signature | Window |
|---|---|---|
| Helius | `{"code":-32429,"message":"max usage reached"}` | plan, until topped up |
| QuickNode | HTTP 429 + `{"code":-32003,"daily request limit reached"}` | daily, resets |
| Alchemy | HTTP 429 + `{"code":429,"Monthly capacity limit exceeded"}` | monthly, until the billing month rolls |

## The lanes are not interchangeable

A lane answering `getBalance` does **not** qualify it as a primary. Each free lane
refuses a different subset of methods. Measured 2026-07-30:

| Lane | `getBalance` | `getTokenAccountsByOwner` | `getProgramAccounts` | p50 |
|---|---|---|---|---|
| MagicBlock `rpc.magicblock.app/mainnet` | 6/6 | ok (programId + mint) | 403 IP block | 46ms |
| PublicNode `solana-rpc.publicnode.com` | 6/6 | **refused** | **refused** | 97ms |
| Leo RPC `?api_key=FREE` | 5/6 | 429 | 429 | 211ms |
| `api.mainnet-beta.solana.com` | 6/6 | ok | ok | 146ms |

**MagicBlock is the best free primary.** PublicNode is the trap: it serves `getBalance`
perfectly while refusing precisely the calls behind $THREE holder gating and token
balances ([api/\_lib/balances.js](../../api/_lib/balances.js),
[api/\_lib/coin/holders.js](../../api/_lib/coin/holders.js),
[api/\_lib/embed-gate.js](../../api/_lib/embed-gate.js),
[api/scene/gate-check.js](../../api/scene/gate-check.js)). Putting it in front of those
readers takes the feature down while every dashboard still reads green.

## Why a refusal must rotate, and when it must not

The breaker splits JSON-RPC errors into two classes:

- **Provider-specific** (capacity, quota, auth, tier gate, policy block). The next lane
  serves the same call, so rotate.
- **Deterministic** (invalid request, method not found, genuinely invalid params, tx
  simulation failed). Every lane fails it identically, so rotating just burns the chain.

Three real phrasings sat on the wrong side of that split until 2026-07-30, each fixed in
`connection.js` and locked down in
[tests/solana-rpc-priority-and-breaker.test.js](../../tests/solana-rpc-priority-and-breaker.test.js):

1. **Alchemy's monthly cap matched no quota phrase.** It took the 10 minute transient
   cooldown instead of the 6 hour quota one, so a lane that could not answer until the
   billing month rolled over re-entered rotation every ten minutes. It was also
   `SOLANA_RPC_URL`, so nearly every Solana call in production began by failing over
   (236 lane failures in 6h).
2. **PublicNode `getProgramAccounts` answers HTTP 200** with
   `{"code":-32010,"… excluded from account secondary indexes; this RPC method
   unavailable for key"}`. A 200 fires no status-driven rotation and `-32010` was not a
   capacity code, so the error surfaced to the caller instead of failing over.
3. **PublicNode `getTokenAccountsByOwner` answers `-32602`** with `"Request blocked.
   Details: blocked parameter: params.1.programId"`. That is a `-32602` which is *not*
   invalid params. Only the wording separates it from a genuine client error, which is
   why the matcher keys on text and a real invalid-params error still refuses to rotate.

Cooldown windows are asymmetric and worth knowing: quota 6h, rate limit 10m, auth 30m,
5xx 2m. One quota trip removes a premium lane for six hours. Verdicts are published to
the shared cache (`rpccool:v1`) so a cold Cloud Run instance inherits them instead of
re-burning a request against a provider already over its cap.

## Config traps

- **A reserve named anywhere else is not a reserve.** `solanaRpcEndpoints()` dedupes to
  the FIRST occurrence, so a URL in both `SOLANA_RPC_URL` and
  `SOLANA_RPC_LAST_RESORT_URLS` is the primary and absorbs 100% of traffic until its cap
  blows. A reserve must appear in `SOLANA_RPC_LAST_RESORT_URLS` and nowhere else.
- **`ALCHEMY_API_KEY` is not the Solana Alchemy lane.** The Solana URL lives inside
  `SOLANA_RPC_FALLBACK_URLS`; `ALCHEMY_API_KEY` stays load-bearing for EVM and NFT paths
  even when Solana capacity is spent, so do not remove it to "clean up".
- **Update single keys with `--update-env-vars`.** `--set-env-vars` replaces the entire
  env set on the service.

## Recovery

```sh
# Repoint the primary at a healthy lane (config only, takes effect on the new revision).
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars SOLANA_RPC_URL=https://rpc.magicblock.app/mainnet
```

Then confirm the tier view recovered:

```sh
curl -s https://three.ws/api/healthz | jq '.subsystems.subsystems[] | select(.name=="rpc_lanes")'
```

Beyond that, only two things actually clear a quota: **money** (top up or upgrade the
plan) or **less volume** (`X402_RING_TICK_CONCURRENCY` and the ring cadence knobs, which
are config-only and free). Everything else just moves which free node absorbs the
throttling.

**GCP credits cannot help here.** Blockchain Node Engine is Ethereum-only and the
BigQuery `blockchain-analytics-*` datasets are EVM chains plus analytics, so the standing
"prefer GCP, credits are pre-approved" rule has nothing to offer this lane. Do not spend
time re-checking it.

## Knock-on effects to expect

RPC starvation does not stay in the RPC layer:

- **x402 settles fail as `broadcast_failed`.** The payer signs against their own RPC, so
  a lagging node of ours has never seen that blockhash and preflight falsely rejects a
  valid payment, after the paid handler already ran. `settleRingPayment()` now resends
  with `skipPreflight: true` for that one error class and lets the validator decide.
- **The treasury self-heal stalls**, which strands the x402 sponsor under its SOL floor,
  which withdraws the Solana accept from every 402 challenge and stops the ring.
