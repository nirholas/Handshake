# three.ws Home: what we store, for how long, and how to get rid of it

Connecting your home to three.ws hands us a key to a physical building. This page
is the complete answer to what we do with it: every piece of data the Home lane
holds, why it exists, how long it stays, and what removes it. Nothing is left
out, and the parts we deliberately do **not** store are listed alongside the
parts we do, because those are the promises that matter most.

If you only read one thing: **we never store the names of your rooms or devices,
and we never store their states.** There is no record of which lights were on, or
when. A log of that is a log of when you are home, and we do not keep one.

Related reading: [three.ws Home](./smart-home.md) for how the connection works,
and the [platform privacy policy](/legal/privacy) for everything outside this
lane.

---

## The inventory

Every durable thing this lane holds. This table is generated from the same list
the code uses (`INVENTORY` in [`api/_lib/home/privacy.js`](../api/_lib/home/privacy.js)),
and a test fails the build if a table exists in the schema without a row here,
so it cannot quietly go out of date.

| Data | Where it lives | Why it exists | How long | What removes it |
|---|---|---|---|---|
| The address of your home and the label you gave it | `home_connections` | To reach your Home Assistant at all | Until you delete the home | Delete the home, delete your account |
| Your Home Assistant access token, encrypted | `home_connections.access_token_enc` | Home Assistant requires it on every connection, so we have to be able to replay it | Erased the moment you disconnect, before the row itself goes | Disconnect, delete the home, delete your account |
| What your instance turned out to be: version, entity and area **counts**, whether it exposes MCP | `home_connections.capabilities` | So the connect screen and the agent can tell you what is available instead of guessing | Until the home is deleted | Delete the home, delete your account |
| **The names of your rooms, devices and scenes** | **nowhere** | To draw your home and understand what you ask for | **Never stored.** Read live and held in memory only while the connection is open | Nothing to delete |
| **Whether a light is on, a door is locked, a room is warm** | **nowhere** | To render your home live | **Never stored.** See the promise above | Nothing to delete |
| Who else you gave access to, and their role | `home_members` | So a household or a building can share one home without sharing one login | Until the member is removed or the home is deleted | Remove the member, delete the home, delete your account |
| The email address of someone you invited | `home_invites` | To send and honour an invitation | Until accepted, revoked or expired | Revoke the invite, delete the home, delete your account |
| Standing permissions: which specific door or alarm the agent may open without asking again | `home_entity_grants` | You granted them, so the agent stops asking about the one thing you said yes to | Until revoked, until it expires, or until the home is deleted. Also removed when the person who granted it deletes their account | Revoke the grant, delete the home, delete your account |
| A short-lived pairing code (as a one-way digest) for a LAN-only home | `home_relay_pairings` | To introduce the add-on inside your house to your account, once | Ten minutes, single use | Redemption, expiry, deleting the home or your account |
| A voice satellite you set up: its name, the room you named, which agent appears on it, and the encrypted key that lets a browser in that room attach | `home_satellites` | So a speaker in a room can carry your agent, and a screen on the same network can show it even when three.ws is unreachable | Until you remove the satellite | Remove the satellite, delete your account |
| A short-lived satellite setup code (as a one-way digest) | `home_satellite_codes` | To claim a satellite you are setting up, once | Until claimed or expired; expired unclaimed codes are swept daily | Claiming it, the sweep, deleting your account |
| A per-account limit an administrator agreed with you, and the sentence explaining why | `home_plan_overrides` | So an operator whose numbers do not fit a published plan gets the numbers they were promised, on the record | Until removed or your account is deleted | Delete your account, or ask for the override to be removed |
| A pending request to open something, and the sentence you were shown: "Unlock the Front Door" | `home_confirmations` | So what a human approves and what actually runs cannot drift apart | The request is valid for seconds. The record rides your action-log window | The retention sweep, deleting the home or your account |
| Every action the agent took: what, to which entities, whether it asked first, whether it worked | `home_action_log` | So you can answer "what did my agent do in my house" without taking our word for it | **Your choice. 90 days by default** | The retention sweep, deleting the home or your account |
| **The sound of your voice** | **nowhere** | Speech has to become words | **Never stored.** Discarded within the turn that produced it | Nothing to delete |
| **What you said, as text** | conversation state only | The agent has to know what you asked for | Not stored by this lane. It lives in the conversation and goes with it | Clear the conversation |

### The one place a device name is written down

