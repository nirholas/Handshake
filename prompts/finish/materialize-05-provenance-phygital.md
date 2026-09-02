# Work order 05: certificates, editions, and the phygital link

**How to run:** paste this whole file into a fresh Claude Code chat in this
repo, or name its path. Read `prompts/finish/materialize-00-CONTEXT.md` first; its
decisions bind this order.

**Binding operating clause:** finish 100%. Never end with a question or an
unexecuted plan. CLAUDE.md hard rules apply: no mocks, no fake data, no
unfinished markers, no em-dash, explicit-path commits. CLAUDE.md gate 1
applies exactly once here: the mainnet attestation send is owner-approved
per action or via a standing approval recorded in this pack's PROGRESS.md.
Devnet is yours; build everything so mainnet is a flag.

## Why this order exists

The moat that compounds. Anyone can print a mesh; only three.ws can hand
you an object whose exact bytes, prompt lineage, and edition number are
attested on Solana at print time, with a QR on the package that resolves
to the living original. This turns a print into a collectible with
provable scarcity and turns every shipped box into a marketing surface.
Solana first, per CLAUDE.md: this is the home-chain feature.

## Step 0: re-derive current state

```
ls api/print/certs* api/_lib/print/certificate.js pages/certificate.html 2>/dev/null
psql "$DATABASE_URL" -c "\d print_certificates" 2>/dev/null
cat scripts/tokenize-3d-devnet-e2e.mjs | head -60
grep -rn "memo" solana-agent-sdk/src api/_lib | head
npm ls qrcode 2>/dev/null
```

Order 02 created the `print_certificates` table (verify). Read
`scripts/tokenize-3d-devnet-e2e.mjs` fully: the repo has already proven a
devnet 3D-asset attestation flow, and this order extends proven code
rather than writing new chain plumbing. Find the platform wallet signing
helper the same way.

## Tasks

### 1. Certificate issuance (`api/_lib/print/certificate.js`)

On an order's transition into `shipped` (hook the store's transition, do
not poll): compute SHA-256 of the exact prepared asset bytes on R2, claim
the next edition number for the creation atomically (a
`SELECT ... FOR UPDATE` counter or unique index race per creation id,
test-proven under concurrency), insert the certificate row, then attest:
a Solana memo-program transaction from the platform wallet carrying a
compact JSON payload (cert id, glb_sha256, edition_no/edition_of,
creation id). Devnet by default; mainnet behind
`PRINT_CERT_CLUSTER=mainnet` plus the gate above. Record the signature on
the row; a failed send leaves `solana_signature` null and a retry path via
the reconciliation cron from order 04 (extend it, do not add a second
cron).

### 2. The certificate page (`/p/:certId`)

`pages/certificate.html` + `src/certificate-page.js` over
`GET /api/print/certs/:id` (public, read-only): the original model
spinning, prompt lineage (respecting the creation's existing visibility
rules; a private creation renders its cert without the prompt), edition
badge, material + print date, the on-chain proof as a link to the
transaction on a Solana explorer plus the raw memo payload rendered so
verification needs no explorer, and a "verify these bytes" affordance
documenting how to hash the asset and compare. Add the route to
`data/pages.json`.

### 3. QR + package insert

Generate a QR PNG per certificate (the `qrcode` package) pointing at
`/p/:certId`, stored to R2 next to the prepared assets, surfaced in the
operator console (order 04) as part of the shipping step: a print-ready
insert card (HTML print stylesheet on an ops-only page: QR, model name,
edition, three.ws mark). The operator prints and boxes it; the adapter
contract's `submit` payload includes the insert URL for partner lanes.

### 4. Editions surface

Edition scarcity per creation: `edition_of` comes from the creator. On the
model page and /materialize, a signed-in creator of the model can cap
editions for their creation (a small settings affordance writing to
`forge_creations` or a sibling table per what order 02 shipped; re-derive)
with the default open edition. Sold-out editions refuse new orders at
quote time with a designed message. Cert page and model page both render
"edition 3 of 25".

### 5. Tests

Hash correctness against a fixture buffer, atomic edition claiming under
concurrent issuance (two parallel transactions, no duplicate edition_no),
memo payload shape, devnet flag default, cert API visibility rules
(private prompt stays private), quote-time sold-out refusal.

## Definition of done

- [ ] `npm test` green including concurrency test on edition claiming.
- [ ] A real devnet attestation executed from this session for a real prepared asset; transaction signature pasted in the report and resolving on a devnet explorer.
- [ ] `/p/:certId` renders that certificate on the dev server with the proof link live.
- [ ] QR PNG generated, stored, and the insert card printable from the ops page.
- [ ] Mainnet path exists behind the env flag + gate, untriggered.
- [ ] `data/pages.json` carries `/p/:certId`'s page entry (pattern per how `/m/:id` is registered; re-derive).
- [ ] `npm run check:rules -- --paths <files you touched>` passes.
- [ ] Committed with explicit paths; this file deleted in the closing commit; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Platform wallet / devnet SOL | The tokenize e2e script already signs on devnet; reuse its wallet source. Devnet faucet if the balance is dry. |
| Memo vs NFT debate | Decided: memo attestation now (cheap, sufficient for verification), collectible mint is a later item per 00-CONTEXT scope. Do not build cNFT infra here. |
| Explorer link choice | Any public Solana explorer URL format; render the raw payload too so the page never depends on a third party. |
| Private creations | Visibility rule stated in task 2: cert renders, prompt withheld. Follow the creation's existing visibility field. |
| Edition cap UI scope creep | One affordance, one field, quote-time enforcement. The marketplace for editions is explicitly later. |

## Report format

Files + tests, the devnet signature, the cert page URL exercised, owner
items (mainnet approval), one line per 00-CONTEXT deviation, next action.
