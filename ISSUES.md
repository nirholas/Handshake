# Production Issues — three.ws

Live tracker for known production issues. When an item is fixed, drop it from
this file rather than leaving it here marked ✅ — this file should only contain
work that is still open.

> The 2026-05 incident batch (20 items, all resolved) and the 2026-06 resolved
> items were archived under `docs/internal/`, which was removed from the repo
> along with the rest of the internal content in commit `b80c1c379`. Both
> archives remain readable in git history:
> `git show b80c1c379^:docs/internal/ISSUES-ARCHIVE-2026-05.md`

---

## Check the deploy gap before debugging anything here

`curl -s https://three.ws/api/version` returns the live commit; compare it to
`main`. Reading the repo tells you what SHOULD be true in production, not what
is: this list has more than once carried confident claims about live mitigations
that had never been deployed.

**Deployed 2026-07-30: production moved `d6a7bf2a4` (2026-07-28) to `bbe5d2403`,
closing a ~70 commit gap.** That alone fixed three items that had been sitting
here as code-complete, each verified live afterwards rather than assumed:
ENS resolution, web search running on scraps, and the stale accuracy number the
`/fact-check` page was publishing. Post-deploy sweep was 465/466 pages
(the one miss was a blog route that landed 6 minutes after the built commit).

Deploys are owner-gated (CLAUDE.md gate 2), so a correct fix can sit unshipped
indefinitely. When an item says "needs deploy", no further engineering is
required. `npm run db:status` reports all migrations already applied.

## Open

Re-verified against the live Cloud Run services on 2026-07-22. The 2026-07-04
log-export batch is now mostly closed: `JWT_SECRET` and `WALLET_ENCRYPTION_KEY`
are set on `three-ws-api` (wallet sign-in and custodial provisioning work),
`ADMIN_CODE` is set on `hyperfy-world` (world.three.ws build rights are gated
again), and the reconstruct lane has a real fallback via
`GCP_RECONSTRUCTION_URL`. What remains requires owner/operator action outside
this repo:

1. **LLM paid backstops are dead** (owner billing decision). `OPENAI_API_KEY`
   is set on the service but the account returns `billing_not_active` 429s, so
   every OpenAI paid backstop is out. The OpenRouter platform key burned its
   credit on paid-model routing (invisible in metering: llm-pricing records
   OpenRouter as $0). Traffic survives on the free lanes (Groq/NIM plus the
   vertex-gemini credits anchor). Action: reactivate OpenAI billing and/or
   fund the OpenRouter key, or accept free-lane-only service.
2. **Every paid Solana RPC lane is over quota at once** (owner action: money).
   Re-probed 2026-07-30 with a metered `getBalance` (never `getHealth`, which is
   unmetered and returns ok on an exhausted endpoint): Helius `-32429 max usage
   reached`, QuickNode `-32003 daily request limit reached`, and BOTH Alchemy
   apps (`ALCHEMY_API_KEY` and the key inside `SOLANA_RPC_FALLBACK_URLS`) return
   `429 Monthly capacity limit exceeded` (they share one account quota, so the
   second is not a spare). The dead Alchemy endpoint was also pinned as
   `SOLANA_RPC_URL`, so every production Solana call began by failing over.
   Mitigated in config on 2026-07-30 (current revision `three-ws-api-00346-x9m`):
   `SOLANA_RPC_URL` points at `https://rpc.magicblock.app/mainnet`, with
   `api.mainnet-beta.solana.com`, PublicNode and Leo RPC as the fallbacks.
   **Pick the primary by call SHAPE, not by a `getBalance` probe.** All the free
   lanes pass `getBalance`, `getLatestBlockhash` and `getSignatureStatuses`
   12/12, which makes them look interchangeable. They are not: on
   `getTokenAccountsByOwner` filtered by `programId`, the call every token and
   USDC balance reader makes constantly, PublicNode returns **HTTP 403
   `blocked parameter: params.1.programId`** and Leo RPC returns `-32603`.
   Only MagicBlock and `mainnet-beta` serve it, which is why they hold the top
   two slots. Promoting PublicNode is actively harmful before commit `61f3ae758`
   ships, because that 403 was sized as an auth failure and parked the whole
   node for 30 minutes on ordinary traffic. The exhausted paid lanes stay in the chain and
   re-enter rotation on their own when quota resets (`QUOTA_COOLDOWN_MS` is 6h).
   The platform is therefore up but throttled, which shows up as intermittent
   5xx and slow settles. Action: top up or upgrade a plan, or cut call volume
   via the ring cadence knobs. Note GCP credits cannot help here: Blockchain
   Node Engine is Ethereum-only, so there is no GCP-hosted Solana RPC.
   **Partly relieved 2026-08-12: a fresh Helius key on a new free-plan account
   is now set as `HELIUS_API_KEY` in the local `.env`.** Probed with metered
   calls only, it serves 6 of the 7 production call shapes at p50 33 ms, the
   fastest lane in the chain, and `solanaRpcEndpoints()` places it first, ahead
   of the keyless free tail (the one miss is `getProgramAccounts`, which every
   other lane also refuses). Its Helius-only surfaces answer too: DAS `getAsset`
   and `getTokenAccounts`, `getPriorityFeeEstimate`, the `/v0` parsed
   transaction history, and the webhooks API. Free plan means the quota is
   modest, so this restores the DAS and holder surfaces rather than replacing a
   paid lane. **Production still runs the exhausted key** until the Cloud Run
   env update lands: `gcloud run services update three-ws-api --region
   us-central1 --project aerial-vehicle-466722-p5 --update-env-vars
   HELIUS_API_KEY=<key>` (single-key merge, never `--set-env-vars`).

