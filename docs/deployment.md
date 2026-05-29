# Deployment & Self-Hosting

This guide covers everything you need to run your own instance of three.ws — from a one-click Vercel deploy to a fully self-hosted setup on any Node.js infrastructure.

---

## Platform overview

three.ws is a full-stack platform. A complete deployment has six moving parts:

| Layer | What it does | Recommended provider |
|---|---|---|
| **Frontend** | Vite-built multi-page SPA (static files) | Vercel / any CDN |
| **API routes** | Node.js serverless functions in `/api/` | Vercel / any Node.js host |
| **Database** | PostgreSQL — agents, users, widgets, keys | [Neon](https://neon.tech) (serverless Postgres) |
| **Rate limiting / cache** | Per-IP and per-user rate limits, session caching | [Upstash Redis](https://upstash.com) |
| **Object storage** | GLB files, generated thumbnails | Cloudflare R2 (recommended) or AWS S3 |
| **IPFS** (optional) | Decentralized asset pinning for on-chain registration | [Pinata](https://pinata.cloud) or Web3.Storage |

None of the optional layers (Redis, IPFS, blockchain relayer) are required to run a working instance. The platform degrades gracefully — Redis missing means in-process rate limiting per serverless instance; IPFS missing means on-chain registration is unavailable; the relayer missing means ERC-7710 delegation redemption is disabled.

---

## Quickest path: one-click Vercel deploy

The fastest route from zero to running:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/nirholas/three.ws)

1. Click the button → connect your GitHub account → Vercel forks the repo to your account.
2. Fill in the environment variables (see the [Required environment variables](#required-environment-variables) section below).
3. Click **Deploy**. The build takes about 3 minutes.
4. After deploy: add your custom domain, configure DNS, point your database.

That's it. You'll have a live instance at `https://your-project.vercel.app`.

---

## Required environment variables

Copy [`.env.example`](../.env.example) to `.env.local` for local work, and add the same variables to your Vercel project under **Settings → Environment Variables** (both Preview and Production environments).

```bash
cp .env.example .env.local
```

### Core (required)

```env
# Public origin — no trailing slash
PUBLIC_APP_ORIGIN=https://yourdomain.com

# PostgreSQL (Neon serverless — HTTPS connection string)
DATABASE_URL=postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require

# JWT signing key — also used (via HKDF) to derive the AES-256-GCM key that
# encrypts agent wallet private keys. Rotate by appending a new kid, never
# by removing the old one mid-rotation.
# Generate: openssl rand -base64 64
JWT_SECRET=
JWT_KID=k1

# Password hashing cost (bcryptjs rounds — 11 is a good default)
PASSWORD_ROUNDS=11
```

### LLM (required for agent conversations)

```env
ANTHROPIC_API_KEY=sk-ant-xxxxx
# Optional overrides
CHAT_MODEL=claude-sonnet-4-6
CHAT_MAX_TOKENS=1024
```

Without `ANTHROPIC_API_KEY`, the chat API falls back to client-side pattern matching — agents still respond, but without the full LLM backend.

### Object storage (required for GLB/asset uploads)

three.ws uses an S3-compatible interface. Cloudflare R2 is recommended because it has zero egress fees — even a viral spike only costs you storage and requests.

```env
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=3d-agent-avatars
# Public CDN base URL for the bucket (custom domain or provider default)
S3_PUBLIC_DOMAIN=https://cdn.yourdomain.com
```

For AWS S3, leave `S3_ENDPOINT` empty (the SDK defaults to `s3.amazonaws.com`) and set `S3_BUCKET` to your bucket name.

For Cloudflare R2: get your account ID and generate R2 API tokens from the Cloudflare dashboard. Set `S3_ENDPOINT` to `https://<account-id>.r2.cloudflarestorage.com`.

### Rate limiting (recommended)

```env
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxx
```

Without Redis, rate limits run in-memory per serverless instance. This is fine for low traffic; for production, use Upstash so limits are enforced consistently across all instances.

### Avatar creation

```env
# Avatar builder — origin where the in-browser avatar builder iframe is hosted.
# Defaults to http://localhost:5173 in dev. Production deployments should host the
# character-studio/ workspace (it is a separate Vite/React app) and point this env
# var at its origin. Same export contract, same humanoid rig, open-source
# and self-hostable.
VITE_CHARACTER_STUDIO_URL=https://studio.three.ws

# Photo-to-avatar pipeline
# Get key at https://avaturn.me/developer
AVATURN_API_KEY=
AVATURN_API_URL=https://api.avaturn.me
VITE_AVATURN_EDITOR_URL=https://editor.avaturn.me/
VITE_AVATURN_DEVELOPER_ID=
```

### Wallet auth (required for on-chain features)

```env
# Privy — social + wallet login (get from https://dashboard.privy.io)
VITE_PRIVY_APP_ID=   # client-side
PRIVY_APP_ID=        # server-side (for verifying identity tokens)
```

### ERC-7710 delegation relayer (optional)

```env
# Enable the server-side relayer that pays gas for redeemDelegations
PERMISSIONS_RELAYER_ENABLED=false

# Hex private key of the relayer EOA — NOT the user's key
# Generate: node -e "const {Wallet} = require('ethers'); const w = Wallet.createRandom(); console.log(w.privateKey, w.address)"
AGENT_RELAYER_KEY=0x...
AGENT_RELAYER_ADDRESS=0x...   # checksummed address derived from AGENT_RELAYER_KEY

# Per-chain RPC URLs (override public RPCs with Alchemy/Infura for production)
RPC_URL_84532=https://sepolia.base.org      # Base Sepolia
RPC_URL_11155111=https://rpc.sepolia.org    # Ethereum Sepolia
```

### IPFS pinning (optional)

Required only if you want on-chain ERC-8004 registration (which pins the agent manifest to IPFS before writing to the registry).

```env
# Pinata (preferred) — get JWT from https://app.pinata.cloud/keys
PINATA_JWT=

# Web3.Storage (fallback)
WEB3_STORAGE_TOKEN=
```

---

## Database setup

### 1. Create a Neon project

1. Go to [neon.tech](https://neon.tech) → **New Project**
2. Choose a region close to your Vercel deployment
3. Copy the connection string — it looks like `postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`
4. Set it as `DATABASE_URL` in your env

The free tier handles early traffic comfortably. When you scale, switch to the pooled connection string (append `?pgbouncer=true` or use the pooled endpoint in the Neon dashboard) to handle many concurrent serverless connections.

### 2. Apply the schema

Three migration scripts apply the schema. All are idempotent — safe to re-run if something fails mid-way.

```bash
# Core schema — agents, users, widgets, API keys, sessions, usage events
node scripts/apply-schema.mjs

# ERC-8004 indexer state — tracks on-chain crawl progress
node scripts/apply-indexer-schema.js

# ERC-7710 delegation tables — permission grants and redemptions
node scripts/apply-delegations-schema.js
```

Each script reads `DATABASE_URL` from `.env.local` then `.env` then the process environment. If you get a connection error, verify the URL includes `?sslmode=require` — Neon requires SSL.

### Schema overview

| Table | Purpose |
|---|---|
| `agents` | Agent metadata, manifest CID, owner wallet address |
| `widgets` | Widget configs, visibility settings, embed URLs |
| `users` | User accounts, wallet addresses, hashed passwords |
| `api_keys` | SHA-256 hashed API keys with scopes |
| `agent_actions` | Per-agent activity log (every tool call) |
| `usage_events` | All tool calls — feed your analytics dashboards |
| `plan_quotas` | Per-plan daily caps for rate limiting |
| `sessions` | Active sessions (refresh tokens stored hashed) |
| `indexer_state` | ERC-8004 on-chain crawl progress per chain |
| `agent_delegations` | ERC-7710 permission grants |

---

## S3-compatible storage setup

three.ws stores GLB model files and generated thumbnails in your S3 bucket. The API uses the `@aws-sdk/client-s3` package, which works with any S3-compatible endpoint.

### Cloudflare R2 (recommended)

```bash
# 1. Create an R2 bucket in the Cloudflare dashboard
# Dashboard → R2 → Create bucket → name it (e.g. "3d-agent-avatars")

# 2. Generate R2 API credentials
# Dashboard → R2 → Manage R2 API Tokens → Create API token
# Permission: Object Read & Write on your bucket

# 3. Apply the CORS policy
aws s3api put-bucket-cors \
  --bucket 3d-agent-avatars \
  --cors-configuration file://cors.json \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

R2 is S3-compatible — the same SDK, different endpoint. Set `S3_ENDPOINT` to your R2 account endpoint and the rest works identically to AWS.

For public serving: configure a custom domain on your R2 bucket (Cloudflare dashboard → R2 → your bucket → Settings → Custom Domains). Set that as `S3_PUBLIC_DOMAIN`. Zero egress, globally cached.

### AWS S3

```bash
# Create bucket
aws s3 mb s3://your-bucket-name --region us-east-1

# Apply CORS policy (required so browsers can load GLBs cross-origin)
aws s3api put-bucket-cors \
  --bucket your-bucket-name \
  --cors-configuration file://cors.json
```

The `cors.json` at the repo root has the required policy. It allows GET requests from your production domain, localhost, and any partner embed domains you add.

To add an embed origin: add it to the `origin` array in `cors.json` and redeploy.

---

## Redis setup

[Upstash](https://upstash.com) offers a free-tier serverless Redis with an HTTPS REST API — no connection pooling issues with serverless functions.

```bash
# 1. Create a Redis database at https://upstash.com
# 2. Choose the same region as your Vercel deployment
# 3. Copy the REST URL and REST token to your env vars
```

Redis is used for:
- **Rate limiting** — per-IP and per-user limits enforced consistently across instances
- **Session caching** — reduces database round-trips for auth checks
- **IPFS pin status** — caches pin results to avoid redundant API calls

Without Redis the platform still works — rate limits run in-memory per serverless instance (adequate for low traffic, inconsistent across scale-outs).

---

## Local development

### Minimum requirements

- Node.js 24.x
- A browser with WebGL 2.0 (Chrome, Firefox, or Edge 90+)
- A Neon database (or any Postgres instance) for the API routes

### Setup

```bash
git clone https://github.com/nirholas/three.ws.git
cd 3d-agent
npm install

# Copy and fill in env vars
cp .env.example .env.local
# Edit .env.local — minimum: DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY

# Apply the schema
node scripts/apply-schema.mjs

# Start the dev server
npm run dev
# App: http://localhost:3000
# API routes: http://localhost:3000/api/*
```

The dev server runs on **port 3000** with Vite HMR. Changes to any source file reflect instantly without a full reload.

### Available scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with HMR on port 3000 |
| `npm run build` | Production build to `dist/` |
| `npm run clean` | Remove `dist/` |
| `npm run deploy` | Build + `vercel --prod` |
| `npm run verify` | Prettier check (exits 1 if formatting drift) |
| `npm run format` | Auto-format all files with Prettier |
| `npm run test` | Run test suite (`test/gen_test.js`) |

---

## Production build

```bash
# Build the full app (SPA + API routes)
npm run build
# Output: dist/

# Build the embeddable web component (CDN-distributable)
TARGET=lib npm run build
# Output: dist-lib/
```

The Vite config handles multi-page routing, asset hashing, and the PWA manifest. Every JS file in `dist/assets/` is content-hashed, so you can serve them with long cache headers safely — Vercel does this automatically (`max-age=604800`).

---

## Vercel configuration

The `vercel.json` at the root configures routing, headers, and background cron jobs.

### Key rewrites

```
/agent/:id/edit      → /agent-edit.html
/agent/:id/embed     → /agent-embed.html   (frame-ancestors: * header)
/agent/:id           → /agent-home.html
/dashboard           → /dashboard/index.html
/w/:id               → widget page (server-side)
/a/:chainId/:id      → on-chain agent page
```

The embed routes explicitly set `frame-ancestors *` so the embed iframe can be hosted on any domain. Other routes omit this header (defaulting to same-origin framing only).

### Background cron jobs

Vercel runs four cron jobs automatically once deployed:

| Cron | Schedule | Purpose |
|---|---|---|
| `/api/cron/erc8004-crawl` | Every 15 min | Index new on-chain agent registrations |
| `/api/cron/index-delegations` | Every 5 min | Index ERC-7710 delegation events |
| `/api/cron/run-dca` | Every hour | Execute scheduled DCA strategies |
| `/api/cron/run-subscriptions` | Every hour | Process recurring subscriptions |

Crons only run in production deployments (not preview). No action needed — Vercel picks them up automatically from `vercel.json`.

### Static asset caching

Assets under `/assets/*` are served with a 7-day cache header. Versioned CDN bundles under `/agent-3d/x.y.z/*` are served with a 1-year immutable cache. Both are configured in `vercel.json` route headers.

---

## Custom domain + HTTPS

On Vercel: **Settings → Domains → Add Domain**.

HTTPS is provisioned automatically via Let's Encrypt — no action needed.

After adding your domain:

1. Configure DNS:
   - **A record:** `76.76.21.21`
   - **CNAME:** `cname.vercel-dns.com`
2. Update `PUBLIC_APP_ORIGIN` in your environment variables to your domain (no trailing slash)
3. Update `cors.json` to include your domain in the allowed origins array
4. Redeploy for the CORS change to take effect

---

## Deploying the smart contracts

> **You probably don't need to do this.** The canonical ERC-8004 registry contracts are already deployed at the same addresses on every major EVM chain. The platform is pre-configured to use them.
>
> - IdentityRegistry (mainnet): `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
> - IdentityRegistry (testnet): `0x8004A818BFB912233c491871b3d84c89A494BD9e`
>
> Only deploy your own if you need a private registry, are auditing the contracts, or are running an isolated test environment.

### Deploy a private registry

```bash
cd contracts

# Install Foundry if not already installed
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Configure env
cp .env.example .env
# Fill in DEPLOYER_PK and BASESCAN_API_KEY

# Build and test
forge build
forge test -vv   # 25 tests across three contracts

# Dry run first
forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org

# Deploy + verify on Base Sepolia
source .env
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PK \
  --broadcast \
  --verify
```

After deploy, copy the three contract addresses printed in the console output into `src/erc8004/abi.js` under the `REGISTRY_DEPLOYMENTS[84532]` entry.

To allow-list a validator address on your ValidationRegistry:

```bash
cast send $VALIDATION_REGISTRY \
  "addValidator(address)" $VALIDATOR_ADDR \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PK
```

---

## Self-hosting on other infrastructure

Vercel is not required. Any Node.js host that can serve static files and run serverless/edge functions works.

### With Nginx (static files only)

If you only need the 3D viewer without agent features or API routes:

```bash
npm run build
# Serve dist/ with any static file server
```

```nginx
server {
    listen 80;
    server_name 3d.yourdomain.com;
    root /var/www/3d-agent/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /assets/ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    add_header Access-Control-Allow-Origin "*";
    add_header Access-Control-Allow-Methods "GET";
}
```

### With Docker

```dockerfile
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

```bash
docker build -t 3d-agent .
docker run -p 8080:80 3d-agent
```

For the full backend (API routes, database, crons) on non-Vercel infrastructure, deploy the functions under `/api/` as a Node.js server. Each file in `/api/` exports a default function compatible with the Vercel Functions signature — any adapter (e.g. `@vercel/node` locally, or a thin Express wrapper) works.

---

## Monitoring and observability

### Vercel built-ins

- **Analytics:** enable in the Vercel dashboard under **Settings → Analytics**
- **Logs:** `vercel logs --prod` or the dashboard log viewer
- **Function duration:** visible per-invocation in the dashboard; serverless functions have a 10-second default timeout (configurable in `vercel.json`)

### Database monitoring

Neon's dashboard has query monitoring, connection graphs, and slow query logs. For production, watch the `usage_events` table — every tool call writes a row, so you can build dashboards directly in SQL or stream to your analytics stack.

### Error tracking

Add Sentry by setting `SENTRY_DSN` in your environment and importing the Sentry SDK in your API entrypoints. No changes to `vercel.json` needed.

### Key rotation

`JWT_SECRET` signs all session tokens. Rotate it by:

1. Adding a new `JWT_KID` and corresponding `JWT_SECRET` in Vercel environment variables
2. Waiting for existing tokens to expire (default session duration)
3. Removing the old key

Never remove the old key while tokens signed with it are still live — users will be silently logged out.

---

## PWA configuration

The app ships as a Progressive Web App. The service worker caches static assets (fonts, images, the model-viewer JS) and recently viewed GLB files so the viewer works offline.

The PWA manifest is generated by `vite-plugin-pwa`. Icons are generated from the source SVG by:

```bash
node scripts/generate-pwa-icons.mjs
```

Re-run this script if you change the app icon.

---

## Smoke test checklist

After deploying, run through these checks to verify the instance is healthy:

| Flow | Check |
|---|---|
| Viewer | Load the app and drag-drop a GLB file |
| Wallet sign-in | Connect MetaMask — SIWE challenge + verify |
| Avatar creation | Navigate to `/create` — avatar builder iframe loads |
| Agent page | Visit `/agent/:id` — 3D viewer with chat overlay |
| Embed | Check `/agent/:id/embed` loads without auth, can be iframed |
| Dashboard | Navigate to `/dashboard` — shows your agents |
| API health | `GET /api/agents` returns JSON (may be empty array) |
| Auth metadata | `GET /.well-known/oauth-authorization-server` returns valid JSON |
| MCP endpoint | `POST /api/mcp` with `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` and a bearer API key |

A full automated smoke test report is in `docs/SMOKE_TEST.md`.

---

## Troubleshooting

### Build fails with "out of memory"

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

### GLB doesn't load (CORS error)

The model URL must either be on the same domain as the app, or the hosting server must include `Access-Control-Allow-Origin` headers. If the model is in your S3 bucket, verify the CORS policy was applied with `aws s3api get-bucket-cors --bucket your-bucket-name`.

### Blank page after deploy

Verify the `vercel.json` routing. The catch-all `{ "src": "/(.*)", "dest": "/$1" }` at the bottom must exist and the more-specific routes above it must match your build output.

### Schema apply fails

Check that `DATABASE_URL` includes `?sslmode=require` — Neon rejects connections without SSL. Also confirm the Neon project is in the active (not suspended) state.

### Cron jobs not running

Crons only fire in **production** deployments, not previews. Verify you deployed with `vercel --prod` or triggered a production deploy from the dashboard.

### Redis connection errors

Upstash REST API uses HTTPS — no ports to open. If you see connection errors, verify `UPSTASH_REDIS_REST_URL` starts with `https://` and the token is correct. Rate limiting falls back to in-memory if Redis is unreachable (it will not crash the API).
