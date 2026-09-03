# Households: members, roles and per-member scopes

A house has more than one person in it. Before this landed, the account that connected a home was
the only way into it, which left exactly two options: share one login (the worst possible outcome
for a system that opens doors) or let one person use the product. For a hotel, an office or a
serviced building, the roles and the attribution are the entire purchase decision.

This document is the contract. It covers the five roles, what each one may do, how a scoped member
sees a narrowed house, how invitations work, and what happens to somebody's access when they leave.

Related: [smart-home.md](smart-home.md) for why three.ws writes zero device code and what the Home
Assistant bridge does.

---

## The rule everything else hangs off

**A guest can never confirm a guarded action.**

Home Assistant's published description of its own `intent__HassTurnOff` tool reads: *"Turns
off/closes a device or entity. For locks, this performs an 'unlock' action."* Verified against a
live instance with a lock exposed to Assist: an agent told to turn something off really does open
the front door, and nothing in the tool name says so.

So "turn the lights off" and "open the building" are the same call with different targets, and the
only thing separating them is who is allowed to say yes. A house sitter should be able to turn the
lights on. A house sitter should not be able to authorise unlocking the front door. That single
distinction is why this table exists, and it is enforced on the server, once, in
`api/_lib/home/members.js`.

## The five roles

| Role | Read state | Ungated actions | Confirm a guarded action | Grant standing allowances | Edit layout | Invite | Manage connection | Disconnect |
|---|---|---|---|---|---|---|---|---|
| `owner` | whole house | yes | yes | yes | yes | yes | yes | yes |
| `admin` | whole house | yes | yes | yes | yes | yes | yes | no |
| `member` | whole house | yes | yes | no | yes | no | no | no |
| `guest` | scoped | scoped | **no** | no | no | no | no | no |
| `viewer` | scoped | no | no | no | no | no | no | no |

Read it as the product decision it is:

- **`owner`** connected the house. Exactly one per home, enforced by a partial unique index, which
  is what makes "you cannot remove the last owner" a schema fact instead of a check somebody
  forgets. Ownership is never assignable and never invitable; transferring it is an update of that
  one row.
- **`admin`** runs the household and cannot take the house off the platform. An admin may add a
  peer admin and may not remove one; only the owner can. You can hire, you cannot fire your equals.
- **`member`** lives here. Acts, confirms, arranges the layout. Cannot hand out access and cannot
  leave a standing allowance behind, because a permanent yes to unlocking something should come
  from the person who owns the risk.
- **`guest`** is visiting. Scoped, and never a confirmation.
- **`viewer`** is a wall display or a monitoring seat. Scoped, and reads only.

**Custom roles are deliberately out of scope.** Five cover households, house sitters, offices and
hotels. Anything past that needs a policy engine with its own evaluation order, conflict rules and
audit surface, which is a different product than "let my partner turn the lights on".

## Capabilities, not role strings

Every enforcement point names a capability rather than testing a role, so adding a role is a change
to one table and not a grep across the codebase. The vocabulary is `read`, `act`, `confirm`,
`grant`, `layout`, `invite`, `manage`, `disconnect`.

`grant`, `invite` and `manage` are held by the same two roles today and are still three names.
They are powers over different things (a lock, the roster, the connection), and collapsing them
would mean a future role could not hold one without the others.

```js
import { requireMembership } from '../_lib/home/members.js';

const gate = await requireMembership(homeId, user.id, 'confirm');
if (!gate.ok) return error(res, gate.status, gate.code, gate.reason);
// gate.role   the role this caller holds
// gate.scope  {mode:'all'} or {mode:'allow', areas:[], entities:[]}
```

`requireMembership` returns a result rather than throwing, because the two failure modes need
different answers:

| Outcome | Status | Meaning |
|---|---|---|
| `{ok: true, role, scope, membership}` | | the caller holds the capability |
| `{ok: false, code: 'home_not_found'}` | 404 | not a member, or no such home, or the home was revoked |
| `{ok: false, code: 'role_forbidden', role, capability, reason}` | 403 | a member, but this role may not do this |

