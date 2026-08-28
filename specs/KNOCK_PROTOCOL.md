# KNOCK_PROTOCOL - v1

The wire contract for a priced door to a person: how a door advertises its
terms, how a knock is paid for and accepted, and how the sender reads the
answer.

Knock is deliberately small. It is one message in one direction, priced by the
recipient, settled to the recipient, and delivered in person by their
[companion](../docs/companion.md). Everything else (threads, contacts, presence)
is out of scope by design.

Reference implementation: `api/knock/**`, `api/x402/knock.js`, and the pure rule
module `api/_lib/knock/policy.js`. Client: `packages/knock-sdk`.

---

## 1. Terms

| Term | Meaning |
| --- | --- |
| **Door** | A recipient's published terms: price, chains, message limit, daily cap. |
| **Knock** | One accepted message through a door. |
| **Free door** | `price_atomics == "0"`. Takes an unpaid POST. |
| **Priced door** | `price_atomics > 0`. Takes an x402 payment. |
| **Receipt token** | An unguessable derived token that lets the sender read one knock's state. |

All amounts are **USDC atomic units**, decimal string, 6 decimals. `"50000"` is
$0.05. Strings, not numbers: a JSON number cannot carry these safely at the top
of the range.

---

## 2. Door document

`GET /api/knock/door?handle=<username>` returns the door as a stranger sees it.
Unauthenticated. Cacheable for 30s.

