# Self-Host the Agent Backend

By the end of this tutorial you have a fully independent three.ws stack running on infrastructure you control — your front-end, your serverless functions, your model-provider proxies, your wallet keys. The hosted platform at `three.ws` is the reference deployment, not a dependency. This walkthrough takes you from a clean machine to a production deployment you operate end-to-end.

This is the heaviest tutorial in the Advanced tier. It's worth doing in full if you need data residency, custom compliance, fork-friendly customizations, or simply the freedom to ship a feature without waiting for the upstream maintainers.

> **Note:** the hosted three.ws platform itself moved off Vercel to Google Cloud Run on 2026-07-07 (one container, `server/index.mjs`, deployed with `npm run deploy:gcp`). This tutorial keeps the Vercel path because it's the lowest-friction way to self-host a fork; everything here works the same, and `vercel.json` remains the live route table either way.

**What you'll build:**

- A local development setup running the full stack (front-end + Vercel functions + Cloudflare workers + database)
- A production deployment on Vercel under a custom domain
- Cloudflare workers proxying Anthropic and OpenAI traffic with your own keys
- An `agent-3d.js` embed script served from your CDN, so embeds on third-party sites point at *your* infrastructure
- The full set of environment variables wired correctly across local, preview, and production
- A hardening pass: CORS, rate limiting, secret hygiene, audit logging

**Prerequisites:**

