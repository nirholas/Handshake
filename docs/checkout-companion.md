# Checkout companion

Your agent reads the payment page before you pay.

Checkout dark patterns are not hidden. They are unread. The fee added on the
last step, the "free trial" that becomes an annual charge, the cancellation
notice period buried in a terms block: all of it is rendered on the screen the
person is looking at, and none of it gets read, because reading it is tedious
and the button is right there. This is the one moment where an agent that can
read a page faster than you is worth more than an agent that can do anything
else.

The [companion](./companion.md) already delivers messages in person. This is the
same companion at the moment money moves.

## What it reports

On a checkout page, and only there, the panel says:

| Finding | Example |
| --- | --- |
| The total is above the price you were shown | "You saw $49.99 earlier and this page charges $62.49, a difference of $12.50." |
| Money the page did not itemise | "The listed amounts come to $54.99 but the total is $62.49. $7.50 is not itemised on this page." |
| Fees, named and summed | "$4.49 of this is fees. Service fee: $2.50. Processing: $1.99." |
| The charge repeats | Auto-renewal, "billed monthly", "per year" |
| A trial converts | "Start your free trial. After the trial you will be billed." |
| The price changes on renewal | Introductory rates, "first year only", "renews at" |
| Conditions on cancelling | Notice periods, non-refundable terms |
| Something may be pre-selected | "uncheck this box", "already added" |

If any of those is a red flag the panel opens itself and optionally says one
line out loud. Otherwise it stays one collapsed line. Most checkouts are
ordinary and it is quiet on them.

## The two passes, and why they are separate

This is the load-bearing design decision, and every future change has to keep
it. The analysis runs in two passes with a hard line between them:

**Arithmetic is decided in code.** Whether the line items add up to the total is
integer minor-unit maths in
[`api/_lib/companion/checkout.js`](../api/_lib/companion/checkout.js). Every
number in every finding was computed there. A language model never performs,
corrects, or infers an amount.

The reason is asymmetry of harm. A model that hallucinates a $12.50 fee onto a
legitimate merchant's checkout is worse than no feature at all, and a model that
misses a real one because it did mental arithmetic is the same failure wearing a
different hat. Arithmetic is the part computers have been reliable at for
seventy years; handing it to a probabilistic system is a choice nobody should
make on a payment screen.

**Prose is read by a model.** What a cancellation clause actually says is a
reading task, and that is what models are good at. The model is given the
redacted page text and returns findings with no amounts in them.

Two guarantees enforce the line:

- `SYSTEM_PROMPT` forbids arithmetic and legal verdicts.
- `sanitizeModelFindings()` **drops** any finding containing a currency amount
  or the words illegal, unlawful, non-compliant, fraudulent, scam, and their
  family. A prompt is a request; a filter is a guarantee.

A finding is dropped rather than softened, because softening leaves a mangled
sentence on a payment screen with our avatar's face on it, while dropping loses
one line from a list that is allowed to be empty.

