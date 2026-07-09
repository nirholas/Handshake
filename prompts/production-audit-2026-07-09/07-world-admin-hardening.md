# 07 — Lock down world.three.ws (unprotected, every visitor has build rights)

## Mission

`world.three.ws` (the Hyperfy-based 3D world) is confirmed live-unprotected right now:
`/api/healthz`'s `subsystems.world.status` reports `"degraded"` because `ADMIN_CODE` isn't set
on the world service. Without it, Hyperfy grants **every visitor** admin/build rights — anyone
can delete the ground, replace the scene, or fill the world with broken GLBs. This is not
theoretical: per `deploy/world/apply-hardening.sh`'s own header comment, an unprotected world is
what broke the world on 2026-06-12 (scene script asset lost, every player fell into the void on
join).

**The fix is already written and staged, just never applied.** This is a one-command deploy, not
a build task.

## Context

- `deploy/world/apply-hardening.sh` — reads in full before running. It:
  1. Creates (or reuses, if already present) a Secret Manager secret `hyperfy-admin-code` with a
     freshly generated random admin code — **printed once, must be saved to a password manager
     immediately**, it is never shown again.
  2. Grants the world's runtime service account (`hyperfy-world-sa@aerial-vehicle-466722-p5.iam.gserviceaccount.com`)
     `secretAccessor` on that secret.
  3. Rebuilds the world image via `gcloud builds submit --config deploy/world/cloudbuild.yaml`
     (as `three-ws-build@` — this project has no legacy default Cloud Build SA).
  4. Applies `deploy/world/cloudrun.yaml` (wires `ADMIN_CODE` + `PUBLIC_MAX_UPLOAD_SIZE=16`).
  5. Polls `https://world.three.ws/status` for up to ~150s until it reports `"protected":true`
     — this is the fail-closed patch (`patches/0003`, per the script's own comment) that makes a
     secret-less revision refuse to boot, so a stuck rollout means the *previous* (unprotected)
     revision is still serving, not a fresh unprotected one.
- In-world, once applied, builders claim rights with the chat command: `/admin <code>`.

## This step is owner-run, not agent-run

The script mints and stores a brand-new secret and needs `gcloud` credentials with Cloud Run +
Secret Manager + Cloud Build access on `aerial-vehicle-466722-p5`. If you (the agent executing
this prompt) have that access already authenticated in this environment, proceed. If not — stop
and hand this back to the owner with the exact command to run:

```bash
bash deploy/world/apply-hardening.sh
```

Do not attempt to work around missing credentials by hand-crafting the secret or the Cloud Run
env var yourself outside the script — the script's fail-closed verification (step 5) is the part
that actually proves the fix worked; a manual env-var edit without that verification loop risks
reporting "done" on a revision that never actually flipped `protected:true`.

## Tasks

1. Confirm current state: `curl -fsS https://world.three.ws/status` — expect to see
   `"protected":false` (or the field absent) confirming the live vulnerability before you touch
   anything.
2. Confirm `gcloud` auth/permissions are available (`gcloud auth list`,
   `gcloud projects get-iam-policy aerial-vehicle-466722-p5` scoped check, or just attempt the
   script and see if it fails on a permission error).
3. Run `bash deploy/world/apply-hardening.sh`.
4. **Capture the printed admin code immediately** — paste it into whatever secrets-of-record the
   owner uses (ask if unclear; do not leave it only in scrollback / a temp file).
5. Confirm the script's own polling loop reports `OK — world is protected` before considering
   this done. If it times out with the WARNING branch, do not report success — follow the
   script's own troubleshooting output (`gcloud run revisions list`, `gcloud run services logs
   read`) to find why the new revision isn't serving, fix that, and re-run.

## Verification (must all pass)

- [ ] `curl -fsS https://world.three.ws/status` now reports `"protected":true`.
- [ ] `curl -fsS https://three.ws/api/healthz` — `subsystems.world.status` is no longer
      `"degraded"` for this reason (check the specific message; a different unrelated world
      issue surfacing after this fix is a separate bug, not a failure of this prompt).
- [ ] A visitor without the admin code cannot invoke build/admin actions in-world (spot-check by
      joining without running `/admin <code>` and confirming build tools are gated).
- [ ] The admin code is recorded somewhere durable outside this conversation.

## Do not

- Do not commit the admin code anywhere in the repo, ever — it lives in Secret Manager only.
- Do not run `--force-regenerate`-equivalent behavior if a secret already exists (the script
  already guards this: it reuses an existing `hyperfy-admin-code` secret rather than rotating
  it, so a prior admin's saved code keeps working — don't fight that by deleting the secret
  first unless the owner explicitly wants a rotation).
