# Cron authentication: the two locks on `/api/cron/*`

The Cloud Scheduler jobs declared in `vercel.json` (its `crons` array is the
source of truth for how many) drive handlers that move real money: custody attestation, buybacks, treasury top-ups, payouts, wallet
intents, the dead-man switch. Anything that can invoke those can spend from
them, so the gate is layered and both layers fail closed.

## Lock 1: the handler gate (`api/_lib/cron-auth.js`)

Every file under `api/cron/` opens with `if (!requireCron(req, res)) return;`.
That helper is the only place the credential is compared:

- `CRON_SECRET` unset is a `503 not_configured`, never a pass. A misconfigured
  deploy must not expose a money-moving sweep.
- The comparison is constant time, so the secret has no timing oracle.
- `Authorization: Bearer <secret>` and `X-Cron-Secret: <secret>` are both
  accepted, and both carry the same secret. The second spelling is not
  historical clutter: it is what makes lock 2 attachable at all (see below).
- An inbound header like `x-vercel-cron` is never authorization on its own.

`tests/api/cron-auth-sweep.test.js` invokes every handler in the directory with
no credential on every test run and requires a closed status from each, plus
each of the `[name].js` dispatcher's routes individually. The sweep is
behavioral, not a grep, so a guard that exists but is never called still fails
it. It also runs against four deliberately broken fixtures (no guard, a verdict
computed and discarded, a 200 above the guard, a handler that hangs) and must
reject all four, so a sweep that quietly degraded into a no-op cannot pass.

## Lock 2: the edge gate (`server/cron-edge-auth.mjs`)

Lock 1 is a convention, not a mechanism. The server's filesystem phase routes
every `api/cron/*.js` file by its existence, so one future handler that forgets
the line is directly internet-invokable. The edge gate makes that omission
survivable: mounted ahead of the route table in `server/index.mjs`, it refuses
the request before any handler is imported.

It accepts two credentials, permanently. This is defense in depth, not a
migration with a cutover:

1. **`CRON_SECRET`**, via `isCronAuthorized()` from the same module lock 1 uses,
   so the edge and the handler can never disagree about what a valid secret is.
2. **A Cloud Scheduler OIDC identity token**: Google-signed, short-lived, bound
   to one audience, and unusable from a leaked env dump.

Both halves of the OIDC identity are required, and the email is the load-bearing
one: any Google service account can mint an ID token for an arbitrary audience,
so an audience match alone authenticates nobody. The token must carry
`email_verified: true`, an email in `CRON_OIDC_SERVICE_ACCOUNT`, and an audience
in `CRON_OIDC_AUDIENCE`. With either var unset the OIDC path is off and only the
secret is accepted.

| Var | Value in production | Effect |
|---|---|---|
| `CRON_OIDC_AUDIENCE` | the Cloud Run service URL | audiences the edge will accept, comma-separated |
| `CRON_OIDC_SERVICE_ACCOUNT` | `three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com` | service-account emails the edge will accept, comma-separated |

The one case where the edge stands aside is "no credential configured at all"
(no `CRON_SECRET`, no OIDC pair), which is a developer's machine: the request
falls through so `requireCron` owns the single canonical 503. Production always
has `CRON_SECRET`, so production is always closed here. A fault inside the gate
itself is a 401, not a pass.

Covered by `tests/server-cron-edge-auth.test.js`, which verifies real RS256
signatures against a locally generated key set: a forged token, a wrong
audience, a wrong issuer, a wrong service account, an unverified email, and an
expired token are each refused, and a genuine one is accepted.

## Attaching the OIDC token (the fleet-wide step)

**The trap:** Cloud Scheduler puts its OIDC token in the `Authorization` header.
The jobs today authenticate with `Authorization: Bearer $CRON_SECRET`, so naively
adding `--oidc-service-account-email` DESTROYS the credential every job runs
on, and they 401 together. The secret must move to `X-Cron-Secret` in the same
update. `node scripts/create-gcp-scheduler.mjs --oidc` does exactly that, and
`tests/cron-scheduler-sync.test.js` pins the pairing so the two can never be
emitted apart.

Order matters. Attach the token first and require it second, never the reverse:

```sh
# 1. Teach the service which identity to trust (merge, never --set-env-vars).
gcloud run services update three-ws-api \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --update-env-vars \
CRON_OIDC_AUDIENCE=https://three-ws-api-lp642k3kpa-uc.a.run.app,\
CRON_OIDC_SERVICE_ACCOUNT=three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com

# 2. Migrate ONE job and prove it before touching the fleet.
node scripts/create-gcp-scheduler.mjs --oidc --only uptime-check
gcloud scheduler jobs run cron--api-cron-uptime-check \
  --location us-central1 --project aerial-vehicle-466722-p5
gcloud scheduler jobs describe cron--api-cron-uptime-check \
  --location us-central1 --project aerial-vehicle-466722-p5 \
  --format='value(status.code,lastAttemptTime,state)'   # empty code = success

# 3. Migrate the rest.
node scripts/create-gcp-scheduler.mjs --oidc

# 4. Confirm nothing is failing, over a window that covers the slowest cron.
gcloud logging read \
  'resource.type="cloud_run_revision"
   resource.labels.service_name="three-ws-api"
   httpRequest.requestUrl:"/api/cron/"
   httpRequest.status=401' \
  --project aerial-vehicle-466722-p5 --freshness=2h --limit=20
```

The sync reads `CRON_SECRET` from `--env-file`, then `process.env`, then the
live Cloud Run service, so on an authenticated machine step 2 needs no argument.

**Rollback** is one command and needs nothing else: `node
scripts/create-gcp-scheduler.mjs` (no `--oidc`) puts the Bearer secret back on
every job. The edge keeps accepting it, because it never stopped.

## Related

- `api/_lib/cron-auth.js`, `server/cron-edge-auth.mjs`,
  `scripts/create-gcp-scheduler.mjs`
- [gcp-production.md](gcp-production.md) for the service, env, and deploy story
- `npm run check:cron-drift` (declared vs live jobs) and
  `npm run audit:cron-liveness` (jobs that exist but never fire)
