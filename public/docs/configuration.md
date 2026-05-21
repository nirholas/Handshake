# Configuration Reference

three.ws is configured through a combination of environment variables and a handful of configuration files. This document is a complete reference for self-hosters and developers setting up a local development environment.

**Configuration files at a glance:**

| File | Purpose |
|---|---|
| `.env.local` | Local development secrets and API keys |
| `vercel.json` | Routing, cron jobs, and response headers |
| `vite.config.js` | Build targets and dev server rewrites |
| `cors.json` | CORS policy applied to your S3/R2 bucket |
| `.mcp.json` | MCP server connection for Claude Code integration |

---

## Environment Variables

Copy `.env.example` to `.env.local` for local development. In production, set these in the Vercel dashboard under **Settings → Environment Variables** for both Preview and Production environments.

```bash
cp .env.example .env.local
```

---

### Core

#### `PUBLIC_APP_ORIGIN`
**Required.** The canonical origin of your deployment — no trailing slash.

```
PUBLIC_APP_ORIGIN=https://yourdomain.com
```

Used to construct absolute URLs in API responses and OAuth metadata. Must match your production domain exactly.

#### `DATABASE_URL`
**Required.** PostgreSQL connection string using Neon's serverless HTTPS driver.

```
DATABASE_URL=postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

Get from: [Neon](https://neon.tech) (free tier works for development), Supabase, or any PostgreSQL host. Always include `?sslmode=require` in production.

After setting this, apply the schema:

```bash
psql "$DATABASE_URL" -f api/_lib/schema.sql
```

The migration is idempotent — safe to re-run.

#### `JWT_SECRET`
**Required.** Long random secret used for two purposes: signing session JWTs and (via HKDF) deriving the AES-256-GCM key that encrypts agent wallet private keys.

```
JWT_SECRET=<base64 string>
```

Generate with:

```bash
openssl rand -base64 64
```

**Rotation:** add a new key ID (`JWT_KID`), wait for old tokens to expire, then remove the old value. Never remove the active signing key mid-rotation.

#### `JWT_KID`
**Optional.** Active key identifier for future key rotation. Defaults to `k1`.

```
JWT_KID=k1
```

#### `PASSWORD_ROUNDS`
**Optional.** bcryptjs cost factor for password hashing. Defaults to `11`.

```
PASSWORD_ROUNDS=11
```

Higher values increase security at the cost of login latency. 11 is a reasonable default for modern hardware.

---

### LLM

#### `ANTHROPIC_API_KEY`
**Required for agent conversations.** If unset, the `/api/chat` endpoint falls back to client-side pattern matching (limited functionality).

```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
```

Get from [console.anthropic.com](https://console.anthropic.com).

#### `CHAT_MODEL`
**Optional.** Override the Claude model used for agent chat. Defaults to `claude-sonnet-4-6`.

```
CHAT_MODEL=claude-sonnet-4-6
```

#### `CHAT_MAX_TOKENS`
**Optional.** Cap on tokens per chat response. Defaults to `1024`.

```
CHAT_MAX_TOKENS=1024
```

---

### Storage (S3-Compatible)

All four S3 variables are required to enable GLB file and thumbnail uploads. The service is S3-compatible and works with AWS S3, Cloudflare R2, Backblaze B2, and MinIO.

#### `S3_ENDPOINT`
**Required for non-AWS providers.** Full URL of the S3-compatible endpoint.

```
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

Leave blank for standard AWS S3.

#### `S3_ACCESS_KEY_ID`
**Required.** Access key for your S3-compatible bucket.

```
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
```

#### `S3_SECRET_ACCESS_KEY`
**Required.** Secret key for your S3-compatible bucket.

```
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

#### `S3_BUCKET`
**Required.** Bucket name where avatars and assets are stored.

```
S3_BUCKET=3d-agent-avatars
```

#### `S3_PUBLIC_DOMAIN`
**Required.** Public CDN base URL for the bucket. Used to construct asset URLs in API responses.

```
S3_PUBLIC_DOMAIN=https://cdn.yourdomain.com
```

Use a custom domain for zero-egress delivery (Cloudflare R2 charges no egress on custom domains).

After setting up the bucket, apply the CORS policy — see the [`cors.json` section](#corsjson) below.

---

### Cache and Rate Limiting

#### `UPSTASH_REDIS_REST_URL`
#### `UPSTASH_REDIS_REST_TOKEN`
**Recommended for production.** Upstash Redis for distributed rate limiting across serverless function instances.

```
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxxxx
```

Get from [upstash.com](https://upstash.com). Without Redis, rate limiting falls back to per-instance in-memory state — ineffective in a multi-instance serverless environment and a security risk in production.

---

### Authentication

#### `VITE_PRIVY_APP_ID`
#### `PRIVY_APP_ID`
**Optional.** Privy app ID for social/email login. Two variables are needed: `VITE_PRIVY_APP_ID` is used client-side (embedded in the built JS), and `PRIVY_APP_ID` is used server-side to verify identity tokens in `/api/auth/privy/verify`.

```
VITE_PRIVY_APP_ID=clxxxxxxxx
PRIVY_APP_ID=clxxxxxxxx
```

Both should be the same value. Get from [dashboard.privy.io](https://dashboard.privy.io).

---

### Avatar Pipeline

#### `VITE_CHARACTER_STUDIO_URL`
**Optional.** Origin where the Character Studio in-browser avatar builder is hosted. Defaults to `http://localhost:5173` in dev and `https://studio.three.ws` in production.

