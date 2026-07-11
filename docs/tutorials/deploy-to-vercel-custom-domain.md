# Deploy to Vercel with a Custom Domain

> **Note — three.ws production no longer runs on Vercel.** On 2026-07-07 the hosted platform migrated to Google Cloud Run: one container ([server/index.mjs](https://github.com/nirholas/three.ws/blob/main/server/index.mjs)) serves the frontend and all API routes, deployed with `npm run deploy:gcp` (see [docs/build.md](/docs/build) and the ops runbook at `docs/ops/gcp-production.md`). This guide remains fully valid for **self-hosting your own fork on Vercel** — the repo's `vercel.json` still works there — but it does not describe how the production site is operated.

By the end of this tutorial you have a live three.ws fork running at a domain you own — `agent.yourcompany.com` or whatever you choose. CI is wired so every commit type-checks, every PR generates a preview, and merges to `main` ship to production. SSL is issued automatically. Rollbacks take one click.

This is the deployment-side companion to [self-host-agent-backend](/tutorials/self-host-agent-backend). That tutorial covered the architectural moving parts; this one walks the deploy and operate flow end-to-end without re-explaining what each component does.

**What you'll build:**

- A Vercel project linked to your fork of `three.ws`
- A working `vercel.json` (the repo's default works, but you'll know what's in it)
- Three environments — `development` (local), `preview` (per PR), `production` (your domain)
- A custom domain wired with DNS and automatic SSL
- A GitHub Actions workflow for type checks and tests on every PR
- Promotion mechanics: how preview becomes production
- Analytics, error tracking, and a rollback procedure
- The cost shape: what you should expect to pay

**Prerequisites:**

- A fork of the `three.ws` repo. If you haven't forked yet, see [self-host-agent-backend](/tutorials/self-host-agent-backend) Step 2.
- A Vercel account (free tier is enough to start)
- A domain you control. New domains can be bought from any registrar — Cloudflare, Namecheap, Porkbun, or Vercel itself
- Node.js 24.x locally for verifying builds before deploying
- Access to your domain's DNS provider (the registrar's panel or, more commonly, Cloudflare DNS)
- Optional: Sentry account for error tracking, a Postgres instance (Neon, Vercel Postgres, Supabase), Upstash Redis. None are required for the bare deploy — you'll add them as needed

---

## Step 1 — One-line deploy first, then the deeper config

Get something live in five minutes. Open a terminal inside your fork:

```bash
cd three.ws
npm i -g vercel
vercel login
vercel link
```

When `vercel link` asks "Set up and deploy?", answer yes, accept the default project name (your repo name), accept the suggested team/scope, and accept the auto-detected framework settings — Vercel will detect Vite from `package.json`.

```bash
vercel
```

Vercel installs deps, runs `npm run build`, and deploys a preview. After about three minutes you'll get a URL like `https://three-ws-yourname.vercel.app`. Hit `/api/healthz`. You should see `{"status":"ok", ...}` — the platform is live, even if every other route 404s or 500s because env vars aren't set yet.

That's the floor. From here every change is incremental.

---

## Step 2 — What's in `vercel.json`

The repo ships a `vercel.json`. Read it once so you know what's working for you. The interesting parts:

```json
{
  "buildCommand": "npm run build:vercel",
  "outputDirectory": "dist",
  "public": true,
  "installCommand": "npm ci --prefer-offline --no-audit --no-fund",
  "env": { "NODE_OPTIONS": "--no-deprecation" },
  "functions": {
    "api/**/*.js": { "includeFiles": "node_modules/@zauthx402/sdk/dist/**" }
  },
  "routes": [
    { "src": "/openapi\\.json", "dest": "/api/openapi-json" },
    { "src": "/\\.well-known/chat-plugin\\.json", "dest": "/api/wk?name=chat-plugin" },
    { "src": "/\\.well-known/x402\\.json", "dest": "/api/wk?name=x402-discovery" }
  ]
}
```

Three things worth understanding:

- **`buildCommand: npm run build:vercel`** runs the production build, including the prebuild step that generates the page index. The local `npm run dev` uses Vite directly; `build:vercel` is the optimized path that ships.
- **`outputDirectory: dist`** is what Vercel serves as static files. After `npm run build`, `dist/` contains `index.html`, hashed JS bundles, the `cdn/` folder, sub-apps under `dist/chat/`, etc.
- **`routes`** rewrites specific paths to specific function files. The well-known routes (`/.well-known/x402.json` → `/api/wk?name=x402-discovery`) are how the platform exposes machine-readable discovery surfaces at the URLs the spec mandates.

You shouldn't need to edit `vercel.json` for the basic deploy. The repo's defaults are tuned for the platform's actual route set.

---

## Step 3 — Set environment variables

The deploy at Step 1 has no env vars. Almost every API route will fail. Add them.

In your terminal:

```bash
vercel env add DATABASE_URL production
vercel env add ANTHROPIC_API_KEY production
vercel env add OPENAI_API_KEY production
vercel env add SOLANA_RPC_URL production
vercel env add SESSION_SECRET production         # openssl rand -hex 32
vercel env add CSRF_SECRET production            # openssl rand -hex 32
vercel env add X402_PAY_TO_BASE production
vercel env add X402_ASSET_ADDRESS_BASE production # 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base mainnet
vercel env add CDP_API_KEY_ID production
vercel env add CDP_API_KEY_SECRET production
# Object storage
vercel env add R2_ENDPOINT production
vercel env add R2_BUCKET production
vercel env add R2_ACCESS_KEY_ID production
vercel env add R2_SECRET_ACCESS_KEY production
vercel env add R2_PUBLIC_BASE production
# Optional but recommended once you have traffic
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
vercel env add HELIUS_API_KEY production
```

The complete list is in `.env.example` in the repo. For an exhaustive walkthrough of what each variable does, see [self-host-agent-backend](/tutorials/self-host-agent-backend).

Repeat for the `preview` and `development` environments where you want different values. Most secrets you'll want **different per environment** — production must have its own `SESSION_SECRET`, its own `X402_PAY_TO_BASE` (so receipts are attributable to the right environment), and ideally its own `ANTHROPIC_API_KEY` (so a runaway preview deploy can't drain your production budget).

For variables that have to be set at build time (not runtime), prefix them with `VITE_`:

```bash
vercel env add VITE_API_BASE production         # https://agent.yourcompany.com
vercel env add VITE_CDN_BASE production         # https://agent.yourcompany.com
```

Triggering a fresh deploy picks up the new env:

```bash
vercel --prod
```

---

## Step 4 — Connect the GitHub repo

So you don't have to `vercel --prod` from your laptop forever, hook up automatic deploys from GitHub.

In the Vercel dashboard:

1. Open your project → **Settings → Git**
2. Click **Connect Git Repository**
3. Authorize Vercel to read your fork
4. Pick your fork from the list

Vercel sets up two integrations:

- **Production deploys** trigger on pushes to the production branch (default: `main`)
- **Preview deploys** trigger on every other branch and every pull request, each getting its own URL

From this point: `git push origin main` ships to production, opens-a-PR ships a preview. You won't run `vercel --prod` from local again.

A subtle but useful Vercel feature: each PR's preview URL is also added as a comment on the PR by the Vercel GitHub app. The comment updates as new commits ship. Reviewers click the URL and exercise the change.

---

## Step 5 — Add a custom domain

In the Vercel dashboard: **Project → Settings → Domains → Add**. Type your domain (e.g., `agent.yourcompany.com`) and submit.

Vercel shows DNS instructions. Two cases:

**Subdomain (most common).** Vercel asks for a `CNAME` record pointing your subdomain at `cname.vercel-dns.com`. Add this record in your DNS provider:

| Type  | Name   | Value                  | TTL    |
|-------|--------|------------------------|--------|
| CNAME | agent  | cname.vercel-dns.com.  | 300    |

Save. Wait. DNS propagation typically takes 1–10 minutes but can take up to 24 hours. Vercel's domains UI shows a green check once it sees the record.

**Apex / root domain (e.g., `yourcompany.com`).** Apex domains can't use CNAME records (per DNS RFCs). Vercel provides A records or, on supporting providers, ALIAS records:

| Type | Name | Value           | TTL |
|------|------|-----------------|-----|
| A    | @    | 76.76.21.21     | 300 |

(Vercel's published IPs may change; copy the exact values from the dashboard.)

If your DNS is on Cloudflare, set the proxy status to **DNS only** (gray cloud), not proxied (orange cloud). Cloudflare's proxy in front of Vercel breaks the auto-SSL handshake and double-caches. Vercel's edge handles caching; you don't need Cloudflare's on top.

Once DNS resolves, Vercel automatically requests a Let's Encrypt certificate and installs it. HTTPS works without any configuration on your side. Confirm:

```bash
curl -I https://agent.yourcompany.com/api/healthz
```

You should see `HTTP/2 200`. If you see `525` or `526` errors, DNS hasn't fully propagated. Wait 10 more minutes.

**Redirect www to apex (or vice versa).** If you want both `agent.yourcompany.com` and `www.agent.yourcompany.com` to resolve, add the `www` variant in Vercel's Domains UI too. Vercel will let you set one as primary and 301 the other to it.

---

## Step 6 — Set the production branch

Vercel defaults the production branch to `main`. Verify in **Settings → Git → Production Branch**.

If you use Git Flow or trunk-based with a different production branch (e.g., `production` or `release`), change it here. The setting is per-project; you can't accidentally ship `feat/foo` to production unless you push it to whichever branch is set.

---

## Step 7 — GitHub Actions for type checks and tests

Vercel's build catches build errors but not type errors that pass through the build (TypeScript with `--noEmit` skipped, or JSDoc errors). Add a CI workflow that catches them.

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci --prefer-offline --no-audit --no-fund
      - run: npm run typecheck
      - run: npm test
      - run: npm run build:vercel
```

The repo already exposes `typecheck`, `test`, and `build:vercel` scripts in `package.json`. If your fork has additional checks (lint, format), add them as separate steps.

Wire required status checks: **Repo Settings → Branches → Add rule → Branch name `main` → Require status checks → Add `CI / test`**. Now no PR merges without CI green.

For larger forks, parallelize:

```yaml
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: 'npm' }
      - run: npm ci --prefer-offline --no-audit --no-fund
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: 'npm' }
      - run: npm ci --prefer-offline --no-audit --no-fund
      - run: npm test
