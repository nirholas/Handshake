# home-relay

**The socket a LAN-only house dials out through.**

three.ws is served over https from Cloud Run. Home Assistant usually lives on a home network, on
an address no server on the internet can route to. For those houses there is no URL we could ever
dial, so the house dials us: the [three.ws Home Assistant
integration](../../home-assistant-integration) opens one outbound WebSocket to this service and
keeps it open, and the platform reaches the instance back down that socket.

Nothing listens on the user's network. No port is forwarded. No inbound firewall rule exists.

```
  three.ws api  ──POST /v1/agent(ws)──►  home-relay  ◄──dial-out ws──  Home Assistant
   (platform)                          (this service)                  (the house)
```

## What it deliberately is not

It is small and dumb on purpose, because it sits between the platform and a building.

- **It holds no database.** Ownership is proved by the signature on the install token the house
  presents ([`src/token.js`](src/token.js)), so the connect path queries nothing.
- **It holds no Home Assistant credential, ever.** Authentication happens locally, inside the
  house. No long-lived token crosses this process, which is why a relayed home's
  `home_connections.access_token_enc` is empty.
- **It forwards only what the protocol permits**, in the direction it permits
  ([`src/protocol.js`](src/protocol.js)), and the integration enforces the same list again at the
  far end, so compromising this service does not compromise a house.