- Node.js **24.x** installed locally (the platform's `engines.node` is `24.x`; older versions miss APIs used by some scripts)
- `git`, `npm`, `gh` (GitHub CLI)
- A GitHub account
- A Vercel account, with `vercel` CLI installed: `npm i -g vercel`
- A Cloudflare account with **Workers** enabled (the free plan is enough to start; bump to Paid before you go over 100k requests/day)
- Anthropic API key (`https://console.anthropic.com`)
- OpenAI API key (`https://platform.openai.com`)
- Coinbase Developer Platform account and API key for the x402 facilitator (`https://portal.cdp.coinbase.com`)
- A Solana RPC endpoint — Helius (`https://www.helius.dev`) or Alchemy work; the public `api.mainnet-beta.solana.com` is too rate-limited for production
- A Postgres database (Vercel Postgres, Neon, or Supabase all work); the schema is in `api/_lib/schema.sql`
- A domain you control (optional for local dev, required for production)
- ~$10 of operational budget for the first month (Vercel free tier is generous; the cost floor is mostly Postgres and Solana RPC)

---

## Step 1 — Understand the moving parts

The platform is intentionally composed of small, independently deployable services. Before you touch the repo, know what you're deploying:

**Front-end (Vite + vanilla JS modules).** A static SPA built into `dist/`. Served as static files from Vercel. No SSR. The viewer, editor, and dashboard all live here. Source under `src/`.

**Serverless functions (Vercel).** Everything under `api/`. Each `.js` file is a Vercel function. These handle: agent CRUD, MCP server endpoint, x402 paid endpoints, ERC-8004 prep/confirm flows, Pump.fun integration, OAuth callbacks, signed-URL avatar storage, etc. The file path is the route — `api/agents.js` becomes `/api/agents`.

**Cloudflare workers (`workers/`).** Edge proxies in front of model providers. The two important ones are:

- A general LLM proxy that fronts Anthropic and OpenAI: rate-limits per agent, redacts logs, and lets you swap keys without redeploying the platform
- A Pump.fun MCP worker that maintains live websocket connections to the Pump.fun program (Vercel functions can't hold long-lived sockets cheaply)

**Database (Postgres).** Stores agents, manifests, accounts, sessions, audit logs, skill access grants, x402 receipts. Schema is checked in.

**Object storage (Cloudflare R2 or S3-compatible).** Stores uploaded GLBs, generated avatars, signed cache artifacts. Configured via `api/_lib/r2.js`.

**SDKs (`sdk/`, `agent-payments-sdk/`, `solana-agent-sdk/`).** Published as npm packages. These are not deployed; they're built and published independently for skill authors to consume.

**Embed bundle (`/agent-3d/<version>/agent-3d.js`, also `/dist-lib/agent-3d.js`).** The `<agent-3d>` custom-element bundle, built by `npm run build:lib` from `src/lib.js` into `dist-lib/` and served from the same deployment. Third-party sites load this script tag and your domain ends up in their `<script src="...">`.

Everything except the database and Cloudflare workers can live on a single Vercel project. The minimum production deployment is: 1 Vercel project, 1 Cloudflare worker, 1 Postgres database, 1 R2 bucket.

---

## Step 2 — Fork and clone

The canonical repository — and the only one to fork — is:

- `https://github.com/nirholas/three.ws`

Fork on GitHub via the CLI:

```bash
gh repo fork nirholas/three.ws --clone=true --remote=true
cd three.ws
```

This drops you into the cloned fork with your remote set to `origin`. Add the upstream so you can pull updates later:

```bash
git remote add upstream https://github.com/nirholas/three.ws
git fetch upstream
```

Now install everything. The workspace includes a couple of npm workspaces and a postinstall script that builds the agent-payments SDK:

```bash
npm ci
```

If `npm ci` fails on a workspace, the most common cause is Node version mismatch. Run `node --version` and confirm it starts with `v24`. If you're on 22 or 23, install Node 24:

```bash
# nvm
nvm install 24 && nvm use 24

# or volta
volta install node@24
```

Then `rm -rf node_modules package-lock.json` and `npm install`.

---

## Step 3 — Provision the database

The Postgres schema is `api/_lib/schema.sql`. Pick a hosted Postgres provider:

**Neon (recommended for first deploy).** Free tier, instant provisioning, branch databases for previews.

```bash
# Create an account at https://neon.tech, create a project, then:
npx neonctl auth
npx neonctl projects create --name three-ws-fork
npx neonctl connection-string --project-id <project-id>
```

Copy the connection string. It looks like `postgresql://user:pass@host/db?sslmode=require`.

**Vercel Postgres.** If you're going production-first, link it directly when you create your Vercel project. Vercel injects `POSTGRES_URL` automatically.

**Supabase.** Works fine; use the "transaction" pooler URL, not the direct URL, to avoid connection limits in serverless.

Once you have a connection string, run the schema:

```bash
psql "$DATABASE_URL" -f api/_lib/schema.sql
```

Confirm the tables exist:

```bash
psql "$DATABASE_URL" -c "\dt"
```

You should see tables like `agents`, `accounts`, `sessions`, `audit_log`, `x402_receipts`, `skill_grants`, etc.

---

## Step 4 — Provision object storage

Avatars and GLB uploads need somewhere to live. Cloudflare R2 is the default — S3-compatible, no egress fees, integrates well with Cloudflare Workers.

```bash
# Install wrangler (the Cloudflare CLI)
npm i -g wrangler
wrangler login

# Create a bucket
wrangler r2 bucket create three-ws-fork-assets

# Generate an S3-compatible API token at:
# https://dash.cloudflare.com → R2 → Manage R2 API Tokens → Create
# Save the Access Key ID, Secret Access Key, and the endpoint URL
```

You'll get an endpoint like `https://<account-id>.r2.cloudflarestorage.com`. Note it — you'll need it in env vars below.

---

## Step 5 — Create your local environment file

Copy `.env.example` to `.env.development`:

```bash
cp .env.example .env.development
```

Open `.env.development` and fill in the values. The file is long; here's the irreducible minimum to get local dev running:

```env
# Front-end
VITE_API_BASE=http://localhost:3000

# Database
DATABASE_URL=postgresql://...

# Object storage
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=three-ws-fork-assets
R2_ACCESS_KEY_ID=<from cloudflare>
R2_SECRET_ACCESS_KEY=<from cloudflare>
R2_PUBLIC_BASE=https://pub-<id>.r2.dev   # the bucket's public hostname

# Model providers (used by the chat function and the worker proxy)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Solana RPC (free public RPC is fine for local; switch in production)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=                       # optional but useful

# x402 facilitator routing
X402_PAY_TO_BASE=0xYourBaseReceiverAddress
X402_ASSET_ADDRESS_BASE=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
X402_MAX_AMOUNT_REQUIRED=1000
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=
X402_CDP_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
X402_FACILITATOR_URL_BASE=https://facilitator.payai.network
X402_FACILITATOR_URL_SOLANA=https://facilitator.payai.network

# Session/CSRF secrets — generate fresh with `openssl rand -hex 32`
SESSION_SECRET=<random hex>
CSRF_SECRET=<random hex>

# Cloudflare worker URLs (set after Step 7)
LLM_WORKER_URL=
PUMPFUN_MCP_WORKER_URL=
```

The exhaustive list of env vars is in `.env.example`. Most are optional — you can leave them empty until you need the feature they unlock. For example, you don't need `HELIUS_API_KEY` to run an agent; you only need it if you're enabling the Pump.fun live feed.

Do **not** commit `.env.development`. It's in `.gitignore` already; double-check with `git status`.

---

## Step 6 — Run it locally

```bash
npm run dev
```

This boots Vite on port 3000 with the API functions proxied through Vercel's local dev (the project uses Vite's dev server alongside Vercel's function emulator via `vercel dev`-style integration baked into the dev script).

In another terminal, sanity-check the API:

```bash
curl http://localhost:3000/api/healthz
```

You should see `{"ok": true}` or similar.

Now open `http://localhost:3000` in a browser. You should land on the platform's home page. Click into the editor — drag any GLB onto it — confirm the avatar loads. Open DevTools → Console. **There should be no red errors.** If there are, the most common causes:

- Database tables missing → re-run the schema in Step 3
- R2 misconfigured → uploads fail with a 500; check the response body
- LLM env vars unset → the chat input shows but messages return 500; set `ANTHROPIC_API_KEY` and reload

If the avatar loads and you can send a chat message that gets a real model response, your local stack is healthy.

---

## Step 7 — Deploy the Cloudflare workers

The LLM proxy worker lives at `workers/` (alongside the strategy executor). The proxy is responsible for:

- Holding the production Anthropic/OpenAI keys server-side
- Rate-limiting per agent (so a runaway agent doesn't bankrupt your provider budget)
- Streaming responses back to the browser
- Stripping or appending headers as required

Configure and deploy:

```bash
cd workers
cp wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml` and fill in your worker name and the secrets bindings. The example file lists the required vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, plus optional Helius keys for the Pump.fun worker.

Set secrets via wrangler (don't put them in `wrangler.toml`):

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
```

Deploy:

```bash
wrangler deploy
```

You'll get a URL like `https://three-ws-llm.<account>.workers.dev`. Put that into your `.env.development` and (later) your Vercel project as `LLM_WORKER_URL`.

If you're running the Pump.fun feed, repeat for `workers/pump-fun-mcp/`.

---

## Step 8 — Build for production

Confirm the production build works before deploying:

```bash
npm run build      # Vite front-end into dist/
npm run build:lib  # <agent-3d> embed bundle into dist-lib/
```

(`npm run build:all` runs both plus the chat sub-app build in one go.)

This builds:

- The Vite front-end into `dist/` (all page entries, plus everything in `public/` — including the artifact viewer at `dist/artifact/`)
- The `<agent-3d>` embed bundle into `dist-lib/agent-3d.js` (ES module; `npm run build:lib:full` adds the UMD build)
- The chat sub-app into `dist/chat/` (via `npm run build:chat`)

Look at `dist/` — there should be an `index.html`, hashed bundles, and the various sub-apps, with the embed bundle in `dist-lib/`. If the build prints warnings about missing env vars (e.g., `VITE_*` vars that the front-end reads at build time), set them before re-running:

```bash
VITE_API_BASE=https://<your-domain>.vercel.app npm run build
```

For preview/staging builds the API base can point at the preview deployment; for production, point it at the final domain.

---

## Step 9 — Create the Vercel project

```bash
vercel login
vercel link        # link your local dir to a new Vercel project
```

When prompted, accept the defaults (the project's `vercel.json` already configures the build and routes correctly).

Now copy your env vars into Vercel. The CLI takes them one at a time or in bulk:

```bash
# One at a time, scoped to production
vercel env add DATABASE_URL production
# (paste the value when prompted)

# Or import all from a file (one VAR=value per line)
cat .env.production | vercel env import production
```

A few env vars that have to be set per-environment:

- `VITE_API_BASE` — must be the public URL of *that* environment (preview, production, etc.)
- `SESSION_SECRET`, `CSRF_SECRET` — use **different secrets per environment**. Don't reuse production secrets in preview.
- `X402_PAY_TO_BASE` — use **different wallets per environment** so you can identify which environment generated which receipt.

Deploy a preview to validate:

```bash
vercel
```

Vercel will print a preview URL. Hit `/api/healthz` on it. Confirm. Then promote to production:

```bash
vercel --prod
```

You now have a production deployment at `https://<project-name>.vercel.app`.

---

## Step 10 — Wire your custom domain

Open the Vercel project → Settings → Domains. Add your domain (e.g., `agent.yourcompany.com`).

Vercel will show DNS instructions: typically a CNAME pointing at `cname.vercel-dns.com`. Add the record in your DNS provider. SSL is issued automatically once DNS resolves.

For the apex domain (e.g., `yourcompany.com`), Vercel needs an A record to its IPs — those are listed in the same dialog.

Within 5–60 minutes the domain resolves and HTTPS works. Test:

```bash
curl -I https://agent.yourcompany.com/api/healthz
```

You should get a 200. If you get a 526 or 525 (SSL handshake errors), DNS hasn't fully propagated yet; wait 10 minutes and retry. If you get a 404, check that the Vercel project's domain settings show your domain as primary.

See [deploy-to-vercel-custom-domain](/tutorials/deploy-to-vercel-custom-domain) for the full DNS/SSL flow including the apex-domain edge cases.

---

## Step 11 — Swap the CDN domain

Up to this point, anyone embedding an agent from your platform is loading the bundle from the platform's own origin. Two facts make the domain swap automatic:

**1. The embed generator derives its URL from the page origin.** The "Copy embed" output is built by `src/editor/publish.js`, which emits `` `${origin}/dist-lib/agent-3d.js` `` from the origin the dashboard is running on. Once your fork is served from `agent.yourcompany.com`, every copied snippet already points at your domain — no build constant to set.

**2. The bundle itself self-locates.** The element derives its API base from the script's own URL (`new URL(import.meta.url).origin`, see `src/element.js:123`), falling back to the page origin, and can be overridden per element with the `api-base` attribute. A third party who pastes your embed on `their-site.com` will have the script fetch agents from *your* domain, not theirs, and you can move infrastructure later without breaking existing embeds.

Verify with a smoke test: create a static HTML file and paste your embed:

```html
<!doctype html>
<html>
  <body>
    <script type="module" src="https://agent.yourcompany.com/dist-lib/agent-3d.js"></script>
    <agent-3d
      agent-id="your-test-agent-id"
      style="width: 360px; height: 480px"
    ></agent-3d>
  </body>
</html>
```

Open it in a browser. The agent should load and chat correctly. Check the Network tab — every request (manifest fetch, model fetch, chat) should hit `agent.yourcompany.com`, not `three.ws`.

---

## Step 12 — Hardening: CORS

`api/_lib/http.js` exposes a `cors()` helper used by every paid route. The default policy is permissive (`Access-Control-Allow-Origin: *`) because the platform is designed to be embedded from anywhere. That's the right call for the public CDN script and for x402 endpoints (anyone with a wallet should be able to pay you).

For **internal** routes that shouldn't be called cross-origin — admin actions, account routes, the dashboard API — tighten CORS to your domain:

```js
import { cors } from '../_lib/http.js';

export default async function handler(req, res) {
  if (cors(req, res, {
    origin: 'https://agent.yourcompany.com',
    methods: 'GET,POST,OPTIONS',
    credentials: true,
  })) return;
  // ... handler
}
```

Audit which routes are sensitive. A simple rule: anything that uses the session cookie (`api/auth/*`, `api/dashboard/*`, account-scoped writes) should restrict CORS to your domain.

---

## Step 13 — Hardening: rate limits

`api/_lib/rate-limit.js` exposes `limits.<bucket>(key)`. Buckets are named (`mcpIp`, `mcpUser`, `chatIp`, etc.) and back into Upstash Redis or a local in-memory fallback.

Set Upstash:

```env
UPSTASH_REDIS_REST_URL=https://<your-instance>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<token>
```

Rate-limit buckets you almost always want on production:

- `chatIp` — the public chat endpoint, throttled by client IP
- `mcpIp` and `mcpUser` — the MCP server (the production code in `api/mcp.js` already calls both)
- A custom bucket for any x402 endpoint, keyed by the payer wallet — see [paid-x402-endpoint](/tutorials/paid-x402-endpoint)

Without Redis, the in-memory fallback works for a single Vercel function instance but doesn't share state across cold starts. It will not protect you against a determined attacker. Set up Upstash before going public.

---

## Step 14 — Hardening: secret hygiene

A few non-negotiables for the env vars you just set:

- **Never commit any of them.** `.env.development`, `.env.preview`, `.env.production` are all gitignored. Confirm with `git check-ignore .env.production`.
- **Rotate on personnel changes.** If anyone with access leaves the project, rotate `SESSION_SECRET`, `CSRF_SECRET`, the LLM keys, and the wallet private keys.
- **Use separate keys per environment.** Don't share `ANTHROPIC_API_KEY` between local dev and production — it makes log attribution impossible and one buggy local script can torch the production rate-limit window.
- **Sweep wallet balances.** `X402_PAY_TO_BASE` receives USDC. Sweep to a cold address daily or set up an automated sweep transaction.
- **CDP keys are sensitive.** Treat them like AWS keys. Coinbase rotates them via the dashboard at any time.

---

## Step 15 — Hardening: audit logging

`api/_lib/audit.js` writes structured records to the `audit_log` table. The platform already writes audit entries for: agent creation, manifest changes, on-chain registrations, x402 payments, skill grants, account-level writes.

In your fork, you'll add audit entries for your own routes:

```js
import { audit } from './_lib/audit.js';

await audit({
  actor: auth.userId,        // or wallet address, or null for unauthenticated
  action: 'custom.action',
  target: targetId,
  meta: { request: summarize(req.body) },
});
```

Hard rule: every mutation to a user-visible record must produce an audit row. The point isn't compliance for its own sake — it's that when something weird happens (a manifest gets corrupted, a wallet drains, an admin role is granted), the audit trail is the only artifact that survives.

Export the audit log to long-term storage if your compliance demands it. The schema is plain Postgres; `pg_dump` works.

---

## Step 16 — Promote-preview workflow

Your deployment now supports three environments:

- **Local** — `npm run dev`, fed by `.env.development`
- **Preview** — every `vercel` deploy (or every PR on the main branch via the Vercel/GitHub integration) generates a preview URL with `.env.preview` values
- **Production** — `vercel --prod` (or merging to `main`) deploys with `.env.production` values

The recommended workflow:

1. Develop locally against `.env.development` and a Neon branch database
2. Open a PR — Vercel auto-deploys a preview with `.env.preview` and a separate Neon preview branch
3. Run smoke tests against the preview (real APIs, real database, real wallets, but isolated from production)
4. Merge to `main` — production deploys automatically

The upstream repo doesn't use GitHub Actions — there's no `.github/workflows/` CI pipeline to inherit. Run the repo's own checks yourself before you promote: `npm run typecheck`, `npm test`, and the `npm run gate` audit bundle. Wire those into whichever CI you prefer on your fork, or run them locally as a pre-promote gate.

---

## Step 17 — Pulling upstream updates

The upstream three.ws repo ships fixes and features regularly. Pull them with:

```bash
git fetch upstream
git checkout main
git merge upstream/main
# resolve conflicts (typically none if you've stayed close to upstream)
npm ci
npm run build      # confirm it still builds
git push origin main
```

Vercel auto-redeploys. New schema migrations (if any) land in `api/_lib/migrations/` — re-run them against your database. The repo uses simple forward-only SQL migrations; check the directory's README for the runner script.

If you've forked aggressively and diverged, you may want to keep your changes in a long-running `your-company/main` branch and merge from `upstream/main` periodically with a clear strategy (e.g., quarterly cadence, with a dedicated "merge upstream" PR).

---

## Step 18 — Operational checklist

Before you point real traffic at your deployment, walk through this list. If any item is unchecked, fix it first.

- All env vars set in production and preview (`vercel env ls`)
- `npm run build` passes locally with production env
- `/api/healthz` returns 200 on the production URL
- A test agent can be created, edited, saved, and embedded
- The LLM proxy worker is deployed and `LLM_WORKER_URL` points to it
- A test chat message gets a real model response in production
- Database schema matches `api/_lib/schema.sql` (run `pg_dump --schema-only` and diff)
- Upstash rate-limiting is wired (or you have a clear plan for when to add it)
- `X402_PAY_TO_BASE` is a wallet you control and the private key is held securely (hardware wallet, KMS, or equivalent — *not* in plaintext anywhere)
- CDP keys are set so x402 settlements route through CDP (otherwise endpoints don't get cataloged in agentic.market)
- Audit logging writes to `audit_log` for at least the core mutations
- A monitoring/alerting service (Vercel's built-in observability is the floor; add Sentry, Better Stack, or Honeycomb for real visibility) is hooked up
- Backup strategy for the database: Neon and Vercel Postgres both do automatic PITR; confirm yours does
- Domain has working HTTPS, all `https://three.ws/...` URLs have been replaced with your domain throughout the front-end, and the CDN bundle correctly self-locates to your domain

---

## Step 19 — What happens when the upstream breaks (and other realities)

A few things you should know going in:

**The upstream is the reference.** When the three.ws hosted platform ships a feature, the source is in the public repo within hours or days. Your fork can adopt it on your schedule. There is no private code path.

**Some upstream features require platform-only secrets.** The hosted three.ws has access to API keys and wallets that aren't published. If you fork, those features (e.g., the platform-managed agent treasury) won't work as-is — you'll either disable them or wire your own equivalents. The code paths that depend on platform secrets are clearly conditional on env-var presence; if your env var is empty, the feature is hidden in the UI.

**You become responsible for security patches.** Vercel handles its own infrastructure. You handle the application code. Subscribe to GitHub Dependabot alerts on your fork. The repo lists Apache-2.0 as its license — you can ship patches yourself, but you should also feed them upstream if they're not specific to your deployment.

**Cost shapes:**

- Vercel: free tier for low traffic; ~$20/month per project once you cross the free limits; bandwidth is the lever
- Neon Postgres: free for the first few GB; $19/month for the next tier
- Cloudflare R2: ~$15/TB/month, no egress fees
- Cloudflare Workers: free for the first 100k requests/day; $5/month + small per-request fees beyond
- LLM tokens: order-of-magnitude bigger than infrastructure. Watch Anthropic/OpenAI bills, not Vercel.
- Solana RPC: Helius free tier covers significant usage; $50/month for the next tier

A self-hosted instance with light traffic runs at $20–50/month all-in. The dominant cost as you grow is LLM tokens.

---

## What you learned

- The component breakdown: front-end, Vercel functions, Cloudflare workers, Postgres, R2, CDN
- How to bring up a development instance with a real database, real model providers, and real wallets
- How to deploy to production on Vercel with your own domain and CDN
- How to swap the CDN base so third-party embeds point at your infrastructure
- The hardening pass: CORS, rate limits, secret hygiene, audit logs
- The promote-preview-production workflow with Vercel + Neon branches
- The operational realities: upstream sync, cost shapes, security patches

## Next steps

- Wire your custom domain end-to-end with CI, SSL, and analytics — [deploy-to-vercel-custom-domain](/tutorials/deploy-to-vercel-custom-domain)
- Swap your LLM provider or add reasoning models — [connect-ai-brain](/tutorials/connect-ai-brain)
- Add a paid x402 endpoint that routes revenue to your own wallet — [paid-x402-endpoint](/tutorials/paid-x402-endpoint)
- Expose your agent as an MCP server for Claude Desktop, Cursor, and other MCP clients — [mcp-server-for-your-agent](/tutorials/mcp-server-for-your-agent)
