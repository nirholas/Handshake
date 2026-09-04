# Knock

**A priced door to a person. Pay their price, get one message through, and their
3D companion delivers it in person.**

Cold outreach is free to send and expensive to receive. That asymmetry is the
whole problem: the person on the receiving end drowns, and the one message that
mattered is lost in the pile. Knock inverts it. You publish a door, you set what
one message from a stranger costs, and the price does the filtering. A stranger
who genuinely needs you buys thirty seconds of your attention for a nickel. A
spammer cannot buy a million of them.

The delivery is the other half. A knock is not a badge on a tab you will get to
later: your [companion](./companion.md) walks on screen wherever you are on
three.ws, turns to you, and says who is at the door and what they paid.

Open yours at **[three.ws/knock](https://three.ws/knock)**.

- **The money is yours.** The USDC settles directly to the wallet you name.
  three.ws never takes custody of it and takes no cut of it.
- **Both kinds of visitor.** A person pays with the wallet in their browser. An
  agent pays over [x402](./x402.md) with no human in the loop.
- **Nothing lands for free.** Price, daily cap, message length, and a block list
  are all yours to set. Every refusal happens before any payment, so a knock
  that was never going to land is never a knock somebody paid for.
- **One message, one door.** Knock is not a chat. It is a way in, once.

---

## Opening your door

1. Pick a username, if you have not (your door lives at `/knock/<username>`).
2. Open [three.ws/knock](https://three.ws/knock) and set:
   - **Price**: anything from $0.001 to $1,000, or `0` for a free door.
   - **Solana wallet**: where the USDC lands. Solana is the home chain and the
     lane an agent settles on by default. A Base address is optional and is only
     advertised when you set one.
   - **Headline and greeting**: what a visitor reads before they write. Tell
     them what you actually want to hear about; it is the cheapest filter you
     have.
   - **Daily cap** and **message length**.
3. Flick **Door open**. Share the link.

A priced door cannot be opened without a payout address. The API refuses the
save rather than quietly routing a stranger's money into the platform's wallet.

**Listed** is separate from **open**. An unlisted open door is reachable by
anyone with the link but never appears in the public directory, which is what
you want if you are handing the link to a specific set of people.

---

## What a visitor sees

`three.ws/knock/<handle>` renders your price, your greeting, and a box. The
message is capped at the length you set, with a live counter.

A **subject** line is optional and is the only thing spoken aloud. The body is
shown in full, in the bubble and in your inbox, but it is never read at you by
your own avatar: a long or hostile paragraph should not be able to hijack your
companion's mouth.

When the knock lands, the sender gets a **receipt URL**. It carries its own
proof (an HMAC over the knock id), so they can check on it later without an
account here, and it exposes exactly two things: the status, and the reply if
you wrote one.

---

## What you see

Two views of the same thing.

**In person.** The knock becomes a companion event whose importance is derived
from the amount paid, so your avatar walks on and says, for example, *"Ada paid
$0.05 to reach you: Your x402 settle path."* Every paid knock scores above the
default interrupt threshold of 60; a free-door knock lands at 45, which puts it
in the feed and the bell without stopping your day. Raise your companion's
threshold if you want only the expensive ones to interrupt.

**In the inbox.** [three.ws/knock](https://three.ws/knock) lists every knock
with what it was worth, plus totals: waiting, all time, and earned. From a row
you can reply, mark read, dismiss, or block.

A **reply** is written back to the receipt link the sender already holds. That
is the whole return path, deliberately: answering someone never hands out your
email address or opens a thread.

A **block** matches on the wallet that paid when there was one, and on the
sender's name when the knock was free. A blocked sender gets the same answer a
shut door gives, so they cannot tell it was them specifically.

---

## For agents

### Read the door first

```bash
curl -s 'https://three.ws/api/knock/door?handle=nirholas'
```

```json
{
  "door": {
    "handle": "nirholas",
    "display_name": "nirholas",
    "free": false,
    "price": "$0.05",
    "price_atomics": "50000",
    "currency": "USDC",
    "networks": ["solana"],
    "max_chars": 600,
    "headline": "Ask me about x402 on Solana",
    "endpoint": "https://three.ws/api/x402/knock?to=nirholas",
    "protocol": "x402"
  }
}
```

Public, cacheable, no credential. A handle nobody has opened a door for and a
handle that matches nobody both answer 404 with the same body, so this cannot be
used to enumerate accounts.

`GET /api/knock/directory` returns every open, listed door, cheapest first.

### Knock, and pay for it

The paid lane is a standard x402 endpoint:

```
POST https://three.ws/api/x402/knock?to=<handle>
```

```json
{
  "from": "Ada (research agent)",
  "subject": "Your x402 settle path",
  "message": "I index x402 endpoints and yours is the only one settling on Solana. Two questions about the facilitator.",
  "url": "https://example.com/ada",
  "sender_kind": "agent",
  "request_id": "ada-2026-08-28-001"
}
```

The first call answers `402` with the door's real price and the recipient's own
address as `payTo`. Pay it and retry with the `X-PAYMENT` header, exactly as
with any other x402 resource. A settled call returns:

```json
{
  "ok": true,
  "knock_id": "c1b0a2d4-…",
  "delivered_to": "nirholas",
  "announced": true,
  "importance": 74,
  "paid": "$0.05",
  "receipt_url": "https://three.ws/api/knock/reply?id=c1b0a2d4-…&token=…",
  "duplicate": false
}
```

`request_id` is an idempotency key. A retry after a settled payment returns the
first knock rather than knocking, and charging, twice.

Free doors take a plain POST instead, with the handle in the body:

```bash
curl -X POST https://three.ws/api/knock/send \
  -H 'content-type: application/json' \
  -d '{"to":"nirholas","from":"Ada","message":"a real message"}'
```

Posting to the wrong lane is not an error you have to guess at: a priced door
answers the free lane with `402` and the x402 endpoint to use, and a free door
answers the x402 lane with `400` and the plain one.

### With the SDK

```bash
npm install @three-ws/knock
```

```js
import { knock, quote } from '@three-ws/knock';
import { wrapFetchWithPayment } from 'x402-fetch';

const door = await quote('nirholas');   // read the live price first

const result = await knock({
	to: 'nirholas',
	from: 'Ada (research agent)',
	subject: 'Your x402 settle path',
	message: 'Two questions about the facilitator.',
	fetchWithPayment: wrapFetchWithPayment(fetch, wallet),
	maxPriceAtomics: 100_000n,          // never spend more than $0.10
	requestId: 'ada-2026-08-28-001',
});
```

The SDK never signs anything itself: you pass the paying `fetch` from the x402
client and wallet you already trust, so your keys and your chain stay yours.
`maxPriceAtomics` is checked against the door's live price before any payment is
attempted, which matters because an owner can raise their price between your
quote and your call.

From the terminal:

```bash
npx @three-ws/knock quote nirholas
npx @three-ws/knock send nirholas "Two questions." --from "Ada" --payer ./payer.mjs
```

A priced door prints the recipient, the amount, the token and the chain, and
stops for a yes. With no TTY it refuses rather than assuming consent.

### From an MCP client

```bash
claude mcp add knock -- npx -y @three-ws/knock-mcp
```

Six tools: `knock_quote`, `knock_directory`, `knock_send`, `knock_receipt`, and
(with `THREE_WS_API_KEY`) `knock_inbox` and `knock_act`.

The MCP server holds no wallet and cannot spend. On a priced door `knock_send`
returns the recipient, amount, token and chain and stops, so the decision to pay
stays with a human. See
[@three-ws/knock-mcp](https://www.npmjs.com/package/@three-ws/knock-mcp).

### Read the answer

```bash
curl -s 'https://three.ws/api/knock/reply?id=<knock id>&token=<receipt token>'
```

```json
{ "knock": { "status": "replied", "reply": "Ask away.", "seen": true, "amount": "$0.05" } }
```

Statuses: `pending`, `read`, `replied`, `dismissed`. A wrong or missing token is
a 404, not a 403: an id on its own should not confirm that a knock exists.

---

## Endpoints

| Endpoint | Auth | What it does |
| --- | --- | --- |
| `GET /api/knock/door?handle=` | none | One door's public terms. |
| `GET /api/knock/directory` | none | Every open, listed door, cheapest first. |
| `POST /api/knock/send` | none | Knock on a free door. |
| `POST /api/x402/knock?to=` | x402 payment | Knock on a priced door. |
| `POST /api/knock/escrowed` | on-chain escrow | Knock on a door that takes escrowed knocks, where the money only moves if you get an answer. |
| `GET /api/knock/reply?id=&token=` | receipt token | What became of a knock you sent. |
| `GET /api/knock/settings` | session | Your door, your totals, your block list. |
| `PATCH /api/knock/settings` | session | Change any of it. |
| `GET /api/knock/inbox` | session | The knocks your door has taken. |
| `PATCH /api/knock/inbox/<id>` | session | Reply, mark read, dismiss, block. |

Error codes are stable and mean what they say: `no_door`, `door_closed`,
`door_full` (429, retryable tomorrow), `message_too_long`, `message_too_short`,
`bad_url`, `missing_sender`, `free_door`, `payment_required`.

The escrowed lane adds `escrow_not_enabled` (409, and the body names the lane
to use instead), `no_payout_wallet` (409), `knock_not_found` (402, nothing is
escrowed at the address the request derives), and four 409s for an escrow that
exists but cannot be used: `already_settled`, `message_mismatch`,
`window_closed`, `underpaid`.

---

## The escrowed lane

The x402 lane sends your USDC to the recipient the instant the payment clears.
Between people who already know each other that is the right shape, and it is
why the lane exists. Between strangers it is the whole risk: a door can bank
every knock and answer none, and you have no recourse. Nobody is going to keep
paying strangers under those terms, and when they stop, the price stops meaning
anything, which was the entire point of pricing a door.

An escrowed door fixes that without giving three.ws your money either. You sign
a `knock` instruction on the [knock_escrow](https://github.com/nirholas/three.ws/tree/main/contracts/knock-escrow)
Solana program, which parks your payment in a vault owned by that knock's own
program address. From there exactly three things can happen to it:

| Outcome | Who can trigger it | Where your money goes |
| --- | --- | --- |
| Answered inside the window | the door's owner, and nobody else | to them, minus the protocol fee |
| Refused | the door's owner | **all of it back to you**, no fee taken |
| The window closes | **anyone at all** | **all of it back to you** |

There is no fourth path. three.ws holds no key that can move a parked knock,
and neither can the protocol authority: the vault's only authority is the
knock's own address. The worst case for a sender is that their money is
unavailable until the window they agreed to runs out.

Two details worth knowing:

**The refund is permissionless.** If only you could claim it back, the guarantee
would be worth exactly as much as your diligence, and an agent that knocked and
went away would leave the money stranded. Anybody can crank an expired refund,
and it can only ever pay the original sender.

**Refusing costs you nothing.** An owner who will not engage is better off
refusing than letting the clock run out: you get your money back immediately
rather than a day later. Reading something and declining to answer is not a
service, so it is not charged for.

### Sending an escrowed knock

```bash
# 1. Check the door takes escrowed knocks and read its price.
curl -s 'https://three.ws/api/knock/door?handle=nirholas'

# 2. Sign the on-chain `knock` instruction yourself, parking the price in escrow.
#    The knock's address derives from (door, your wallet, a nonce you choose).

# 3. Deliver the message against it.
curl -sX POST https://three.ws/api/knock/escrowed \
  -H 'content-type: application/json' \
  -d '{
        "to": "nirholas",
        "from": "Ada (research agent)",
        "message": "two questions about the facilitator, happy to pay for the time",
        "sender_wallet": "<the wallet that signed the knock>",
        "nonce": 7
      }'
```

The response carries the knock's address, its vault, the deadline, and the
seconds remaining. The message body itself never touches the chain: the escrow
commits to its SHA-256, so both sides can prove later what was actually sent
without publishing a stranger's private message to a public ledger. That hash is
also what stops a paid escrow being reused to deliver a different message.

### Opening an escrowed door

```bash
curl -sX PATCH https://three.ws/api/knock/settings \
  -H 'content-type: application/json' \
  -d '{ "escrow_enabled": true, "escrow_window_hours": 24 }'
```

Off by default on every door, because turning it on changes what a stranger is
agreeing to when they pay. It needs a Solana address on the door: that address
is where an answer pays out, and it is half of the door's on-chain identity.
The window can be 1 hour to 30 days, the same band the program enforces.

---

## Why it is built this way

**Refuse before charging.** The message is read and validated against that
door's limits before the 402 is issued. A knock that is too long, a door that is
shut, a door that is full for the day, a sender who is blocked: all of them cost
nothing. The handler that records the knock also runs before settlement, so even
a payer who skipped the pre-flight gets refused without moving money.

**The price is the ranking.** A mail client guesses at importance from keywords.
A knock does not have to guess: the sender said what reaching you was worth, in
money. The companion's importance score is a log-scaled function of the amount,
so a $50 knock outranks a $0.05 one without a $5,000 knock being able to sit
permanently at the top of the feed.

**The body is never spoken.** Only the subject line is read aloud. Anything a
stranger writes is untrusted text, and untrusted text does not get to use your
avatar as a speaker.

**No custody, no cut.** `payTo` on the 402 challenge is the recipient's own
address. There is no platform wallet in the path to be drained, reconciled, or
argued about. The escrowed lane keeps that property while removing the trust it
used to require: the money sits in a vault whose only authority is the knock's
own program address, so three.ws cannot release it, refund it, or redirect it,
and neither can anyone else outside the three outcomes above.

---

## Related

- [The Companion](./companion.md) is what delivers a knock in person.
- [x402](./x402.md) is the payment protocol the priced lane speaks.
- [Notifications](./notifications.md) covers the per-category channel matrix; knocks are their own category, and the avatar channel is on for them by default.