```

Two jobs, run in parallel. Most teams add a third job for a smoke test against the Vercel preview URL; see Step 11.

---

## Step 8 — Environment promotion

You have three environments now:

| Environment | Trigger                  | URL pattern                                      | Env vars source |
|-------------|--------------------------|--------------------------------------------------|-----------------|
| Development | `npm run dev` locally    | `http://localhost:3000`                          | `.env.development` (gitignored) |
| Preview     | Push any non-prod branch | `https://three-ws-<hash>-yourname.vercel.app`    | Vercel `preview` env scope |
| Production  | Push to `main`           | `https://agent.yourcompany.com`                  | Vercel `production` env scope |

The promotion path is **dev → preview → production**. Every change rides this path:

1. Write code locally. `npm run dev`. Hit `http://localhost:3000`. Confirm behavior.
2. Push a branch and open a PR. CI runs. Vercel's GitHub bot comments with a preview URL. You and reviewers smoke-test the preview.
3. Merge to `main`. Vercel auto-deploys to production. Production traffic now hits the new build.

If preview surfaces a bug, you fix on the same branch and push — the same preview URL updates. No redeploy ceremony.

**Don't ever `vercel --prod` from local once GitHub integration is wired.** It bypasses CI. Lock yourself out of the temptation: revoke your local CLI's permission to push prod via **Settings → Security → Deploy Hooks → Disable interactive deploys**.

