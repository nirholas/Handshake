# IBM hosted-page audit: proving the publish-once page works on a foreign origin

`scripts/audit-ibm-hosted-page.mjs` (`npm run audit:ibm-hosted`) loads
`pages/ibm/hello.html` the way IBM's visitors load it: from a domain that is not
three.ws.

Every other page audit in this repo loads pages from three.ws itself. That is
the right test for every page except this one. `hello.html` is a **publish-once**
file: it is uploaded to a host we do not control (see
[pages/ibm/HOSTING.md](../../pages/ibm/HOSTING.md)), and from there every asset it
names and every document it fetches from three.ws is a **cross-origin** request.
Two classes of break live only on that origin, and both are invisible to
`npm run audit:console`.

## What it catches

**1. A missing `access-control-allow-origin` on something the page reads.**
On 2026-09-04 `/x402.js`, `/i18n.js`, `/locales/*.json` and `/ibm/hello.live`
all answered without one. On three.ws all four were perfect, and the console
sweep was green. On the hosted copy:

- the live-update fetch failed, so the page was frozen on its baked baseline,
  which is precisely the thing HOSTING.md promises will not happen;
- the language switcher never mounted;
- the paid x402 demo never armed.

The fix is header routes in `vercel.json` granting those paths open CORS, next
to the same grant `/embed/v1.js` and `/assistant/v1.js` already carry. They are
public, unauthenticated, cookie-free static files whose whole purpose is to be
read from other origins.

**2. A root-relative URL that resolves against the publisher's domain.**
`hello.live.html` is authored to run same-origin on three.ws, so it names its own
scripts `/x402.js`. `scripts/build-ibm-shell.mjs` rewrites those to absolute URLs
when it bakes `hello.html`, but the *runtime* live-update path swaps in the
fetched document as-is, so the same URL came back root-relative and asked IBM's
server for a file only three.ws has. The boot script now applies the same
rewrite (`abs()`), and the builder refuses to bake a `href`/`data-src`/`poster`/
`action`/`srcset` that is root-relative, because those are not rewritten
anywhere and would break the same way.

Runtime `i18n.js` had the same shape: it fetched `/locales/<code>.json` and
`/api/locale` root-relative, which resolves against whatever page loaded it.
`src/i18n.js` now derives its data origin from `import.meta.url`, so the
catalogs travel with the code. On three.ws itself that resolves to `''` and the
URLs are byte-identical to what they always were.

## Running it

```bash
# What IBM's visitors get right now.
npm run audit:ibm-hosted

# What this working tree would give them. Needs a local server and a built dist/
# (the page loads the agent-3d bundle from it like any visitor would).
npm run build && node server/index.mjs &
THREE_WS_ORIGIN=http://localhost:8080 npm run audit:ibm-hosted

HEADFUL=1 npm run audit:ibm-hosted     # watch it run
```

The audit serves `pages/ibm/` from a throwaway origin of its own and lets the
page talk to a real three.ws **over the network**. Nothing is stubbed or
intercepted: a proxy answering for three.ws would satisfy CORS on the browser's
behalf and blind the audit to the only failure it exists to catch. That is worth
stating plainly because the first draft of this script did exactly that and
reported a green run over a page whose live update was dead.

## What it asserts

| Check | Why it is the right signal |
|---|---|
| Live update applied | `data-ibm-source="live"` on `<html>`. `"baked"` means the fetch failed and the visitor is reading whatever content was frozen in at publish time. |
| Language switcher mounted | `customElements.get('lang-switcher')` is defined, which happens only if `i18n.js` loaded, ran, and read a catalog. |
| x402 widget bound | A payable element carries `data-x402-bound="1"`, which `x402.js` sets on each element it binds. The markup alone is present even when the script was blocked, so the markup alone proves nothing. |
| No console errors, page errors or failed requests | On this page a console error means a visitor lost a demo. Auth- and payment-gated statuses (401/402/403/429) are expected: a paid demo answering 402 is the demo working. The console filter is `scripts/lib/console-noise.mjs`, shared with `npm run audit:console` so the two audits agree about what a defect is. |

Exit code is 0 only when all four pass.

## Related

- [pages/ibm/HOSTING.md](../../pages/ibm/HOSTING.md) - what IBM publishes and how.
- [page-audit.md](page-audit.md) - the authed full-site sweep.
- `npm run audit:console` - the console sweep over every route on three.ws itself.
