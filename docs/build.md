# Build & deploy artifact integrity

How three.ws is built, how the local build maps to what Cloud Run serves, and
the guards that keep what we ship identical to what we wrote. Read this before
touching the build pipeline.

## Commands at a glance

| Command | What it does |
| --- | --- |
| `npm run build` | The app build: `prebuild` lifecycle → `vite build` (`--max-old-space-size=6144`) → `scripts/strip-sw-from-embeds.mjs` → `scripts/inject-tour-boot.mjs`. Output → `dist/`. |
| `npm run deploy:gcp` | The **production deploy**: `check:dist` + `db:check` gates → `gcloud builds submit` (Docker image via `server/cloudbuild.yaml`) → Cloud Run (`three-ws-api`, `us-central1`) → CDN cache purge. Run `npm run build` first so `dist/` is current (see [CI parity](#ci-parity)). |
| `npm run build:vercel` | Legacy full-build orchestrator (`scripts/build-vercel.mjs`) from the Vercel era — runs the gate suite, bundles the API with esbuild, and builds every sub-package. **Not on the Cloud Run deploy path**; kept for full local reproduction (see [the trap](#the-esbuild-overwrite-trap)). |
| `npm run clean` | `rm -rf dist/* dist-lib/*`. |
| `npm run check:dist` | Asserts the published `agent-3d` library bundle + `dist-lib` mirror exist and the version matches `package.json` (`scripts/check-dist.mjs`). |
| `npm run audit:deploy` | Pre-flight for the three 2026-06-11 outage classes: committed symlinks, unsatisfied peer deps, undeclared `api/` imports (`scripts/audit-deploy-artifacts.mjs`). |
| `npm run guard:esbuild` | esbuild-trap guard — blocks committing a bundled `api/*.js` (scans the git index). `:all` sweeps the working tree. |

## CI parity

Production runs on **Google Cloud Run** (service `three-ws-api`, region
`us-central1`), not Vercel — the Vercel deployment was retired 2026-07-07. A
deploy is two steps from the repo root:

```bash
npm run build        # produce dist/ (the front-end Cloud Run serves)
npm run deploy:gcp   # build the image + deploy to Cloud Run
```

`deploy:gcp` runs `check:dist` and `db:check`, then `gcloud builds submit
--config server/cloudbuild.yaml`. Cloud Build builds the root `Dockerfile` on a
32-vCPU machine with BuildKit inline caching (an unchanged `package-lock.json`
skips `npm ci`), pushes the image, deploys it to Cloud Run in one run, and the
`deploy:gcp:purge-cdn` step invalidates the CDN cache. The image copies the
already-built `dist/` and runs `server/index.mjs`, which serves the static
front-end, the `vercel.json` route table, and every `api/**` handler from source
(no per-route bundling). The ~76 scheduled jobs run on **Google Cloud
Scheduler** driven off the `vercel.json` cron list; there is **no GitHub Actions
CI**. Full runbook: [docs/ops/gcp-production.md](./ops/gcp-production.md).

`.npmrc` sets `legacy-peer-deps=true` (npm never auto-installs peers — the
reason `audit:deploy` checks the peer tree), and `engines.node` pins Node
`24.x`, matching the `node:24-slim` base image.

**`npm run build:vercel` is a superset of `npm run build`, kept for full local
reproduction — not the production path.** The app's Vite build is byte-for-byte
the same step in both — `build:vercel`'s `buildApp` phase runs the identical
`vite build && strip-sw-from-embeds && inject-tour-boot` with the same
`NODE_OPTIONS`. `build:vercel` additionally:

1. Front-loads the audit/verify gates (`audit:deploy`, `test:gate`,
   `verify:solana`, `verify:onchain`, `audit:mcp`).
2. Bundles the API with esbuild (`scripts/bundle-api.mjs`) — **the step that
   overwrites `api/*.js` in place** (see [the trap](#the-esbuild-overwrite-trap)).
3. Builds the embeddable library + `avatar-sdk`, then `character-studio` and
   `chat`.

Run it only **in a throwaway worktree** (because of step 2). For day-to-day
front-end iteration, `npm run build` is faithful and safe.

## The esbuild-overwrite trap

`npx vercel build` and `scripts/bundle-api.mjs` both esbuild every API route and
write the bundle back over the source: `esbuild ... --outdir=api
--allow-overwrite`. In an ephemeral CI checkout that is harmless and fast.
**Locally it destroys the hand-written route sources** — and because the Cloud
Run image serves `api/**` from source, a committed bundle ships broken handlers.
If one of those
bundles is `git add`ed and committed, the real source is lost and the repo
balloons by millions of generated lines. This has happened twice
(commits `c94190b3`, `dabd5884` — both reverted).

A bundled file is unmistakable: its opening lines carry esbuild's interop
helpers (`__defProp`, `__commonJS`, `__toESM`, `__esm`) or the `bundle-api`
`createRequire` banner — none of which ever appear at the top of a hand-written
route.

### Guard: `scripts/guard-esbuild-bundles.mjs`

Refuses to commit a bundled `api/*.js`. It scans the **staged blob** (`git show
:path`) — what a commit would actually record, not just the working tree — and
exits non-zero on any bundle.

```bash
npm run guard:esbuild           # scan staged api JS (pre-commit use)
npm run guard:esbuild:all       # sweep every working-tree api/**/*.js
node scripts/guard-esbuild-bundles.mjs --files api/foo.js   # explicit paths
```

Detection logic is unit-tested (`tests/guard-esbuild-bundles.test.js`): it must
catch real esbuild/banner output and must not false-positive on a hand-written
route (verified clean across all 1100+ `api/**/*.js`).

### Wiring it as a pre-commit hook

This repo's `.git/hooks` are managed by **git-lfs** (do not overwrite them). To
add the guard, chain it from a `pre-commit` hook that preserves any existing LFS
behavior:

```sh
# .git/hooks/pre-commit   (chmod +x)
#!/bin/sh
node scripts/guard-esbuild-bundles.mjs || exit 1
# (git-lfs installs its own pre-commit on some setups — call it here if present)
command -v git-lfs >/dev/null 2>&1 && git lfs pre-commit "$@"
```

If you ever stage a bundle by accident, recover the source before committing:

```bash
git restore --staged -- api/ public/   # unstage the bundles
git restore -- api/ public/            # restore source from HEAD
```

### Recognizing it after the fact

```bash
head -1 api/<route>.js   # bundle if it starts with __defProp / createRequire / esbuild
```

## Source-map & secret hygiene

- `dist/`, `dist-lib/`, `dist-artifact/`, `.vercel/`, and every `.env*` file are
  gitignored (`.gitignore`) — build output and secrets never reach git.
- The Vite app build emits **no `.js.map` source maps** into `dist/` (production
  config), so no source is shipped to clients.
- `scripts/audit-deploy-artifacts.mjs` blocks committed symlinks (a file tracer
  can't resolve them) and undeclared `api/` imports (phantom hoisted deps that
  vanish on dedupe).

## Embed integrity

Embed surfaces (`/widget`, `/embed`, `/agent-embed`, `/a-embed`,
`/avatar-embed`, `/agent-token-page`) load inside third-party iframes. They must
**not** register the service worker — an SW registered from an iframe is scoped
to `https://three.ws/` and would intercept every other tab on the origin.

`scripts/strip-sw-from-embeds.mjs` runs as the last step of `npm run build` and
removes the VitePWA `register-sw` `<script>` from each embed HTML in `dist/`. It
is idempotent and fails loudly if no embed HTML is found. Verify with:

```bash
grep -l 'vite-plugin-pwa:register-sw' dist/widget.html dist/embed.html   # expect: no matches
```