Carried forward from the retired `prompts/x402-catalog/` tracker (campaign
closed 2026-07-28; full history in git):

3. **Fact-check benchmark cannot be re-run from this machine** (owner action:
   one credential). The two halves of this item that were about code and about
   the deploy are both closed, verified live on 2026-07-30 after the deploy:
   web search really does lead with Vertex-grounded Google Search now (a live
   call to `POST /api/x402/fact-check` returned `supported` at 0.98 confidence
   with `vertexaisearch.cloud.google.com` grounding sources, not DuckDuckGo
   scraps), and `GET /api/fact-check-benchmark` now returns `ran: false` instead
   of serving the stale 2026-07-08 run, so `/fact-check` renders its honest
   "not yet run" state to visitors rather than a misleading 20%.
   What remains is only the measurement. `scripts/fact-check-benchmark.mjs`
   targets the PAID endpoint `https://three.ws/api/x402/fact-check`, which
   answers a small free allowance and then 402s, so a 40-claim run needs a
   bypass. Neither bypass exists: there is no token with the `x402:bypass`
   OAuth scope, and `INTERNAL_API_KEY` (the `x-api-key` service path in
   `api/_lib/x402/access-control.js`) is unset both locally and on the
   `three-ws-api` Cloud Run service. Action: set `FACT_CHECK_BYPASS_TOKEN`, or
   set `INTERNAL_API_KEY` on the service and pass it as `x-api-key`. Then
   `node scripts/fact-check-benchmark.mjs`. The runner refuses to publish any
   run with >10% errored claims, so a degraded run cannot poison the page.
4. **Replicate is an unfunded optional image lane** (owner action,
   non-blocking). Narrowed on 2026-07-30: two of this item's three original
   claims were stale and are struck. ASR **works**, `NVIDIA_ASR_FUNCTION_ID` is
   set and `GET /api/v1/ai/asr` returns 200 `configured: true`, with a real 16kHz
   WAV round-tripping in 1.5s via `riva-asr`. Redis is **present**, not absent:
   `UPSTASH_REDIS_REST_URL` points at a self-hosted SRH proxy on the VPC, and the
   ASR quota counter decrementing proves the store is live. Only
   `REPLICATE_API_TOKEN` is genuinely absent, and `api/_lib/ai-image-lanes.js`
   treats Replicate as one of three lanes with Vertex serving the traffic, so
   nothing is degraded. Fund it only if a third image lane is wanted.
