# Privacy policy: three.ws Checkout Companion

Last updated: 2026-08-28

This extension reads checkout pages so it can tell you what you are about to
pay. That is a sensitive thing to point at a browser, so this document is
specific about what it reads, what it sends, and what is kept.

## What it reads

Only on a page that passes a local check for looking like a checkout. That check
runs entirely in your browser, before any network request exists. On every other
page the extension reads nothing and sends nothing.

On a checkout page it reads the **visible text** of the page and the **amounts**
displayed on it.

## What it never reads

**Anything you type.** The reader refuses form fields structurally rather than
filtering them afterwards: there is no code path in
[`extract.js`](extract.js) that reads an `<input>`, `<textarea>`, `<select>`,
`<iframe>`, or an editable region. Your card number, security code, billing
address, and email are in those elements. They are never read, so they can never
be sent.

Content hidden from you (`display:none`, `aria-hidden`) is also skipped.

## What is removed before anything is sent

Redaction happens in your browser, before the request. Even though the reader
never touches form fields, the visible text of a page can still carry personal
data (a confirmation step that prints your card's last four, an order blob
rendered into the page). All of it is stripped:

| Removed | Replaced with |
| --- | --- |
| Card numbers (validated by Luhn) | `[card ending 1234]` |
| Bank account numbers (IBAN) | `[bank account removed]` |
| Security codes (CVV/CVC) | `[security code removed]` |
| Email addresses | `[email removed]` |
| Phone numbers | `[phone removed]` |
| Government id numbers | `[government id removed]` |
| Long opaque tokens (session ids, keys) | `[token removed]` |

The panel tells you how many redactions were made on each page, so the claim is
checkable against what you are looking at.

## What is sent

To `https://three.ws/api/companion/checkout`, over TLS:

- The redacted visible text of the checkout page.
- The amounts on the page and the label beside each one.
- The **hostname** of the site. Never the full URL, never the path, never the
  query string.
- Your credential: your three.ws session or a companion bridge token.

## What is kept

**Nothing about the page.** The findings are computed and returned in the same
request. No page text, no amounts, no URL, and no hostname is written to a
database. There is no record of what you bought or where.

Two things persist, both in your own browser only:

- **Your settings** and, if you set one, your bridge token.
- **Remembered prices**: one amount per site, kept for one hour, so the total at
  checkout can be compared against the price you were shown. Capped at twenty
  sites. Clear them any time from the options page.

The only server-side record is the aggregate usage counter three.ws already
keeps for language-model spend, which counts requests and tokens, not content.

## Third parties

The page text is processed by the language-model provider three.ws is configured
to use for your account, for the duration of the request, to read the fine
print. It is not used to train models. No data is sold, and there is no
advertising, analytics, or tracking in this extension.

## Your control

- Turn reading off entirely from the popup. It then does nothing on any page.
- Turn off remembered prices to stop the cross-page comparison.
- Disconnect your account from the options page.
- Uninstalling removes everything the extension stored.

## Contact

Questions: [three.ws/community](https://three.ws/community).
