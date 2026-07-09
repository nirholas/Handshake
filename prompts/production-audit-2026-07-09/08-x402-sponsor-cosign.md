# 08 — Fix x402 sponsor-mode 502s (club-cover, dance-tip)

## Mission

`/api/healthz` reports `sponsor_cosign: "missing"` (or `"mismatch"`, check the live value —
they mean different repairs, see below). The self-hosted x402 facilitator advertises a Solana
fee-payer pubkey (`X402_FEE_PAYER_SOLANA`) in every 402 challenge, but the matching **secret**
(`X402_FEE_PAYER_SECRET_BASE58`) needed to actually co-sign a sponsor-mode settlement can't be
loaded on the deploy. Every paid endpoint that relies on sponsor-mode settlement — confirmed:
club-cover, dance-tip — 502s on every real payment attempt. This passes every other x402 health
check (the pubkey is advertised, so clients build valid payment payloads against it) and only
fails at settle time, which is why it's easy to miss without `/api/healthz`'s dedicated probe.

## Context — read `api/healthz.js` before touching anything

The relevant probe is in `api/healthz.js` (search `sponsor_cosign`): it imports
`loadFeePayerKeypair` from `api/_lib/x402/self-facilitator.js` and calls it. That function
(`api/_lib/x402/self-facilitator.js`, search `export function loadFeePayerKeypair`):

- Throws `"X402_FEE_PAYER_SECRET_BASE58 not set"` if the env var is simply missing →
  `healthz` reports `sponsor_cosign: "missing"`.
- Throws `"fee-payer secret pubkey <derived> != advertised X402_FEE_PAYER_SOLANA <advertised>"`
  if the secret is set but decodes to a **different** keypair than the pubkey the platform is
  advertising → `healthz` reports `sponsor_cosign: "mismatch"`. This is the more dangerous case:
  it means either the wrong secret was pasted into the env, or `X402_FEE_PAYER_SOLANA` was
  updated without updating the matching secret (or vice versa) — two config values that must
  always move together and currently don't.

**Check the live value first** — `missing` and `mismatch` have different fixes:
```bash
curl -fsS https://three.ws/api/healthz | jq '.subsystems.x402.sponsor_cosign, .warnings'
```
(adjust the jq path to wherever `sponsor_cosign` actually lands in the response — check
`api/healthz.js`'s output shape directly if unsure).

## Existing tooling — use it, don't hand-roll a diagnosis

- **`scripts/audit-service-wallets.mjs`** — read-only, purpose-built for exactly this class of
  bug (per its own header: *"cross-check the x402 advertised fee-payer/payTo against what the
  secrets actually resolve to. Surfaces the class of misconfig that silently 502s paid
  endpoints"*). Run it against the real deploy secrets:
  ```bash
  vercel env pull .env.audit.local   # or gcloud equivalent — see root CLAUDE.md's
                                      # "Env-var trap" note: vercel env pull returns EMPTY
                                      # for secret-type vars, so prefer pulling from the
                                      # actual Cloud Run service if this comes back empty:
                                      #   gcloud run services describe three-ws-api
                                      #     --region us-central1 --format=json
                                      #     | jq '.spec.template.spec.containers[0].env'
  node --env-file=.env.audit.local scripts/audit-service-wallets.mjs
  ```
  This tells you definitively whether `X402_FEE_PAYER_SECRET_BASE58` is absent, or present but
  deriving to the wrong pubkey — don't guess.
- **`scripts/x402-ring-setup.mjs`** — only if the audit above shows the sponsor role has no
  usable secret at all (not a mismatch, a true absence with no known-good value to fall back
  to). It can generate a fresh `sponsor` role keypair (`--roles=sponsor`) and print the matching
  `X402_FEE_PAYER_SOLANA` / `X402_FEE_PAYER_SECRET_BASE58` pair. **Read its guard behavior
  first** — it refuses to regenerate a role that already has a key on file without
  `--force-regenerate`, specifically because an existing wallet may hold funds. If
  `X402_FEE_PAYER_SOLANA` currently points at a pubkey with a real balance, generating a *new*
  keypair means that balance is now unreachable by the new secret — do not blindly regenerate;
  confirm first whether the currently-advertised pubkey has funds worth preserving
  (`audit-service-wallets.mjs` reports balances) and needs its *secret* recovered instead of
  replaced.

## Tasks

1. Run `scripts/audit-service-wallets.mjs` against real deploy env to get a definitive
   missing-vs-mismatch-vs-underfunded diagnosis for the `x402-ring-sponsor` role (see
   `api/_lib/solana-signers.js` `SIGNER_SPECS` for the exact role name/purpose/floor —
   `minSol: 0.03`, below which the facilitator also refuses to settle regardless of cosign
   status, so check the balance too, not just presence/match of the secret).
2. Based on the diagnosis:
   - **Missing, and the advertised pubkey has no funds worth preserving** → generate a fresh
     sponsor keypair with `scripts/x402-ring-setup.mjs --roles=sponsor`, fund it above the
     `minSol` floor, set both env vars on the Cloud Run service.
   - **Missing or mismatch, and the advertised pubkey DOES hold funds** → the correct secret
     exists somewhere (a password manager, an old env export, wherever it was originally
     provisioned) — this is a **recovery**, not a regeneration. Locate the correct secret rather
     than minting a new keypair that abandons the funded one. If it's genuinely unrecoverable,
     that's an owner-level decision (funds are stuck) — stop and report it rather than silently
     generating a replacement that orphans real SOL.
   - **Present, matches, but underfunded** → top up from the treasury (check
     `api/_lib/treasury-autopilot.js` / the economy-master topup cron mentioned in
     `solana-signers.js`'s comment on this role — it may already be supposed to auto-refill this
     and isn't).
3. Set/repair `X402_FEE_PAYER_SECRET_BASE58` (and `X402_FEE_PAYER_SOLANA` if it changed) on the
   Cloud Run service env (`gcloud run services update three-ws-api --region us-central1
   --update-env-vars ...` — never commit the secret to the repo or `vercel.json`).
4. Redeploy/restart so the new env takes effect (a Cloud Run env-var update triggers a new
   revision automatically; confirm it rolled out).

## Verification (must all pass)

- [ ] `curl -fsS https://three.ws/api/healthz` — `sponsor_cosign` reports `"ready"`.
- [ ] `scripts/audit-service-wallets.mjs` shows the `x402-ring-sponsor` role passing its
      pubkey-match check and above its SOL floor.
- [ ] A real (small, real-money) settlement against club-cover or dance-tip completes without a
      502 — this is the actual end-to-end proof; a green healthz alone isn't sufficient given
      root `CLAUDE.md`'s "verify against real behavior" standard for payment-path fixes. If
      making a real payment isn't feasible in this session, at minimum trigger the facilitator's
      settle path against a testnet/devnet equivalent if one exists, and clearly flag that
      mainnet settlement itself is unverified.

## Do not

- Do not generate a replacement keypair without first checking whether the currently-advertised
  pubkey holds real funds — see step 2 above. This is the one action in this pack that can
  irreversibly strand real money if done carelessly.
- Do not paste the secret into any committed file, log statement, or this conversation's visible
  output — `audit-service-wallets.mjs` is deliberately read-only and never logs secret material;
  match that discipline in every step you add.
