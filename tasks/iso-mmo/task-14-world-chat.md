# Task 14 — World chat: rate limit, length cap, mute

## Context

The game room (`GameRoom.js`) has no chat. The sibling room
`multiplayer/src/rooms/WalkRoom.js` already implements a working chat (message
handling around lines 191/346–351) with the patterns this game should reuse:
sanitization, rate limiting, and broadcast. The world guide specifies world chat
focused with `C`, messages to everyone online, per-window rate limits, rejection
of overly long messages, and the ability to mute players.

## Goal

A world chat for the game realm: send/receive messages to everyone in the realm,
rate-limited and length-capped, with client-side mute.

## What to build

1. **Server chat handler.** Add `onMessage('chat', ...)` to `GameRoom`: sanitize
   with the existing `clean()` helper, enforce a max length (reject longer
   messages with a notice), and rate-limit using the established bucket pattern
   (`_rateOk`, e.g. a `chat` limit). Broadcast accepted messages to the realm with
   sender id + name + sanitized text + server timestamp. Reuse `WalkRoom`'s
   approach so behavior is consistent across the two experiences.
2. **Scope.** Chat is per-realm (each realm is its own room), matching player
   visibility. Do not leak messages across realms/instances.
3. **Command passthrough.** Messages starting with `/` route to the command
   system (Task 13) instead of broadcasting.
4. **Client chat UI.** A chat panel + input focused with `C` (Task 12 binding):
   scrollback of recent messages with sender names, send on `Enter`, auto-scroll,
   and an unobtrusive collapsed state. Show rejected-message feedback (too long /
   rate-limited) inline. Distinguish system/command replies from player messages.
5. **Mute.** Let a player mute another (e.g. click a name → Mute). Muted senders'
   messages are hidden client-side. Persist the mute list per account (Task 16).
   Provide an unmute path and a view of who is muted.

## Definition of done

- Two sessions in the same realm see each other's messages in real time; sessions
  in different realms do not.
- Over-length and flood messages are rejected server-side with clear feedback.
- Muting hides a player's messages and persists; unmuting restores them.
- `/` messages go to commands, not chat. No console errors.

## Dependencies

Reuses `WalkRoom` chat patterns. Feeds Task 13 (command input). Mute persistence
uses Task 16.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
