# three.ws Checkout Companion

A browser extension that reads the payment page before you pay, and tells you
in plain language what you are actually agreeing to: what the total really is,
whether the charge repeats, what the fine print commits you to.

It is the [companion](https://three.ws/companion) doing the one job an agent is
uniquely good at, at the one moment it matters. Checkout dark patterns are not
hidden, they are just unread: a fee added on the last step, a "free trial" that
becomes an annual charge, a cancellation window buried in a terms block nobody
scrolls. All of it is on the screen. Nobody reads it. The companion does.

## What it does

On a page that looks like a checkout, and only there, it shows a small panel:

- **The total against the price you were shown.** If you saw $49.99 on the
  product page and the checkout says $62.49, it says so, and it says the
  difference is $12.50.
- **Money the page did not itemise.** If the line items add up to less than the
  total, the gap is named.
- **Whether this repeats.** Auto-renewal, trials that convert, introductory
  rates that change on renewal.
- **The conditions.** Cancellation notice periods, non-refundable terms,
  pre-selected add-ons.

If something is worth stopping for, the panel opens itself and (optionally) says
one line out loud. If the page is ordinary, it stays a single collapsed line.
Most checkouts are ordinary, and the extension is quiet on them by design.

## Install

Unpacked, for development:

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, and select this directory.
3. Sign in at [three.ws](https://three.ws) in the same browser, or paste a
   companion bridge token from [three.ws/companion](https://three.ws/companion)
   into the extension's options page.

Firefox and Safari both load the same MV3 sources; see
[docs/checkout-companion.md](../../docs/checkout-companion.md#other-browsers).

## How it decides what to say

Two passes, and the split between them is the whole safety design:

1. **Arithmetic, in code.** Whether `49.99 + 12.50` matches the total is decided
   by integer minor-unit maths in
   [`api/_lib/companion/checkout.js`](../../api/_lib/companion/checkout.js),
   never by a language model. Every number in a finding was computed. This pass
   runs with no model reachable at all, which is why a checkout read still works
   when the LLM chain is down.
2. **Reading, by model.** A model reads the redacted prose and reports what the
   cancellation clause says. It is forbidden from producing amounts or legal
   verdicts, and `sanitizeModelFindings()` drops any finding that does either
   anyway, because a prompt is a request and a filter is a guarantee.

It never says a charge is illegal, fraudulent, or a scam. It says what the page
says and where the numbers disagree. See
[PRIVACY.md](PRIVACY.md) and [PERMISSIONS.md](PERMISSIONS.md).

## Files

| File | What it is |
| --- | --- |
| [`extract.js`](extract.js) | Pure page reading and money parsing. The no-inputs rule lives here. Tested in [`tests/checkout-extract.test.js`](../../tests/checkout-extract.test.js) |
| [`content.js`](content.js) | Detects a checkout, reads it, mounts the panel |
| [`panel.js`](panel.js) / [`panel.css`](panel.css) | The shadow-DOM panel and its positioning |
| [`background.js`](background.js) | The only code that talks to the network; owns the credential |
| [`popup.html`](popup.html) / [`options.html`](options.html) | Switches, account connection, and the privacy disclosure |

## Related

- [`extensions/walk-avatar/`](../walk-avatar) walks your avatar across any site
  and reads pages aloud. Same rig, different job.
- [`docs/checkout-companion.md`](../../docs/checkout-companion.md) is the full
  reference, including the API contract.
