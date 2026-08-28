# @three-ws/herald-mcp

**Let your agent tell you something in person.**

An MCP server with one idea behind it: when an agent finishes something that
mattered, or gets stuck, it should not add a line to a log you will never scroll
back to. It should walk up to you and say so.

Wire this in, and it does. Your own 3D companion appears in the corner of
whatever browser tab you have open, gestures, and says the line out loud, with a
link to click through.

```
you: run the migration, then the backfill, and tell me when it's done
agent: [runs for 22 minutes]
       [calls announce_result: task "the backfill", outcome succeeded, 1320s]
your browser: your avatar walks on: "the backfill finished in 22m"
```

## Tools

| Tool | What it does |
| --- | --- |
| `announce` | Say one line, with importance (0-100), tone, a gesture, and an optional link. |
| `announce_result` | Report a finished task. The urgency is chosen from the outcome, so a failure cuts through quiet hours and a success does not. |
| `check_rail` | Prove the key and the rail work, without interrupting anybody (queues at importance 0, which every client drops). |

## Install

```sh
npx -y @three-ws/herald-mcp
```

Claude Code:

```sh
claude mcp add herald -e THREE_WS_API_KEY=sk_live_... -- npx -y @three-ws/herald-mcp
```

Claude Desktop / Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "herald": {
      "command": "npx",
      "args": ["-y", "@three-ws/herald-mcp"],
      "env": { "THREE_WS_API_KEY": "sk_live_..." }
    }
  }
}
```

## The key

Create one at [three.ws/dashboard/developers](https://three.ws/dashboard/developers)
with the **`herald:announce`** scope, and put it in `THREE_WS_API_KEY`.

An announcement is always delivered to **the key owner's own** live sessions.
There is no recipient parameter: this server cannot be pointed at anybody else,
so the worst a leaked key can do is annoy the person who leaked it. Revoke it in
the same place.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `THREE_WS_API_KEY` | yes | | API key with `herald:announce`, or an OAuth access token. Aliases: `THREE_WS_TOKEN`, `THREE_WS_BEARER`. |
| `THREE_WS_BASE` | no | `https://three.ws` | Override for self-hosting or a preview deployment. |
| `THREE_WS_TIMEOUT_MS` | no | `20000` | Per-request timeout. |

## When to use it (and when not to)

Announcements are scarce on purpose. The receiving client applies an importance
floor, a rate limit, dedupe, quiet hours, and a freshness window, so anything
that does not clear the bar is dropped rather than queued. That is the feature:
an interruption only works while it is rare.

Good: a long job finished, a job failed, a decision is needed, something broke,
money moved.

Bad: progress updates, "starting step 3 of 7", anything the person can read
later. Those belong in the notification inbox
([@three-ws/notifications-mcp](https://www.npmjs.com/package/@three-ws/notifications-mcp)).

If nothing is open to hear it, the line expires in about five minutes. The rail
is a live channel, not an archive.

## Example calls

```jsonc
// something broke, and it should wake somebody up
{ "name": "announce", "arguments": {
    "text": "The payments worker has been failing for 10 minutes",
    "from": "watchdog", "importance": 95, "tone": "error",
    "url": "https://three.ws/dashboard", "key": "payments-worker-down" } }

// a long task finished, and it should not
{ "name": "announce_result", "arguments": {
    "task": "the nightly backfill", "outcome": "succeeded", "seconds": 1320 } }

// wiring check
{ "name": "check_rail", "arguments": { "note": "claude-code" } }
```

## How it reaches a browser

`POST /api/herald/announce` queues the line on the account's rail; the page
listens over SSE and hands it to [@three-ws/herald](https://www.npmjs.com/package/@three-ws/herald),
which decides whether it clears the person's own rules and then delivers it
through the 3D companion (or an accessible card when there is no GPU).

Try the whole loop, including the rules engine, at
[three.ws/herald](https://three.ws/herald).

## License

Apache-2.0.
