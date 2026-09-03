# Home plans, entitlements and quotas

How three.ws decides what a connected house costs, what each plan covers, and the two things no
plan may ever refuse.

This document is both the reference for the mechanism and the **pricing proposal put to the
owner**. Every number in the plan table is a proposal with a measured cost behind it, and every
number is a config value: applying an owner-approved figure is an environment variable on a
running service, not a deploy.

Related: [`docs/smart-home.md`](smart-home.md) (what the lane is),
[`docs/home-privacy.md`](home-privacy.md) (retention and deletion),
[`docs/home-households.md`](home-households.md) (roles and seats).

---

## The two commitments to read first

**1. A limit never blocks a safety action.** Over quota, past due, downgraded, paused: a user can
still lock their door, close their garage, close a water valve and arm their alarm. The safe
direction is always free. A product that will not let someone lock up because they hit a quota is
indefensible.

**2. Nothing about the gate is a paid feature.** Confirmation prompts, the action log's integrity
and every safety property of the role system exist on every tier, including the free one. There is
no metered dimension for any of them and there must never be one. Selling safety would be wrong,
and it would also make the free tier a liability.

Both are enforced in code rather than promised in prose.
[`api/_lib/home/entitlements.js`](../api/_lib/home/entitlements.js) checks the safety exemption
*before* it looks at any counter, any plan or any pause state, and it gets the list of safe moves
from [`packages/home-bridge/src/safety.js`](../packages/home-bridge/src/safety.js) rather than
keeping a copy that could drift. `tests/home-entitlements.test.js` asserts both, first in the file.

---

## The cost model, measured

The Home lane's cost model is unusual, and the unusual part decides the shape of the plans: **the
expensive thing is not an action, it is a held socket.** A house that is connected and idle
occupies heap on a Cloud Run instance for the whole month whether or not anybody speaks to it, so
a plan metered only on actions would charge nothing for the dominant cost.

Everything below was measured, not assumed. Re-derive it with:

```bash
node scripts/home-test-instance.mjs --up --onboard --seed --json --name cost
node --expose-gc scripts/measure-home-entitlement-cost.mjs \
  --url http://127.0.0.1:<port> --token "<token>" --homes 16 --rates
```

`--rates` reads the live Cloud Run prices from Google's own Cloud Billing Catalog API rather than
from a remembered figure. The production service shape comes from
`gcloud run services describe three-ws-api --region us-central1`: 4 GiB, 2 vCPU, concurrency 160.

| Dimension | Measured marginal cost | How it was read (2026-09-03) |
|---|---|---|
| A connected home | **$0.0155 / home / month** | 16 real WebSocket connections to a real Home Assistant (125 entities): 302 KB heap, 262 KB RSS marginal per connection. At 60% of a 4 GiB instance that is ~9,800 homes per instance; the instance costs $152.42/month at $0.0000025/GiB-s + $0.000024/vCPU-s |
| An open live stream | **$0.0066 / stream / month** | a 23,036-byte room graph, serialized once per 10 s, at the same rates |
| An agent turn, default chain | **$0** | the default provider chain leads with platform-held free lanes (`isFreeLane` in [`api/_lib/llm-pricing.js`](../api/_lib/llm-pricing.js)) |
| An agent turn, Vertex Gemini 2.5 Flash | **$0.0025** | `costMicroUsd` over the real 6,359-token home prompt (the room graph) plus 250 output tokens |
| An agent turn, Claude Haiku 4.5 | **$0.0076** | same prompt, same function |
| An agent turn, Claude Sonnet 5 | **$0.0228** | same prompt, same function |
| A voice minute | **$0** | the default lanes are keyless: Edge Read Aloud TTS ([`api/_lib/tts-edge.js`](../api/_lib/tts-edge.js)) and NVIDIA Riva ASR ([`api/_lib/asr-nvidia.js`](../api/_lib/asr-nvidia.js)) |
| An action-log row | negligible | a busy evening of voice control is a few dozen rows of a few hundred bytes |

### What that measurement changed

Two findings inverted the assumptions this work started from, and both are worth stating plainly
because they point the pricing in the opposite direction:

**One agent turn on a paid model costs more than a year of holding that house's socket.**
$0.0228 against $0.0155 per month. The connection is not the expensive part after all; the prompt
is, because the room graph makes a home prompt large.

**Voice is not a cost driver at all.** The default speech lanes are keyless and cost the platform
nothing per utterance. Voice minutes are metered because an unbounded always-listening satellite is
an abuse surface and because a paid speech lane can be selected, not because the default costs
money.

### Can the free tier carry a connected home?

