# 12. Households: members, roles, per-member scopes, SSO

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Orders
[01](home-01-connection-store.md) to [04](home-04-agent-tools.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
grep -n "user_id" api/_lib/migrations/*home_connections*.sql
ls api/auth/                                             # session, saml, siwe, github, privy, persona
sed -n '1,40p' api/auth/saml/\[action\].js               # what SSO already does
grep -rn "getSessionUser\|getRequestUser" api/home/ --include=*.js | head
```

Order 01 deliberately keyed `home_connections` on a single `user_id` and said this order must not
require rewriting that column. Honour that: add membership beside it, do not replace it.

## Why this is not optional

A house has more than one person in it. Today the owner's account is the only way in, which means
either everyone shares one login (the worst possible outcome for a system that opens doors) or
only one person can use the product. For the enterprise cases (a hotel, an office, a serviced
building), roles and an audit trail are the entire purchase decision.

## The model

### `home_members`

| Column | Type | Notes |
|---|---|---|
| `home_id` | `uuid not null references home_connections(id) on delete cascade` | |
| `user_id` | `uuid not null references users(id) on delete cascade` | |
| `role` | `text not null` | `owner`, `admin`, `member`, `guest`, `viewer`. Check-constrained. |
| `entity_scope` | `jsonb not null default '{"mode":"all"}'` | `{"mode":"all"}` or `{"mode":"allow","areas":[],"entities":[]}` |
| `invited_by` | `uuid references users(id)` | |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |

Primary key `(home_id, user_id)`. The row for the creating user is `owner` and is created in the
same transaction as the connection, backfilled for existing rows by the migration.

### The roles

| Role | Read state | Ungated actions | Confirm a guarded action | Grant standing allowances | Edit layout | Invite | Disconnect |
|---|---|---|---|---|---|---|---|
| `owner` | yes | yes | yes | yes | yes | yes | yes |
| `admin` | yes | yes | yes | yes | yes | yes | no |
| `member` | yes | yes | yes | no | yes | no | no |
| `guest` | scoped | scoped | **no** | no | no | no | no |
| `viewer` | scoped | no | no | no | no | no | no |

**A guest can never confirm a guarded action.** A house sitter should be able to turn lights on
and should not be able to authorise unlocking the front door. That single row is the reason this
table exists.

### Entity scope

`guest` and `viewer` carry an allowlist of areas or entities. Enforcement is **server-side, in
the store's query and in the gate**, never in the UI. A scoped member's room graph is filtered
before it leaves the server, so a guest cannot read the state of a room they were not given.

## Enforcement points, all of them

Every one of these must consult membership, and each needs a test:

1. `api/_lib/home/store.js`: `getConnection` and friends resolve through membership, not
   `user_id` equality. **This is the change that touches everything; do it first and let the
   tests tell you what you missed.**
2. `api/_lib/home/runtime.js`: `acquire` authorises by membership.
3. The room graph projection: filtered by `entity_scope` before serialization.
4. The gate: a guarded action from a `guest` is refused with a role reason, not a confirmation.
5. `POST /api/home/:id/confirm`: role-checked.
6. Grants, layout, invites, disconnect: per the table.
7. The MCP and chat tools: a bearer principal inherits the role of the user whose token it is.
8. `home_action_log`: `user_id` is the acting member, always. "Who did what" is the product here.

## Invitations

- An invite is an email or a link, short-lived, single-use, bound to the home and the role.
- Accepting requires an account. Sign-up flows through the existing paths; do not invent one.
- An invite can be revoked before acceptance and a member can be removed after.
- Removing a member revokes their standing allowances in the same transaction. A stale grant for
  a removed member is exactly the bug that gets someone burgled.

## SSO for the enterprise case

`api/auth/saml/[action].js` already exists. This order does not build SSO; it makes home
membership work with it:

- A SAML-authenticated user joins a household by the same invite path.
- If SAML supplies group claims, document the mapping to roles and implement it if the existing
  SAML handler already surfaces groups. If it does not, say so plainly and leave the manual path,
  rather than half-wiring a claim mapping.
- Deprovisioning: a removed identity must lose home access. Whatever the existing session
  revocation path is, ensure it reaches `home_members`.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Migration: `home_members`, backfill every existing connection with an `owner` row, in one transaction. | `api/_lib/migrations/<ts>_home_members.sql` |
| 2 | Store: membership resolution replacing `user_id` equality, with the role returned on every read. | `api/_lib/home/store.js` |
| 3 | Scope filtering in the graph projection. | `api/_lib/home/store.js` or a sibling projection module |
| 4 | Role enforcement at all eight points. | as listed |
| 5 | Invitations: schema, endpoints, UI. | `api/home/[id]/members.js`, `src/home/members.js` |
| 6 | Member management UI: list, role change, remove, per-member scope editor, pending invites. | same |
| 7 | SAML notes and, if groups are available, the mapping. | `docs/home-security.md` or a new doc |
| 8 | Tests: a role matrix over every enforcement point. | `tests/home-roles.test.js` |

## Definition of done

- [ ] The role matrix above exists as an executable test that iterates roles by enforcement point. Paste the run: every cell asserted.
- [ ] A `guest` receives a role refusal, not a confirmation prompt, when attempting an unlock. Transcript.
- [ ] A scoped `guest` cannot read the state of an out-of-scope room: the filtered graph is proven at the API boundary, not in the UI.
- [ ] Removing a member deletes their standing allowances in the same transaction. Prove with the rows before and after.
- [ ] An invite is single-use and expires. Two refusals.
- [ ] The backfill gave every pre-existing connection exactly one `owner` row. Paste the count query.
- [ ] `home_action_log` attributes actions to the acting member, proved with two members acting on one home.
- [ ] The order 03 tenancy tests still pass unchanged: a non-member still gets 404, not 403.
- [ ] `npx vitest run --root .` shows no new failures.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| The membership change touches many call sites | That is why it is task 2 and why the tests come with it. Change the store's contract, run the suite, and fix what breaks. Do not add a parallel "or user_id equals" branch; that is how a role system becomes decorative. |
| Deciding whether a `member` may confirm | Yes. A `guest` may not. That is the line: a member lives there, a guest is visiting. |
| SAML groups are not exposed by the existing handler | Say so in the doc and ship the manual invite path. Do not half-wire a claim mapping you cannot test. |
| Tempted to let the UI hide what the server allows | Never. Every rule in the table is enforced server-side, and the UI merely reflects it. Prove enforcement at the API. |
| An enterprise asks for a custom role | Not in v1. The five cover households, house sitters, offices and hotels. Custom roles need a policy engine and that is a different product decision. |

## Report format

1. The full role matrix test output.
2. The guest-refusal and scope-filtering transcripts.
3. The member-removal grant cleanup proof.
4. The backfill count.
5. The two-member attribution proof.
6. Full-suite output.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-12-households-rbac.md

Never delete it on a partial.
