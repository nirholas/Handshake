# 04. Publish a real fact-check benchmark run

Read [00-INDEX.md](00-INDEX.md) first.

## Where this stands

Two of the three original problems are closed and verified live:

- Web search leads with Vertex-grounded Google Search. A live call to
  `POST /api/x402/fact-check` returned `supported` at 0.98 confidence with
  `vertexaisearch.cloud.google.com` grounding sources.
- `GET /api/fact-check-benchmark` returns `ran: false` instead of serving a stale
  run, so `/fact-check` renders its honest "not yet run" state rather than a
  misleading accuracy number. Confirmed again 2026-08-01.

What remains is the measurement itself. `scripts/fact-check-benchmark.mjs` targets
the **paid** endpoint `https://three.ws/api/x402/fact-check`, which answers a small
free allowance and then 402s, so a 40-claim run needs a bypass. Neither bypass
currently exists: there is no token carrying the `x402:bypass` OAuth scope, and
`INTERNAL_API_KEY` (the `x-api-key` service path in
[api/_lib/x402/access-control.js](../../api/_lib/x402/access-control.js)) is unset
both locally and on the `three-ws-api` Cloud Run service.

## The work

1. **Set the bypass.** Config-only, pre-approved:
   ```sh
   gcloud run services update three-ws-api --region us-central1 \
     --project aerial-vehicle-466722-p5 \
     --update-env-vars INTERNAL_API_KEY=<generated>
   ```
   Generate a strong value, store it where the other service secrets live, and
   pass it to the runner as `x-api-key`. `FACT_CHECK_BYPASS_TOKEN` is the
   alternative path if you prefer a scoped token over a service key; pick one and
   document which.

2. **Run it.**
   ```sh
   node scripts/fact-check-benchmark.mjs
   ```
   The runner refuses to publish any run with more than 10% errored claims, so a
   degraded run cannot poison the page. If it refuses, fix the errors rather than
   loosening the threshold: an errored claim usually means an LLM lane or the RPC
   chain is failing, which is work orders [02](02-solana-rpc-capacity.md) and
   [06](06-llm-lane-resilience.md), not this one.

3. **Verify the page tells the truth.** `/fact-check` must render the new run with
   its date, sample size, and methodology link. Check the empty state still works
   by reading the handler, not by deleting the run.

4. **Make it repeatable.** A benchmark that can only be run by the person who set
   the key rots. Document the exact invocation in `docs/`, and consider wiring it
   as a scheduled run so the published number carries a recent date. If you
   schedule it, add the cron to `vercel.json` (which `scripts/create-gcp-scheduler.mjs`
   reads) and note the cron count change against `npm run check:claude`.

## Verify

```sh
curl -s https://three.ws/api/fact-check-benchmark | python3 -m json.tool
curl -s -o /dev/null -w '%{http_code}\n' https://three.ws/fact-check
npm run gate
```

## Definition of done

- [ ] `GET /api/fact-check-benchmark` returns `ran: true` with a real report,
      sample size, and run timestamp.
- [ ] `/fact-check` renders that run in a browser with no console errors.
- [ ] The bypass mechanism (which one, where the key lives, how to rotate it) is
      documented in `docs/`.
- [ ] Errored-claim rate from the run is stated in [PROGRESS.md](PROGRESS.md).
- [ ] `data/changelog.json` entry (tag: `feature` or `improvement`) announcing the
      published accuracy number in plain language.