**Yes, comfortably.** At 1.6 cents per home per month, ten thousand free connected homes cost
about $155 a month, which is roughly one warm Cloud Run instance. The honest constrained free tier
some cost models would have forced (a session-scoped connection that closes when the tab does) is
not necessary and would make the free tier worse for no saving worth having. The free tier gets a
real, persistent, always-connected home.

The dimension that actually needs a ceiling is the agent turn on a paid model, and that is where
the tiers separate.

---

## The dimensions

| Dimension | Scope | Period | Scales with $THREE | Why it is metered |
|---|---|---|---|---|
| `homes` | account | concurrent | yes | the held socket, the lane's primary cost |
| `members` | per home | concurrent | **no** | the enterprise dimension: seats are sold, not held |
| `streams` | per home | concurrent | yes | a wall display is a subscriber we serialize the house to |
| `voiceMinutes` | account | monthly | yes | abuse surface, and a paid speech lane can be chosen |
| `agentTurns` | account | monthly | yes | the only dimension where a turn can really spend money |
| `logRetentionDays` | account | ceiling | yes | a hotel needs a year of attribution, a household needs last Tuesday |
| `relayConnections` | account | concurrent | yes | a dial-out tunnel costs what a direct connection costs |

`members` deliberately does **not** scale with the $THREE ladder. Holding a bag and buying seats
for a hotel are different purchases, and multiplying one by the other prices neither correctly.

`logRetentionDays` is a **ceiling on what a user may set**, never a value of its own.
[`api/_lib/home/privacy.js`](../api/_lib/home/privacy.js) owns the per-home retention setting, its
90-day default and the purge. The ceiling is checked when the user raises the setting and is never
applied retroactively: shortening somebody's existing audit trail for a billing reason would
destroy their evidence, and the log's integrity is not for sale on any tier.

---

## The proposed plan table

**This table is a proposal. Nothing here is a decided price.**

| Dimension | User (free) | Beta | Pro | Three Dimensional |
|---|---|---|---|---|
| Connected homes | 1 | 2 | 5 | unlimited |
| Household seats per home | 3 | 5 | 15 | unlimited |
| Live streams per home | 2 | 3 | 10 | unlimited |
| Voice minutes / month | 300 | 600 | 3,000 | unlimited |
| Agent turns / month | 1,000 | 2,500 | 15,000 | unlimited |
| Action-log retention | 90 days | 90 days | 365 days | 3,650 days |
| Relay connections | 1 | 1 | 5 | unlimited |

Reasoning, dimension by dimension:

- **Homes at 1 on free** is not a cost constraint (a free home costs 1.6 cents a month). It is the
  natural upgrade trigger: the second house is a household with an office or a parent's place, and
  that is a person who has already decided the product is worth something.
- **Turns at 1,000 free** covers roughly 33 agent conversations a day. On the default free LLM
  chain that costs the platform nothing; on Sonnet 5 it would be $22.83, which is why the ceiling
  exists at all. Pro's 15,000 is $342 at Sonnet prices and $0 on the default chain, so the number
  to watch is the paid-model mix, not the turn count.
- **Voice at 300 minutes free** is five hours of speech a month. It costs nothing today; the
  number is an abuse ceiling, and it should move the day a paid speech lane becomes the default.
- **Seats at 3 free** is a household. 15 on Pro is a small office. A hotel is an override, not a
  tier, which is exactly the point of the override row.
- **Retention at 90 days free** deliberately equals the platform default, so no existing home is
  retroactively over its ceiling the day this ships. Pro's 365 is the compliance answer;
  3,650 is the schema's hard maximum and promising more would be a promise the database refuses.

The `holder` badge intentionally carries the same base numbers as `user`: holding $THREE raises
quotas through the ladder's existing `rateMultiplier` (2x Bronze through 10x Genesis) rather than
through a second set of thresholds. A Genesis holder therefore gets 10 homes and 10,000 turns
without any of that being modelled twice.

### Applying a number

Every limit is env-overridable as `HOME_LIMIT_<TIER>_<DIMENSION>` in upper snake case:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars HOME_LIMIT_PRO_HOMES=25,HOME_LIMIT_USER_AGENT_TURNS=1500
```

`unlimited` and `-1` both mean no limit. An unparseable value is ignored and the default stands,
because a typo that resolved to zero would lock somebody out of their own house. Note
`--update-env-vars`, never `--set-env-vars`, which replaces the whole environment.

---

## Per-account overrides: the enterprise row

Enterprise limits are configurable per account rather than hardcoded, because that is what the
sales conversation is. A hotel does not buy "Pro", it buys 400 rooms and a year of attribution,
and the shape of that deal is known on the call and not at deploy time.

```bash
curl -X POST https://three.ws/api/home/plan \
  -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" --cookie "$SESSION" \
  -d '{
        "action": "override",
        "user_id": "…",
        "limits": { "homes": 400, "members": "unlimited", "logRetentionDays": 730 },
        "note": "Hotel group: 400 rooms, one year of attribution. Agreed on the 2026-09-03 call."
      }'
