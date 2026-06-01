# Task 15 — Friends: requests, presence, direct messages

## Context

There is no social graph. Players cannot add each other, see who is online, or
message privately. The world guide describes a friends system: add by search or
invite, mutual accept required, see who is online and which realm they are in,
and send direct messages. (Parties and teleport-to-friend are explicitly NOT in
scope — do not build those.)

## Goal

An account-level friends system: send/accept friend requests, see friends'
online status and current realm, and exchange direct messages.

## What to build

1. **Account identity.** Friends are keyed to accounts (wallet address from Task
   17), not ephemeral session ids — a friendship must survive reconnects and
   realm changes. Use the persistence layer (Task 16).
2. **Friend graph API.** Backend endpoints (Vercel functions in `api/`, or a
   dedicated store) for: search users by display name, send a friend request,
   accept/decline, remove a friend, and list friends. Requests are pending until
   accepted; both directions stored consistently. Validate the requester owns the
   account (auth from Task 17). Guard against spam/self-add/duplicate requests.
3. **Presence + location.** Track which accounts are online and their current
   realm. Since players connect to per-realm Colyseus rooms, publish presence
   from the server (a shared presence store — Redis presence is already wired in
   `index.js` when `REDIS_URI` is set; use it, or the persistence store) so a
   friend's online/offline + realm shows accurately across instances.
4. **Direct messages.** Allow sending a DM to a friend whether or not they are in
   the same realm. Deliver in real time if online; queue + deliver on next login
   if offline (persisted). Respect the mute list (Task 14). Rate-limit + length-
   cap like world chat.
5. **Client friends UI.** A friends panel (HUD + `F` binding from Task 12):
   incoming/outgoing requests with accept/decline, the friends list with live
   online/offline + realm badges, a search-to-add flow, and a DM thread view with
   unread indicators. Designed empty state ("No friends yet — search to add
   someone") and offline/error states.

## Definition of done

- A request can be sent, accepted, and the friendship appears for both accounts
  and persists across sessions.
- Friends' online status and current realm display accurately, including across
  separate realm instances.
- DMs deliver live when online and arrive on next login when offline; muted users
  are suppressed; spam is rate-limited. No console errors.

## Dependencies

Requires Task 16 (persistence) and Task 17 (account identity/auth). Uses presence
infra referenced in `index.js`. Honors Task 14 mute list.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
