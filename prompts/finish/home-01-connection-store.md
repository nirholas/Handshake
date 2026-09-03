# 01. Connection store: schema, encrypted credentials, lifecycle

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first; this file assumes it and
does not repeat the architecture or the security rule.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated. Every architectural decision here is already made; if you
disagree with one, implement it and say so in your report rather than stopping to relitigate it.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
npx vitest run packages/home-bridge                      # the client library: expect 30 passed, 6 skipped
ls api/_lib/migrations | grep -i home                    # expect nothing yet
grep -rn "home_connections" api/ --include=*.js -l       # expect nothing yet
npm run db:status                                        # READ IN FULL before touching the schema
node -e "import('./api/_lib/secret-box.js').then(m=>console.log(Object.keys(m)))"
node scripts/read-service-env.mjs '^WALLET_ENCRYPTION_KEY$' --names 2>/dev/null || echo "run this where gcloud is available"
```

`npm run db:migrate` applies **every** pending migration in `api/_lib/migrations/`, not only
yours, and there is no dry run. Read `db:status` output in full first.

## What this order owns

The record of "this user has connected this home", the credential that makes it work, and the
lifecycle around it. Nothing above the store: no endpoints (order 03), no runtime (order 02).

## The schema

One migration, `api/_lib/migrations/<UTC timestamp>_home_connections.sql`. Follow the header
style of the neighbouring migrations: a comment block stating what the table is, why each
non-obvious column exists, and which decisions were considered and rejected.

### `home_connections`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid primary key default gen_random_uuid()` | |
| `user_id` | `uuid not null references users(id) on delete cascade` | the owner. Household membership arrives in order 12 and must not require a rewrite of this column. |
| `label` | `text not null` | what the user calls it ("Home", "The office"). User-supplied, so treat as untrusted on render. |
| `base_url` | `text not null` | normalized by `normalizeBaseUrl` before write. Store the normalized form, never the raw input. |
| `access_token_enc` | `text not null` | `encryptSecret()` output. **Never** a plaintext token, never a hash (we must replay it). |
| `token_fingerprint` | `text not null` | `sha256(token)` hex, so a re-connect with the same token is idempotent and a rotation is detectable without decrypting. |
| `transport` | `text not null default 'direct'` | `direct` or `relay` (order 10). Constrained by a check. |
| `relay_id` | `text` | null for `direct`. |
| `capabilities` | `jsonb not null default '{}'` | measured at connect: `{ websocket: true, mcp: true, mcpToolCount: 29, haVersion: '2026.9.0' }`. Measured, never assumed. |
| `status` | `text not null default 'pending'` | `pending`, `connected`, `unreachable`, `auth_failed`, `revoked`. Constrained by a check. |
| `status_detail` | `text` | the last human-readable reason, for the UI to show without a second call. |
| `last_ok_at` | `timestamptz` | last successful handshake. |
| `last_error_at` | `timestamptz` | |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |
| `revoked_at` | `timestamptz` | soft delete. A revoked row keeps its audit lineage; the ciphertext is scrubbed to `''` on revoke. |

Indexes: `(user_id) where revoked_at is null`, and a unique `(user_id, base_url) where revoked_at
is null` so one user cannot silently hold two live records for the same house.

### `home_entity_grants`

The standing per-entity allowances from the safety gate. **Per entity and per direction, never
per domain.**

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid primary key default gen_random_uuid()` | |
| `home_id` | `uuid not null references home_connections(id) on delete cascade` | |
| `entity_id` | `text not null` | e.g. `lock.office_door`. |
| `granted_by` | `uuid not null references users(id)` | who said yes. |
| `expires_at` | `timestamptz` | null means until revoked. The UI must offer a bounded option. |
| `created_at` | `timestamptz not null default now()` | |

Unique on `(home_id, entity_id)`.

**Rejected, with the reason, in the migration header:** a `granted_domain` column. A user who
lets the agent open the office door has not let it open the front door, and a domain grant is
exactly the mistake that turns a convenience into a burglary tool.

### `home_action_log`

Every write the platform performs against a house. This is not the general `audit_log`: it is
higher volume, it carries the physical-action verdict, and an operator has to be able to answer
"what did my agent do in my house last Tuesday" without a join across a shared table.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial primary key` | |
| `home_id` | `uuid not null references home_connections(id) on delete cascade` | |
| `user_id` | `uuid` | null when the actor is an agent principal with no account. |
| `actor` | `text not null` | `user`, `agent`, `voice`, `mcp`, `automation`. |
| `channel` | `text not null` | `websocket` or `mcp`. |
| `action` | `text not null` | `light.turn_on`, or the MCP tool name. |
| `entity_ids` | `text[] not null default '{}'` | resolved targets, not the raw argument. |
| `guarded` | `boolean not null default false` | did the gate fire. |
| `confirmed_by` | `uuid` | who said yes, when it did. |
| `risk` | `text` | `security`, `physical`, or null. |
| `outcome` | `text not null` | `ok`, `refused`, `failed`. |
| `detail` | `jsonb` | small. No secrets, no full state dumps. |
| `created_at` | `timestamptz not null default now()` | |

Index `(home_id, created_at desc)`. Retention is order 15's job; leave the column set it needs.

## The store module

New file `api/_lib/home/store.js`. Every function takes and returns plain objects; no HTTP, no
Home Assistant, no `res`.

