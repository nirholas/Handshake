# M3 — Medium: Root production image ships devDeps + toolchain + full source, runs as root

**Severity:** Medium · **Area:** Infra · **Commit-gate:** no

## The defect
[Dockerfile](../../Dockerfile) is single-stage (`FROM node:24-slim`):
- `npm ci` (line 39) installs **all** deps including devDependencies (playwright,
  vite, typescript, jsdom, esbuild…).
- The `python3 make g++` toolchain (lines 24-30) stays in the final image.
- `COPY . .` (line 43) ships the entire source tree and `dist/`.
- No `npm prune --omit=dev` (agent-mm's own Dockerfile does this).
- No `USER` directive → the container runs as **root** on Cloud Run.

Larger attack surface, larger image, slower cold starts, and root execution.

## The fix
Three independent, low-risk improvements (do them in this order, verifying boot
after each):

1. **Drop privileges** — add before `CMD`:
   ```dockerfile
   USER node
   ```
2. **Prune dev deps** after the SDK build step:
   ```dockerfile
   RUN npm prune --omit=dev
   ```
   First confirm the server doesn't import a devDep at runtime
   (`grep -rE "require\(|from ['\"]" server/ api/_lib/ | grep -f <(node -e "console.log(Object.keys(require('./package.json').devDependencies).join('\n'))")`
   — or just boot after pruning and watch for `ERR_MODULE_NOT_FOUND`).
3. **Multi-stage** (bigger change, optional): a `builder` stage with the compiler
   toolchain that produces `dist/` + `node_modules`, then a slim runtime stage that
   `COPY --from=builder` only the needed artifacts — discards `python3/make/g++`
   entirely.

Keep the existing correct layer caching (manifests-only copy before `npm ci`).

## Verification
1. `docker build .` succeeds.
2. `docker run` → `server/index.mjs` boots and serves `/api/health`.
3. `docker run --rm <img> whoami` → `node`, not `root`.
4. Image size noticeably smaller (`docker images`).

## Done checklist
- [ ] `USER node` added.
- [ ] Dev deps pruned (runtime verified clean).
- [ ] (Optional) multi-stage split landed.
- [ ] Image boots and serves as non-root.