**404 and never 403 for a non-member.** A stranger must not be able to learn that a home id is
real, so "you are not in this household" and "that home does not exist" are the same answer. A
member who lacks a capability gets 403 naming their role, because a guest refused an unlock
deserves to be told it is their role and not a broken door.

## Entity scope

`guest` and `viewer` carry an allowlist of areas and entities:

```json
{ "mode": "allow", "areas": ["kitchen"], "entities": ["light.hall_lamp"] }
```

`{"mode":"all"}` is the whole house, and it is what every non-scoped role gets. Promoting a guest to
a member normalizes their scope to `{"mode":"all"}` in the same statement, so a stale allowlist
cannot silently keep narrowing somebody who was widened.

There is no domain form (`"all locks"`), for the same reason `home_entity_grants` refused a
`granted_domain` column: a scope that names a domain is a scope nobody can reason about at the
moment they grant it, and a user who let the agent open the office door has not let it open the
front door.

### Scope is enforced in the projection, never in the UI

`filterGraphForScope(graph, scope)` runs server side, before serialization. Three things happen and
all three matter:

1. **Rooms the member was not given are removed, not marked.** A room whose name reached the client
   has been disclosed. A `visible: false` flag would be a leak with a checkbox on it.
2. **In a room reached through a single entity grant, the room's rollups are recomputed.** The
   unfiltered hall reports two lights with one on; a guest who was given one lamp sees one light
   with none on. Leaving the original rollup would report the state of exactly the entities the
   filtering just removed.
3. **Floors with no visible room are removed**, because the floor list is the shape of the building.

For actions rather than reads, `outOfScopeEntities(scope, targets)` names every resolved target
that falls outside the scope. Pass it the RESOLVED entities, not the raw argument: an area name or
a device id in a request expands to the entities it actually touches, and that expansion is the
only form that answers "did it open the front door".

## Where it is enforced

Membership resolution replaced `user_id` equality in the store, so every surface above it became
membership-aware at once rather than each one growing its own check.

| Point | Where | How |
|---|---|---|
| Store reads | `api/_lib/home/store.js` | `getConnection`, `listConnections` and `getDecryptedToken` join `home_members`. Each row comes back carrying `role` and `entity_scope`. There is deliberately no `or user_id = ...` beside the join. |
| Bridge runtime | `api/_lib/home/runtime.js` | `acquire` reads the home and its token through those two store functions, so it inherits membership without a check of its own |
| REST routes | `api/_lib/home/access.js` | `resolveHomeAccess(req, res, homeId, capability)` is the single door. It returns `role` and `scope`, refuses a non-member 404 and a member without the capability 403 |
| Room graph | `api/home/[id].js`, `api/home/[id]/stream.js` | `filterGraphForScope` runs before serialization, on the single read and on every streamed frame |
| The gate | `api/home/[id]/call.js` | `confirmed: true` from a role without `confirm` is refused before the socket is acquired, and an out-of-scope target is refused against the live graph |
| Scenes | `api/home/[id]/activate.js` | needs `act`; a scoped role is refused outright, because a scene reaches the whole house and a half-run scene is worse than none |
| Confirmation redemption | `api/home/[id]/confirm.js` | needs `confirm`; bearer principals are refused before authentication |
| Chat and MCP tools | `api/_lib/home/tools.js` | a bearer principal inherits the role of the account whose token it is, through `requireMembership` |
| Action log | everywhere it is written | `user_id` is the acting member, never the connection's owner |

Route by route:

