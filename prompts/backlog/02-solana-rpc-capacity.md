# 02. Solana RPC: route by call shape, survive on 1 of 3 paid lanes

Read [00-INDEX.md](00-INDEX.md) first.

## What is wrong

Healthz reports `rpc_lanes: 1/3 paid lanes serving`. All three paid plans have hit
their caps at various points in the last two weeks (Helius `-32429 max usage
reached`, QuickNode `-32003 daily request limit reached`, both Alchemy apps
`429 Monthly capacity limit exceeded`, and the two Alchemy keys share one account
quota so the second is not a spare). Production currently runs primarily on free
lanes, which caps the achievable settle rate and produces `broadcast_failed`,
`Blockhash not found`, and malformed-response parse errors.

GCP credits cannot solve this: Blockchain Node Engine is Ethereum-only, so there
is no GCP-hosted Solana RPC to fail over to.

## The trap that makes every naive probe wrong

**Free lanes are not interchangeable, and `getBalance` cannot tell them apart.**
All the free lanes pass `getBalance`, `getLatestBlockhash`, and
`getSignatureStatuses`. On `getTokenAccountsByOwner` filtered by `programId`, the
call every token and USDC balance reader makes constantly:

- PublicNode returns **HTTP 403 `blocked parameter: params.1.programId`**
- Leo RPC returns **-32603**
- Only MagicBlock and `api.mainnet-beta.solana.com` serve it

That is why those two hold the top two slots today. Also: never probe with
`getHealth`. It is unmetered and returns ok on a fully exhausted endpoint.

## The work

1. **Build a capability matrix probe, not a liveness probe.** Write
   `scripts/probe-rpc-lanes.mjs` that runs every lane in `SOLANA_RPC_URL` plus
   `SOLANA_RPC_FALLBACK_URLS` against the **call shapes production actually
   makes**: `getBalance`, `getLatestBlockhash`, `getSignatureStatuses`,
   `getTokenAccountsByOwner` (programId filter), `getProgramAccounts`,
   `sendTransaction` (simulate only), `logsSubscribe` where WS is configured.
   Output a table of lane by method with the exact error code on refusal. Metered
   calls only.

2. **Make the router refuse to promote a lane that cannot serve the shape.** The
   failover chain in `api/_lib/solana/connection.js` currently ranks lanes without
   knowing which methods each supports, which is how a 403 on a `programId` filter
   got sized as an auth failure and parked a whole node for 30 minutes on ordinary
   traffic. Add per-method capability so a method-level refusal demotes the lane
   for that method only, with its own short cooldown, and never counts as an auth
   fault. Cover it with a test that asserts a `blocked parameter` 403 does not
   trigger the auth path.

3. **Cut call volume where it is free to cut.** The ring cadence knobs already
   exist. Audit which pipelines poll on a timer and could be event-driven or
   longer-interval without user-visible change. Land the reductions behind the
   existing config so they can be tuned without a deploy.

4. **Surface quota state honestly.** The exhausted paid lanes re-enter rotation on
   their own when quota resets (`QUOTA_COOLDOWN_MS` is 6h). Show, on the ops
   surface, which lanes are cooling down and when each is expected back, so the
   next reader does not re-diagnose "all lanes dead" during a normal cooldown.

## Verify

```sh
node scripts/probe-rpc-lanes.mjs                 # the new matrix, all lanes, all shapes
curl -s https://three.ws/api/healthz | python3 -c "import json,sys;print([s for s in json.load(sys.stdin)['subsystems']['subsystems'] if s['name']=='rpc_lanes'])"
npm run gate
```

## Owner action (optional, the work order does not wait on it)

Restoring one paid plan lifts the ceiling: free lanes cap the achievable settle
rate at roughly 82 to 95%. Top up or upgrade Helius, QuickNode, or Alchemy. State
the cost and the measured ceiling in your report and let the owner decide. Do not
block any of the four tasks above on it.

## Definition of done

- [ ] `scripts/probe-rpc-lanes.mjs` exists, runs offline-safe against live lanes,
      and prints a lane-by-method matrix with error codes.
- [ ] A method-level refusal no longer parks a lane as an auth failure; test
      committed.
- [ ] Ops surface shows per-lane quota cooldown with expected recovery time.
- [ ] `npm run gate` green, `npm run check:rules -- --paths <touched>` clean.
- [ ] `docs/ops/` documents the capability matrix and the `getHealth` trap.
- [ ] `data/changelog.json` entry (tag: `infra`).