5. **BSC testnet contracts are code-complete but never publicly deployed**
   (owner action; re-homed here 2026-07-30 when the BNB Chain campaign's work
   orders were retired). Every contract proof in that campaign ran against an
   anvil fork or a local instance because no funded deployer key exists:
   `BNB_TESTNET_DEPLOYER_KEY` is absent from the shell env, the root `.env`, and
   `contracts/.env`, and the public faucet is reCAPTCHA-gated, so the
   `GreenfieldVault` and `WorldMoves` deploys and every real Greenfield write
   never happened. The deploy scripts are dry-run verified and unchanged
   (`forge script script/DeployGreenfieldVault.s.sol` /
   `script/DeployWorldMoves.s.sol --broadcast`, both documented in
   [contracts/DEPLOYMENTS.md](contracts/DEPLOYMENTS.md)). Action: fund a
   throwaway EOA at `https://www.bnbchain.org/en/testnet-faucet`, set
   `BNB_TESTNET_DEPLOYER_KEY` (and `GREENFIELD_VAULT_OPERATOR_KEY`, which falls
   back to the same key), re-run the two scripts, then set
   `WORLD_MOVES_ADDRESS_TESTNET`. No code change is needed: the moment the
   address exists, `/api/bnb/world-config` starts returning `deployed:true` for
   real visitors and the sender/reader/ghost paths light up as already proven.
   Full history: `prompts/bnb-chain/PROGRESS.md`.

6. **The x402 sponsor has under a day of runway** (owner action: ~1 SOL).
   Re-measured 2026-07-31: the sponsor
   (`WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`) holds 0.0318 SOL, barely
   above its 0.03 floor, against a measured burn of 0.060 SOL/day (7 days of
   `fee_lamports` over successful settles): roughly half a day of runway.
   Do not quote a remembered burn rate
   here; the previously circulated "1 to 2 SOL/day" was wrong by roughly 10x.
   ~1 SOL covers about 16 days at the current burn. The number is now live on
   the payment-outcome board: `GET /api/ops/payment-outcomes` shows balance
   vs floor, measured burn, and runway (see `docs/ops/payment-outcomes.md`; ships with the next
   deploy). **Never top up per-agent wallets**, that strands
   SOL and kills the rail. Related but already handled: the earlier
   `fee_wallet_below_floor` outage (18:00 to 02:45) was a symptom of item 2, not
   an independent fault, and cleared with no funding the moment `SOLANA_RPC_URL`
   was repointed. Do not lower `X402_SPONSOR_SOL_FLOOR_LAMPORTS`; the shortfall
   was 0.00018 SOL and the floor was doing its job.

7. **`x402_settle` reports degraded, and what remains is rail faults**
   (closes with item 2). Re-read 2026-07-31 01:10 UTC: the sensor is DOWN at
   30.3% (549/1813 paid attempts, 3h) with the faults dominated by `http_502`
   (1055) and `http_402` (153), so the degradation has deepened since the
   repoint; the free lanes alone are not holding the rate. Earlier readings:
   near 78% on 2026-07-30, 95.2% in the hour right after the RPC repoint. Every current failure is RPC-shaped rather than financial:
   `broadcast_failed` with empty simulation logs, `Blockhash not found`, and
   malformed-response parse errors. The test that settles this is grouping
   failures by payment amount, because they are amount-independent and the
   *smallest* bucket has the worst ratio, which insufficient funds cannot
   produce. Free lanes cap the achievable rate at roughly 82-95%, so restoring
   one paid RPC plan is the fix.

8. **The OKX marketplace chat bot is logged out** (owner action: one login).
    Chat for OKX agent #2632 is delivered by a local `okx-a2a` daemon plus an
    `onchainos` wallet session, both outside this repo. The daemon is staged and
    running with skills linked; only the wallet session is logged out, and
    finishing it needs a human (email OTP as `claude@three.ws`). Run
    `npm run okx:bot` for the current login URL and the follow-up poll command:
    exit 0 means online, exit 2 means staged but logged out. A codespace cannot
    stay up on its own, so an always-on host is the durable fix.

Found by the 2026-07-30 documentation audit, which read the handlers behind
every surface it documented. Only the production-affecting findings are listed
here; the code-quality items from that pass are not production issues.

