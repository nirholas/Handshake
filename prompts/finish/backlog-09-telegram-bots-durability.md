# 09. Telegram feed bots: durable hosting for both channels

Read [00-INDEX.md](backlog-00-INDEX.md) first.

> **Commit gate.** These bots track a launchpad other than `$THREE`. The code
> lives in a different repo (`nirholas/pump-fun-sdk`), so nothing here should land
> in three.ws without owner approval. Build and deploy freely; ask before
> committing anything that names the launchpad into this repo.

## What is wrong

Two live feeds run as **local processes in this codespace**, which means both die
on every rebuild and every idle nap:

| Feed | Directory | Port | State |
|---|---|---|---|
| Graduation and migration tracker | `/workspaces/pump-fun-sdk/channel-bot` | 3900 | live since 2026-08-01 20:46 UTC |
| All-claims firehose | `/workspaces/pump-fun-sdk/pumpkit/packages/allclaims` | 3901 | live since 2026-08-01 21:14 UTC |

Revive either with `npm start` from its directory. Durable hosting is one
`./deploy-cloudrun.sh` away for the first and unwritten for the second.

## The work

1. **Deploy both to Cloud Run.** `channel-bot/deploy-cloudrun.sh` exists and is the
   template. Write the equivalent for the all-claims package. Pin the
   `three-ws-build@` and `three-ws@` service accounts.

2. **Never use `--set-env-vars` for these.** Their config breaks the flag: the RPC
   URL list contains commas and the channel id can contain `@`, so neither the
   default separator nor the `^@^` alternate delimiter is safe. `deploy-cloudrun.sh`
   writes a YAML env file instead. Do the same for the second bot.

3. **Keep the bot identities separate.** Each feed has its own bot and its own
   channel. Reusing one token across both is unsupported and crosses the feeds.
   Put the **numeric `-100…` chat id** in `CHANNEL_ID`, never the handle: the
   shared `t.me` link is not always the username, and `getChat?chat_id=@handle`
   returns `chat not found` even with the bot already an admin. Recover the real
   id from `getUpdates?allowed_updates=["my_chat_member"]`, whose promotion event
   carries the chat id, username, and full admin rights object.

4. **Keep websockets, do not fall back to polling.** `getSignaturesForAddress`
   limit-20 per 30s against the program samples a handful of valid transactions
   per minute out of thousands, so events get missed entirely. The code only
   enables WS when `SOLANA_WS_URL` is explicitly set. `wss://rpc.magicblock.app/mainnet`
   carries the full firehose on the free tier (measured 4,545 events per 20s) and
   `wss://solana-rpc.publicnode.com` also works keyless. The three.ws Helius key is
   plan-exhausted and its WS handshakes 429 forever, so do not point these at it.

5. **Sync the stale decoders.** `@pumpkit/core` and `@pumpkit/channel` are March
   snapshots missing the post-2026-05-21 V2 layouts (quote-mint claims, lifetime
   claimed, fake social-claim detection). The current decoder lives in
   `channel-bot/src/claim-monitor.ts`. Either sync pumpkit from it or make every
   future bot copy from channel-bot, and write down which, because this trap has
   already been hit once.

6. **Process hygiene for whoever debugs this next.** The bot's cmdline is
   `node dist/index.js` (relative), so `pkill -f "channel-bot/dist/index.js"`
   silently matches nothing. Match on cwd via `/proc/<pid>/cwd`, and never kill a
   same-named process whose cwd is `/workspaces/three.ws`.

## Verify

```sh
curl -s localhost:3900/stats    # or the Cloud Run URL once deployed
curl -s localhost:3901/stats
```

Baseline for the firehose once live: roughly 20 claims/min detected, digest every
60s, zero post failures. Flood control matters: Telegram caps around 20 posts/min
per channel, so large claims post individually and the rest batch into a digest,
with a sliding-window budget reserving one slot for the digest.

## Definition of done

- [ ] Both bots run on Cloud Run, surviving a codespace rebuild.
- [ ] Each uses its own token and numeric channel id, verified by a live post.
- [ ] WS mode confirmed active on both, with event rates recorded.
- [ ] The decoder sync decision is made, executed, and written down.
- [ ] A README in each bot directory documents deploy, env, and revival.
- [ ] Owner approval obtained before committing any of this into three.ws.