| Export | Contract |
|---|---|
| `createConnection({ userId, label, baseUrl, token, transport, relayId })` | normalizes the URL, encrypts the token, computes the fingerprint, upserts on the unique key, returns the row **without** any credential field. |
| `listConnections(userId)` | live rows only, credential-free, newest first. |
| `getConnection(id, userId)` | ownership-checked. Returns null rather than throwing on a miss, and never leaks existence across users. |
| `getDecryptedToken(id, userId)` | the ONLY function that returns plaintext. Its own export so every call site is greppable. |
| `recordHandshake(id, { status, statusDetail, capabilities })` | updates status, `last_ok_at` / `last_error_at`, capabilities. |
| `revokeConnection(id, userId)` | sets `revoked_at`, scrubs `access_token_enc` to `''`, writes an audit row. Idempotent. |
| `grantEntity({ homeId, entityId, grantedBy, expiresAt })` / `revokeGrant` / `listGrants(homeId)` | the allowance table. `listGrants` filters expired rows in SQL, not in JS. |
| `logHomeAction(entry)` | fire and forget, mirroring [`api/_lib/audit.js`](../../api/_lib/audit.js): never throws, never blocks a response. |

Rules the module enforces, not its callers:

- A row is never returned with `access_token_enc` on it. Build the safe projection in SQL.
- Ownership is a `WHERE user_id = $1` in every query, never a check in JS after a fetch.
- `getDecryptedToken` writes nothing and logs nothing containing the token. `scrub-secrets.js`
  exists in `api/_lib/`; read it before you log anything near a credential.

## Tasks, in risk order

| # | Task | Files |
|---|---|---|
| 1 | Write the migration. Read `npm run db:status` in full, then apply with `npm run db:migrate`. | `api/_lib/migrations/<ts>_home_connections.sql` |
| 2 | The store module with every export above. | `api/_lib/home/store.js` |
| 3 | Connection verification: a `verifyConnection({ baseUrl, token })` that opens a real `HomeBridge`, reads the capabilities (HA version, entity count, whether `mcp_server` answers and with how many tools), closes it, and returns the measured capability object. Never guesses a capability. | `api/_lib/home/verify.js` |
| 4 | Tests against a real instance and against the recorded fixture. | `tests/home-store.test.js` |
| 5 | Wire `home_connections` into the credential inventory if one exists (`grep -rn "WALLET_ENCRYPTION_KEY" docs/ scripts/`), so the next key rotation covers these rows. | as found |

## Definition of done

Every line mechanically checkable. Paste the command output into your report.

- [ ] `npm run db:status` reports the home migration applied and nothing of yours pending.
- [ ] `grep -rn "access_token_enc" api/ --include=*.js` shows reads only inside `api/_lib/home/store.js`.
- [ ] `grep -rn "getDecryptedToken" api/ --include=*.js` shows exactly the call sites you intend.
- [ ] A round trip proves the credential path: create a connection against a live local HA, read it back, confirm the returned row has no credential field, then `getDecryptedToken` and open a real `HomeBridge` with it that connects.
- [ ] `revokeConnection` twice in a row succeeds both times and leaves `access_token_enc = ''`.
- [ ] `listConnections` for user B never returns user A's row; `getConnection(A.id, B.id)` returns null.
- [ ] A grant for `lock.office_door` does not clear the gate for `lock.front_door`. Assert it.
- [ ] An expired grant is filtered by the SQL, proved with a row whose `expires_at` is in the past.
- [ ] `npx vitest run tests/home-store.test.js packages/home-bridge` passes.
- [ ] `npm run check:rules -- --paths <your files>` is clean.
- [ ] `STRUCTURE.md` gains nothing yet (no user surface), but `docs/smart-home.md` phase 1 is updated to say the store landed.

## Never blocked

| Blocker | Do this |
|---|---|
| `WALLET_ENCRYPTION_KEY` is not set locally | `secret-box.js` falls back to `JWT_SECRET` with a one-time warning, so local development works. Production has it. Do not invent a second key or store plaintext. |
| `db:status` says pending migrations you did not write | Read them. Apply if unrelated and safe; that is the command's normal behaviour. Stop only on something destructive. |
| The unique `(user_id, base_url)` constraint fights a legitimate case | Two records for the same URL under one user is the case it exists to prevent. If a real need appears (two accounts on one HA), the second dimension is the token fingerprint, not dropping the constraint. |
| You want to store the room graph in Postgres | Do not. It is a live projection of a live socket and it goes stale the moment a light changes. Order 02 owns the in-memory cache. |
| Encrypting feels like it can wait | It cannot. A home access token is a key to a physical building. It gets the same primitive as a custodial wallet key, on the first commit. |

## Report format

1. The `db:status` output before and after.
2. The credential round-trip transcript (create, read back credential-free, decrypt, connect).
3. The isolation proof (user B cannot see user A's home).
4. The grant scoping proof.
5. Test output, verbatim.
6. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front of you.
2. Append the outcome to `prompts/finish/home-PROGRESS.md` (create it if this is the first order
   to finish, following the format of a sibling `-PROGRESS.md`).
3. Commit with explicit paths and a subject that describes the diff, and delete this file in that
   same commit:

       git rm prompts/finish/home-01-connection-store.md

If a line genuinely cannot pass inside this session, finish everything else, leave this file in
place, and state exactly which line remains and who owns it. Never delete this file on a partial.
