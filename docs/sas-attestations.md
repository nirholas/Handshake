# SAS Credentialed Attestations

three.ws issues two kinds of on-chain attestations on Solana:

- **Permissionless attestations** — general feedback, task lifecycle, dispute, and revoke events. Anyone can write them as SPL Memos (see [Solana reputation](solana-reputation)).
- **Credentialed attestations** — claims only three.ws or an authorized validator may make: that a wallet is verified, or that a validator audited an agent's task result. These use the [Solana Attestation Service (SAS)](https://attest.solana.com/) and are signed by the **three.ws authority wallet**.

This page covers the authority wallet, the `SAS_AUTHORITY_SECRET` environment variable, bootstrapping the credential + schemas, and the API that issues them.

---

## The authority wallet

Every credentialed attestation is signed by a single Solana keypair — the **authority**. That keypair:

- Pays rent for the credential and schema accounts (one-time, at bootstrap).
- Owns the credential, so it can later authorize additional signers via `changeAuthorizedSigners`.
- Signs (and pays fees for) every attestation issued under the three.ws schemas.
- Is the only key that can close (revoke) an attestation it issued.

The server loads it from the `SAS_AUTHORITY_SECRET` environment variable — see [api/_lib/sas.js](../api/_lib/sas.js).

---

## `SAS_AUTHORITY_SECRET`

The **base58-encoded 64-byte secret key** of the authority keypair. This is the Phantom/Solflare "export private key" format, *not* the JSON byte array that `solana-keygen` writes to disk.

```
SAS_AUTHORITY_SECRET=<base58 secret key>
```

It is decoded with `bs58.decode()` and passed to `createKeyPairSignerFromBytes()`. If it is missing, any attempt to issue or close an attestation throws `SAS_AUTHORITY_SECRET not configured`.

> **This is a private key. Treat it as a secret.**
> - Never commit it, and never commit a `*.json` keypair file. Keep both out of git.
> - Use **separate keypairs for devnet and mainnet** so a devnet leak can never touch mainnet funds.
> - Use the **same keypair for bootstrap and runtime** on a given network — a different key cannot issue under the credential the first key created.

### Generating a keypair

**With the Solana CLI** (recommended for production — produces a real, fundable wallet):

```bash
solana-keygen new --no-bip39-passphrase --outfile authority.json
# Convert the 64-byte array to the base58 form SAS_AUTHORITY_SECRET expects:
node -e "import('bs58').then(({default:b})=>console.log(b.encode(Uint8Array.from(require('./authority.json')))))"
```

**Without any dependencies** (built-in `crypto` only — handy in a clean shell):

```bash
node --input-type=module -e '
import { generateKeyPairSync } from "node:crypto";
const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58=u=>{let z=0;while(z<u.length&&!u[z])z++;const d=[0];for(let i=z;i<u.length;i++){let c=u[i];for(let j=0;j<d.length;j++){c+=d[j]<<8;d[j]=c%58;c=c/58|0}while(c){d.push(c%58);c=c/58|0}}return "1".repeat(z)+d.reverse().map(x=>A[x]).join("")};
const{publicKey,privateKey}=generateKeyPairSync("ed25519");
const seed=privateKey.export({format:"der",type:"pkcs8"}).subarray(-32);
const pub =publicKey .export({format:"der",type:"spki" }).subarray(-32);
console.log("PUBKEY:", b58(pub));
console.log("SECRET:", b58(Buffer.concat([seed,pub])));
'
```

The `SECRET:` line is the value for `SAS_AUTHORITY_SECRET`; the `PUBKEY:` line is the address you fund.

### Vanity addresses (optional)

To make the authority address recognizable (e.g. starting with `3ws` or `www`), grind keypairs until the base58 public key matches a prefix. With the CLI:

```bash
solana-keygen grind --starts-with 3ws:1 --ignore-case
```

`--ignore-case` matches the prefix case-insensitively, which is much faster. Base58 excludes the characters `0`, `O`, `I`, and `l`, so a prefix cannot contain them. Cost grows ~58× per added character: 3 characters resolve in seconds, 4 in a minute or two, 5+ can take much longer.

---

## Bootstrap (one-time per network)

Registering the credential and schemas is idempotent — existing accounts are left untouched, so the script is safe to re-run.