```json
{
  "door": {
    "handle": "nirholas",
    "display_name": "nirholas",
    "avatar_url": "https://…",
    "verified": null,
    "open": true,
    "free": false,
    "price_atomics": "50000",
    "price": "$0.05",
    "currency": "USDC",
    "networks": ["solana"],
    "headline": "Ask me about x402 on Solana",
    "greeting": "…",
    "max_chars": 600,
    "endpoint": "https://three.ws/api/x402/knock?to=nirholas",
    "protocol": "x402"
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `free` | boolean | Authoritative. Clients MUST branch on this, not on `price`. |
| `price_atomics` | string | Decimal atomic USDC. |
| `price` | string | Display only. Never parse it. |
| `networks` | string[] | Ordered by preference. Solana leads unless the owner set only Base. |
| `max_chars` | integer | The door's own limit, 40 to 2000. |
| `endpoint` | string | Absolute URL of the lane to use. |
| `protocol` | `"http"` \| `"x402"` | Which lane `endpoint` speaks. |

A payout address is **never** in this document.

**Non-enumeration.** A handle that matches no account and a handle whose owner
has not opened a door MUST both answer `404` with the same body.

`GET /api/knock/directory?limit=<1-100>` returns `{ doors: [...], count }`:
every door that is open **and** listed, ordered by `price_atomics` ascending.
Open and listed are independent: an unlisted open door is reachable by link and
absent from the directory.

---

## 3. Knock request

The same body on both lanes, except that the free lane carries `to`.

```json
{
  "from": "Ada (research agent)",
  "subject": "Your x402 settle path",
  "message": "…",
  "url": "https://example.com/ada",
  "sender_kind": "agent",
  "request_id": "ada-2026-08-28-001"
}
```

| Field | Required | Constraint |
| --- | --- | --- |
| `to` | free lane only | Handle. On the paid lane it is the `?to=` query parameter. |
| `from` | yes | 1 to 64 chars after trim. Shown and spoken. |
| `message` | yes | 8 to `max_chars` chars after trim. Shown in full, **never spoken**. |
| `subject` | no | Up to 120 chars. The only field read aloud. |
| `url` | no | `http(s)` only, up to 400 chars. Any other scheme is rejected. |
| `sender_kind` | no | `agent` \| `human` \| `unknown`. Self-declared, never trusted for access. |
| `request_id` | no | Up to 80 chars. Idempotency key, scoped to the recipient. |

`sender_kind` is displayed, not enforced. It exists so a recipient can see what
claims to be knocking, not to gate anything.

---

## 4. Lanes

### 4.1 Free lane

```
POST /api/knock/send
```

Unauthenticated. `201` on acceptance, `200` when `request_id` matched an earlier
knock.

A **priced** door MUST answer this lane with `402` and the x402 endpoint:

```json
{
  "error": "payment_required",
  "error_description": "nirholas charges $0.05 to be reached",
  "endpoint": "https://three.ws/api/x402/knock?to=nirholas",
  "price_atomics": "50000",
  "protocol": "x402"
}
```

### 4.2 Paid lane

```
POST /api/x402/knock?to=<handle>
```

A standard [x402](../docs/x402.md) resource. The `402` challenge MUST advertise:

- `amount` equal to that door's `price_atomics` at request time, and
- `payTo` equal to **the recipient's own address** for each advertised network.

A **free** door MUST answer this lane with `400 free_door` and the plain
endpoint, so a client that guessed wrong is redirected rather than refused.

### 4.3 Ordering guarantee

This is the load-bearing rule of the protocol.

> Every refusal that can be determined from the request and the door MUST be
> evaluated **before** the `402` challenge is issued, and MUST be re-evaluated
> **before** settlement.

Concretely: a shut door, a door at its daily cap, a blocked sender, a missing
`from`, and a message outside the length bounds are all refused with no payment
taken. Implementations that deliver-then-settle (as this one does) get the
second half for free: the handler that records the knock runs before settlement,
so a throw there refuses the knock without moving money.

A conforming client MAY therefore retry a `4xx` from this endpoint without
worrying that the previous attempt was charged.

---

## 5. Knock response

```json
{
  "ok": true,
  "knock_id": "c1b0a2d4-7e33-4f01-9a55-2b7c1d0e9f4a",
  "delivered_to": "nirholas",
  "announced": true,
  "importance": 74,
  "paid": "$0.05",
  "receipt_url": "https://three.ws/api/knock/reply?id=…&token=…",
  "duplicate": false
}
```

| Field | Notes |
| --- | --- |
| `announced` | The knock cleared the default interrupt threshold. Not a promise: the recipient may have raised their own bar. |
| `importance` | 0 to 100, see §7. |
| `duplicate` | `request_id` matched an earlier knock. Nothing new was delivered, and on the paid lane nothing new settles. |
| `receipt_url` | Absolute. The sender's only handle on this knock. |

---

## 6. Receipt

```
GET /api/knock/reply?id=<knock id>&token=<receipt token>
```

The token is derived, not stored:

```
token = base64url(HMAC-SHA256(server_secret, "knock-receipt-v1:" + knock_id))[0:32]
```

Constant-time compared. A wrong or absent token MUST answer `404`, not `403`: an
id alone must not confirm that a knock exists.

```json
{
  "knock": {
    "id": "c1b0a2d4-…",
    "subject": "Your x402 settle path",
    "status": "replied",
    "reply": "Ask away.",
    "replied_at": "2026-08-28T04:02:11.000Z",
    "seen": true,
    "amount": "$0.05",
    "created_at": "2026-08-28T03:41:02.000Z"
  }
}
```

`status` is one of `pending`, `read`, `replied`, `dismissed`. `reply` is
non-null **only** when `status == "replied"`.

The receipt MUST NOT expose anything about the recipient beyond the reply they
deliberately wrote. No name, no address, no wallet, no read timestamps beyond
the `seen` boolean.

---

## 7. Importance

A knock's importance is a pure function of the amount paid. There is no keyword
scoring: the sender already stated what reaching this person was worth, in
money.

```
importance(0)      = 45
importance(a > 0)  = clamp(round(80 + 6 * log10(a / 10^6)), 62, 99)
```

Properties a conforming implementation MUST preserve:

1. Every paid knock scores **above** 60, the default interrupt threshold. Paying
   to reach someone is the signal.
2. A free knock scores **below** 60. It enters the feed and the bell; it does not
   stop the recipient's day.
3. The function is monotonic in the amount and bounded at 99, so no single
   payment can permanently own the top of the feed.

---

## 8. Delivery

An accepted knock becomes a companion event with `source_kind = "knock"` and a
`spoken_line` of the form:

```
<from> paid <price> to reach you: <subject>.
<from> is at your door.                        (free door, or no subject)
```

The `message` body is **never** placed in `spoken_line`. Untrusted text does not
get to use the recipient's avatar as a speaker.

It also raises a `knock_received` notification, which rides the recipient's
normal per-category channel matrix (`knock` category: in-app, push, email and
avatar on by default, telegram off). Muting the category mutes the delivery;
nothing here bypasses it.

---

## 9. Error codes

Stable, machine-readable, returned as `{"error": <code>, "error_description": …}`.

| Code | Status | Meaning |
| --- | --- | --- |
| `no_door` | 404 | No open door for that handle, or no such account. |
| `door_closed` | 403 | Shut right now. Also what a blocked sender sees. |
| `door_full` | 429 | Daily cap spent. Retryable tomorrow. Nothing was charged. |
| `missing_sender` | 400 | No `from`. |
| `message_too_short` | 400 | Under 8 characters. |
| `message_too_long` | 400 | Over that door's `max_chars`. |
| `bad_url` | 400 | `url` was not a plain `http(s)` link under 400 chars. |
| `free_door` | 400 | Paid lane used on a free door. Carries the plain endpoint. |
| `payment_required` | 402 | Free lane used on a priced door. Carries the x402 endpoint. |

**Blocked senders and shut doors are indistinguishable by design.** A blocked
sender who could tell it was them would simply knock again under another name.

---

## 10. Privacy and custody invariants

1. **No custody.** `payTo` is the recipient's address. No platform wallet is in
   the settlement path. A priced door cannot be opened without a payout address.
2. **No enumeration.** Unknown handle and shut door are indistinguishable.
3. **No leakage through the receipt.** See §6.
4. **No spoken bodies.** See §8.
5. **No unpaid refusals turning into paid ones.** See §4.3.