9. **Live R2 CORS does not match `scripts/set-r2-cors.mjs`** (owner action:
    one credential). CONFIRMED by measurement, not inference, and RE-CONFIRMED
    unchanged on 2026-09-02: `node scripts/set-r2-cors.mjs --probe` reads the
    enforced policy from outside and exits 1 on this bucket. The probe needs no
    credentials of any kind (it discovers the public host from a live listing
    endpoint and the upload host from the auth-free `/api/forge-upload`), so
    anyone can re-check this in one command.

    | Surface | Result |
    |---|---|
    | Site edge, `three.ws/avatars/*.glb`, foreign origin | PASS, `access-control-allow-origin: *`. Not affected. |
    | Public bucket host `pub-*.r2.dev`, foreign origin GET/HEAD | FAIL. Body returns `200`, but with no `access-control-allow-origin`, so the browser discards it. Allowlisted origins DO get their origin echoed, which is how the live read rule is known to still be the old allowlist rather than the world-open `*`. |
    | Presigned `PUT` preflight on the S3 endpoint | Mixed. `204` for `three.ws`, `*.vercel.app`, `localhost:3000`; `403` for `www.three.ws`, `*.app.github.dev`, `localhost:5173`. |

    The live policy is one allowlist rule serving both reads and writes
    (`GET, PUT, HEAD, POST, DELETE`), predating the script's split into a
    world-open `public-read` rule plus an origin-locked `browser-upload` rule.
    Impact: user-generated avatars resolve to `pub-*.r2.dev` via
    `publicUrl()` in [api/_lib/r2.js](api/_lib/r2.js), so third-party embeds
    reading those GLBs directly get a CORS failure. The `/api/glb` proxy is
    the working mitigation and stays correct after the fix; the docs now say
    which host needs it (docs/media-api.md, both embed tutorials).

    Blocked on one credential, not on code. The only R2 token reachable from
    this machine (`S3_*` in `.env`, identical to the Cloud Run service env,
    bucket `chatty-storage`) is object-scoped and gets `403 AccessDenied` on
    Get/PutBucketCors. Secret Manager holds no R2 or Cloudflare admin token
    (checked 2026-08-01 with working gcloud auth). As of 2026-09-02 this
    machine holds no R2 token at all and its gcloud session has expired, which
    changes nothing: the probe above still measures the live policy without
    credentials, and applying the fix still needs the admin token below.
    Owner: mint an "Admin Read & Write" R2 token scoped to the bucket (the
    script prints the exact steps; its `--get` path explains this instead
    of crashing), drop it in `.env.local` as `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`,
    then `node scripts/set-r2-cors.mjs` and confirm with `--probe`.

---

## Recently closed (do not re-open without new evidence)

Kept briefly because each one was previously mis-stated on this list, and the
wrong version is what a future reader would otherwise trust.

- **`/api/avatar/optimize?draco=1` (closed 2026-08-01).** It returned
  `500 transcode_failed` with `draco.createCompressedPrimitive is not a function`
  because the deployed image had resolved an older `@gltf-transform` than the
  pinned `^4.4.0`. This was always dependency drift in the image, never a code
  bug. The 2026-08-01 rebuild fixed it, verified live against production:
  `curl "https://three.ws/api/avatar/optimize?src=https://three.ws/avatars/cesium-man.glb&draco=1"`
  returns `200` with a 129,972-byte GLB stamped `glTF-Transform v4.4.0`. The two
  sibling defects filed under the same item also shipped: the silent-expression
  report (`x-render-expression` on `/api/avatar/render`, pinned by
  `tests/api/avatar-render-expression-report.test.js`) and the oversized-source
  stall (streaming 50 MB cap returning `413`/`504`, covered by
  `tests/avatar-optimize-source-cap.test.js`).

  A second, unrelated defect on the same endpoint was found once the 500 was
  gone and is **also closed (2026-08-13)**: `?draco=1` returned a file BIGGER
  than its input (default.glb 748,088 to 890,160, +19.0%; michelle.glb 849,756
  to 974,036, +14.6%) and said nothing about it. Cause: stored avatars are
  quantized and meshopt-packed, gltf-transform keeps `EXT_meshopt_compression`
  attached after reading, so Draco was layered beside the meshopt payload and
  re-quantized already-quantized attributes. The pipeline now drops the other
  mesh-compression scheme and dequantizes before encoding, keeps whichever
  encoding is actually smaller, and falls back to the original bytes when
  nothing helped. `x-three-ws-optimize` / `x-three-ws-optimize-refused` report
  which happened. Pinned by `tests/avatar-optimize-never-inflates.test.js`.

