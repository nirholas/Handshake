# P100-03: Get the master wallet secret out of plaintext env

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/production-100-03-master-key-hygiene.md`".
Read [00-INDEX.md](production-100-00-INDEX.md) and `CLAUDE.md` first.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Delete this file when the
   definition of done is verified; write follow-ups for any remainder first.
2. Storage migration of an existing secret is config work and pre-approved (config-only
   service updates, per CLAUDE.md). **Rotation is not:** generating a new master wallet and
   moving its funds is stop-and-ask gate 1. This order migrates storage and prepares
   rotation; it never rotates.
3. Env-var traps, both of which have burned real sessions: `--set-env-vars` REPLACES the
   whole env set (never use it); `--update-env-vars` and `--update-secrets` merge. And
   `vercel env pull` returns empty secrets; never trust it.

## The problem, measured 2026-08-02 (re-measure in step 0)

`ECONOMY_MASTER_SECRET_BASE58`, the base58 secret key of the economy master wallet, sits as
a PLAINTEXT env var on the `three-ws-api` Cloud Run service, while its sibling
`X402_FEE_PAYER_SECRET_BASE58` is a Secret Manager reference. Any principal with
`run.services.get` on the project can read the master wallet's key from the service config.

## Step 0: re-derive the state

```bash
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
gcloud run services describe three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --format=yaml | grep -n -A2 "SECRET\|_KEY" | head -60
gcloud secrets list --project aerial-vehicle-466722-p5
curl -s https://three.ws/api/healthz | head -c 1500        # baseline before touching env
```

Confirm which vars are literal `value:` entries versus `valueFrom.secretKeyRef`. If the
master secret is already a secretRef, skip to task 3 (the sweep), then task 4.

## Tasks

1. **Migrate the master secret.** Create a Secret Manager secret (name it in the style of
   the existing ones), add the current value as version 1, grant the runtime service account
   (`three-ws@...`) `roles/secretmanager.secretAccessor` on that one secret (per-secret
   grant, matching how the existing secrets are wired, never project-wide), then flip the
   service: `gcloud run services update three-ws-api --region us-central1 --project
   aerial-vehicle-466722-p5 --update-secrets ECONOMY_MASTER_SECRET_BASE58=<secret>:latest`.
   That single update both attaches the secret and removes the plaintext literal; verify in
   the post-update YAML that no literal value remains anywhere (including old revisions'
   traffic: confirm 100% of traffic is on the new revision).
2. **Prove nothing broke.** The new revision must serve: re-read healthz and compare to the
   step 0 baseline, and confirm a signing path that uses the master key still works (the
   treasury tick or a settle, observed via `/api/healthz` counters or
   `/api/ops/payment-outcomes`, not assumed). If the service degrades, roll back traffic to
   the prior revision first, then diagnose.
3. **Sweep for siblings.** From the step 0 YAML, list every env var whose name looks
   secret-bearing (`_SECRET`, `_KEY`, `_TOKEN`, `_PRIVATE`) and is a plaintext literal.
   Migrate each the same way in one batch update. Judgment call per CLAUDE.md: non-secret
   config that merely matches the pattern (public keys, ids) stays put; say so in the report.
4. **Document and hand the rotation to the owner.** Extend `docs/ops/wallet-key-migration.md`
   (it already holds the encryption-key rotation runbook) with a short section: where the
   master secret now lives, how to add a new version, and the owner-gated rotation plan
   (generate new wallet, move funds, retire old version) with exact commands. Add one row to
   [OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md): rotate-or-accept decision, since the old value was
   readable in plaintext for some window.
5. No changelog entry: security-internal, nothing user-visible. Log in
   [PROGRESS.md](production-100-PROGRESS.md).

## Definition of done

- [ ] Post-update `gcloud run services describe` YAML shows the master secret (and every
      migrated sibling) as a secretRef; no plaintext secret literals remain on the serving
      revision, and 100% of traffic is on it.
- [ ] Healthz and a real master-key signing path verified no worse than baseline.
- [ ] Runbook section written; `npm run audit:docs` clean.
- [ ] Rotation row in [OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md); outcome in
      [PROGRESS.md](production-100-PROGRESS.md); this file deleted.

## Never blocked

| Blocker | Resolution |
|---|---|
| `gcloud` missing / auth dead | PATH export above; revive with `gcloud auth login --no-launch-browser` through a fifo; verify with a real read. |
| Fear of breaking settles mid-flight | The flip creates a new revision; the old one keeps serving until ready. Baseline first, compare after, roll back traffic on regression. |
| A var is ambiguous (secret or config?) | Trace where the code reads it (`grep -rn "<NAME>" api/ server/`). Migrate real credentials; leave identifiers; record each call in the report. |
| Secret Manager quota or IAM denial | The build/runtime SAs and per-secret grant pattern already exist on this project; copy an existing secret's binding. If genuinely denied, file the fix, migrate what you can, and follow-up-file the rest. |

## Report format

Table of migrated vars (name, secret name, revision), the verification reads (healthz delta,
signing proof), siblings deliberately left with reasons, and the one-line owner ask.
