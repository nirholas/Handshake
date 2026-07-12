# H4 — High: `.dockerignore` doesn't exclude ring-signer secrets or prod log dumps

**Severity:** High · **Area:** Infra / secrets · **Commit-gate:** no

## The defect
[.dockerignore](../../.dockerignore) excludes `.env`, `.env.*`, `*.log` but has **no
rule for `*.json`** and no explicit secret entries. The repo root holds:
- `.x402-ring-secrets.json` — x402 ring-signer secrets (mode 0600, gitignored)
- `three.ws-log-export-*.json` — multi-MB production log dumps (gitignored)

The root [Dockerfile:43](../../Dockerfile) does `COPY . .`, so **any local
`docker build .` bakes these into the image.** Production is saved only because
[.gcloudignore](../../.gcloudignore) uses a `/*` deny + allowlist that keeps them out
of the Cloud Build upload — the two ignore files disagree, so the protection is one
build-method away from failing (a dev building locally, an alternate CI, etc.).

Verified: `git check-ignore .x402-ring-secrets.json` → ignored; `.dockerignore` has
no matching rule; `COPY . .` present.

## The fix
Add explicit exclusions to `.dockerignore`:

```
# Secrets and local dumps — never bake into an image
.x402-ring-secrets.json
*-log-export-*.json
three.ws-log-export-*.json
*.pem
*.key
```

Consider also switching the Dockerfile to copy only what the runtime needs (see M3),
which removes the whole class of accidental-inclusion. Keep `.gcloudignore` as the
prod defense but stop relying on it as the *only* one.

## Verification
1. `docker build -t threews-test .` then
   `docker run --rm threews-test sh -c 'ls -la /app/.x402-ring-secrets.json'` → must
   be "No such file".
2. Confirm the image still boots (`server/index.mjs` starts).

## Done checklist
- [ ] Secret + log-dump globs added to `.dockerignore`.
- [ ] Local image build verified to NOT contain the secret file.
- [ ] Image still boots.