| Route | Capability |
|---|---|
| `GET /api/home` | membership list (every home this account is in, each with its role) |
| `GET /api/home/:id` | `read` |
| `DELETE /api/home/:id` | `disconnect` |
| `GET /api/home/:id/stream` | `read` |
| `GET /api/home/:id/log`, `/macros` | `read` |
| `POST /api/home/:id/call`, `/activate` | `act`, plus `confirm` when the body carries `confirmed: true` |
| `POST /api/home/:id/confirm` | `confirm` |
| `GET /api/home/:id/grants` | `read` |
| `POST`, `DELETE /api/home/:id/grants` | `grant` |
| `/api/home/pair` on an existing home | `manage` |
| `GET /api/home/:id/members` | `read` |
| `POST`, `PATCH`, `DELETE /api/home/:id/members` | `invite` |

`resolveHomeAccess` defaults to `read`, which is the safe default and also a silent one: a new
route that writes to a house and forgets to name a capability would be admitted to a viewer.
`tests/home-roles.test.js` reads every call site under `api/home/` and fails if any of them omits
it, because that omission is invisible at runtime until somebody exploits it.

## Invitations

An invite is an email address plus a link: single use, expiring (7 days by default), and bound to
one home and one role.

- **The plaintext token leaves the server exactly once**, in the `invite_url` of the creating
  response. What is stored is `sha256` of it. An invite is a bearer credential for a role in a
  building, so a leaked database must not be a set of working keys.
- **Single use is enforced in the redeeming UPDATE's own WHERE clause**, not by a read followed by
  a write, so two people opening the same link at the same moment cannot both become members.
- **Accepting requires an account, and this endpoint does not create one.** Registration and
  sign-in already exist, they carry the captcha, the password rules and the session handling, and a
  second door into account creation is a second door to keep secure. An unauthenticated POST
  answers 401 with the invite intact, so a client can send the visitor through `/register` and
  bring them back to the same link.
- **A re-invite to the same address replaces the outstanding one** rather than stacking a second
  working key.
- **An account that is already in the household keeps the role it has.** An invite is a way in, not
  a way to be quietly demoted (or promoted) by a stale link. Use the roster `PATCH` to change
  somebody's role.
- **Ownership is never invitable.** `createInvite` throws on `role: 'owner'` and the schema's check
  constraint refuses the row.

## Removing somebody

`removeMember` deletes the membership row **and every standing allowance that member authorised, in
one transaction.** The two halves are inseparable: a standing allowance is a permanent yes to
unlocking one specific thing, recorded against the account that said it. Leaving a removed member's
allowances in place means the front door still opens on the authority of somebody who no longer
lives there, and nothing in any UI would ever show it.

```
before                                   after
lock.office_door   granted by Sam        lock.front_door   granted by the owner
cover.garage       granted by Sam
lock.front_door    granted by the owner
```

## The API

| Method | Path | Capability | What it does |
|---|---|---|---|
| `GET` | `/api/home/:id/members` | `read` | the roster, the outstanding invitations, and the matrix |
| `POST` | `/api/home/:id/members` | `invite` | invite an email address to a role and scope |
| `PATCH` | `/api/home/:id/members` | `invite` | change a member's role or scope |
| `DELETE` | `/api/home/:id/members` | `invite` | remove a member (`user_id`) or withdraw an invitation (`invite_id`) |
| `GET` | `/api/home/invites/:token` | none | what this link is for, without spending it |
| `POST` | `/api/home/invites/:token` | account | redeem it and join the household |

Reading the roster is a plain `read` capability on purpose: you should be able to see who else holds
keys to the house you are in.

Creating an invite:

```bash
curl -X POST https://three.ws/api/home/$HOME_ID/members \
  -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  --cookie "__Host-sid=$SESSION" \
  -d '{"email":"sitter@example.com","role":"guest",
       "scope":{"mode":"allow","areas":["kitchen"],"entities":["light.hall_lamp"]}}'
```

```json
{
  "invite": { "id": "...", "email": "sitter@example.com", "role": "guest",
              "scope": { "mode": "allow", "areas": ["kitchen"], "entities": ["light.hall_lamp"] },
              "expires_at": "2026-09-10T03:31:52.462Z" },
  "invite_url": "https://three.ws/home/join?invite=BBQFpFGdBbULN9KQUhbIfw0SiFA0DDbPx1iFFpx2Lng"
}
```

