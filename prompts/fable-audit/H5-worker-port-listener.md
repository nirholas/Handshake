# H5 — High: `agent-mm` and `agent-orders` workers have no `$PORT` listener

**Severity:** High · **Area:** Workers / Cloud Run · **Commit-gate:** no

## Context
Cloud Run **services** require the container to answer a startup probe on `$PORT`.
Cloud Run **Jobs** are exempt. `agent-sniper` was dead for days because it ran a
long-lived loop with no listener — fixed by adding a conditional HTTP stub
([workers/agent-sniper/index.js:44-58](../../workers/agent-sniper/index.js), which
notes it "matches workers/agora-citizens").

## The defect
[workers/agent-mm/index.js](../../workers/agent-mm/index.js) and
[workers/agent-orders/index.js](../../workers/agent-orders/index.js) run long-lived
loops; their Dockerfiles use `CMD ["node", "workers/agent-<x>/index.js"]` with no
HTTP server (agent-mm Dockerfile even asserts "no HTTP port — it's a background
worker"). No `gcloud run deploy` / `jobs` command for either exists anywhere in
`deploy/`, `scripts/`, or `workers/`. If they are (or ever get) deployed as
**services**, they crash-loop on boot. These are the money-moving market-maker and
limit-order workers.

## The fix
Add the same liveness stub `agent-sniper`/`agora-citizens` use, so the worker is
safe whether deployed as a service or a job:

```js
import http from 'node:http';
// near startup, before/alongside the main loop:
if (process.env.PORT) {
  http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); })
      .listen(Number(process.env.PORT), () => console.log(`[agent-mm] liveness on :${process.env.PORT}`));
}
```

**And** clarify the deploy path: either (a) add the `gcloud run deploy` command for
each worker to `workers/deploy/` and keep the liveness stub, or (b) deploy them as
Cloud Run **Jobs** and update the Dockerfile comment to say so. Don't leave the
deploy path undocumented.

## Verification
1. `PORT=8080 node workers/agent-mm/index.js` → binds 8080 and the loop still runs.
2. Without `PORT` set → no listener, loop runs (job mode unaffected).
3. Repeat for `agent-orders`.

## Done checklist
- [ ] Liveness stub added to both workers.
- [ ] Deploy path documented (service+stub, or job) for both.
- [ ] Dockerfile comments corrected to match reality.
