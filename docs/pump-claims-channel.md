# pump.fun first-claims Telegram channel

A live feed of **first-time pump.fun creator fee claims**, delivered to a
Telegram channel (`@pumpfunclaims`), one message per claim.

A "first claim" is the first time a creator ever pulls their accrued
creator/delegated rewards out of the fee vault. It is an on-chain, irreversible
signal that the creator is live and engaged with their coin, which is why it
gets its own channel rather than a line in the holder changelog.

## How it works

```
pump.fun program activity
        │
        ▼
scanFirstClaims()            api/_lib/pump-claims.js
   ├── PUMPFUN_BOT_URL indexer   (preferred)
   └── direct Solana RPC scan    (fallback, see "Known limits")
        │
        ▼
pushTelegramLane()           api/_lib/pump-claims-push.js
   ├── diff against app_settings['pump_claims_push_telegram']
   ├── oldest-first, 10 per tick, 3.5s apart
   └── Telegram sendMessage → TELEGRAM_PUMP_CLAIMS_CHAT_ID
        │
        ▼
GET /api/cron/pump-claims-push   every 5 minutes (Cloud Scheduler)
```

The same scanner also backs `GET /api/pump/first-claims` and the
`pumpfun_first_claims` MCP tool, so the channel and the API never disagree.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot that posts. Create via [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_PUMP_CLAIMS_CHAT_ID` | yes | `@pumpfunclaims`, or the `-100…` numeric id. |
| `PUMPFUN_BOT_URL` | yes in practice | pump.fun claims indexer. Without it the scan returns nothing (see below). |
| `PUMPFUN_BOT_TOKEN` | optional | Bearer token for the indexer, when it requires one. |

The bot **must be an administrator of the channel** with permission to post.
Telegram rejects `sendMessage` from a non-admin bot to a channel with
`403: Bot is not a member of the channel chat`.

There is deliberately **no fallback** to `TELEGRAM_CHANGELOG_CHAT_ID`. This feed
is high-volume third-party coin activity; the holder changelog is a different
audience. With `TELEGRAM_PUMP_CLAIMS_CHAT_ID` unset the lane reports
`{ skipped: 'not_configured' }` and posts nothing.

Set the variables on the running service (never with `--set-env-vars`, which
replaces the entire env set):

```bash
gcloud run services update three-ws-api \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --update-env-vars TELEGRAM_PUMP_CLAIMS_CHAT_ID=@pumpfunclaims
```

## Verifying it

```bash
# 1. Is the scan returning claims at all?
curl -s 'https://three.ws/api/pump/first-claims?sinceMinutes=60&limit=5'

# 2. Does the bot have channel access? (replace $TOKEN)
curl -s "https://api.telegram.org/bot$TOKEN/getChat?chat_id=@pumpfunclaims"

# 3. Watch the lane
gcloud logging read 'resource.type="cloud_run_revision"
  resource.labels.service_name="three-ws-api"
  textPayload:"pump-claims"' --freshness=1h
```

The cron returns its lane result in the response body, so a manual authenticated
call reports exactly what happened: `{ posted, scanned, backlog }`, or
`{ skipped }`, or `{ error }`.

## State and safety properties

State lives in `app_settings` under `pump_claims_push_telegram`:

```json
{ "lastTs": 1723661000, "seen": ["<tx signature>", "..."] }
```

- **First run seeds without posting.** Enabling the lane records what is already
  on-chain and starts posting from the next tick, so switching it on never dumps
  a backlog into the channel.
- **Dedupe is by transaction signature**, not by timestamp. Two claims landing in
  the same second are common; a timestamp-only cursor would silently drop the
  second one. `seen` is a bounded ring of 400 signatures; `lastTs` bounds the
  scan window so the ring never has to answer for anything older.
- **A three-hour cutoff** bounds any catch-up. A lane that has been down for a
  day drains recent claims and drops stale ones rather than replaying history.
- **State is written per message, not per run.** A tick killed mid-batch (the
  Cloud Run request deadline is shorter than a full paced run) resumes at the
  next claim instead of repeating delivered ones.
- **A DB lock** (`pump_claims_push_lock`, 240s TTL) stops overlapping ticks from
  double-posting. Every outbound request is bounded well under that TTL (each
  Telegram `sendMessage` goes through the shared `fetchUpstream` with a 10 s
  deadline and at most two attempts), which is what keeps the lock's guarantee
  true.
- **All message fields are HTML-escaped.** Claim data is third-party on-chain
  data; unescaped text could otherwise smuggle a clickable link posted under the
  platform bot's identity.

## Known limits: the RPC fallback cannot serve this feed

`scanFirstClaims` prefers the `PUMPFUN_BOT_URL` indexer and falls back to a
direct RPC scan of the pump program's recent signatures. **That fallback cannot
produce a useful result, and the channel will stay silent without the indexer.**

Measured against mainnet on 2026-08-14:

```
getSignaturesForAddress(pump program, limit: 200)
  → 200 signatures
  → wall-clock span covered: 0 seconds
  → 172 of 200 were failed transactions
```

The pump.fun program clears its 200-signature page in under one second, so the
fallback samples a fraction of a single second of chain activity no matter what
`sinceMinutes` the caller asks for. Two consequences:

1. A claim instruction is rare relative to buys and sells, so a sample that
   small almost never contains one.
2. "First ever claim" cannot be established from one second of history, which is
   the whole point of the feed.

Paginating backwards does not fix it: at roughly 200 transactions per second,
one hour of lookback is on the order of 700k signatures.

The supported source is an indexer. `PUMPFUN_BOT_URL` points at the upstream
`pumpfun-claims-bot`, and it is **not configured on the production service**,
which is why `GET /api/pump/first-claims` currently returns `{"items":[]}` for
every window. Set it and the channel starts posting with no code change.

If no indexer is available, the alternative that fits this repo is a Helius
enhanced-transaction webhook on the pump program filtered to the claim
discriminators, received at a sibling of
[api/pump/helius-webhook.js](../api/pump/helius-webhook.js). That path is not
built yet.

## Related

- [api/_lib/pump-claims.js](../api/_lib/pump-claims.js) - the shared scanner
- [api/_lib/pump-claims-push.js](../api/_lib/pump-claims-push.js) - the delivery lane
- [api/cron/pump-claims-push.js](../api/cron/pump-claims-push.js) - the cron entry point
- [api/_lib/commit-feed-push.js](../api/_lib/commit-feed-push.js) - the sibling commit feed this lane mirrors