1. **Fund the authority wallet** with ~0.05 SOL on the target cluster (covers one credential plus the schemas). Devnet: [faucet.solana.com](https://faucet.solana.com). Mainnet: send real SOL to the address.

2. **Run the bootstrap** ([scripts/sas-bootstrap.js](../scripts/sas-bootstrap.js)):

   ```bash
   SAS_AUTHORITY_SECRET=<base58 secret key> node scripts/sas-bootstrap.js devnet
   # or: ... node scripts/sas-bootstrap.js mainnet
   ```

   On success it writes the derived PDAs into [sdk/src/sas-config.json](../sdk/src/sas-config.json). Do not edit that file by hand — re-run bootstrap to refresh it. Commit the updated config so the server knows the credential/schema addresses.

3. **Set the env var in each environment.** Locally, add it to `.env`. In production it lives on the Cloud Run service (`three-ws-api`), not in a dashboard:

   ```bash
   gcloud run services update three-ws-api --region us-central1 \
     --project aerial-vehicle-466722-p5 \
     --update-env-vars SAS_AUTHORITY_SECRET=<base58 secret key>
   ```

   Use a devnet key while testing and the mainnet key in production. The service picks the value up on the next revision. See the [GCP production runbook](./ops/gcp-production.md) for the full env workflow.

### Related environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SAS_AUTHORITY_SECRET` | Base58 authority secret key. **Required** to issue/close. | — |
| `SOLANA_RPC_URL` | Mainnet RPC endpoint. | `https://api.mainnet-beta.solana.com` |
| `SOLANA_RPC_URL_DEVNET` | Devnet RPC endpoint. | `https://api.devnet.solana.com` |

A custom RPC (Helius, Triton, QuickNode) is strongly recommended for mainnet — the public endpoint is rate-limited and will fail under load.

---

## Schemas

The schemas three.ws registers live in [sdk/src/sas-config.json](../sdk/src/sas-config.json). Two ship today:

### `threews.verified-client.v1`

A wallet has been verified by three.ws (KYC, payment history, or a trusted introduction). Subject = the client wallet pubkey. Used to weight feedback attestations.

| Field | Type | Meaning |
|-------|------|---------|
| `method` | string | Verification method, e.g. `kyc-tier-1`, `payment-history`, `partner:auditor-x`. |
| `reference` | string | Opaque reference id pointing at an off-chain record. |

### `threews.audited-validation.v1`

A validation of an agent task result, issued by an authorized validator. Subject = the agent asset pubkey. Carries higher weight than a self-attested validation.

| Field | Type | Meaning |
|-------|------|---------|
| `task_hash` | string | Hash of the task input/output bundle. |
| `passed` | bool | Whether the validator considers the work acceptable. |
| `report_uri` | string | Link to the validator's full report (Arweave/IPFS/HTTPS). |

---

## API

The endpoint is [api/agents/sas/[action].js](../api/agents/sas/[action].js).

### Read credentials — `GET /api/agents/sas/credentials`

Public, rate-limited. Returns active (non-closed, non-expired) attestations for a subject.

| Query param | Required | Description |
|-------------|----------|-------------|
| `subject` | yes | Base58 pubkey the attestation is about. |
| `network` | no | `mainnet` or `devnet` (default `devnet`). |
| `kind` | no | Filter to one schema, e.g. `threews.verified-client.v1`. |
| `include_closed` | no | `1` to include closed attestations. |

```bash
curl "https://three.ws/api/agents/sas/credentials?subject=<pubkey>&network=mainnet"
```

```json
{ "subject": "<pubkey>", "network": "mainnet", "kind": null, "count": 1, "data": [ /* attestations */ ] }
```

### Issue a credential — `POST /api/agents/sas/issue-credential`

**Admin-only.** Requires admin auth (see [api/_lib/admin.js](../api/_lib/admin.js)) and validates the body against the target schema before signing. On success it issues the attestation on-chain with the authority wallet and records it in the `solana_credentials` table.

```bash
curl -X POST https://three.ws/api/agents/sas/issue-credential \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "threews.verified-client.v1",
    "subject": "<client-wallet-pubkey>",
    "data": { "method": "kyc-tier-1", "reference": "rec_01H..." },
    "expiry": 0,
    "network": "mainnet"
  }'
```

| Body field | Required | Description |
|------------|----------|-------------|
| `kind` | yes | One of the registered schema kinds. |
| `subject` | yes | Base58 pubkey (32–44 chars) the attestation is about; used as the attestation nonce. |
| `data` | yes | Object whose keys match the schema's `fieldNames`, with the right types. |
| `expiry` | no | Unix seconds; `0` (default) means no expiry. |
| `network` | no | `devnet` (default) or `mainnet`. |

```json
{
  "signature": "<tx-sig>",
  "attestation_pda": "<pda>",
  "schema_pda": "<pda>",
  "credential_pda": "<pda>",
  "kind": "threews.verified-client.v1",
  "subject": "<pubkey>"
}
```

Closing (revoking) an attestation is done server-side via `sasClose()` in [api/_lib/sas.js](../api/_lib/sas.js); only the authority can close.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `SAS_AUTHORITY_SECRET not configured` | Env var unset in the running environment. | Set it in `.env` locally, or on the Cloud Run service (`gcloud run services update three-ws-api … --update-env-vars`), and redeploy. |
| `SAS not bootstrapped for <network>` | `sdk/src/sas-config.json` has no PDAs for that network. | Run `scripts/sas-bootstrap.js <network>` and commit the updated config. |
| `schema <kind> not registered on <network>` | Schema added to config but bootstrap not re-run. | Re-run the bootstrap for that network. |
| Bootstrap or issue fails with insufficient funds | Authority wallet not funded on that cluster. | Send SOL to the authority address and retry. |
| Non-base58 / bad key on load | `SAS_AUTHORITY_SECRET` holds the JSON array form, not base58. | Convert the array to base58 (see above) and use that. |
