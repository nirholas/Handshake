# Crews

A **crew** is a group of accounts whose agents fly one short tag. It is the group
half of the social system: [friends](/play) are one-to-one and live in the
in-world drawer, a crew is the name a set of people operate under, and it has a
public headquarters at [`/crews`](https://three.ws/crews).

Every crew has:

- a **tag**: 2 to 6 letters or digits, unique across the whole site, rendered
  over its members' avatars in the 3D world,
- a **name**: 2 to 32 characters, what people read,
- an **owner**: the founder, who can remove members; ownership passes to the
  longest-standing member if the owner leaves,
- a **roster**: one account belongs to at most one crew at a time.

## The headquarters

`/crews` renders the crew as a room rather than a list. Each member stands in it
as their own agent's 3D avatar, resolved from the account's agent identity, and
is lit when they are online in a realm and unlit when they are not. Presence is
read from the same Redis keys the in-world friends list reads, so "in world"
means the same thing in both places.

Three views share the page:

| URL | Who sees it | What it shows |
| --- | --- | --- |
| `/crews` | signed out | The public crew directory |
| `/crews` | signed in | Your HQ, or the found-a-crew form plus any invites addressed to you |
| `/crews/<TAG>` | anyone | That crew's HQ, read-only, shareable |

A crew's colour is derived from its tag (an FNV-1a hash to a hue), so the same
crew looks the same in the room, the directory, and the share card without
anyone uploading art or storing a palette.

### Rendering budget

Browsers cap live WebGL contexts at roughly 16, and a large crew asking for one
canvas per member would evict the rest of the site's viewers. `LIVE_FIGURE_BUDGET`
in [`src/crews-page.js`](../src/crews-page.js) caps how many members render as a
live `<agent-3d>` (6); everyone past that renders as their avatar's still image,
and live figures mount only when they scroll into the stage.

Two rules keep those contexts alive once they exist. Presence refreshes every 20
seconds, and the room writes the new state into the figures already standing
rather than rebuilding the stage: the cast is rebuilt only when the membership
itself changes, so a long-open tab is not creating and discarding WebGL contexts
four times a minute. And a figure whose model fails to load (the agent's GLB was
replaced, storage had a bad minute) falls back to the member's still portrait on
the same plinth, so the person keeps standing in the room instead of leaving a
gap.

## API

All endpoints answer `{ data: … }` on success and
`{ error: <code>, error_description: <sentence> }` on failure.

### `GET /api/crews`

The caller's crew, roster and pending invites. Requires a session or bearer
token. Returns empty values rather than an error when the caller is in no crew.

```bash
curl -s https://three.ws/api/crews -H "Authorization: Bearer $THREE_WS_TOKEN"
```

```json
{
  "data": {
    "crew": { "id": "…", "tag": "NOVA", "name": "Nova Collective", "role": "owner", "isOwner": true, "memberCount": 3 },
    "members": [
      {
        "id": "…", "name": "Ada", "username": "ada", "avatarUrl": "https://…/ada.png",
        "role": "owner", "joinedAt": "2026-07-31T09:12:00.000Z",
        "online": true, "realm": "mainland", "server": 2,
        "standee": { "agentId": "…", "agentName": "Ada-1", "modelUrl": "https://…/ada-1.glb", "thumbUrl": "https://…/ada-1.png" }
      }
    ],
    "invites": []
  }
}
```

`standee` is the member's renderable agent. It is `null` when the account has no
agent, and `modelUrl` is `null` when the agent's avatar is private: visibility is
enforced exactly as `api/agents.js` enforces it, so a private model can never
leak through a roster.

### `POST /api/crews`

Every mutation goes through one endpoint, selected by `action`.

| `action` | Body | Effect |
| --- | --- | --- |
| `create` | `{ tag, name }` | Found a crew; the caller becomes owner |
| `invite` | `{ userId }` | Invite an account (any member may invite) |
| `accept` | `{ crewId }` | Accept an invite; clears your other invites |
| `decline` | `{ crewId }` | Decline an invite |
| `leave` | `{}` | Leave; disbands the crew if you were the last member |
| `kick` | `{ userId }` | Owner only: remove a member |

```bash
curl -s https://three.ws/api/crews \
  -H "Authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"create","tag":"NOVA","name":"Nova Collective"}'
```

Mutations are CSRF-guarded. A browser calling with the session cookie must send a
single-use token from `GET /api/csrf-token` in `X-CSRF-Token` (`src/api.js`'s
`apiFetch` does this for you) or the request answers `403 csrf_missing` /
`403 csrf_invalid`. Bearer-token callers are exempt: the token is itself the
proof of intent, and no browser attaches it on a cross-site request.

A malformed envelope answers with its own status rather than a guess at your
intent: `415` for a non-JSON content-type, `413` for an oversized body, `400
bad_body` for anything that is not a JSON object.

Error codes you should handle: `bad_tag`, `bad_name`, `tag_taken`,
`tag_reserved`, `already_in_crew`, `target_in_crew`, `no_invite`, `not_owner`,
`not_member`, `self_invite`, `self_kick`.

`self_invite` and `self_kick` close the two loops a UI can otherwise walk a user
into: inviting yourself, and an owner removing themselves instead of leaving
(which is what hands ownership on).

`tag_reserved` covers tags that would collide with a route segment (`SEARCH`,
`INDEX`, `API`, `ADMIN`, `NEW`, `ME`, `ALL`, `NULL`). Both `/crews/:tag` and
`/api/crews/:tag` resolve an exact file before the dynamic segment, so a crew
tagged `SEARCH` would be permanently unreachable at its own URL. The tag is
refused at founding time, which is the only point where that is fixable without
breaking an existing crew's link.

### `GET /api/crews/<TAG>`

The public view of one crew: identity plus roster with presence and standees. No
auth required. `404 not_found` when no crew flies that tag.

The tag is case-insensitive and a trailing slash is fine, so `/api/crews/NOVA`,
`/api/crews/nova` and `/api/crews/NOVA/` are one resource. The path is the only
thing that selects the crew: a `?tag=` on the query string is ignored, so a link
can never answer with a different crew's roster than the one its URL names.

### `GET /api/crews/search?q=<term>`

Accounts to invite, for a caller who is already in a crew. Each hit carries what
the inviter needs before clicking:

```json
{ "data": { "results": [
  { "id": "…", "name": "Ada", "username": "ada", "avatarUrl": "…", "crew": null, "invited": false },
  { "id": "…", "name": "Grace", "username": "grace", "avatarUrl": "…", "crew": { "tag": "AXI", "name": "Axiom" }, "invited": false }
] } }
```

`crew` non-null means they already fly someone else's tag and cannot be invited;
`invited` means your crew already has an invite out to them. The UI renders both
as state on the row instead of letting the click fail.

Returns `400 no_crew` when the caller is in no crew: searching people to invite
with no crew to invite them to is a dead path, so it is closed here rather than
rendered and then rejected on submit.

### `GET /api/crews/directory?limit=24`

Every crew with at least one member, biggest first, with up to five member faces
each. Public and cacheable; no auth.

## Where the code lives

| Piece | File |
| --- | --- |
| Page markup | [`pages/crews.html`](../pages/crews.html) |
| Page logic | [`src/crews-page.js`](../src/crews-page.js) |
| Page styles | [`src/crews.css`](../src/crews.css) |
| Data layer | [`api/_lib/crews-store.js`](../api/_lib/crews-store.js) |
| Endpoints | [`api/crews/`](../api/crews) |
| Presence | [`api/_lib/presence-store.js`](../api/_lib/presence-store.js) |
| Schema | `api/_lib/migrations/2026-06-05-crews.sql` |
| Tests | [`tests/crews-shared.test.js`](../tests/crews-shared.test.js), [`tests/crews-wiring.test.js`](../tests/crews-wiring.test.js) |

The in-world friends drawer links to the HQ from its header, which is how a
player who is already social in the world finds the group surface.
