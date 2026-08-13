# Livepeer federation: adapter, measurement, and recommendation

Roadmap Phase 4 slice: "federate with existing decentralized compute networks
where appropriate." This note is the measured record: what was built, what the
live network did when we pointed real jobs at it, and whether to expand.

Every number here was measured from this workspace, most recently on
2026-08-13. Re-measure before trusting it:
`node scripts/livepeer-federation-bench.mjs --jobs 20`.

---

## What was built

The cheapest-to-verify GPU job class on the platform is the forge
text-to-image reference view (one image per text-to-3D job, 4-step distilled
models, verified by magic-byte sniffing at the persistence seam). The adapter
routes exactly that class:

- `api/_providers/livepeer.js`: the adapter. Accepts the same
  `(prompt, { aspectRatio, seed })` envelope as the platform's own image lanes
  and returns the same `{ imageUrl, model, lane }` envelope, with `imageUrl`
  persisted to R2 exactly like the NIM FLUX and Vertex lanes. Verification
  before persistence: gateway `safety_check` screening honored, artifact bytes
  must carry a real PNG/JPEG signature and clear a 1 KB floor. Dark unless
  `LIVEPEER_FEDERATION_ENABLED` is truthy.
- Chain position in `api/_mcp3d/text-to-image.js`: after the first-party free
  lanes (Vertex/NIM cost the platform nothing), before the paid Replicate
  backstop ($0.003/image). A successful federated call is strictly cheaper
  than every remaining option at that point in the ladder.
- `api/_lib/image-persist.js`: the persist-to-R2 rule was copy-pasted between
  `text-to-image.js` and `forge-reference-image.js`; the adapter needed a
  third copy, so the rule now lives in one module and both call sites import
  it. No behavior change.
- `scripts/livepeer-federation-bench.mjs`: the comparison harness. Runs N
  real jobs per lane, reports latency/success/cost per lane with failure
  classes, and writes a JSON report.
- Tests: `tests/livepeer-federation.test.js` (flag gating, gateway
  resolution, request/response envelope, all four verification gates, error
  coding) and `tests/image-persist.test.js`.

## Gateways

| Gateway | Auth | State (re-measured 2026-08-13) |
|---|---|---|
| `https://livepeer.studio/api/generate` | `LIVEPEER_API_KEY` bearer | **Live and authenticating.** An unkeyed POST to `/api/generate/text-to-image` returns `401 {"errors":["request is not authenticated"]}`, not a 404, so the adapter's exact path is correct and the route is serving. The path is confirmed independently by the official SDK we depend on: `livepeer@3.5.0` builds the same `/api/generate/text-to-image` on server `https://livepeer.studio/api` (`node_modules/livepeer/funcs/generateTextToImage.js`). Requires an API key; none exists in `.env`, the Cloud Run env, or Secret Manager. |
| `https://dream-gateway.livepeer.cloud` | none (public, rate-limited) | **Dead, and the cause is a stale DNS record rather than a lapsed domain.** `livepeer.cloud` is still actively managed (authoritative NS `merlin`/`ariella.ns.cloudflare.com`, and `www.livepeer.cloud` resolves to live Cloudflare proxy IPs), but the `dream-gateway` record still points at 216.128.149.0, which reverse-resolves to `vultrusercontent.com` and serves a Let's Encrypt cert for `plasticoslins.com`. That is a decommissioned Vultr GPU host whose IP has been reassigned to an unrelated tenant: a dangling DNS record, not an expired registration. Confirmed against the local resolver and both Cloudflare and Google DoH, so it is not a local hijack. |
| `LIVEPEER_GATEWAY_URL` override | env | Supported for a self-hosted gateway or a future replacement edge. |

Why the distinction matters: a lapsed domain would eventually be reclaimed or
go dark, whereas a dangling record inside a live zone points user prompt text
at whoever currently holds that IP, indefinitely and with a valid TLS
certificate for their own name. That is the reason both lanes refuse the
public gateway outright instead of retrying it.