```
VITE_CHARACTER_STUDIO_URL=https://studio.three.ws
```

Character Studio is an open-source 3D avatar editor (full body customisation — hair, clothing, accessories, skin tone, proportions). It runs as a separate Vite/React app under `character-studio/` in this monorepo and posts the exported GLB back to the parent via `postMessage`. It is fully compatible with the three.ws avatar runtime — same humanoid skeleton naming, ARKit `viseme_*` blendshapes, and Mixamo animation support.

#### `AVATURN_API_KEY`
**Optional.** API key for the Avaturn photo-to-avatar pipeline. Used server-side by `/api/onboarding/avaturn-session` to exchange selfie photos for a session URL.

```
AVATURN_API_KEY=xxxxx
```

Sign up at [avaturn.me/developer](https://avaturn.me/developer).

#### `AVATURN_API_URL`
**Optional.** Override for self-hosted or staging Avaturn deployments. Defaults to `https://api.avaturn.me`.

```
AVATURN_API_URL=https://api.avaturn.me
```

#### `VITE_AVATURN_EDITOR_URL`
**Optional.** URL for the hosted Avaturn editor (no photos required, opened by the "Use default avatar" card at `/create`).

```
VITE_AVATURN_EDITOR_URL=https://editor.avaturn.me/
```

#### `VITE_AVATURN_DEVELOPER_ID`
**Optional.** Developer ID appended as a query parameter to the Avaturn editor URL.

```
VITE_AVATURN_DEVELOPER_ID=xxxxx
```

#### `AVATAR_REGEN_PROVIDER`
**Optional.** Provider for avatar regeneration. Set to `stub` for testing. Defaults to `none` (API returns `501 regen_unconfigured`).

```
AVATAR_REGEN_PROVIDER=none
```

---

### Blockchain and Permissions

#### `PERMISSIONS_RELAYER_ENABLED`
**Optional.** Enables the server-side ERC-7710 delegation relayer endpoint (`POST /api/permissions/redeem`). Defaults to `false`.

```
PERMISSIONS_RELAYER_ENABLED=false
```

#### `AGENT_RELAYER_KEY`
**Conditional.** Hex private key of the relayer EOA that pays gas for `redeemDelegations`. Required when `PERMISSIONS_RELAYER_ENABLED=true`. This is the server's relayer key, not a user key.

```
AGENT_RELAYER_KEY=0x...
```

Generate a fresh wallet:

```bash
node -e "const {Wallet} = require('ethers'); const w = Wallet.createRandom(); console.log(w.privateKey, w.address)"
```

Never commit a real value. Rotate via Vercel environment variables.

#### `AGENT_RELAYER_ADDRESS`
**Conditional.** EIP-55 checksummed address derived from `AGENT_RELAYER_KEY`. Fund with testnet ETH before enabling the relayer.

```
AGENT_RELAYER_ADDRESS=0x...
```

#### `RPC_URL_<CHAINID>`
**Optional.** Per-chain RPC URL overrides. Pattern: `RPC_URL_` followed by the chain ID. Defaults to public RPC endpoints, which are less reliable under load.

```
RPC_URL_84532=https://sepolia.base.org        # Base Sepolia
RPC_URL_11155111=https://rpc.sepolia.org      # Ethereum Sepolia
```

Use Alchemy or Infura URLs in production for reliable RPC access.

---

### IPFS Pinning

At least one pinning provider is needed to enable on-chain avatar registration via IPFS.

#### `PINATA_JWT`
**Optional (preferred).** JWT for IPFS pinning via Pinata.

```
PINATA_JWT=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Get from [app.pinata.cloud/keys](https://app.pinata.cloud/keys).

#### `WEB3_STORAGE_TOKEN`
**Optional (fallback).** Token for IPFS pinning via Web3.Storage (legacy v1 API).

```
WEB3_STORAGE_TOKEN=xxxxx
```

---

### Minimum Local Development Configuration

The smallest `.env.local` that runs the dev server with core features:

```env
PUBLIC_APP_ORIGIN=http://localhost:5173
DATABASE_URL=postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
JWT_SECRET=<output of: openssl rand -base64 64>
ANTHROPIC_API_KEY=sk-ant-...
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=3d-agent-avatars
S3_PUBLIC_DOMAIN=https://cdn.yourdomain.com
```

Avatar creation, blockchain features, and IPFS are all optional for local development.

---

## `vercel.json`

Controls routing and cron jobs for the Vercel deployment. The `routes` array maps incoming URL patterns to destination files or API handlers.

**Key route patterns:**

```json
{ "src": "/agent/([^/]+)/edit",  "dest": "/agent-edit.html" }
{ "src": "/agent/([^/]+)/embed", "dest": "/agent-embed.html" }
{ "src": "/agent/([^/]+)",       "dest": "/agent-home.html" }
{ "src": "/a/(\\d+)/(\\d+)",    "dest": "/api/a-page?chain=$1&id=$2" }
{ "src": "/dashboard",           "dest": "/dashboard/index.html" }
{ "src": "/studio",              "dest": "/studio/index.html" }
```

**Embed routes** include security headers that allow cross-origin iframe embedding:

```json
{
  "src": "/agent/([^/]+)/embed",
  "headers": {
    "content-security-policy": "frame-ancestors *",
    "permissions-policy": "microphone=(self), camera=(self), xr-spatial-tracking=*"
  },
  "dest": "/agent-embed.html"
}
```

**Versioned CDN routes** for the web component library serve immutable assets with long cache TTLs:

```json
{
  "src": "/agent-3d/([0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?)/(.*)",
  "headers": { "cache-control": "public, max-age=31536000, immutable" },
  "dest": "/agent-3d/$1/$2"
}
```

**Cron jobs** run on a schedule via Vercel's cron infrastructure:

```json
"crons": [
  { "path": "/api/cron/erc8004-crawl",      "schedule": "*/15 * * * *" },
  { "path": "/api/cron/index-delegations",  "schedule": "*/5 * * * *" },
  { "path": "/api/cron/run-dca",            "schedule": "0 * * * *" },
  { "path": "/api/cron/run-subscriptions",  "schedule": "0 * * * *" }
]
```

These only run in the Vercel production environment, not locally.

---

## `vite.config.js`

The build is controlled by the `TARGET` environment variable:

| Command | `TARGET` | Output | Description |
|---|---|---|---|
| `npm run build` | `app` (default) | `dist/` | Full multi-page SPA |
| `npm run build:lib` | `lib` | `dist-lib/` | Self-contained web component for CDN |
| `npm run build:all` | both | both | Builds app and lib sequentially |

**App build** (`TARGET=app`) emits multiple HTML entry points for the SPA:

- `index.html` — marketing/landing
- `app.html` — agent creator
- `agent-home.html`, `agent-edit.html`, `agent-embed.html` — agent pages
- `dashboard/index.html` — user dashboard
- `studio/index.html` — widget studio

**Library build** (`TARGET=lib`) emits a self-contained ES module and UMD bundle:

```
dist-lib/agent-3d.js       # ES module
dist-lib/agent-3d.umd.cjs  # UMD (CommonJS-compatible)
```

Three.js and ethers are bundled (not externalized) so the web component works as a zero-install drop-in embed via `<script type="module">`.

**VitePWA** generates a service worker for the app build. Assets matching `**/*.{js,css,ico,png,svg,woff2}` are precached. Google Fonts are cached with a `CacheFirst` strategy and a 1-year TTL.

The dev server includes a rewrite middleware that mirrors the `vercel.json` route patterns, so `http://localhost:5173/agent/my-agent/edit` works the same as in production.

---

## `cors.json`

This file defines the CORS policy for your S3-compatible storage bucket — it is **not** applied to the API server. Apply it to your bucket using the AWS CLI (or equivalent):

```bash
aws s3api put-bucket-cors \
  --bucket 3d-agent-avatars \
  --cors-configuration file://cors.json \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

The default `cors.json` restricts GET requests to a specific list of origins:

```json
[
  {
    "method": ["GET"],
    "origin": [
      "https://three.ws/",
      "http://localhost:*",
      "https://localhost:*"
    ],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
```

**Add your own domain** to the `origin` array before applying. At minimum, `claude.ai` must be included if you want the MCP `render_avatar` tool to fetch GLBs from your bucket inside Claude.

For a fully open public platform where any site can embed agent viewers, set `"origin": ["*"]`.

---

## `.mcp.json`

Configures the MCP server connection for Claude Code integration. Claude Code auto-discovers this file from the project root.

The production configuration points to the hosted MCP endpoint and authenticates with a bearer API key:

```json
{
  "mcpServers": {
    "3d-agent": {
      "url": "https://three.ws/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}
```

Replace the `Authorization` value with an API key from your dashboard. For local development, point `url` at `http://localhost:5173/api/mcp`.

**Never commit a real API key** in this file. Add `.mcp.json` to `.gitignore` or use a development-only key with limited permissions.

---

## Production Checklist

Before going live, verify the following:

- [ ] `JWT_SECRET` is generated with `openssl rand -base64 64` (never a short or guessable string)
- [ ] `DATABASE_URL` includes `?sslmode=require`
- [ ] `PUBLIC_APP_ORIGIN` is set to your production domain (no trailing slash)
- [ ] Upstash Redis is configured — rate limiting is per-instance in-memory without it
- [ ] S3 bucket CORS policy is applied with your production domain in the `origin` list
- [ ] All environment variables are set in Vercel for **Production** (not just Preview)
- [ ] `AGENT_RELAYER_KEY` is set via Vercel env vars, not committed to git
- [ ] `.mcp.json` does not contain a real API key if checked into git
- [ ] `JWT_KID` is set so key rotation can be performed without invalidating all sessions