The refusals, in full:

| Situation | Status | Code |
|---|---|---|
| not a member of this home | 404 | `home_not_found` |
| a member, but the role lacks the capability | 403 | `role_forbidden` |
| an admin acting on the owner row | 403 | `role_forbidden` |
| an invite link that was never issued | 404 | `invite_not_found` |
| an invite already redeemed | 410 | `invite_spent` |
| an invite past its expiry | 410 | `invite_expired` |
| an invite withdrawn before use | 410 | `invite_revoked` |
| the home was disconnected | 410 | `home_revoked` |

## Attribution

`home_action_log.user_id` is the **acting member**, always, and never the connection's owner. Two
people acting in one house produce two rows under two ids, and a refused guarded action records the
refusal with `confirmed_by` null: an audit trail that named a confirmer for an action nobody
confirmed would be lying about who opened a door.

Roster changes (invite, role change, invitation withdrawn, member removed, invitation accepted) go
to the general `audit_log` as `household.*` actions, because they are writes against the household
and not against the house.

## SSO and the enterprise case

three.ws has SAML SSO at `/api/auth/saml/*` (login, ACS, logout). Households work with it, with one
honest limitation.

**SAML group claims are not available.** Measured, not assumed: `extractSamlIdentity` in
`api/_lib/saml.js` returns `{issuer, nameID, nameIDFormat, email, name, sessionIndex}` and nothing
else. It checks the common spellings for email, display name, given name and surname, and every
other attribute in the assertion is dropped before the handler sees it. There is no `GROUP_KEYS`
list and no group plumbing anywhere below it.

So there is no role mapping to implement, and half-wiring one that cannot be tested against a real
IdP would be worse than not having it. **A SAML-authenticated user joins a household through the
same invite path as everybody else**, and their role is set by a person who already administers the
home. For an office rolling out to a floor of people, that is one invite per person, or one shared
link per role sent to a distribution list.

If group-based provisioning becomes a requirement, the work is: collect group attributes in
`extractSamlIdentity` (add a `GROUP_KEYS` list beside the existing ones and return the matches),
store a per-issuer group-to-role mapping, and apply it at ACS time. That is a real feature with a
real test surface, and it needs an IdP to test against. It is not a line of glue.

### Deprovisioning

**Membership outlives a session, so revoking sessions is not enough.** An account with a `guest` row
in somebody's house still has standing access to a building after every one of its sessions is
gone, and any standing allowance it left behind still opens a lock on its authority.

`revokeAllMemberships(userId)` is the half that reaches the houses. It removes the account from
every household it is a member of, deletes every standing allowance it authorised anywhere, and
revokes any invitation it accepted. It is wired into account deletion in `api/auth/[action].js`,
beside the session and refresh-token revocation.

**Owner rows are left alone.** An owner's home is their own record, and cascading a deprovision into
deleting somebody's house is not a decision a webhook gets to make. Their allowances are still
revoked.

SAML has no SLO endpoint and no SCIM provisioning here, so upstream-initiated deprovisioning is not
automatic today: an IdP deactivating a user stops them signing in and does not by itself reach
`home_members`. Call `revokeAllMemberships` from whatever path removes the account.

## Where the code is

| Piece | File |
|---|---|
| Schema, backfill, the owner trigger | `api/_lib/migrations/20260903130000_home_members.sql` |
| The role matrix, scope, invitations, deprovisioning | `api/_lib/home/members.js` |
| The roster endpoint | `api/home/[id]/members.js` |
| Invite redemption | `api/home/invites/[token].js` |
| The matrix as an executable test | `tests/home-roles.test.js` |

The owner row is created by a database trigger on `home_connections`, not by the application. "A
connection has an owner" is an integrity fact about the data rather than a step in one code path, so
it holds for every writer: the connection store, a future admin tool, a support script, a manual
insert. A home can never exist in a state where nobody can administer it.
