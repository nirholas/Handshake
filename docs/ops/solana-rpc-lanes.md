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

```sh
node --env-file=.env scripts/probe-rpc-lanes.mjs          # lane x method matrix
node --env-file=.env scripts/probe-rpc-lanes.mjs --ws      # also probe logsSubscribe
node --env-file=.env scripts/probe-rpc-lanes.mjs --json    # machine-readable
```

[scripts/probe-rpc-lanes.mjs](../../scripts/probe-rpc-lanes.mjs) resolves every lane in
the exact order `solanaRpcEndpoints()` does, then probes each one against the call
shapes production actually makes: `getLatestBlockhash`, `getBalance`,
`getSignatureStatuses`, `getTokenAccountsByOwner` (programId filter),
`getProgramAccounts`, `getAccountInfo`, and `simulateTransaction` as a read-only
stand-in for `sendTransaction`. It prints the matrix, then every refusal verbatim with
its JSON-RPC code, then a per-lane verdict: `safe as primary`, `usable, NOT safe as
primary - missing <methods>`, `quota spent`, `key rejected`, or `DEAD`. It exits 1 only
on `DEAD` (serves nothing and gives no reason), so a routine daily cap does not cry
wolf. It classifies refusals by importing `isMethodRefusal` from the router itself, so
the matrix and the breaker cannot drift apart.

Measured 2026-08-01 (10 lanes, 8 shapes with `--ws`):

| Lane | shapes served | verdict |
|---|---|---|
| MagicBlock | 7/8 | safe as primary (refuses `getProgramAccounts`) |
| `api.mainnet-beta.solana.com` | 7/8 | safe as primary (refuses `getProgramAccounts`) |
| Alchemy (both apps) | 6/8 | safe as primary; `getProgramAccounts` over CU/s cap |
| PublicNode | 5/8 | not a primary: refuses `getTokenAccountsByOwner` |
| Tatum (both hosts) | 2/8 | free tier gates balance + token + program reads |
| Leo RPC | 2/8 | thin, high latency |
| QuickNode | 0/8 | quota spent (`-32003` daily cap) |
| Helius | 0/8 | quota spent (bare HTTP 429) |

Only MagicBlock and `api.mainnet-beta.solana.com` served `logsSubscribe`.

To probe by hand instead, use a **metered** method on every configured lane:

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
refuses a different subset of methods, and which ones changes without notice.
Re-measured 2026-08-07 (3 samples per cell, p50 of the three):

| Lane | `getBalance` | `getTokenAccountsByOwner` | `getProgramAccounts` | p50 |
|---|---|---|---|---|
| `api.mainnet-beta.solana.com` | 3/3 | 3/3 | 403 IP block | 94ms |
| PublicNode `solana-rpc.publicnode.com` | 3/3 | **20s timeout** | -32010 not indexed | 137ms |
| Leo RPC `?api_key=FREE` | 3/3 | 2/3 (`-32603`) | 429 | 254ms |
| Tatum `api.tatum.io/v3/...` | **-16401 paid only** | **-16401 paid only** | 429 | 58ms |
| Tatum `solana-mainnet.gateway.tatum.io` | **-16401 paid only** | **-16401 paid only** | 429 | 70ms |
| MagicBlock `rpc.magicblock.app/mainnet` | **403 IP block** | **403 IP block** | **403 IP block** | 159ms |

**`api.mainnet-beta.solana.com` is now the best free primary**, and it is the only
keyless lane serving both `getBalance` and `getTokenAccountsByOwner`.

Three lanes that a naive latency ranking would promote are traps:

- **MagicBlock was the recommended primary until 2026-08-07**, when it began answering
  every method with HTTP 403 "Your IP or provider is blocked from this endpoint". It is
  pruned from `FREE_KEYLESS_MAINNET` entirely: a hard egress block never recovers on a
  cooldown, so re-probing it only burns a real request to relearn the block.
- **Both Tatum hosts** are the fastest numbers in the table and the least useful: they
  gate `getBalance` and `getTokenAccountsByOwner` behind a paid plan (`-16401`) and cap
  the keyless tier at 5 requests/minute. They now rank last, behind mainnet-beta.