---

## Step 9 — Analytics

The Vercel free tier ships **Web Analytics** (privacy-friendly, no-cookie, ~1KB script). Enable it: **Project → Analytics → Enable**. The script auto-injects into your pages.

For richer product analytics, options:

- **Plausible (self-hosted or hosted).** Add the script tag to `index.html`.
- **PostHog.** Same. PostHog's free tier covers most early-stage usage.
- **Custom.** The platform has a `/api/usage` route used for internal telemetry; wire your own events there.

Don't try to instrument both Vercel Analytics and a heavy SDK like Segment without thinking about it — you'll double-count page views and confuse yourself. Pick one source of truth for product metrics. Vercel Analytics is the cheapest start.

For agent-specific events (chat messages sent, skills invoked, x402 payments completed), the platform's `audit_log` table is your source — query it via your admin tool of choice (Metabase, Grafana, or a custom dashboard route).

---

## Step 10 — Error tracking

`console.error` in a Vercel function disappears into the deployment logs, where it's only useful if you happen to check at the right moment. Set up a real error tracker.

Sentry has the cleanest Vercel integration. From the Vercel dashboard:

1. **Marketplace → Sentry → Add Integration**
2. Authorize, pick your Sentry project, finish
3. Sentry's wizard generates env vars (`SENTRY_DSN`, etc.) and adds them to your Vercel project automatically

Now add Sentry to the code. For the back-end functions:

```bash
npm install @sentry/node
```

```js
// api/_lib/sentry.js
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV || 'production',
    tracesSampleRate: 0.1,
  });
}

export function captureError(err, extra = {}) {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err, { extra });
  } else {
    console.error('captureError', err, extra);
  }
}
```