That last point is the whole security argument, and it is why the allowlist is generated rather
than transcribed: see [The allowlist](#the-allowlist).

## Run it

```bash
cd services/home-relay
npm ci
HOME_RELAY_SIGNING_KEY=$(openssl rand -hex 32) \
HOME_RELAY_SERVICE_TOKEN=$(openssl rand -hex 32) \
PORT=8080 npm start
# {"event":"relay.listening","port":8080}

curl -s localhost:8080/healthz
```

| Variable | Required | What it is |
|---|---|---|
| `HOME_RELAY_SIGNING_KEY` | yes | Signs and verifies the install tokens a house presents. The platform mints tokens with the same key. |
| `HOME_RELAY_SERVICE_TOKEN` | yes | The platform's own credential for opening a session over a house's socket. Not a user credential. |
| `PORT` | no | Listen port. Defaults to 8080, which is what Cloud Run sets. |

## Endpoints

| Path | Who calls it | What it does |
|---|---|---|
| `GET /healthz`, `GET /` | Cloud Run, monitoring | Liveness plus counts |
| `GET /v1/status` | the platform | Which installs are connected right now |
| `WS /v1/agent` | a house | The dial-out socket. Presents an install token, then stays |
| `WS /v1/bridge?relay_id=` | the platform | Opens one session over that house's socket |
| `POST /v1/revoke`, `POST /v1/unrevoke` | the platform | Cut an install off, or restore it |

`@three-ws/home-bridge` speaks the `/v1/bridge` side for you:
`createRelayTransport({ relayUrl, relayId, serviceToken })` returns the transport a `HomeBridge`
takes in place of a URL and a token. See [that package's
README](../../packages/home-bridge/README.md#a-house-you-cannot-dial-into).

## The allowlist

[`allowlist.json`](allowlist.json) is the contract: which frame types cross, which Home Assistant
WebSocket commands may be sent into a house, which event types may come back, and which service
domains are refused outright (`shell_command`, `python_script`, `hassio`, `supervisor`, `backup`,
`update`, `cloud`, `config`, `auth`, `command_line`, plus named services like
`homeassistant.restart`).

It is enforced twice: here in JavaScript, and again in Python inside the house. Two enforcement
points that drift apart would be worse than one, so the Python side **reads this generated file**
rather than transcribing the rules, and it is generated from `src/protocol.js` rather than
hand-written:

```bash
node services/home-relay/scripts/gen-allowlist.mjs
```

`tests/home-relay-protocol.test.js` fails if the checked-in file is stale, so a rule change that
forgets to regenerate is a red test rather than a silent divergence between the two enforcers.

Rate limits live in the same manifest, per install, on both frame rate and actuation rate: a bug
in an integration must not be able to flood a house, and a compromised platform caller must not be
able to hammer a lock.

## The protocol, in one exchange

```
  house                        relay                        platform
    |-- hello ------------------>|
    |<----------------- hello.ok |
    |                            |<---- (opens wss /v1/bridge?relay_id=)
    |<------------ session.open  |
    |-- session.ready ---------->|---- session.ready ----------->|
    |<-------- ha {get_states} --|<---- ha {get_states} ---------|
    |-- ha {result} ------------>|----- ha {result} ------------>|
```

Frames are JSON text objects carrying `{ v, t, ... }`. `v` is the protocol version and a mismatch
is refused rather than coerced, which is what makes an old integration a named upgrade prompt
instead of a confusing failure. `src/protocol.js` is pure: no sockets, no timers, no I/O, so the
part that must never be wrong is testable exhaustively without a network.

Note what never appears in that exchange: an `auth` frame. Authentication happens inside the
house, before `session.ready`, so no Home Assistant credential ever crosses this process.

## Public API

```js
import { createRelay } from './src/server.js';

const relay = createRelay({ signingKey, serviceToken, log: (event, fields) => {} });
await relay.listen(8080);
relay.stats();          // { installs, sessions, revoked }
await relay.close();    // closes every house's socket first, for a clean SIGTERM
```

```js
import { mintInstallToken, newRelayId, verifyInstallToken } from './src/token.js';

const relayId = newRelayId();                                     // hr_<24 url-safe chars>
const token = mintInstallToken({ relayId, userId, homeId }, key); // hr1.<payload>.<hmac>
verifyInstallToken(token, key);                                   // { ok, claims } | { ok:false, reason }
```

```js
import { checkOutbound, checkInbound, allowlistManifest } from './src/protocol.js';

checkOutbound({ type: 'call_service', domain: 'light', service: 'turn_on' });
// { allowed: true }
checkOutbound({ type: 'call_service', domain: 'shell_command', service: 'x' });
// { allowed: false, code: 'not_allowed', reason: 'The "shell_command" domain administers...' }
```

## Deploy

```bash
gcloud builds submit --config services/home-relay/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s) services/home-relay
```

Three settings in [`cloudbuild.yaml`](cloudbuild.yaml) are load-bearing, and none of them is a
performance preference:

- `--no-cpu-throttling` with `--min-instances=1`. A house's dial-out socket has to survive between
  platform requests; a throttled or scaled-to-zero container lets every one of them die and
  reconnect in a loop.
- `--allow-unauthenticated`. Houses dial in from the public internet carrying their own bearer
  token, and this service authenticates every connection itself. IAM auth would make the feature
  impossible, not safer.
- `--timeout=3600`. Cloud Run caps a request and a WebSocket **is** a request, so this is how long
  a house's socket may live before it must reconnect. The integration reconnects with backoff, so
  the ceiling costs a few hundred milliseconds an hour per house and nothing else.

`--session-affinity` is deliberately absent. A house holds one socket to one instance, and the
platform is routed to whichever instance holds it by relay id, so affinity would buy nothing and
pin load unevenly.

To build the image locally:

```bash
docker build -t home-relay services/home-relay
```

## Tests

```bash
npx vitest run tests/home-relay-protocol.test.js   # the allowlist, exhaustively, no network
npx vitest run tests/home-relay-transport.test.js  # this server, in process, over a real socket
```

The live proof against an actual Home Assistant on a network the caller cannot route to is
[`scripts/home-relay-e2e.mjs`](../../scripts/home-relay-e2e.mjs); the two-network recipe is in
[docs/home-relay.md](../../docs/home-relay.md).

## Read next

- [`home-assistant-integration/`](../../home-assistant-integration): the other end of the socket,
  the part that installs in the house through HACS.
- [`@three-ws/home-bridge`](../../packages/home-bridge): the client that speaks to this.
- [docs/home-relay.md](../../docs/home-relay.md): installing the integration, configuring this
  service, and the two-network setup that proves the path against an unroutable house.
- [docs/home-relay-threat-model.md](../../docs/home-relay-threat-model.md): what an attacker gets
  at every position around this socket, including a compromised relay.
- [docs/smart-home.md](../../docs/smart-home.md): why the reachability problem exists and the
  three honest answers to it.