- **PublicNode** serves `getBalance` perfectly while refusing precisely the calls behind
  $THREE holder gating and token balances
  ([api/\_lib/balances.js](../../api/_lib/balances.js),
  [api/\_lib/coin/holders.js](../../api/_lib/coin/holders.js),
  [api/\_lib/embed-gate.js](../../api/_lib/embed-gate.js),
  [api/scene/gate-check.js](../../api/scene/gate-check.js)), and it does so by *hanging*
  rather than erroring, so each first call costs the full attempt timeout before the
  method demotion parks it. Putting it in front of those readers takes the feature down
  while every dashboard still reads green.

### `getTokenLargestAccounts`: the shape with no free primary (measured 2026-08-12)

Holder distribution reads that shape and nothing else can substitute for it:
[api/\_lib/crypto-token-holders.js](../../api/_lib/crypto-token-holders.js) behind
`/api/crypto/holders`, and the concentration half of `/api/crypto/security`. With
Helius at `max usage reached` and Alchemy at `Monthly capacity limit exceeded` on
the same day, the keyless tail had to carry it, and every lane in front failed in a
different way:

| Lane | `getTokenLargestAccounts` |
|---|---|
| PublicNode | hangs forever (no answer at 35s) |
| `api.mainnet-beta.solana.com` | HTTP 429 |
| Leo RPC | `-32603 Internal JSON-RPC error.` on every call |
| Solana Vibe Station `public.rpc.solanavibestation.com` | serves it; throttles to a few requests, then `-32005` |
| Tatum (both hosts) | serves it, at 5 requests/minute |

Three fixes landed together, and the endpoint went from roughly one success in three
to 8/8 on a warmed instance:

- **`-32603` is now a failover signal** ([classifyRpcBody](../../api/_lib/solana/connection.js)).
  It is the JSON-RPC spec's "internal error", the node's own fault rather than a
  deterministic verdict, so unlike `-32601`/`-32602` the next lane may well serve it.
  Unclassified, Leo's envelope was handed back as though it were the chain's answer
  and the lanes that do serve the shape were never tried.
- **A hang past the attempt bound demotes the (lane, method) pair**, not the lane
  (`throwDisposition`). Charging PublicNode's silent refusal to the whole lane benched
  the free chain's primary for every other method. This is the behaviour this runbook
  already described; before 2026-08-12 the code cooled the lane instead.
- **Solana Vibe Station joined `FREE_KEYLESS_MAINNET`**, behind Leo and ahead of the
  Tatum pair. Verified real mainnet (genesis `5eykt4Us...`, slot within 1 of
  mainnet-beta). Its throttle answers `-32005`, which the capacity classifier already
  parks correctly, so it is depth rather than a primary.

The standing cost is unchanged and is a billing decision, not a code one: while both
metered lanes sit at their monthly ceiling, this shape is served only by throttled
free nodes, so it stays the first read to degrade.

A balance read that cannot reach a lane must never be recorded as a balance of zero.
[scripts/audit-service-wallets.mjs](../../scripts/audit-service-wallets.mjs) reports an
unreadable wallet as `‼ unreadable`, and
[scripts/gcp-triage.mjs](../../scripts/gcp-triage.mjs) classifies that as `investigate`,
never as the `owner` "fund this wallet" finding. On 2026-08-07 the older behaviour turned
one throttled lane into four fake below-floor money emergencies.

[scripts/audit-wallet-flows.mjs](../../scripts/audit-wallet-flows.mjs) follows the same
rule as of 2026-08-11. It used to coerce every wallet in a chunk whose lane threw to
`0`, so a single failed chunk silently shrank the fleet total by whatever those wallets
held and still exited clean. It now leaves them unread, excludes them from every total,
lists them under `UNVERIFIED`, and exits `2`. A `null` account inside a *successful*
`getMultipleAccounts` response is still a real zero: that account does not exist on
chain. Only a call that threw is an unread.