The platform already has a `_lib/sentry.js` you can extend. The pattern: every Vercel function's error path calls `captureError`. Don't sample those down — errors are rare and you want all of them.

For the front-end:

```bash
npm install @sentry/browser
```

```js
// src/sentry-bootstrap.js
import * as Sentry from '@sentry/browser';
if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.05,
  });
}
```

Import this from your app entrypoint. Now front-end errors (Three.js initialization failures, manifest load errors, network errors in the chat) also flow to Sentry.

Set up a Sentry alert: "any new issue (first seen in last 24h) in production environment" → page someone. The signal-to-noise on this alert is excellent for a small platform.

---

## Step 11 — Smoke tests against preview

A great CI step is exercising the preview URL after Vercel deploys it. Add to `.github/workflows/ci.yml`:

```yaml
  smoke:
    runs-on: ubuntu-latest
    needs: test
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - name: Wait for Vercel preview
        id: wait
        uses: patrickedqvist/wait-for-vercel-preview@v1.3.1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          max_timeout: 300
      - name: Smoke test
        env:
          PREVIEW_URL: ${{ steps.wait.outputs.url }}
        run: |
          set -e
          curl -fsS "$PREVIEW_URL/api/healthz" | tee /tmp/health.json
          test "$(jq -r .status /tmp/health.json)" = "ok"
          curl -fsS -I "$PREVIEW_URL/" | head -1 | grep -q "200"
          curl -fsS -I "$PREVIEW_URL/dist-lib/agent-3d.js" | head -1 | grep -q "200"
```

Three checks: the health endpoint responds, the home page returns 200, the CDN bundle exists. If any fail, the PR's CI goes red. Add more checks as you find behaviors worth gating on.

For deeper smoke tests, point Playwright at the preview URL:

```yaml
      - name: Playwright smoke
        env:
          BASE_URL: ${{ steps.wait.outputs.url }}
        run: |
          npm ci
          npx playwright install --with-deps chromium
          npm run test:smoke
```

Where `test:smoke` runs a small Playwright suite that loads an agent, sends a chat message, and asserts a response comes back. The platform's `tests/e2e/` directory has examples.

---

## Step 12 — Rollback

Despite all the CI, you will ship a regression. The fix is fast.

**Option A: rollback via the Vercel dashboard.** Project → Deployments → find the last good deployment → click `...` → **Promote to Production**. Done. The DNS at `agent.yourcompany.com` flips to the older build in seconds. You can then debug at your leisure on a new branch.

**Option B: rollback via git.** Revert the bad commit on `main`, push. CI runs and the production build deploys with the revert applied. This is slower than option A but leaves a clean git history.

**Option C: rollback specific routes.** Vercel doesn't natively support per-route rollback, but if the bad change is in a single function, you can patch that function in a tiny commit and ship just it. Same as option B with a smaller diff.

Whatever you do, **don't redeploy in panic**. Take the rollback first, then investigate. Production is back up; you can debug calmly.

---

## Step 13 — Branch protection (the boring but vital settings)

In your GitHub repo: **Settings → Branches → Add rule** for `main`:

- Require pull request reviews before merging
- Require status checks to pass before merging (select `CI / test` and `CI / smoke` if you wired the smoke step)
- Require branches to be up to date before merging
- Do not allow bypassing the above settings (even for admins)

For higher-stakes deployments (multi-person teams, customer-facing platform), also enable:

