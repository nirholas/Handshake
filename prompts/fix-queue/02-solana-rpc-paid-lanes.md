# 02. Two of three paid Solana RPC lanes are exhausted, and free lanes cap the settle rate

**Severity: P0.** Solana is the home chain, so this is the highest-value
infrastructure item in the queue. Read [00-INDEX.md](00-INDEX.md) first.

## Symptom (measured 2026-08-01 against production)

`GET https://three.ws/api/healthz`:

```
rpc_lanes  ok  1/3 paid lanes serving
helius     ok  premium RPC healthy
```

One paid lane is serving. The rail faults in work order
[01](01-x402-settle-down.md) (`http_502` x1171 in 3h, `broadcast_failed`,
`Blockhash not found`) are the downstream symptom: free lanes cap the achievable
settle rate at roughly 82 to 95%, and the platform is currently well under that.

`ISSUES.md` item 2 has the full history: Helius `-32429 max usage reached`,
QuickNode `-32003 daily request limit reached`, and both Alchemy apps returning
`429 Monthly capacity limit exceeded` (they share one account quota, so the
second was never a spare). Note that `helius` currently reads healthy, so the
lane set has partially recovered since that entry was written. Re-measure rather
than trusting either document.

## Two traps that have burned previous sessions

1. **Probe with a metered call, never `getHealth`.** `getHealth` is unmetered
   and returns `ok` on a fully exhausted endpoint. Use `getBalance`.
2. **Pick the primary by call SHAPE, not by a probe that all lanes pass.** Every
   free lane passes `getBalance`, `getLatestBlockhash` and
   `getSignatureStatuses`, which makes them look interchangeable. On
   `getTokenAccountsByOwner` filtered by `programId`, the call every token and
   USDC balance reader makes constantly, PublicNode returns
   `HTTP 403 blocked parameter: params.1.programId` and Leo RPC returns
   `-32603`. Only MagicBlock and `mainnet-beta` serve it, which is why they hold
   the top two slots. Promoting PublicNode is actively harmful.

GCP credits cannot solve this: Blockchain Node Engine is Ethereum only, so there
is no GCP-hosted Solana RPC to fail over to.

## The job

1. **Re-probe every lane** in `SOLANA_RPC_URL` and `SOLANA_RPC_FALLBACK_URLS`
   (values on the Cloud Run service; read them with
   `gcloud run services describe three-ws-api --region us-central1
   --project aerial-vehicle-466722-p5 --format=yaml`) with a metered
   `getBalance` AND a `getTokenAccountsByOwner` filtered by `programId`. Build a
   capability matrix: lane, `getBalance` verdict, `getTokenAccountsByOwner`
   verdict, error code.
2. **Re-order the chain from that matrix**, primary first by capability then by
   quota headroom. Apply with `--update-env-vars` only. Exhausted paid lanes
   stay in the chain and re-enter rotation on their own when quota resets
   (`QUOTA_COOLDOWN_MS` is 6h); do not delete them.
3. **Check the 403-sizing fix shipped.** A `403` from PublicNode was once sized
   as an auth failure and parked the whole node for 30 minutes on ordinary
   traffic. Commit `61f3ae758` addresses it. Confirm it is in the running image
   (`/api/version` vs `git log`), and if it is not, that is a reason to include
   this in the next deploy, not a reason to promote PublicNode.
4. **Quantify the ceiling.** Measure the settle success rate attributable to
   lane faults specifically, so the owner sees what one restored paid plan buys.
   That number is the entire business case for the spend.
5. **Report the owner action in one line**: top up or upgrade one paid plan
   (Helius, QuickNode, or Alchemy), or accept the free-lane ceiling. Do not
   wait on it, and do not re-scope Solana work because of it.

## Verification

- Your capability matrix, re-run after the re-order, with the primary passing
  both call shapes.
- `GET /api/healthz` `rpc_lanes` detail.
- The rail-fault count in `x402_settle` over a fresh 3h window.

## Done when

The primary lane serves both call shapes, the fallback order is justified by the
matrix rather than by habit, `ISSUES.md` item 2 reflects the measured state, and
the owner has a one-line spend decision with a number attached.