**When the model is unreachable the feature still works.** `reading_status`
comes back `unavailable` and every arithmetic finding still stands. The
highest-value finding in the whole product ("this total is $12.50 more than you
were quoted") needs no model at all.

## What it never does

- **It never renders a legal verdict.** It does not say a charge is illegal,
  non-compliant, fraudulent, or a scam. It says what the page says and where the
  numbers disagree. We cannot know the former, the user cannot verify it, and a
  false accusation over a legitimate merchant's checkout is a liability we would
  deserve.
- **It never blocks a payment.** It has no mechanism to and never claims to.
- **It never advises whether to buy.** It reports; the person decides.

## Privacy

The extension **never reads an input**. Not the value, not the placeholder, not
a `contenteditable`, not an iframe. `collectText()` and `collectAmounts()` in
[`extract.js`](../extensions/checkout-companion/extract.js) refuse those nodes
structurally rather than filtering their contents afterwards, because a filter
is a list of the cases someone thought of. Card number, CVV, billing address and
email all live in inputs, so none of them can be read, so none of them can be
sent.

Redaction then runs in the browser over the visible text anyway (a confirmation
step that prints your card's last four is real), stripping Luhn-validated card
numbers, IBANs, security codes, emails, phone numbers, government ids and long
opaque tokens. The panel reports the redaction count so the claim is checkable.

Only the **hostname** is sent, never the path or query string.

**Nothing about the page is stored.** `POST /api/companion/checkout` writes no
row. Findings are computed and returned in the same request. The one piece of
cross-page memory is a single remembered amount per site, kept in the browser
for one hour, capped at twenty sites, which is what makes the "total versus the
price you were shown" comparison possible without any surveillance at all.

Full disclosures:
[PRIVACY.md](../extensions/checkout-companion/PRIVACY.md),
[PERMISSIONS.md](../extensions/checkout-companion/PERMISSIONS.md).

## API

### `POST /api/companion/checkout`

Auth: a three.ws session, or `Authorization: Bearer <companion bridge token>`
(the same token as [`/api/companion/ingest`](./companion.md), rotatable from
`/companion`). Rate limit: 40 per 10 minutes per account.

Request:

```json
{
  "url": "https://shop.example/checkout",
  "title": "Checkout",
  "currency": "USD",
  "text": "Order summary. Subtotal $49.99. Service fee $7.50. Order total $62.49. Your plan auto-renews every month.",
  "amounts": [
    { "value": 4999, "role": "subtotal", "context": "Subtotal" },
    { "value": 750,  "role": "service",  "context": "Service fee" },
    { "value": 6249, "role": "total",    "context": "Order total" }
  ],
  "quoted": { "value": 4999 }
}
```

`value` is **integer minor units** (cents). The parse from `"$49.99"` to `4999`
happens in the content script, next to the DOM node that supplied the currency;
a float arriving here would mean the parse happened somewhere that could not
know the currency's exponent. `role` is one of `total`, `subtotal`, `line`,
`fee`, `surcharge`, `handling`, `processing`, `service`, `tax`, `shipping`,
`discount`, `unknown`.

Response:

```json
{
  "findings": [
    {
      "id": "total_above_quoted",
      "severity": "flag",
      "title": "The total is higher than the price you were shown",
      "detail": "You saw $49.99 earlier and this page charges $62.49, a difference of $12.50.",
      "amount": 1250,
      "currency": "USD",
      "source": "arithmetic"
    }
  ],
  "spoken": "Heads up: this total is $12.50 more than the price you were shown.",
  "currency": "USD",
  "reading_status": "ok",
  "redactions": 0,
  "redaction_counts": { "card": 0, "iban": 0, "email": 0, "phone": 0, "cvv": 0, "government_id": 0, "token": 0 }
}
```

`severity` is `flag` (opens the panel), `notice`, or `info`. `source` is
`arithmetic` (computed here), `phrase` (a pattern matched in the page text), or
`reading` (a model read the prose). Findings sort by severity, then arithmetic
before prose, because a number you can check against your own screen in two
seconds beats a paraphrase.

`reading_status` is `ok`, `unavailable` (no model reachable; arithmetic findings
still returned), or `skipped` (no provider configured, or too little text).

## Installing the extension

Sources: [`extensions/checkout-companion/`](../extensions/checkout-companion).

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → select that
   directory.
2. Sign in to three.ws in the same browser, or paste a bridge token from
   [`/companion`](https://three.ws/companion) into the options page.

### Other browsers

The sources are plain MV3 and load unmodified in Firefox
(`about:debugging` → **Load Temporary Add-on**) and in Safari via
`xcrun safari-web-extension-converter`.

**On iOS specifically:** a Safari Web Extension is the only way this can exist.
iOS has no equivalent of Android's `SYSTEM_ALERT_WINDOW`, so no App Store app
can draw a floating panel over other apps, and there is no third-party API for
reading another app's screen contents. An extension inside Safari can read the
page Safari is showing, which covers web checkouts (where the subscription dark
patterns overwhelmingly live) and nothing else. That boundary is a platform
fact, not a roadmap item. See [iOS](./ios-app.md).

## Tests

- [`tests/companion-checkout.test.js`](../tests/companion-checkout.test.js):
  redaction, the arithmetic, and what the model is not allowed to say.
- [`tests/checkout-extract.test.js`](../tests/checkout-extract.test.js): money
  parsing across locales, and the no-inputs rule held against a real DOM.

## Related

- [Companion](./companion.md): the message lanes and the avatar delivery channel
- [Notifications](./notifications.md): the per-category channel matrix
- [`extensions/walk-avatar/`](../extensions/walk-avatar): the same rig, walking
  your avatar across any site
