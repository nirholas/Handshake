# Task 13 — Chat slash commands

## Context

There is no command system in the game. The world guide lists player commands:
`/pickup` (pick up your firepit/shack), `/lock` and `/unlock` (protect structures
from mis-clicks), `/dismount` (leave a mount), `/who` (list nearby players in your
realm), and `/help` (list commands). Several of these have their action logic
defined in other tasks (`/pickup` `/lock` `/unlock` → Task 07; `/dismount` →
Task 09). This task builds the parser/router and the self-contained commands.

## Context dependency

Slash commands are entered through chat, so build on the world chat input from
Task 14 (or, if building first, add a minimal command input that Task 14 absorbs).

## What to build

1. **Command router (server).** A single parser that receives chat input
   beginning with `/`, splits command + args, validates the command exists and
   the caller may run it, dispatches to a handler, and returns a result message
   to that client. Unknown commands return a helpful error. Rate-limit commands.
2. **Wire the commands:**
   - `/pickup` — invoke the Task 07 structure-pickup action (list owned
     structures or pick up the targeted/nearest one; free the shack slot).
   - `/lock` / `/unlock` — toggle the Task 07 structure `locked` flag for the
     owner's adjacent structure.
   - `/dismount` — invoke the Task 09 dismount action.
   - `/who` — reply with the list of players currently in the caller's realm
     (real `state.players`, count + names), respecting any privacy/mute rules.
   - `/help` — reply with the list of available commands + one-line descriptions,
     generated from the command registry (never a hardcoded duplicate list).
3. **Client.** Typing a `/command` in chat sends it through the command path;
   command replies render as system messages distinct from player chat.
   Autocomplete/hint for command names is a plus (show matching commands as the
   user types `/`). `/help` output is readable and scannable.

## Definition of done

- Each command runs its real action and returns accurate output; `/help` lists
  exactly the registered commands; `/who` reflects real realm occupancy.
- Commands for actions the caller can't perform (no structure to pick up, not
  mounted) return a clear, honest message rather than failing silently.
- Commands are rate-limited and validated server-side. No console errors.

## Dependencies

Requires Task 14 (chat input) and the action implementations in Task 07
(`/pickup` `/lock` `/unlock`) and Task 09 (`/dismount`). `/who` and `/help` are
self-contained here.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