- Require signed commits
- Require linear history (no merge commits — squashes or rebases only)
- Restrict who can push to `main` (only Vercel's GitHub app + named release engineers)

These rules are annoying when you're the only contributor. They are load-bearing once the team grows past one person.

---

## Step 14 — Production checklist

Before you call it done:

- DNS resolves and SSL works for your custom domain
- `/api/healthz` returns 200
- A test agent can be created in the dashboard, edited, and embedded on a third-party page
- The embed bundle at `https://agent.yourcompany.com/dist-lib/agent-3d.js` serves correctly with a `Cache-Control` header
- GitHub → Vercel integration is live; pushing to `main` triggers a production deploy and pushing a branch triggers a preview
- CI passes on a recent PR and the preview URL is reachable
- Sentry receives a deliberately thrown error from a preview deploy (test once, then remove the test)
- Vercel Analytics is enabled and shows page views in the dashboard within a few minutes of opening the site
- Branch protection rules are on `main`
- Rollback procedure is documented in your team's runbook (one line is enough: "Vercel → Deployments → Promote to Production")
- At least one team member other than the deployer can perform the rollback
- DNS TTL is set to 300 seconds (not 86400) so a rollback that involves DNS changes propagates quickly

---

## Step 15 — Cost shape

Roughly what to expect:

- **Vercel.** Free tier (Hobby) covers small projects — 100 GB-hours of serverless execution, 100 GB bandwidth, unlimited static. Pro starts at $20/seat/month with much higher limits. The lever that moves you off free is bandwidth (the CDN bundle plus model files are weighty).
- **Database.** Neon free tier is enough for <1 GB. $19/month buys you the next tier with multi-branch databases and longer history. Vercel Postgres is comparable. Supabase free tier is more generous than either if you don't need branches.
- **Redis (Upstash).** Free tier covers tens of thousands of requests per day. $0.20 per 100k requests beyond.
- **R2 / object storage.** Cloudflare R2 is ~$15/TB/month with zero egress. AWS S3 is ~$23/TB/month plus egress, which matters once you serve avatars from it. Pick R2 unless you have a strong AWS reason.
- **LLM tokens.** Order of magnitude bigger than infrastructure for any agent that gets used. Anthropic Sonnet at the time of writing is ~$3 per million input tokens and $15 per million output. A typical chat message round trip is 3,000–8,000 tokens. Do the multiplication for your traffic.
- **Solana RPC.** Helius free covers significant usage; $50/month for production tiers.
- **CDP.** No charge for facilitator usage itself; you pay gas on settle (covered by the buyer, not you).
- **Domain.** $10–15/year for a `.com`. Less for `.dev`, more for premium TLDs.

A real small-scale deployment: ~$25/month infrastructure floor + variable LLM tokens. A real medium-scale deployment with 10k visitors/month: ~$200/month infrastructure + likely $500–1500/month in LLM tokens. The infra side scales linearly and predictably; the LLM side scales with engagement and is the lever where pricing decisions actually matter.

---

## Step 16 — Things that will go wrong

In rough order of likelihood:

**The build breaks because Node version drifts.** Confirm `engines.node` in `package.json` matches what Vercel installs. The repo pins to `24.x`; Vercel respects this. If it ever stops, set `NODE_VERSION=24` in your project's env vars (build-time scope).

**A migration runs out of order.** Your `migrations/` directory is the source of truth — if two engineers add migrations on parallel branches, the lexically-earlier one applies first regardless of merge order. The fix: timestamp filenames (`20260514120000_add_x.sql`), don't number them (`002_add_x.sql`).

**The CDN bundle gets stale at edges.** Vercel's edge respects `Cache-Control` headers. Make sure your build emits hashed filenames (`agent-3d.<hash>.js`) and your script tag references the canonical URL that always rewrites to the latest hash. The repo handles this; if you customize the build pipeline, don't break the hashing.

**Cold starts spike.** Some serverless functions hit a cold start every few minutes if traffic is sparse. The fix: a `cron` that hits `/api/healthz` every 5 minutes from a scheduled GitHub Action or an external uptime monitor (Better Uptime, Pingdom, or just a `cron-job.org`-style free service).

**SSL renewal fails.** Vercel renews Let's Encrypt certs automatically. Failures are extremely rare. If you do see a cert error, check the domain still resolves correctly — failures almost always trace back to DNS changes you forgot to make.

**A preview deploy leaks production data.** The preview environment shares a database with production unless you wire it to a separate one. Use Neon's branch databases, or set a different `DATABASE_URL` in the `preview` env scope. The cleanest pattern: preview has its own database, seeded from a sanitized snapshot of production.

---

## What you learned

- The repo's existing `vercel.json` and how its routes map to functions
- The env-vars setup for three environments and the rationale for separating them
- DNS + SSL for a custom subdomain or apex
- A CI workflow that gates merges on type checks, tests, and a smoke test against the preview URL
- Production promotion via merge to `main`, never `vercel --prod` from local
- Analytics, error tracking, and the right alerts to set
- Rollback procedure (one click) and branch protection
- The cost shape so you can budget realistically

## Next steps

- The deeper architectural tour of what's running on the deployment — [self-host-agent-backend](/tutorials/self-host-agent-backend)
- Make sure your embed code points at your domain, not the upstream — [embed-on-website](/tutorials/embed-on-website)
- Add a paid endpoint and route revenue to a wallet you control — [paid-x402-endpoint](/tutorials/paid-x402-endpoint)
- Expose your agent as an MCP server from your domain — [mcp-server-for-your-agent](/tutorials/mcp-server-for-your-agent)
