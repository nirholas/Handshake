# 12 · Telegram price bot

A [grammY](https://grammy.dev) bot backed by `hoodchain`: `/price AAPL` reads a
Chainlink feed, `/trending` lists the newest NOXA / Odyssey launches. Long-
polling, no webhook, no server — deployable on any free-tier host (Railway,
Fly.io, Render) or your own machine.

**What it proves:** a full user-facing bot is ~70 lines once the SDK does the
chain work, and the read surface (`getQuote`, `getRecentLaunches`) is the same
one used by examples 02 and 05.

## Prerequisites

- Node ≥ 20.
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (`/newbot`,
  free, instant).

## Run

```bash
npm install && npm install ../../../robinhood-chain-sdk
TELEGRAM_BOT_TOKEN=123456:ABC-your-token node index.js
```

Then message your bot `/price AAPL` or `/trending` on Telegram.

## Verified behavior

Without a token, the bot fails immediately with a helpful message instead of
hanging (tested):

```
✗ TELEGRAM_BOT_TOKEN is not set.
  Create a bot with @BotFather on Telegram, then:
  TELEGRAM_BOT_TOKEN=123456:ABC-... node index.js
```

Import and registry load were verified live:

```
grammy Bot: function
registry size 95
```

> **Live Telegram session: pending a bot token.** This repo doesn't hold a
> Telegram bot credential, so the long-polling session itself (the actual
> `/price` reply screenshot) is the one piece not captured here — everything
> up to that boundary (SDK reads, grammY wiring, the failure path) is real and
> tested. Owner: run the command above with a `@BotFather` token to go live.

## Deploy for free

Any Node ≥ 20 host works — set `TELEGRAM_BOT_TOKEN` as an environment
variable and run `npm start`. No inbound port needed (long-polling), which is
why this fits comfortably inside every major free tier.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
