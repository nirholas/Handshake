# Livepeer federation: adapter, measurement, and recommendation

Roadmap Phase 4 slice: "federate with existing decentralized compute networks
where appropriate." This note is the measured record: what was built, what the
live network did when we pointed real jobs at it, and whether to expand.

Every number here was measured on 2026-08-12 from this workspace. Re-measure
before trusting it: `node scripts/livepeer-federation-bench.mjs --jobs 20`.

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

| Gateway | Auth | State (measured 2026-08-12) |
|---|---|---|
| `https://livepeer.studio/api/generate` | `LIVEPEER_API_KEY` bearer | Reachable (404 on bare path, TLS valid). Requires an API key; none exists in `.env`, the Cloud Run env, or Secret Manager. |
| `https://dream-gateway.livepeer.cloud` | none (public, rate-limited) | **Dead at the DNS edge.** DNS (local resolver AND Cloudflare/Google DoH, so it is not a local hijack) resolves the host to 216.128.149.0, which serves a Let's Encrypt cert for `plasticoslins.com` and an unrelated "Plasticos Lins" 404 page. The domain's authoritative DNS appears expired or hijacked; there is no Livepeer service behind it. |
| `LIVEPEER_GATEWAY_URL` override | env | Supported for a self-hosted gateway or a future replacement edge. |

The same outage is visible from production, so it is not sandbox network
egress: `POST https://three.ws/api/inference/livepeer` (an existing demo
endpoint that calls the dream gateway's `/llm` surface from Cloud Run) returned
`livepeer.ok: false` on the public gateway while the platform leg answered
fine.

Both lanes resolve their gateway through one module,
[`api/_lib/livepeer-gateway.js`](../../api/_lib/livepeer-gateway.js)
(`LIVEPEER_GATEWAY_URL` override > keyed studio > public gateway), so a
gateway that moves is a one-file change. That module also marks the public
gateway unusable, and the LLM comparison lane acts on it: with no key and no
override, `/api/inference/livepeer` returns
`livepeer.error: "gateway_unavailable"` without dialing. The point is not the
failed request, it is that a POST there would hand the user's prompt text to
whoever now answers for that hostname. Point `LIVEPEER_GATEWAY_URL` at the
host to dial it again if the domain is ever restored.

## Measured comparison (2026-08-12)

`node scripts/livepeer-federation-bench.mjs --jobs 3`:

- **baseline lane** (platform chain, flag off): 0/3. Not a lane failure: this
  workspace carries no `.env` (NVIDIA_API_KEY / GOOGLE_CLOUD_PROJECT /
  REPLICATE_API_TOKEN all unset), so the chain correctly throws
  `unconfigured` at the request boundary. The adapter's wiring into the chain
  is covered by `tests/livepeer-federation.test.js` instead.
- **livepeer lane** (public gateway): 0/3, failure class `unreachable`
  (TLS `ERR_TLS_CERT_ALTNAME_INVALID` against the unrelated cert above).
  Cost $0.00, no fallback paid: the adapter failed over exactly as designed
  and the harness recorded the exact request it would send.

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
   dead at DNS. A federated lane that fails 100% of requests would still be
   correct (the chain fails over), but it would add a 90s-timeout-class
   hang risk on every text-to-3D job for zero benefit.
2. When `LIVEPEER_API_KEY` lands, the expansion decision is a measurement,
   not an argument: run the bench, and expand only if the studio lane clears
   roughly 9 of 10 jobs with p95 latency under the Vertex lane's and cost
   under Replicate's $0.003/image.
3. If Livepeer's AI gateway program does not recover (the public gateway has
   been sunset in favor of the studio product line), the same adapter shape
   ports to the next decentralized network (the env-var contract, envelope,
   verification gates, and bench harness are network-agnostic; only
   `api/_providers/livepeer.js` internals change).

Solana note: nothing in this slice touches a chain. No EVM dependency was
introduced; the federation lane is a plain HTTPS compute call.