The developer documentation for this API surface is in flux, which is itself
input to the recommendation below. As of 2026-08-13 `docs.livepeer.org` serves
network-operator documentation (orchestrators and delegators) and states
plainly: "These docs cover *running* the network. A developer platform, and a
Build section of these docs, is on the way. In the meantime, ask in the
Livepeer Discord." The AI API reference pages (`text-to-image`, `llm`,
`image-to-video`, and siblings) are still listed in
`https://docs.livepeer.org/llms.txt`, so the surface is not withdrawn, but
there is currently no rendered public reference for it. The request shape this
adapter sends is therefore pinned to the official SDK's generated client, which
is versioned in our lockfile, rather than to a documentation page that moved.

The same outage is visible from production, so it is not sandbox network
egress. Re-confirmed 2026-08-13: `POST https://three.ws/api/inference/livepeer`
(an existing demo endpoint that calls the dream gateway's `/llm` surface from
Cloud Run) returns `livepeer.ok: false`, `error: "network_error"` against
`https://dream-gateway.livepeer.cloud/llm` while the platform leg answers fine
in the same response.

Both lanes resolve their gateway through one module,
[`api/_lib/livepeer-gateway.js`](../../api/_lib/livepeer-gateway.js)
(`LIVEPEER_GATEWAY_URL` override > keyed studio > public gateway), so a
gateway that moves is a one-file change. That module also marks the public
gateway unusable, and the LLM comparison lane acts on it: with no key and no
override, `/api/inference/livepeer` returns
`livepeer.error: "gateway_unavailable"` without dialing.

**That guard is in the tree but not yet in production.** The live revision at
the time of writing was built from commit `6839844cc` (2026-08-12T18:37Z),
which predates it, which is why the re-confirmation above shows the endpoint
still dialing the host and reporting `network_error` rather than refusing up
front. The next deploy of `api/inference/livepeer.js` closes it; deploys are
owner-gated, so this note records the gap rather than assuming it away. The
point is not the failed request, it is that a POST there hands the user's
prompt text to whoever now answers for that hostname, and production is still
doing that on every run of the demo until the deploy lands. Point
`LIVEPEER_GATEWAY_URL` at the host to dial it again if the record is ever
repointed at a real gateway.

## Measured comparison (full 20-job run, 2026-08-13)

`node scripts/livepeer-federation-bench.mjs --jobs 20`, 20 distinct seeded
prompts per lane:

| Lane | Succeeded | Failure class | Cost | Latency p50/p95 |
|---|---|---|---|---|
| baseline (platform chain, flag off) | 0/20 | `unconfigured` (20/20) | $0.00 | n/a |
| livepeer (public gateway) | 0/20 | `tls` (20/20) | $0.00 | n/a |

Neither zero is a lane defect, and they are zero for different reasons:

- **baseline**: this workspace's `.env` carries only the QA sweep account, so
  `NVIDIA_API_KEY` / `GOOGLE_CLOUD_PROJECT` / `REPLICATE_API_TOKEN` are unset
  and the chain throws `text-to-image is not configured` at the request
  boundary before any network call. The adapter's wiring into the chain is
  covered by `tests/livepeer-federation.test.js` instead. Supplying the
  production credentials does not fix this from here either: NVIDIA's
  `ai.api.nvidia.com` accepts the TLS handshake from this sandbox but never
  answers the inference POST (measured: two direct probes with the lane's exact
  body, 120 s and 150 s, zero bytes received), while the Vertex lane needs
  `GCP_SERVICE_ACCOUNT_JSON` or the GCE metadata server, neither of which
  exists outside Cloud Run. Production serves this lane normally, so a
  first-party latency baseline has to be measured from production, not from a
  developer workspace.