`home_confirmations.summary` holds the sentence you are shown before you approve
something physical: *"Unlock the Front Door"*. It has to name the thing, because
approving "unlock entity 4f2a" is not approving anything. That sentence is
generated on our servers from the entities the safety gate actually resolved, it
is never model output, and it is the only persisted string in this lane that
carries a friendly name. It is bounded by your action-log window for exactly
that reason.

### Why entity state is not stored, restated

The room graph and every entity's state are a live projection of a live
WebSocket. They are stale the moment a light changes, so a database copy would
only ever serve a lie with a timestamp on it. That is the engineering reason. The
real reason is the one above: an occupancy record of a household is not a thing
we want to be holding, for anyone, for any length of time.

If a future feature needs a state history (for analytics, or for an agent's
long-term memory), it is not a small addition to this campaign. It needs its own
explicit opt-in, its own retention window, and its own disclosure, and it does
not inherit any of the above. A test in `tests/home-privacy.test.js` fails the
build if a migration creates a table shaped like one.

---

## Retention of the action log, and the decision behind it

`home_action_log` is the hard one. It is the audit trail an operator needs, and
read the other way round it is a behavioural record of a household: when someone
came home, which rooms they lit, what time the bedroom light went off. Those are
the same rows.

**The default is 90 days.** Long enough to answer "what happened last month",
short enough that the trail never becomes a history of someone's life. Keeping it
forever would make an audit feature into a surveillance archive; keeping it for a
day would make the audit useless.

**It is yours to change.** You can shorten it to a single day. You can lengthen
it, up to ten years, if you operate a building whose obligations are longer than
ours. Lengthening past the 90-day default requires a written reason, enforced by
the database as well as by the API, because "why does this building keep two
years of occupancy data" is a question somebody will eventually be asked and the
answer should already be on the record.

Shortening it never requires a reason. Keeping less of somebody's data is not the
decision that has to be justified.

Your plan also sets a ceiling on how long the log may be kept, and that ceiling
is one-way: it can refuse a request to keep more, and it never shortens what is
already kept. Retroactively truncating an audit trail because a plan changed
would destroy somebody's evidence, and the log's integrity is not a paid feature
on any tier. A request over the ceiling comes back as `retention_over_plan` with
the limit, which is a different answer from "tell us why" so nobody retypes a
justification that was never the problem.

Changing the window applies **immediately**, not at the next sweep. Setting it to
one day deletes everything older than a day before the request returns.

```bash
# Keep two weeks
curl -X PATCH https://three.ws/api/home/privacy \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" --cookie "$COOKIE" \
  -d '{"homeId":"<your home id>","retentionDays":14}'

# A building operator keeping a year
curl -X PATCH https://three.ws/api/home/privacy \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" --cookie "$COOKIE" \
  -d '{"homeId":"<home id>","retentionDays":365,"reason":"Building operator: incident records are kept for one year."}'
```

### The sweep

The purge is a job, not a promise. It runs inside the platform's existing
retention cron, [`/api/cron/db-retention`](../api/cron/db-retention.js), on the
schedule declared in `vercel.json` and synced to Cloud Scheduler by
`scripts/create-gcp-scheduler.mjs`. Section E of that file joins each log row
against its own home's setting, so the whole policy lives in the database rather
than half of it in a cron's environment.

It is deliberately exempt from that cron's storage-pressure valve in both
directions: shortening somebody's audit trail because our disk is full is not our
call to make, and these rows are far too small to be the reason it is full.

The same pass clears two things that have no per-home window because they hang
off an account rather than a house and are dead within minutes by design:
retired confirmation records, which ride the home's own log window, and expired
unclaimed satellite pairing codes, whose creating migration names this pass as
the thing that sweeps them.

---

## Seeing it, exporting it, deleting it

One endpoint, `/api/home/privacy`, signed in, following the same shape as
[`/api/irl/privacy`](../api/irl/privacy.js).

| Call | What it does |
|---|---|
| `GET /api/home/privacy` | The inventory above, plus a live count of what we hold about you right now, plus your current retention setting |
| `GET /api/home/privacy?export=1` | All of it, as a JSON download |
| `PATCH /api/home/privacy` | `{ homeId, retentionDays, reason? }` |
| `DELETE /api/home/privacy` | `{ scope: "home", homeId }` or `{ scope: "all" }` |

The export contains every row of the inventory: `homes_you_own`, `members`,
`invites`, `grants`, `action_log`, `confirmations`, `relay_pairings`,
`satellites`, `satellite_codes`, `plan_override`, and `memberships` (homes
somebody else owns that you belong to). It deliberately does
**not** contain your access token in any form. A key to your front door does not
belong in a file that lands in a downloads folder. The export carries the token's
fingerprint instead, which proves which token is stored without being usable.