- **The autopilot spend default.** `POST /api/agents/:id/autopilot/run` read
  `body?.dry_run === true`, so a bare `POST {}` ran a REAL cycle while the
  sibling runner on the same wallet (`api/agents/wallet-intents.js`) read
  `dry_run !== false` and simulated. Now `body?.dry_run !== false`: silence
  simulates, and spending must ask for itself. The cockpit's Run button relied
  on the unsafe default, so it now sends `dry_run: false` explicitly and asks a
  second time before spending; a Preview cycle button runs the simulation.
  Pinned by `tests/autopilot-run-dry-run-default.test.js` (3 of its 6 cases fail
  against the old expression).
- **The `/pulse` marketplace GMV.** This list said "a confirmed `trial` row with
  a non-zero amount inflates published GMV". **That mechanism never occurred**:
  a trial is written `status='trial', kind='trial'` and only a `'pending'` row
  is ever promoted to `'confirmed'`, so the `status='confirmed'` filter already
  excluded every trial. Live data agrees: all 10,454 `skill_purchases` rows are
  `kind='trial', status='trial'`, and there is not one confirmed purchase yet.
  The defect was real but latent: the money aggregates filtered on status alone
  while the counts filtered on status AND kind, so they rested on an invariant
  nothing enforced, and a trial carries the listing's FULL price in `amount`
  despite nothing being paid. Every aggregate now derives from one shared
  `paidRow` predicate, `series_7d` included. Do not re-file this as an
  observed inflation of a published number; it was never that.
- **Oversized sources on `/api/avatar/optimize`.** See item 9.
- **Neon storage pressure.** `isStoragePressured()` reports `pressured: false` at
  2768MB, and `SHOW neon.max_cluster_size` returns **16TB**, so the 8192MB
  high-water on the service is a deliberate runaway backstop rather than a cap
  being approached. Worth watching only because the branch grew ~230MB in a day.
- **ASR and Redis.** See item 5: both were listed as unconfigured and both work.
- **World blueprint assets.** The `world` subsystem reported "1 blueprint
  asset(s) missing" while all 17 distinct assets served 200 to an independent
  sweep. The sensor swept the blueprint list verbatim (136 entries for 17 files)
  and treated a single transient HEAD timeout as a hard 404, parking a degraded
  verdict for the full cache hour. Now it sweeps distinct assets, retries a
  transient failure once, logs which URL is implicated, and only a 404/410
  counts. `world` reports ok.
- **Three shadowed agent routes.** `GET /api/agents/ens/:name`,
  `GET /api/agents/8004/agent` and `GET /api/agents/8004/search` all answered the
  agent-profile dispatcher's "agent not found": the broad
  `/api/agents/([^/]+)(?:/.*)?` route sat above them and, being pre-filesystem,
  the filesystem phase never saw them either. `api/agents/ens/[name].js` had
  never served a request, and `/demos/erc8004` could neither search the registry
  nor open an agent. Routes added above the catch-all and pinned by
  `tests/vercel-agents-subpath-routes.test.js`. Ships with the next deploy.
- **The seed cron's 409 storm.** Every payment in a batch was built from
  identical inputs with a fixed priority fee, so all N serialized to the same
  bytes, collided on one hashed payment id, and 409'd on all but one (about 40 of
  41 lost per tick, the largest single source of 4xx on the fleet). The compute
  unit price now varies by index. Cover:
  `tests/x402-seed-tx-uniqueness.test.js`.
- **Redis proxy SIGBUS.** `three-ws-redis-proxy` was crashing on signal 10 at
  512Mi, which surfaced as cache SET timeouts and rate-limiter degradation while
  healthz still read `cache: ok` because the memory fallback masked it. Raised to
  1Gi.
- **The bridge-down alert carried no information.** Its message escaped its own
  template interpolations, so it logged the literal source text instead of the
  count and the bridge names.
