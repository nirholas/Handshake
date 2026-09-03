# The home relay: threat model

**What an attacker gets, at every position around the socket a LAN-only house dials out through,
and what stops them.**

This is the document [`services/home-relay/src/server.js`](../services/home-relay/src/server.js),
[`protocol.js`](../services/home-relay/src/protocol.js) and
[`api/home/pair.js`](../api/home/pair.js) tell you to read before changing them. It covers the
relay specifically. The platform-wide model, the prompt-injection boundary and the abuse surface
are in [home-security.md](home-security.md).

## What the relay is

Most Home Assistant installs answer only on their own network. three.ws is served over https from
Cloud Run and cannot route to RFC1918 space, so for those houses there is no URL we could ever
dial. The house dials us instead: the three.ws integration inside it opens **one outbound
WebSocket** to [`services/home-relay`](../services/home-relay/README.md) and keeps it. The
platform then asks the relay to open a session over that socket.

Nothing listens on the user's network. No port is forwarded. No inbound firewall rule exists.

```
  three.ws api  ──WS /v1/bridge──►  home-relay  ◄──WS /v1/agent──  Home Assistant
   (platform)                     (this service)                    (the house)
```

## The design decision the whole model rests on

**The obvious implementation would be the worst thing this platform could ship.** "Forward any
HTTP request into the LAN" is a caller-chosen path into somebody's home network, and no amount of
authentication makes that safe, because the authenticated caller is exactly who you have to worry
about once anything upstream is compromised.

So the relay is not a proxy. It carries a **fixed, enumerated set** of Home Assistant WebSocket
message types and refuses everything else. The set is derived from what
[`packages/home-bridge`](../packages/home-bridge/README.md) actually sends, which is what the
product's three channels need: the entity subscription, four registry reads, and service calls.
Nothing else has ever been needed, so nothing else is permitted.

## The five positions, and what each one gets

### 1. A stranger on the internet

Gets nothing. There is no inbound path to the house at all, and the relay's own endpoints require
either a signed install token (`/v1/agent`) or the platform's service token (`/v1/bridge`).

### 2. Someone who steals an install token

An install token (`hr1.<payload>.<hmac>`, see [`token.js`](../services/home-relay/src/token.js))
identifies which house is dialling in. It is minted by three.ws at pairing time, stored by the
integration, and presented on every dial-in. The relay verifies the HMAC with the shared signing
key and reads the relay id out of the payload, so it stays **stateless about ownership**: it never
queries a database on the connect path, and it cannot be tricked into binding a socket to a relay
id its holder was not granted.

A stolen token gets an attacker a socket to the relay. It does not get them a house:

- The relay only ever joins that socket to **the owning user's own sessions**.
- The physical-action gate still sits above every one of those sessions, so a guarded action still
  needs a person.
- The token is **not** a Home Assistant credential. In relay mode three.ws stores no Home
  Assistant token at all (`home_connections.access_token_enc` is empty), because the integration
  authenticates to Home Assistant locally with a refresh token it mints for itself and never sends
  off the machine.

Revocation is push-based and immediate: three.ws calls `POST /v1/revoke` when a home is revoked,
the relay drops the socket and denies the relay id. The token deliberately carries no expiry the
user would have to re-pair around, because it is not the last line of defence: the platform
re-reads the connection row on every bridge connect, so a revoked home never gets a session opened
even if the relay were to forget the denial.

### 3. A compromised or buggy platform-side caller

This is the position the allowlist in the relay exists for. Even holding the service token, a
platform caller can send only the enumerated outbound types, and:

- `subscribe_events` is limited to `state_changed`. Anything else "would subscribe to more of the
  house than the room graph needs", and is refused by name.
- `call_service` is refused outright for `shell_command`, `python_script`, `hassio`, `supervisor`,
  `backup`, `update`, `cloud`, `config`, `auth` and `command_line`, plus the named services that
  survive a permitted domain: `homeassistant.restart`, `homeassistant.stop`,
  `homeassistant.check_config`, `homeassistant.reload_all`, `homeassistant.reload_core_config`,
  `persistent_notification.create`.
- Only `result`, `event` and `pong` come back out of a house.

Rate limits are per install and cover both frame rate and actuation rate (40 outbound frames per
second, 60 service calls per minute, 8 concurrent sessions, 4 MB per frame): a bug in an
integration must not be able to flood a house, and a compromised platform caller must not be able
to hammer a lock.

### 4. A compromised relay

**This is the position that matters most, because the relay is operated by us and is therefore
exactly the component a user has to trust least.**

The allowlist is enforced **twice, independently**: once in the relay
([`server.js`](../services/home-relay/src/server.js)) so a bad platform caller cannot reach past
it, and again in the integration inside the house (`relay_client.py`) so a bad relay cannot
either. Compromising the relay does not widen what may enter a house by one message type.

Both enforcement points read the same enumeration rather than transcribing it:
[`protocol.js`](../services/home-relay/src/protocol.js) is the source of truth,
[`allowlist.json`](../services/home-relay/allowlist.json) is the generated copy the Python side
reads, and `tests/home-relay-protocol.test.js` fails if the checked-in copy is stale. Two
enforcement points that drift apart would be worse than one.

The relay also holds nothing worth stealing: no database, no Home Assistant credential, and no
persistent record of what passed through it.

### 5. Someone inside the house

Out of scope, and honestly so. Anyone with access to the Home Assistant instance can already do
everything the relay could ever ask for, directly, without us.

## What is deliberately accepted

- **The relay sees traffic in transit.** It terminates both sockets, so it can read the state and
  service calls that cross it. It cannot read a Home Assistant credential, because none crosses,
  and it cannot widen the message set, because the far end enforces the list again. Encrypting
  end to end past the relay would require the integration and the platform to share a key the
  relay never sees, which is worth doing and is not done today.
- **The install token has no expiry.** See position 2 for why: revocation is push-based and the
  platform re-checks the connection row on every session.
- **A house can lie about its own state.** An instance that reports a door as locked when it is
  not is a compromised house, and no relay design fixes that.

## The invariant

**Nothing on this path may open a building without a person.** The relay does not implement the
gate, and it must never be given a way to bypass one: a service call arriving over `/v1/bridge`
has already been through
[`api/_lib/home/tools.js`](../api/_lib/home/tools.js) and, if guarded, has already been redeemed
by a signed-in human at `POST /api/home/:id/confirm`. If a change to this service would let a call
reach a house without having passed that, the change is wrong.

## Read next

- [`services/home-relay/README.md`](../services/home-relay/README.md): running it, its endpoints,
  and regenerating the allowlist.
- [home-security.md](home-security.md): the platform threat model, the injection boundary, the
  eleven checks.
- [smart-home.md](smart-home.md): why the reachability problem exists and the three answers to it.
- [tutorials/connect-your-home.md](tutorials/connect-your-home.md): the user-facing walkthrough.