- **livepeer**: every one of the 20 jobs died at the TLS layer against the
  dangling `dream-gateway` record, verbatim:
  `livepeer gateway unreachable: fetch failed: ERR_TLS_CERT_ALTNAME_INVALID
  Hostname/IP does not match certificate's altnames: Host:
  dream-gateway.livepeer.cloud. is not in the cert's altnames:
  DNS:plasticoslins.com`. Cost $0.00 and nothing was paid downstream: the
  adapter failed over exactly as designed.

That verbatim cause is new in this run. Node's `fetch` collapses every
transport fault to the string `fetch failed` and hides the reason on
`err.cause`, so the adapter previously reported the outage as a bare
`unreachable` with no diagnosis, and the bench's `tls` failure class was
unreachable code. The adapter now flattens the cause chain into the message
(`describeTransportFailure`), which is what lets the table above distinguish a
certificate fault from a DNS miss or a refused connection. Covered by
`tests/livepeer-federation.test.js`.

Because the free path cannot execute the job class, the work order's dry-run
branch applies. The adapter is proven to the request boundary: the exact POST
body (`{ prompt, model_id: "ByteDance/SDXL-Lightning", width, height,
num_images_per_prompt: 1, safety_check: true }`), the exact headers (bearer
present only when keyed), and the exact upstream response are all recorded
above and reproducible with the bench script.

**What a funded run needs, exactly:** one env var, `LIVEPEER_API_KEY`, from a
Livepeer Studio account (Settings, API Keys at livepeer.studio). With that set
the adapter's gateway resolution flips to the studio AI gateway automatically
and the same `--jobs 20` bench produces the full latency/cost/success
comparison. Studio's metered rate for a ~1s SDXL-Lightning-class job is in
the low fractions of a cent; the harness models it at
`LIVEPEER_STUDIO_COST_PER_IMAGE` (default $0.0025) until the account's
dashboard reports the real number.

## Recommendation

**Do not expand yet. Keep the adapter dark (flag off) and re-evaluate after
the funded 20-job run.** Rationale:

1. The only currently working gateway requires a paid-account key, and the
   free no-key path (dream-gateway) is not rate-limited or degraded, it is
   dead: 20 of 20 jobs failed at the TLS layer against a certificate issued to
   an unrelated domain. A federated lane that fails 100% of requests would
   still be correct (the chain fails over), but it would add a
   90s-timeout-class hang risk on every text-to-3D job for zero benefit.
2. When `LIVEPEER_API_KEY` lands, the expansion decision is a measurement,
   not an argument: run the bench, and expand only if the studio lane clears
   roughly 9 of 10 jobs with p95 latency under the Vertex lane's and cost
   under Replicate's $0.003/image. Measure the Vertex comparison number from
   production, not from a workspace run: the 2026-08-13 attempt above showed
   the first-party lanes cannot execute locally even with production
   credentials supplied, so a locally-derived p95 would be a sandbox artifact
   rather than the bar the federated lane has to beat.
3. The vendor's own developer surface is mid-migration, which is a reason to
   wait rather than to commit. The public gateway is gone, the AI API
   reference pages are unrendered, and the docs site says a developer platform
   is still "on the way". Adopting a lane whose documented contract is
   temporarily unpublished means taking the SDK's generated client as the only
   specification, which is fine for a dark adapter and not fine for a lane in
   the live path.
4. If Livepeer's AI gateway program does not recover, the same adapter shape
   ports to the next decentralized network (the env-var contract, envelope,
   verification gates, and bench harness are network-agnostic; only
   `api/_providers/livepeer.js` internals change).

**Revisit trigger.** Re-run the bench when any one of these changes: an
`LIVEPEER_API_KEY` is provisioned, the `dream-gateway` record starts resolving
to a host serving a certificate for a `livepeer` name, or the Build section of
`docs.livepeer.org` ships a rendered AI API reference. Absent one of those,
there is nothing new to measure and the lane stays dark.

Solana note: nothing in this slice touches a chain. No EVM dependency was
introduced; the federation lane is a plain HTTPS compute call.