```

Admin session only. Sending `"limits": {}` clears the override and returns the account to its plan.
An unknown dimension is dropped rather than stored, so a typo in a form cannot install a limit
nothing reads. A dimension the deal did not mention keeps its plan value.

The `note` is not decoration: "why does this account have 400 homes" is a question somebody asks
six months after the person who agreed it has moved on, and the answer has to be in the row.

---

## The downgrade path

**A downgrade never disconnects a house.** When a plan change leaves an account with more connected
homes than it covers, the excess are **paused**:

- `home_connections.deactivated_at` and `deactivated_reason` are set. Nothing else changes.
- The row survives. The encrypted access token survives. The action log survives with its lineage.
- `revoked_at` is **not** set. Revoke is the user saying "take my house off this platform" and it
  scrubs the credential irreversibly; a pause is the platform saying "your plan covers fewer of
  these right now" and it must be reversible.
- The oldest homes stay live by default, because they are the ones most likely to be the real
  house, and the user swaps freely at [`/smart-home/plan`](https://three.ws/smart-home/plan).
- **A paused home still answers safety actions.** Locking up, closing a garage or valve and arming
  an alarm work on a paused home exactly as they do on a live one.

Bringing a paused home back while at the limit is refused with a designed message, not a 500,
which is the whole reason a user pauses one first and resumes another.

---

## Counters: one number, not two

`agentTurns` has **no event kind of its own**. A conversation with the agent already writes exactly
one `kind: 'chat'` row into `usage_events` carrying the provider, model, token counts and priced
cost ([`api/chat.js`](../api/chat.js)), and that row is what an invoice would charge for. Minting a
second row beside it would mean two numbers that disagree, and the one on the invoice being wrong.
So a home turn is the same row, distinguished by the `home_id` the chat handler stamps into its
`meta` when a home tool ran.

`voiceMinutes` does get its own kind (`home.voice`), because nothing counted voice before: the TTS
and ASR lanes write no usage events at all. That is a new fact, not a duplicated one.

Reads are cached in Redis per (account, dimension, month) and **seeded from `usage_events`** when
cold, so the cache converges on the authoritative number rather than starting a private tally. A
cache eviction while events are still in the write buffer under-counts for the rest of the month.
That bias is deliberate: a quota that errs must err toward serving the user, and over-counting
would refuse somebody access to their own house over a Redis hiccup.

Without Redis, every read goes straight to `usage_events`. Correct, just slower.

The **quota period is the UTC calendar month.** The platform has no per-user plan billing cycle to
key off (`users.plan` is a column, not a subscription), and inventing one here would be a second
billing clock that drifts from whatever the real one turns out to be. It resets on a date every
user can predict, and it is shown on the plan page with that date.

---

## Where enforcement happens

| Point | File | What it refuses |
|---|---|---|
| Acquisition | [`api/home/index.js`](../api/home/index.js) | a new home past `homes`, **before** any socket is opened. Reconnecting a house the account already has is an update, not an acquisition, so a token rotation is never refused |
| Stream | [`api/home/[id]/stream.js`](../api/home/%5Bid%5D/stream.js) | a new SSE subscriber past `streams`, before any SSE head is written |
| Seats | [`api/home/[id]/members.js`](../api/home/%5Bid%5D/members.js) | an invitation past `members`, counting outstanding invites as well as members, billed to the home's **owner** |
| Retention | [`api/_lib/home/privacy.js`](../api/_lib/home/privacy.js) | raising retention past the plan's ceiling. Never applied retroactively |
| Actions | [`api/home/[id]/call.js`](../api/home/%5Bid%5D/call.js) | an ordinary action on a paused home. **The safety exemption is checked first**, so a safety action is never reached by this code |

Ordinary service calls are **not** metered at all. Actions are cheap; the socket is the cost. A
user can run twenty lights all evening without touching a quota.

There is also a separate, unrelated ceiling: the per-instance backpressure ladder in
[`api/_lib/home/admission.js`](../api/_lib/home/admission.js). That answers "is this instance
full"; this document answers "does your plan cover this". The two compose and neither replaces the
other.

---

## The plan page

[`/smart-home/plan`](https://three.ws/smart-home/plan) shows every dimension whether or not it is
near its ceiling, each with its usage, its limit, the reset date and the reason it is metered. A
quota you only meet at the moment it refuses you is a quota nobody showed you.

It is also where a user swaps which homes are live after a downgrade, and where the two lines a
limit can never touch are stated in words rather than buried in a policy nobody opens.
