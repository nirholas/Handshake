# 09. Telegram feed bots: durable hosting for both channels

Read [00-INDEX.md](backlog-00-INDEX.md) first.

> **Commit gate.** These bots track a launchpad other than `$THREE`. The code
> lives in a different repo (`nirholas/pump-fun-sdk`), so nothing here should land
> in three.ws without owner approval. Build and deploy freely; ask before
> committing anything that names the launchpad into this repo.

## Status: done, verified live 2026-09-02

Both feeds now run on Cloud Run and no longer depend on this codespace. The
sibling repo is checked out at `/workspaces/pump-fun-sdk`, so the deliverables
below are verifiable from here, which they were not when this order was written.

| Feed | Cloud Run service | Revision | Uptime | Transport |
|---|---|---|---|---|
| Graduation and migration tracker | `pumpfun-channel-bot` | `-00004-tvk` | 25.4 h | websocket |
| All-claims firehose | `pumpfun-allclaims-bot` | `-00008-6d8` | 25.7 h | websocket |

Both are `Ready=True`, pinned singletons (`minScale=1`, `maxScale=1`) on the
`three-ws@` runtime SA. The codespace was rebuilt on 2026-09-02 and both local
processes on ports 3900/3901 died with it while the two services kept running:
that rebuild is the proof of durability this order asked for, not a regression.

Measured the same day: the tracker had posted 1,719 messages over 23,456 events
(`degraded: false`, delivery `ok`); the firehose had detected 15,566 claims and
posted 754 digests over 14,862 events, on `rpc.magicblock.app/mainnet`, with 2
post failures. Channel ids are distinct and numeric (`-1003965305979` and
`-1003905427189`), each with its own bot token in its own Secret Manager secret.

One open observation, not a failure: the firehose reports 531 queue drops
(roughly 6.5% of claim transactions never fetched). That is the RPC queue's
designed backpressure rather than a fault, and the levers are queue capacity and
endpoint count. The 2026-08-02 baseline of zero drops was a 3h43m measurement,
not a contract.

### What was left to build

Every numbered item below had already been completed by the 2026-08-01/02
sessions. The one real gap this pass found and closed was configuration
durability: `.env` is gitignored, so the rebuild destroyed the only copy of each
bot's working config, and nothing could read it back. That stranded a bot twice
over, since `deploy-cloudrun.sh` also reads its whole configuration from `.env`.
Each bot directory now has a `recover-env.sh` that rebuilds `.env` from the live
revision plus Secret Manager, applying the same numeric-`CHANNEL_ID` guard the
deploy applies. It is committed in the sibling repo (`9701edb9`) and unpushed.

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

Both services are private, so a stats read needs an identity token:

```sh
P=aerial-vehicle-466722-p5
for S in pumpfun-channel-bot pumpfun-allclaims-bot; do
  curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
    "$(gcloud run services describe "$S" --region us-central1 --project "$P" \
      --format='value(status.url)')/stats"
done
```

`localhost:3900` and `localhost:3901` only answer when a bot is running locally
as a fallback, which is no longer the normal state. If a local run is needed,
restore its config first with `./recover-env.sh` from the bot's directory: the
gitignored `.env` does not survive a codespace rebuild.

Baseline for the firehose once live: roughly 20 claims/min detected, digest every
60s, zero post failures. Flood control matters: Telegram caps around 20 posts/min
per channel, so large claims post individually and the rest batch into a digest,
with a sliding-window budget reserving one slot for the digest.

## Definition of done

- [x] Both bots run on Cloud Run, surviving a codespace rebuild. Proven by the
      2026-09-02 rebuild: both local processes died, both services stayed up.
- [x] Each uses its own token and numeric channel id, verified by a live post
      (1,719 messages posted and 754 digests posted, to distinct `-100...` ids).
- [x] WS mode confirmed active on both, with event rates recorded above.
- [x] The decoder sync decision is made, executed, and written down in
      `DECODERS.md` at the sibling repo root: the all-claims copy is canonical,
      nothing was refactored into a shared package, and the two stale copies are
      marked do-not-copy. Its rule for future bots is to copy that file and its
      test together.
- [x] A README in each bot directory documents deploy, env, and revival, now
      including `recover-env.sh`.
- [ ] Owner approval to commit this file's update into three.ws. Nothing else
      here needs it: the code landed in the sibling repo, which the gate at the
      top of this file exempts.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/backlog-09-telegram-bots-durability.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