### Disconnect is not deletion, on purpose

Disconnecting a home erases the credential and keeps the record, so you can still
answer "what did my agent do in my house last Tuesday" about a house you have
since unplugged. That is the right default, and it is not deletion. `DELETE` with
`scope: "home"` is the other verb: the row and everything pointing at it are
gone, and there is nothing left to read.

### Deleting an account

three.ws does not yet have a single platform-wide "delete my account and
everything in it" endpoint. Rather than promise one, this lane carries its own
complete deletion, exported as
`deleteAllHomeDataForUser(userId, { email })` in
[`api/_lib/home/privacy.js`](../api/_lib/home/privacy.js). It is the function a
platform-wide path calls when it lands, and it is idempotent, so calling it twice
is the same as calling it once.

It removes more than a cascade would. Three things do not follow from deleting
your `users` row on their own, and all three are handled explicitly:

- **Memberships and grants on homes you do not own.** Deleting your account
  removes your access to other people's houses, not just your own.
- **Your identity inside another household's action log.** Those columns carry no
  foreign key, because an actor can be an agent with no account behind it. The
  household keeps its own history; the pointer to you is scrubbed.
- **Invitations addressed to your email**, which live on somebody else's home and
  no cascade from your account reaches.

A related schema bug was fixed as part of this work:
`home_entity_grants.granted_by` referenced `users(id)` with no action, so a
household member who had granted a standing allowance on somebody else's home
could never delete their account at all. It now cascades, which is also the
privacy-correct behaviour: the allowance does not outlive the person who
authorised it.

---

## What reaches our logs

Application logs go to a different system, with a different retention, read by
different people. A home detail that leaks there has the longest tail of any leak
in this lane, so the rule is strict:

- **No entity name, area name, scene name, base URL or token in any log line.**
- **Ids, never names.** An id is opaque; "Sarah's Bedroom Camera" is not.
- **Error messages shown to you may name an entity**, because they have to be
  useful. Error messages sent to logs and alerts must not.
- The action log's freeform `detail` column is passed through
  [`scrubSecrets`](../api/_lib/scrub-secrets.js) before it is written, so a caller
  that spreads an options object carrying a token into it writes `[redacted]`.

Two leaks were found and fixed while writing this page. The disconnect audit
entry was recording the home's base URL and the label the user chose (`"Mum's
flat"`) into the platform's 365-day `audit_log`, where it also outlived the
account, because `audit_log.user_id` is set to null on deletion rather than
removed. It now records the transport and status only, and account deletion
removes the lane's audit rows outright. The dropped-write warning was passing a
raw driver message through, which can echo a bound parameter; it is redacted and
truncated now.

A test in `tests/home-privacy.test.js` reads the lane's source and fails if any
log call carries a base URL, a home label, or a friendly name.

---

## What you are told, and when

Policy pages are not disclosure. The moment somebody is actually deciding whether
to trust us with their building is the moment they are looking at the connect
button, so the text is there, in front of them. It lives in one module,
[`api/_lib/home/disclosure.js`](../api/_lib/home/disclosure.js), because a
promise that exists in two places drifts, and a drifted privacy promise is a
false one.

**On the connect screen**, next to the token field:

> A Home Assistant long-lived access token is a key to your building. Anyone
> holding it can turn on your lights and can also unlock your doors, open your
> garage and disarm your alarm.
>
> We encrypt it before it touches disk and we never show it again, not even to
> you. Deleting the home erases it.
>
> We store the address of your home, the name you give it, and a count of how
> many entities and areas it has. We do not store the names of your rooms or
> devices, and we never store their states: no record of which lights were on, or
> when.
>
> We keep a log of every action the agent takes in your home, so you can check
> it. It is yours: you choose how long it lives, ninety days by default, and you
> can delete it at any time.
>
> The agent asks you first, every time, before anything unlocks, opens or
> disarms. Locking up and closing never asks.

**At the voice opt-in**, before the microphone is ever enabled:

> The wake word is detected on this device. Nothing leaves it until you say the
> wake word or press the button.
>
> After that, the audio of your request is sent to be turned into text, and the
> text is sent to the agent so it can act. Both happen over an encrypted
> connection.
>
> We never store the audio. It is discarded as soon as it has been turned into
> words.
>
> The text of what you said lives in this conversation and goes when the
> conversation does. It is not added to your home's records.
>
> What the agent then does in your home is written to your action log, the same
> as any other action.

Both are served live by `GET /api/home/privacy` under `disclosures`, so the
screens render the same strings this page quotes rather than their own copy of
them.
