# 08. OKX marketplace chat bot: get it off the codespace

Read [00-INDEX.md](backlog-00-INDEX.md) first.

> **Commit gate.** Content here references a marketplace outside the `$THREE`
> ecosystem. Get owner approval before committing anything that names it.

## What is wrong

Chat for the marketplace listing (agent #2632, "three.ws 3D Studio") is delivered
by a **local `okx-a2a` daemon plus a wallet session**, both outside this repo. It
goes offline on its own: a codespace rebuild wipes the CLIs and an idle nap kills
the daemon (observed alive at 21:09, stale pid by 03:13). The marketplace's own
tests then report "timeout, no delivery in 30 min", which is what got the listing
flagged offline once already.

**State on 2026-09-02.** The wallet session is logged in (`claude@three.ws`), the daemon
is running under the worker's own supervisor rather than the codespace autostart unit, and
`/api/healthz` shows the `okx_chat_bot` subsystem for the first time. It is still a
codespace, so every beat says so: `hostDurable=false` reads as degraded on the ops surface,
not green. What is left is the deploy itself.

## Immediate revive (do this first, it takes one command)

```sh
npm run okx:bot        # scripts/okx-bot-revive.mjs
# exit 0 = online
# exit 2 = staged but logged out; it prints the login URL and the poll commands
```

The login needs a human: email OTP as `claude@three.ws`. Run this immediately
before any retest window. The wiring table is in
[../okx-ai/RUNBOOK.md](okx-ai-RUNBOOK.md) section 0.5.

Then hand the daemon to the worker instead of leaving it parentless, so the fleet can see
it and an expired session pages instead of going quiet:

```sh
PORT=8080 OKX_BOT_REPO_ROOT=/workspaces/three.ws \
  node --env-file=.env.local workers/okx-chat-bot/index.js
```

## The durable fix

A codespace cannot stay up on its own, so the real deliverable is an always-on
host. Build it:

1. **Containerize the daemon and its session state.** The daemon spawns the AI CLI
   in `~/.okx-agent-task/workspace`, and that directory's `CLAUDE.md` and
   `.claude/skills` are the **only** context chat answers have. It is empty by
   default, which means a naive host ships an agent that knows nothing about
   three.ws. Bake real context in.

2. **Do not replace the adapter with a one-shot responder.** The adapter does not
   read a reply out of the CLI's stdout; the AI subsession sends the reply itself
   via the `okx-a2a` CLI. A simple LLM responder would break the task lifecycle,
   not just chat. Custom hosts are supported through
   `OKX_A2A_AI_<PROVIDER>_COMMAND` and `..._EXEC_ARGS_JSON`, but whatever runs
   there must be genuinely agentic.

3. **Deploy to Cloud Run** in `aerial-vehicle-466722-p5`, pinning the
   `three-ws-build@` build service account and the `three-ws@` runtime service
   account (the default compute SA was deleted). Config-only env updates are
   pre-approved; the deploy itself is owner-gated, so prepare it to one command.

4. **Add a liveness signal.** The listing goes offline silently today. Expose a
   health endpoint and wire it into the same monitoring that watches the rest of
   the fleet, so "the bot is logged out" becomes an alert instead of a discovery.

5. **Session renewal.** The wallet session expires and needs a human OTP. Make the
   host detect an expired session and emit an actionable alert naming the exact
   command, rather than failing chat silently.

## Owner actions

- One email OTP login when the session is logged out.
- An AI-provider credential for the headless box, if the host cannot reuse this
  machine's.

## Definition of done

- [ ] `npm run okx:bot` exits 0, chat delivery verified end to end with a real
      inbound message.
- [ ] The daemon runs on an always-on host, not this codespace.
- [ ] Its workspace carries real three.ws context, verified by asking it a
      platform question and reading the answer.
- [ ] A health endpoint exists and an offline session raises an alert.
- [ ] [../okx-ai/PROGRESS.md](okx-ai-PROGRESS.md) updated with the host details.