Both audits prune hosts with a hard egress block from their own lane chains rather than
trusting `SOLANA_RPC_URL` blindly, because that var still points at MagicBlock in `.env`
and on the Cloud Run service. Pointing an audit at a 403 lane is how it came to read
every wallet as empty in the first place.

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

## A refusal demotes the METHOD, not the lane

Benching a lane because it refused one call shape is the wrong disposition, and it was
the live behaviour until 2026-08-01. Two defects compounded: the rotating fetch read the
response body only on a 429, so on PublicNode's `403 blocked parameter` the classifier
saw an empty string and fell through to the **auth** branch, parking a healthy free
primary for 30 minutes on traffic the balance readers generate constantly. The rotation
then cascaded onto the exhausted paid lanes the free chain exists to protect.

The router now tracks capability per `(lane, method)`:

- A refusal demotes that pair for **15 minutes**. The lane keeps serving every other
  shape and never enters cooldown. It is never an auth fault.
- Endpoint selection runs three passes: skip cooling + skip demoted, then forgive
  cooling, then forgive both. The widest pass exists so stale bookkeeping can never
  strand a request that every lane has refused at some point.
- A JSON-RPC batch is skipped on a lane demoted for **any** method it carries: one
  refused member breaks the whole reply.
- Demotions are process-local by design. Re-discovering one on a cold instance costs one
  request that transparently fails over; re-discovering a quota block costs a request
  against a plan already over its cap, which is what keeps a daily cap pinned. That
  asymmetry is why the quota verdict is fleet-shared and this one is not.

**Breadth is what separates a policy block from a ban.** `Your IP or provider is blocked
from this endpoint` is emitted per-method by MagicBlock and `api.mainnet-beta.solana.com`
(for `getProgramAccounts` alone, while serving six other shapes) **and** caller-wide by a
node that has genuinely banned our egress. The wording is identical, so the text cannot
decide it. A lane that accumulates **4 or more** distinct demotions is refusing the
caller, not the call, and takes the full auth-window lane bench, published fleet-wide.
Four is the threshold because the widest legitimate refusal set we run is three (Tatum's
free tier gates three shapes while still serving `getLatestBlockhash` and
`getSignatureStatuses`, which are worth keeping).

## Reading the cooldown state instead of re-diagnosing it

