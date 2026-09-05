# Build & deploy artifact integrity

How three.ws is built, how the local build maps to what Cloud Run serves, and
the guards that keep what we ship identical to what we wrote. Read this before
touching the build pipeline.

## Commands at a glance

| Command | What it does |
| --- | --- |
| `npm run build` | The app build: `prebuild` lifecycle → `vite build` (`--max-old-space-size=6144`) → `scripts/strip-sw-from-embeds.mjs` → `scripts/inject-tour-boot.mjs` → `scripts/inject-atlas.mjs`. Output → `dist/`. |
| `npm run build:gcp` | The **full pre-deploy build**, in the load-bearing order: `check:conflicts` → `check:browser-graph` → `ensure:avatar-studio` → build info snapshot → `build:chat` → `npm run build` (the vite build wipes `dist/`, so everything that writes into `dist/` comes after it) → UMD library build (`build:lib:full`) → `publish:lib` (mirrors the library into `dist/`) → `build:info` → `check:dist` → `check:pages`. Run this, not bare `npm run build`, before deploying: `check:dist` fails without the published library bundle. |
| `npm run deploy:gcp` | The **production deploy**: `check:dist` + `check:pages` + `db:check` gates → `gcloud builds submit` (Docker image via `server/cloudbuild.yaml`) → Cloud Run (`three-ws-api`, `us-central1`) → CDN cache purge → `smoke:prod` sweep of the live site. Run `npm run build:gcp` first so `dist/` is complete (see [CI parity](#ci-parity)). |
| `npm run deploy:gcp:full` | `build:gcp` + `deploy:gcp` in one command. |
| `npm run build:vercel` | Legacy full-build orchestrator (`scripts/build-vercel.mjs`) from the Vercel era — runs the gate suite, bundles the API with esbuild, and builds every sub-package. **Not on the Cloud Run deploy path**; kept for full local reproduction (see [the trap](#the-esbuild-overwrite-trap)). |
| `npm run clean` | `rm -rf dist/* dist-lib/*`. |
| `npm run check:dist` | Asserts the published `agent-3d` library bundle + `dist-lib` mirror exist, the version matches `package.json`, and a short list of critical static pages resolves in `dist/` (`scripts/check-dist.mjs`). The full page sweep against the `vercel.json` route table is `npm run check:pages` (`scripts/check-pages.mjs`). |
| `npm run audit:deploy` | Pre-flight for the three 2026-06-11 outage classes: committed symlinks, unsatisfied peer deps, undeclared `api/` imports (`scripts/audit-deploy-artifacts.mjs`). |
| `npm run guard:esbuild` | esbuild-trap guard — blocks committing a bundled `api/*.js` (scans the git index). `:all` sweeps the working tree. |

## CI parity

Production runs on **Google Cloud Run** (service `three-ws-api`, region
`us-central1`), not Vercel — the Vercel deployment was retired 2026-07-07. A
deploy is two steps from the repo root:

```bash
npm run build:gcp    # produce a complete dist/ (app build, then the library mirror check:dist requires)
npm run deploy:gcp   # build the image + deploy to Cloud Run
```

(`npm run deploy:gcp:full` runs both.) Bare `npm run build` is the app build
only: the vite step wipes `dist/`, so without the follow-on `publish:lib`
mirror the `check:dist` gate fails. `build:gcp` encodes the correct order.

`deploy:gcp` runs `check:dist`, `check:pages`, and `db:check`, then `gcloud builds submit
--config server/cloudbuild.yaml`. Cloud Build builds the root `Dockerfile` on a
32-vCPU machine with BuildKit inline caching (an unchanged `package-lock.json`
skips `npm ci`), pushes the image, deploys it to Cloud Run in one run, and the
`deploy:gcp:purge-cdn` step invalidates the CDN cache, after which `smoke:prod`
sweeps every registered page on the live site. The image copies the
already-built `dist/` and runs `server/index.mjs`, which serves the static
front-end, the `vercel.json` route table, and every `api/**` handler from source
(no per-route bundling). The scheduled jobs run on **Google Cloud Scheduler**,
provisioned from the `crons` array in `vercel.json` by
[scripts/create-gcp-scheduler.mjs](../scripts/create-gcp-scheduler.mjs); that
array is the count, so read it there rather than trusting a number quoted here
(115 entries on 2026-09-05). There is **no GitHub Actions CI**. Full runbook: [docs/ops/gcp-production.md](./ops/gcp-production.md).

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
balloons by millions of generated lines. This has happened twice before; both
incidents had to be reverted.

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
route (verified clean across all 1700+ `api/**/*.js`).

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

Embed surfaces (`widget.html`, `embed.html`, `agent-embed.html`, `a-embed.html`,
`avatar-embed.html`, `agent-token-page.html`, `assistant-frame.html`) load inside third-party iframes. They must
**not** register the service worker — an SW registered from an iframe is scoped
to `https://three.ws/` and would intercept every other tab on the origin.

`scripts/strip-sw-from-embeds.mjs` runs straight after the vite step of
`npm run build` (before `inject-tour-boot` and `inject-atlas`) and
removes the VitePWA `register-sw` `<script>` from each embed HTML in `dist/`. It
is idempotent and fails loudly if no embed HTML is found. Verify with:

```bash
grep -l 'vite-plugin-pwa:register-sw' dist/widget.html dist/embed.html   # expect: no matches
```

## Related

- [Deployment](/docs/deployment) - the deployment overview
- [Architecture](/docs/architecture) - how the pieces fit together
- [Contributing](/docs/contributing) - workflow and conventions for changes
