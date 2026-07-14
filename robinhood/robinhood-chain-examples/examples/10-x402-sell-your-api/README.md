# 10 · Sell your API with x402 — blocked on siblings

**Status: not built.** This example is supposed to be a ~20-line paid
endpoint using `hood402` middleware. That package doesn't exist yet in the
`robinhood/` workspace — see [example 09](../09-x402-paid-api-call) for the
same gap on the client side, and the root README's SDK feedback for the full
picture of what's shipped vs. pending.

## What's missing

**`hood402`** — the Wave-2 payment package (prompt 05 in
`prompts/robinhood-chain/`). This example needs its server-side middleware:
something like

```js
import { hood402 } from 'hood402'
app.get('/quote/:symbol', hood402({ priceUsdg: '0.01' }), async (req, res) => {
  res.json(await getQuote(hood, req.params.symbol))
})
```

wrapping any Express/Fastify/Hono route in a USDG-denominated x402 paywall.

## Owner action

Build `hood402` (prompt 05), then this example becomes a real deployable
endpoint (Cloud Run, matching this campaign's existing serverless pattern) —
no further action needed from this repo until then.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