`rpc_lanes` reports which lanes are parked and when each returns, on `/api/healthz` and
on the public [/status](https://three.ws/status) page:

```sh
curl -s https://three.ws/api/healthz | jq '.subsystems.subsystems[] | select(.name=="rpc_lanes")'
```

The `detail` line carries a census (`1/3 paid lanes serving; mainnet.helius-rpc.com back
in 4h12m, …`) and the `lanes` array carries `recoversAt` (absolute, so a cron-parked
snapshot stays true), `recoversIn`, `paid`, and `blockedMethods` per lane. URLs are
masked to scheme + host, so no API key leaves the process. A quota cooldown clears
itself: read these before concluding the tier is dead.

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
# Re-probe with the capability table above before picking one: the right answer
# changes as free providers gate methods. As of 2026-08-07 mainnet-beta is the only
# keyless lane serving getBalance AND getTokenAccountsByOwner.
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

Then confirm the tier view recovered:

```sh
curl -s https://three.ws/api/healthz | jq '.subsystems.subsystems[] | select(.name=="rpc_lanes")'
```

Beyond that, only two things actually clear a quota: **money** (top up or upgrade the
plan) or **less volume** (`X402_RING_TICK_CONCURRENCY` and the ring cadence knobs, which
are config-only and free). Everything else just moves which free node absorbs the
throttling.

### Confirmation poll cadence (the hottest RPC consumer we control)

Every server-signed send, x402 settle, and launch confirms through
`pollConfirmation()` in [api/\_lib/solana/confirm.js](../../api/_lib/solana/confirm.js).
At a flat cadence over the 90s ceiling, one transaction that never lands costs ~75
`getSignatureStatuses` calls plus ~25 `getBlockHeight` calls, and a transaction that
never lands is exactly what happens when the tier is throttled, so the flat cadence spent
the most requests precisely when requests were scarcest.

It now serves the opening polls at the base cadence (where nearly every healthy confirm
lands, so the common path is unchanged) and backs off geometrically after that. Same 90s
ceiling, roughly a third of the requests. All four knobs are read per call, so retuning
is a config-only `--update-env-vars` with no rebuild:

| Var | Default | Meaning |
|---|---|---|
| `SOLANA_CONFIRM_POLL_INTERVAL_MS` | `1200` | opening cadence |
| `SOLANA_CONFIRM_FAST_POLLS` | `3` | polls at that cadence before backing off |
| `SOLANA_CONFIRM_POLL_BACKOFF` | `1.5` | multiplier per poll after that (clamped to >= 1) |
| `SOLANA_CONFIRM_POLL_MAX_INTERVAL_MS` | `6000` | ceiling (clamped to >= the base) |

**GCP credits cannot help here.** Blockchain Node Engine is Ethereum-only and the
BigQuery `blockchain-analytics-*` datasets are EVM chains plus analytics, so the standing
"prefer GCP, credits are pre-approved" rule has nothing to offer this lane. Do not spend
time re-checking it.

## When every lane fails at the wire

Ten unrelated hosts do not die in the same millisecond. On 2026-08-27 the fleet
logged `all 10 endpoints failed this request, fetch failed` about 2,000 times an
hour while a direct probe of the same lanes from the same region answered fine:
when every lane fails with a transport error (DNS, refused socket, reset) inside
one request, the weather is on our side of the wire (instance egress, resolver,
socket pool) and it clears in well under a second. `connection.js` stacks three
answers, cheapest first:

- **The error names the errno.** A thrown fetch carries the undici cause code
  (`ECONNRESET`, `EAI_AGAIN`, `ENOTFOUND`, ...) and the lane it died on, so
  `fetch failed` alone no longer sends a reader hunting for a week. `EAI_AGAIN` is
  a resolver problem, `ECONNRESET` a socket one.
- **One jittered re-sweep.** When the first sweep was transport-only, every lane
  is tried once more after a 250-700 ms pause. An HTTP 429 or a quota body is a
  verdict about the lane, not the wire, and never triggers it.
- **Last-good reads instead of a 502.** Idempotent read methods (`getBalance`,
  `getAccountInfo`, `getMultipleAccounts`, `getTokenAccountsByOwner`,
  `getTokenLargestAccounts`, `getProgramAccounts`, `getSignaturesForAddress`,
  `getTransaction`, the DAS `getAsset*` family, and a few more) answer from the
  last body a lane returned for the identical call, kept in the shared cache for
  15 minutes and marked with an `x-solana-rpc-stale` header carrying its age in
  ms. Blockhash and slot reads are excluded on purpose: a stale blockhash
  produces a transaction that fails later and worse. A success republishes its
  body at most once a minute per call shape, so the steady state costs one cache
  write a minute per distinct read, not one per RPC call.

A batch that a lane refuses for its own per-batch cap (`maximum number of calls
in a batch`, `batch too large`) is split into at most 64 single requests, four at
a time, instead of failing the whole call; the cap is remembered per (lane,
method) for 30 minutes so the next batch goes straight to the split, and a batch
too wide to split rotates to a lane that takes it whole.
[tests/solana-rpc-transport-fallback.test.js](../../tests/solana-rpc-transport-fallback.test.js)
and [tests/solana-rpc-rotating-fetch.test.js](../../tests/solana-rpc-rotating-fetch.test.js)
pin this behaviour.

## Knock-on effects to expect

RPC starvation does not stay in the RPC layer:

- **x402 settles fail as `broadcast_failed`.** The payer signs against their own RPC, so
  a lagging node of ours has never seen that blockhash and preflight falsely rejects a
  valid payment, after the paid handler already ran. `settleRingPayment()` now resends
  with `skipPreflight: true` for that one error class and lets the validator decide.
- **The treasury self-heal stalls**, which strands the x402 sponsor under its SOL floor,
  which withdraws the Solana accept from every 402 challenge and stops the ring.
