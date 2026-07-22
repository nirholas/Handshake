# Deploying `skill_license`

The program id is the program keypair's pubkey, baked into `declare_id!` and
`Anchor.toml`: **`EdngSwxmDktyrr4phwGEZnCXEoQ27vgnBtowjhKa7Wr8`**. The same id is
used on localnet, devnet, and mainnet.

## Keys (never commit)

| Key | Purpose | Storage |
|---|---|---|
| Program keypair | Its pubkey is the program id; signs the initial deploy. | `contracts/skill-license/.deploy/skill_license-keypair.json` (gitignored) → secret manager as `SKILL_LICENSE_PROGRAM_KEYPAIR`. |
| Deploy/upgrade authority | Pays for + upgrades the program. | `~/.config/solana/skill-license-deployer.json` → `SKILL_LICENSE_DEPLOY_AUTHORITY`. |
| Minter | The backend wallet authorized to call `mint_skill_license` / `revoke_skill_license`. | `SKILL_LICENSE_MINTER_KEY` (base58 secret) in the server secret manager — never on the client. |

The program keypair generated for this id already lives at the gitignored
`.deploy/` path. If you need to regenerate (new id), update `declare_id!`,
`Anchor.toml`, `contracts/idl/skill_license.json`, and the default in
`api/_lib/skill-license-onchain.js`.

## 1. Build

```bash
cd contracts/skill-license
anchor build            # → target/deploy/skill_license.so + refreshed IDL
```

`anchor build` regenerates the IDL from `src/lib.rs`. Diff it against
`../idl/skill_license.json` and reconcile any drift (the JSON is the version the
backend + smoke test consume).

## 2. Deploy

```bash
# point the program keypair into place first
cp .deploy/skill_license-keypair.json target/deploy/skill_license-keypair.json

anchor deploy \
  --provider.cluster devnet \
  --provider.wallet ~/.config/solana/skill-license-deployer.json \
  --program-keypair target/deploy/skill_license-keypair.json
```

Repeat with `--provider.cluster mainnet` for production.

## 3. Initialize the marketplace (one-time)

The singleton `Marketplace` config must exist before any license can be minted.
Set `SKILL_LICENSE_MINTER_KEY` to the backend minter wallet and run:

```bash
SKILL_LICENSE_MINTER_KEY=<base58-secret> \
SOLANA_RPC_URL_DEVNET=https://api.devnet.solana.com \
node scripts/skill-license-smoke.mjs
```

On first run the smoke test initializes the marketplace (admin = minter), mints
a license to a fresh synthetic owner, verifies the on-chain record, and asserts
the buyer holds exactly 1 NFT. It is re-runnable and exits non-zero on failure.

To initialize with a **separate** admin authority (recommended for production —
so the minter key can be rotated by a cold admin key), call
`buildInitializeMarketplaceIx({ authority, minter })` from
`api/_lib/skill-license-onchain.js` with distinct keys and submit it signed by
the admin.

## 4. Wire the backend

Set on the server (the `three-ws-api` Cloud Run service, via
`gcloud run services update three-ws-api --region us-central1 --update-env-vars ...`):

| Env | Value |
|---|---|
| `SKILL_LICENSE_PROGRAM_ID` | the deployed program id (optional; defaults to the baked id) |
| `SKILL_LICENSE_MINTER_KEY` | base58 secret of the authorized minter |
| `SOLANA_RPC_URL` / `SOLANA_RPC_URL_DEVNET` | RPC endpoints (already configured) |

Verification (`GET /api/skills/license-onchain`) needs only the RPC + program id.
Minting (`mintSkillLicenseOnchain`) also needs `SKILL_LICENSE_MINTER_KEY`. If the
minter key is absent, verification still works and minting is simply disabled —
no crash.

## Upgrade authority

Keep the upgrade authority on a hardware/cold key in production. Transfer it
after the first deploy:

```bash
solana program set-upgrade-authority \
  EdngSwxmDktyrr4phwGEZnCXEoQ27vgnBtowjhKa7Wr8 \
  --new-upgrade-authority <COLD_AUTHORITY_PUBKEY>
```
